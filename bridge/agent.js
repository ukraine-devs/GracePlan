// Grace Bridge relay — raw CDP over WebSocket, no playwright.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import WebSocket from "ws";
import { execFileSync, execSync } from "node:child_process";

const CDP_HOST = "localhost:9222";
const PROJECT_URL = process.env.GRACE_PROJECT_URL || "https://chatgpt.com/g/g-p-6ade243a41e48191b297ec2ac5c7e822-grace-planner/project";
// Conversation links inside a project use the bare project key (g-p-<id>),
// while the project page URL carries a human-readable slug after it.
const PROJECT_KEY = ((PROJECT_URL.match(/\/g\/(g-p-[0-9a-f-]{8,})/i) || [])[1] || "g-p-6ade243a41e48191b297ec2ac5c7e822").replace(/-+$/, "");
const GIZMO_ID = PROJECT_KEY;
const PROJECT_BASE = "https://chatgpt.com/g/" + PROJECT_KEY;
const projectUrl = (gptId) => PROJECT_BASE + "/c/" + gptId;
const PORT = 8899;
const STATE_FILE = "/opt/grace-bridge/state.json";
const UPLOAD_DIR = "/opt/grace-bridge/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let state = { chats: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
// The same conversation can arrive from a send and from a sync at once; the
// relay list must never hold two entries for one ChatGPT chat.
function dedupeChats(chats) {
  const byId = new Map();
  for (const chat of chats || []) {
    if (!chat?.gptId) continue;
    const previous = byId.get(chat.gptId);
    if (!previous || (chat.updatedAt || 0) >= (previous.updatedAt || 0)) byId.set(chat.gptId, chat);
  }
  return [...byId.values()];
}
state.chats = dedupeChats(state.chats);
const save = () => { state.chats = dedupeChats(state.chats); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, fallback = null) => Promise.race([promise.catch(() => fallback), sleep(ms).then(() => fallback)]);
const dbg = (msg) => { try { fs.appendFileSync("/tmp/agent.log", new Date().toISOString() + " " + msg + "\n"); } catch {} };

// ---------- raw CDP client ----------
async function cdpList() {
  const res = await fetch(`http://${CDP_HOST}/json/list`);
  return res.json();
}
async function cdpVersion() {
  const res = await fetch(`http://${CDP_HOST}/json/version`);
  return res.json();
}

class CdpSession {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.on("message", (raw) => { const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
      else if (msg.method && this.handlers.has(msg.method)) this.handlers.get(msg.method)(msg.params, msg.sessionId); });
    ws.on("close", () => { for (const { reject } of this.pending.values()) reject(new Error("CDP closed")); }); }
  static async open(wsUrl) { const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 }); await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }); return new CdpSession(ws); }
  send(method, params = {}, sessionId) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })); }); }
  on(method, fn) { this.handlers.set(method, fn); }
  close() { this.ws.close(); }
}

let activeRequests = 0;
// Two lanes: the visible project tab (sends, publications) and an auxiliary tab
// for status reads. Sends themselves are serialised, because they share one tab.
const MAX_PARALLEL = 2;
// A wedged ChatGPT tab must not block the whole relay: waiting for a slot is
// bounded and fails loudly instead of hanging every later request.
async function slot(timeoutMs = 90000) {
  const started = Date.now();
  while (activeRequests >= MAX_PARALLEL) {
    if (Date.now() - started > timeoutMs) throw new Error("relay is busy: a ChatGPT tab is still working, try again shortly");
    await sleep(500);
  }
  activeRequests++;
}
function releaseSlot() { activeRequests = Math.max(0, activeRequests - 1); }

const SITE_URL = "https://graceplanner.vercel.app/";

async function openTab(url, reuseTargetId = null) {
  const v = await cdpVersion();
  const browser = await CdpSession.open(v.webSocketDebuggerUrl);
  const pinned = !!reuseTargetId;
  const targetId = reuseTargetId || (await browser.send("Target.createTarget", { url, background: true })).targetId;
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const session = {
    pinned,
    send: (method, params = {}) => browser.send(method, params, sessionId),
    on: (method, fn) => browser.on(method, (params, sid) => { if (sid === sessionId) fn(params); }),
    close: async () => {
      if (!pinned) { try { await browser.send("Target.closeTarget", { targetId }); } catch {} }
      try { browser.close(); } catch {}
    },
  };
  await session.send("Runtime.enable").catch(() => {});
  return { session, targetId };
}

// The window watched over VNC keeps one ChatGPT project tab: work happens in
// that tab instead of throwing new windows on screen.
async function openProjectTab() {
  const base = "https://chatgpt.com/g/" + PROJECT_KEY + "/";
  const existing = (await cdpList()).find((t) => t.type === "page" && (t.url || "").startsWith(base));
  if (existing) {
    const { session } = await openTab(existing.url, existing.id);
    await session.send("Page.bringToFront").catch(() => {});
    return { session, targetId: existing.id, reused: true };
  }
  return openTab(PROJECT_URL);
}

// Desktop layout of the VNC window: Grace Planner in front, the project beside it.
async function ensureDesktopTabs() {
  const v = await cdpVersion();
  const browser = await CdpSession.open(v.webSocketDebuggerUrl);
  try {
    const pages = (await cdpList()).filter((t) => t.type === "page");
    const hasProject = pages.some((t) => (t.url || "").startsWith("https://chatgpt.com/g/" + PROJECT_KEY));
    let siteId = pages.find((t) => (t.url || "").startsWith("https://graceplanner.vercel.app"))?.id;
    if (!hasProject) await browser.send("Target.createTarget", { url: PROJECT_URL, background: true });
    if (!siteId) siteId = (await browser.send("Target.createTarget", { url: SITE_URL, background: true })).targetId;
    await browser.send("Target.activateTarget", { targetId: siteId }).catch(() => {});
    dbg("desktop tabs ready");
  } finally { try { browser.close(); } catch {} }
}

async function closeTab(session) {
  try {
    const pages = (await cdpList()).filter((t) => t.type === "page");
    if (pages.length <= 1) return;
    await session.close();
  } catch {}
}

// Failed operations can leave ChatGPT tabs behind; a pile of them slows the
// whole browser down, so surplus tabs are closed before heavy work.
async function sweepTabs(keep = 2) {
  try {
    const list = await cdpList();
    const pages = list.filter((t) => t.type === "page" && /chatgpt\.com/.test(t.url || ""));
    for (const tab of pages.slice(keep)) {
      await fetch(`http://${CDP_HOST}/json/close/${tab.id}`).catch(() => {});
    }
  } catch {}
}

async function evaluate(session, expression, awaitPromise = true) {
  const r = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) { try { fs.writeFileSync("/tmp/evalfail.js", String(expression)); } catch {} dbg("EVAL FAIL: " + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200)); throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); }
  return r.result?.value;
}

async function navigate(session, url) {
  await session.send("Page.enable").catch(() => {});
  const loaded = new Promise((res) => session.on("Page.loadEventFired", res));
  await session.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(30000)]);
}

async function waitComposer(session, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(session, `!!(document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]')) && !/just a moment/i.test(document.title)`);
    if (ok) return true;
    await sleep(3000);
  }
  throw new Error("ChatGPT composer did not appear (Cloudflare or login issue)");
}

async function saveUploads(files) {
  const paths = [];
  for (const f of files || []) {
    const safe = String(f.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
    const p = `${UPLOAD_DIR}/${crypto.randomUUID().slice(0, 8)}_${safe}`;
    fs.writeFileSync(p, Buffer.from(String(f.data).split(",").pop(), "base64"));
    if (/\.zip$/i.test(p)) {
      const dir = `${UPLOAD_DIR}/${crypto.randomUUID().slice(0, 8)}_zip`;
      fs.mkdirSync(dir, { recursive: true });
      try {
        execFileSync("python3", ["-m", "zipfile", "-e", p, dir], { timeout: 30000 });
        const inner = [];
        const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const fp = `${d}/${e.name}`; if (e.isDirectory()) walk(fp); else if (!/__MACOSX/i.test(fp) && /\.(png|jpe?g|webp|pdf|txt)$/i.test(fp)) inner.push(fp); } };
        walk(dir);
        inner.sort().slice(0, 10).forEach((fp) => paths.push(fp));
        dbg("zip unpacked " + inner.length + " files from " + safe);
      } catch (e) { dbg("zip unpack failed: " + e.message); paths.push(p); }
    } else {
      paths.push(p);
    }
  }
  return paths;
}

// Attach files through the real GTK file dialog: the page opens it, xdotool
// types the path. Synthetic drop/paste and file-input injection are ignored by
// the current ChatGPT composer.
const XENV = { ...process.env, DISPLAY: ":1", XAUTHORITY: "/home/ubuntu/.Xauthority" };
function xd(args) {
  try { execFileSync("xdotool", args, { env: XENV, timeout: 8000 }); return true; }
  catch (e) { dbg("xdotool failed: " + e.message); return false; }
}

async function openAttachDialog(session) {
  const clicked = await evaluate(session, `(() => {
    const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
    if (el) el.focus();
    const form = document.querySelector('form') || document;
    const b = form.querySelector('button[aria-label="Add files and more"]');
    if (!b) return "no-btn";
    b.click();
    return "ok";
  })()`).catch(() => "err");
  if (clicked !== "ok") return clicked;
  let plusClicks = 1;
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0 && plusClicks < 4) {
      await evaluate(session, `(() => { const b = (document.querySelector('form') || document).querySelector('button[aria-label="Add files and more"]'); if (b) { b.click(); return true; } return false; })()`).catch(() => false);
      plusClicks += 1;
    }
    await sleep(600);
    const item = await evaluate(session, `(() => {
      const it = [...document.querySelectorAll('button, [role="menuitem"], [role="option"]')]
        .find((n) => /add photos\s*(&|and)\s*files/i.test((n.innerText || '') + ' ' + (n.getAttribute('aria-label') || '')));
      if (!it) return "no-item";
      it.click();
      return "ok";
    })()`).catch(() => "err");
    if (item === "ok") return "ok";
  }
  return "no-item";
}

// Attach images the way a user does: put the file on the X11 clipboard and
// press Ctrl+V through a real browser key event. Synthetic paste/drop events
// and file-input injection are ignored by the ChatGPT composer.
function xclipImage(path) {
  const type = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
  try {
    // xclip forks and keeps the pipes open, so run it detached through a shell.
    execSync(`xclip -selection clipboard -t ${type} -i ${JSON.stringify(path)} </dev/null >/dev/null 2>&1 &`, { env: XENV, timeout: 8000, shell: "/bin/bash" });
    return true;
  } catch (e) { dbg("xclip failed: " + e.message); return false; }
}

async function uploadFiles(session, paths) {
  if (!paths.length) return true;
  await session.send("Network.enable").catch(() => {});
  let filePolls = 0;
  session.on("Network.responseReceived", (params) => {
    try {
      const url = params?.response?.url || "";
      if (/backend-api\/files/.test(url)) {
        dbg("file net " + params?.response?.status + " " + url.slice(0, 90));
        if (/backend-api\/files\/[^/?]+$/.test(url) && params?.response?.status === 200) filePolls += 1;
      }
    } catch {}
  });
  const thumbCount = () => evaluate(session, `document.querySelectorAll('img[src^="blob:"]').length + document.querySelectorAll('img[src^="data:"]').length`);
  for (let pi = 0; pi < paths.length; pi++) {
    const p = paths[pi];
    if (pi > 0) {
      // A paste replaces the previous attachment if it fires while ChatGPT is
      // still processing, so wait until the chip count actually grew.
      let grew = false;
      for (let w = 0; w < 25; w++) {
        await sleep(1000);
        const n = await thumbCount().catch(() => 0);
        if (n >= pi) { grew = true; break; }
      }
      dbg("chips " + (grew ? "grew" : "timeout") + " before " + String(p).split("/").pop());
    }
    const name = String(p).split("/").pop();
    if (!/\.(png|jpe?g|webp)$/i.test(p)) { dbg("skip non-image " + name); continue; }
    if (!xclipImage(p)) return false;
    await withTimeout(session.send("Page.bringToFront"), 3000).catch(() => {});
    await evaluate(session, `(() => {
      const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return document.activeElement === el || el.contains(document.activeElement);
    })()`).catch(() => false);
    await sleep(400);
    for (const type of ["rawKeyDown", "keyUp"]) {
      await withTimeout(session.send("Input.dispatchKeyEvent", { type, modifiers: 2, key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 }), 5000);
    }
    let ok = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const seen = await evaluate(session, `(() => {
        const text = document.body.innerText || '';
        const thumbs = document.querySelectorAll('img[src^="blob:"]').length + document.querySelectorAll('img[src^="data:"]').length;
        return { byName: text.includes(${JSON.stringify(name.slice(0, 16))}), thumbs };
      })()`).catch(() => ({ byName: false, thumbs: 0 }));
      if (seen.thumbs > 0 || seen.byName) { ok = true; dbg("pasted " + name + " (" + JSON.stringify(seen) + ")"); break; }
    }
    if (!ok) { dbg("paste failed for " + name); return false; }
    const pollsBefore = filePolls;
    let uploaded = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (filePolls > pollsBefore) { uploaded = true; dbg("upload completed for " + name); break; }
    }
    if (!uploaded) dbg("no upload poll for " + name);
    await sleep(800);
  }
  return true;
}

async function waitIdle(session, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    const idle = await evaluate(session, `(() => ({
      stop: !!document.querySelector('[data-testid="stop-button"]'),
      composer: !!(document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]')),
      len: ((document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]'))?.innerText || "").trim().length,
    }))()`).catch(() => null);
    if (idle && !idle.stop && idle.composer && !idle.len) return true;
  }
  throw new Error("chat did not become idle");
}

// The composer replaces a pasted image with the next one, so multiple files go
// out as separate messages; the real task text rides on the last one.
async function sendWithFiles(session, paths, text) {
  if (!paths.length) { await typeAndSend(session, text); return; }
  const N = paths.length;
  for (let i = 0; i < N - 1; i++) {
    if (!(await uploadFiles(session, [paths[i]]))) throw new Error("file not attached: " + paths[i].split("/").pop());
    await typeAndSend(session, `Изображение ${i + 1} из ${N}.`);
    dbg("part " + (i + 1) + "/" + N + " sent");
    await waitIdle(session, 180000);
  }
  if (!(await uploadFiles(session, [paths[N - 1]]))) throw new Error("file not attached: " + paths[N - 1].split("/").pop());
  await typeAndSend(session, text);
  dbg("final sent");
}

// Publishing a whole site-side transcript: one huge insert is slow and flaky,
// so the text is split on paragraph boundaries and sent as consecutive parts.
function splitForComposer(text, limit = 6000) {
  const parts = [];
  let current = "";
  for (const block of String(text).split(/\n{2,}/)) {
    const piece = block.length > limit ? block.slice(0, limit) : block;
    if (!piece) continue;
    if (current && (current + "\n\n" + piece).length > limit) { parts.push(current); current = piece; }
    else current = current ? current + "\n\n" + piece : piece;
  }
  if (current) parts.push(current);
  return parts;
}
async function sendTranscript(session, text) {
  const parts = splitForComposer(text);
  if (!parts.length) throw new Error("Пустой текст для публикации");
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `Часть ${i + 1}/${parts.length}\n\n` : "";
    await typeAndSend(session, prefix + parts[i]);
    await waitIdle(session, 240000).catch(() => {});
    dbg("transcript part " + (i + 1) + "/" + parts.length + " sent");
  }
}

async function typeAndSend(session, text) {
  const msg = text || "Please review the attached files.";
  // Focus the composer in-page: coordinate clicks miss when the tab viewport is
  // small and the composer sits outside the visible area.
  const focused = await evaluate(session, `(() => {
    const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
    return document.activeElement === el || el.contains(document.activeElement);
  })()`);
  if (!focused) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(600);
      focused = await evaluate(session, `(() => {
        const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
        if (!el) return false;
        el.focus();
        return document.activeElement === el || el.contains(document.activeElement);
      })()`).catch(() => false);
      if (focused) break;
    }
  }
  if (!focused) throw new Error("composer not focused");
  dbg("composer focused");
  await sleep(300);
  await evaluate(session, `(() => { const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]'); if (!el) return false; el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return true; })()`).catch(() => false);
  const ins = await evaluate(session, `(() => {
    const el = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
    if (!el) return 'no-el';
    el.focus();
    const ok = document.execCommand('insertText', false, ${JSON.stringify(msg)});
    return ok ? 'ok' : 'execCommand-false';
  })()`).catch((e) => "err:" + e.message);
  dbg("insert=" + ins + " len=" + await evaluate(session, `((document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]'))?.innerText || "").length`));
  await sleep(500);
  // Send: only the composer's "Send" button actually submits in the current UI.
  const composerLen = () => evaluate(session, `((document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]'))?.innerText || "").trim().length`);
  const clickSend = () => evaluate(session, `(() => {
    const b = document.querySelector('button[aria-label="Send"]')
      || document.querySelector('[data-testid="send-button"]')
      || [...document.querySelectorAll('button')].find(x => /^send/i.test(x.getAttribute('aria-label') || ''));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`).catch(() => false);
  dbg("composer len before send " + (await composerLen()));
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickSend();
    await sleep(1500);
    if (!(await composerLen())) break;
    for (const [type, code] of [["rawKeyDown", 13], ["keyUp", 13]]) {
      await session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, unmodifiedText: type === "rawKeyDown" ? "\r" : undefined });
    }
    await sleep(1500);
    if (!(await composerLen())) break;
  }
  dbg("composer len after send " + (await composerLen()));
  if (await composerLen()) throw new Error("message was not sent (composer still has text)");
  await sleep(500);
}

// Read the conversation through ChatGPT's own backend API.
const readConversation = async (session, gptId) => {
  if (!gptId) return [];
  const r = await evaluate(session, `(async () => {
    const cid = ${JSON.stringify(gptId)};
    const s = await (await fetch('/api/auth/session')).json();
    if (!s.accessToken) return { error: 'no accessToken' };
    const res = await fetch('/backend-api/conversation/' + cid, { headers: { authorization: 'Bearer ' + s.accessToken } });
    if (!res.ok) return { error: 'http ' + res.status };
    const j = await res.json();
    const nodes = Object.values(j.mapping || {}).map(n => n.message).filter(Boolean);
    nodes.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    const out = [];
    for (const m of nodes) {
      const role = m.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = (m.content?.parts || []).filter(p => typeof p === 'string').join(String.fromCharCode(10)).trim();
      if (!text) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === role && prev.content === text) continue;
      out.push({ role, content: text });
    }
    return { messages: out };
  })()`);
  if (!r || r.error) throw new Error("conversation read failed: " + (r?.error || "empty"));
  return r.messages || [];
};

async function waitReply(session, gptId, timeoutMs = 240000, minMessages = 0) {
  const deadline = Date.now() + timeoutMs;
  let last = "", stable = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    let messages;
    try { messages = await readConversation(session, gptId); } catch { continue; }
    // Only a trailing assistant message counts: with multi-file sends the
    // conversation already holds replies to the earlier image parts.
    if (messages.length < minMessages) continue;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") { stable = 0; last = ""; continue; }
    const text = lastMsg.content;
    const stopping = await evaluate(session, `!!document.querySelector('[data-testid="stop-button"]')`).catch(() => false);
    if (!stopping && text && text === last) { stable += 1; if (stable >= 2) return { reply: text, messages }; }
    else { stable = 0; last = text; }
  }
  throw new Error("timeout waiting for ChatGPT reply");
}

// Backend reads hit rate limits (429) now and then; the rendered page is the
// fallback source for the very same reply.
const lastAssistantText = `(() => {
  const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const last = nodes[nodes.length - 1];
  return last ? (last.innerText || '').trim() : '';
})()`;
async function waitReplyDom(session, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = "", stable = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    const text = await evaluate(session, lastAssistantText).catch(() => "");
    const stopping = await evaluate(session, `!!document.querySelector('[data-testid="stop-button"]')`).catch(() => false);
    if (!stopping && text && text === last) { stable += 1; if (stable >= 2) return text; }
    else { stable = 0; last = text; }
  }
  throw new Error("timeout waiting for ChatGPT reply (page)");
}

const chatIdExpr = `(() => { const m = location.href.match(/\\/c\\/([0-9a-f-]{20,60})/i); return m ? m[1] : null; })()`;

// ---------- operations ----------
async function opNewChat(body) {
  await slot();
  let session = null;
  try {
    ({ session } = await openProjectTab());
    dbg("project tab ready");
    await waitComposer(session, 90000);
    dbg("composer ready");
    // The project root composer starts a brand-new conversation when a message
    // is sent, and its "+" attachment menu actually opens here. The dedicated
    // "New chat" page did not open that menu, which broke attachments.
    const paths = await saveUploads(body.files);
    dbg("uploads " + paths.length);
    await sendWithFiles(session, paths, body.text || body.title || "Start Grace Planner chat");
    dbg("sent");
    let gptId = null;
    for (let i = 0; i < 60; i++) { gptId = await evaluate(session, chatIdExpr); if (gptId) break; await sleep(1000); }
    if (!gptId) throw new Error("conversation id not resolved");
    // Return as soon as the conversation exists. The reply arrives through the
    // site's regular state sync, so a slow or rate-limited read never holds the
    // request open past the platform limit.
    const messages = [{ role: "user", content: body.text || body.title || "" }];
    const chat = { siteChatId: body.siteChatId || null, gptId, url: projectUrl(gptId), title: body.title || "New chat", messages, updatedAt: Date.now() };
    state.chats = state.chats.filter((c) => c.gptId !== gptId);
    state.chats.push(chat); save();
    return { ok: true, gptId, url: chat.url, reply: "", messages, pending: true };
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

// Publishes a site-side chat into the ChatGPT project with its real content,
// so what the user sees on the site exists in the project as well.
async function opPublish(body) {
  await sweepTabs();
  const text = String(body.transcript || "").trim();
  if (!text) throw new Error("transcript required");
  if (text.length > 200000) throw new Error("transcript too long");
  await slot();
  let session = null;
  try {
    ({ session } = await openProjectTab());
    await waitComposer(session, 90000);
    await sendTranscript(session, text);
    let gptId = null;
    for (let i = 0; i < 60; i++) { gptId = await evaluate(session, chatIdExpr); if (gptId) break; await sleep(1000); }
    if (!gptId) throw new Error("conversation id not resolved");
    // Same contract as new/send: the conversation exists now, its answer is
    // picked up by the status poll instead of holding this request open.
    const messages = [{ role: "user", content: text }];
    const chat = { siteChatId: body.siteChatId || null, gptId, url: projectUrl(gptId), title: String(body.title || "Grace Planner chat").slice(0, 120), messages, updatedAt: Date.now() };
    state.chats = state.chats.filter((c) => c.gptId !== gptId && !(body.siteChatId && c.siteChatId === body.siteChatId));
    state.chats.push(chat); save();
    healthCache = { at: 0, value: null };
    return { ok: true, gptId, url: chat.url, messages };
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

// What the site shows to the user: which ChatGPT account the relay drives,
// which project it writes to, and whether the two chat lists agree.
let healthCache = { at: 0, value: null };
async function opHealth() {
  pruneEmptyChats();
  await sweepTabs();
  if (healthCache.value && Date.now() - healthCache.at < 60000) return healthCache.value;
  await slot();
  let session = null;
  try {
    ({ session } = await openTab(PROJECT_URL));
    await waitComposer(session, 60000);
    // The project list renders lazily: wait for project-scoped rows (or an empty
    // state), then scroll, otherwise a half-rendered page reports no chats.
    const projectPrefix = "/g/" + GIZMO_ID + "/c/";
    for (let i = 0; i < 30; i++) {
      const ready = await evaluate(session, `(() => {
        const mine = [...document.querySelectorAll('a[href*="/c/"]')]
          .filter((a) => (a.getAttribute('href') || '').includes(${JSON.stringify(projectPrefix)})).length;
        const text = document.querySelector('main')?.innerText || '';
        return mine > 0 || /no chats|нет чатов|поки нема|start a chat|create a chat/i.test(text);
      })()`).catch(() => false);
      if (ready) break;
      await sleep(1000);
    }
    await sleep(1500);
    const info = await evaluate(session, `(async () => {
      let account = null, plan = null;
      try { const s = await (await fetch('/api/auth/session')).json(); account = s?.user?.email || null; plan = s?.account?.planType || null; } catch (e) {}
      const rows = new Map();
      const scrollers = [...document.querySelectorAll('main, main *')]
        .filter((n) => n.scrollHeight > n.clientHeight + 40 && n.clientHeight > 200).slice(0, 4);
      const inProject = ${JSON.stringify("/g/" + GIZMO_ID + "/c/")};
      for (let round = 0; round < 6; round++) {
        for (const a of document.querySelectorAll('a[href*="/c/"]')) {
          const href = a.getAttribute('href') || '';
          if (!href.includes(inProject)) continue;
          const m = href.match(/\\/c\\/([0-9a-f-]{20,60})/i);
          if (!m || rows.has(m[1])) continue;
          rows.set(m[1], (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120));
        }
        for (const s of scrollers) s.scrollTop = s.scrollHeight;
        await new Promise((r) => setTimeout(r, 700));
      }
      return { account, plan, chats: [...rows.entries()].map(([gptId, title]) => ({ gptId, title })), url: location.href };
    })()`);
    const projectChats = info?.chats || [];
    // Replies are fetched here as well: the site polls this status regularly,
    // so a chat whose last turn is the user's gets its answer without waiting
    // for a full sync.
    const awaiting = state.chats
      .filter((c) => {
        const messages = c.messages || [];
        return !messages.length || messages[messages.length - 1].role === "user";
      })
      .slice(0, 4);
    for (const chat of awaiting) {
      try {
        const messages = await readConversation(session, chat.gptId);
        if (messages.length > (chat.messages || []).length) { chat.messages = messages; chat.updatedAt = Date.now(); save(); }
      } catch {}
    }
    const ids = new Set(projectChats.map((c) => c.gptId));
    const published = state.chats.filter((c) => c.gptId);
    const value = {
      ok: true,
      online: true,
      account: info?.account || null,
      plan: info?.plan || null,
      projectId: GIZMO_ID,
      projectUrl: PROJECT_URL,
      projectChats,
      siteChats: state.chats.length,
      siteChatsLinked: published.length,
      missingOnProject: published.filter((c) => !ids.has(c.gptId)).map((c) => ({ gptId: c.gptId, title: c.title })),
      chats: state.chats,
      checkedAt: Date.now(),
    };
    healthCache = { at: Date.now(), value };
    return value;
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

async function opSend(body) {
  if (!body.gptId) throw new Error("gptId required");
  await slot();
  let session = null;
  try {
    ({ session } = await openTab(projectUrl(body.gptId)));
    await waitComposer(session, 60000);
    const paths = await saveUploads(body.files);
    await sendWithFiles(session, paths, body.text);
    // Same as a new chat: the reply comes from the state sync, not from this
    // request, so sending stays fast and survives rate limits.
    const chat = state.chats.find((c) => c.gptId === body.gptId);
    if (chat) {
      chat.messages = [...(chat.messages || []), { role: "user", content: body.text }];
      chat.updatedAt = Date.now();
      save();
    }
    return { ok: true, gptId: body.gptId, reply: "", messages: chat?.messages || [], pending: true };
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

// Sync the whole Grace Planner project: every conversation that exists on the
// ChatGPT side (even one created by hand) shows up on the site, and chats that
// lost their reply on the site side get their messages back from the server.
// Sync the Grace Planner project: the project page (what the user actually
// sees on chatgpt.com) is the source of truth for the chat list.
let lastSyncAt = 0;
let syncPromise = null;
async function opSync(body) {
  pruneEmptyChats();
  if (syncPromise) return syncPromise;
  if (Date.now() - lastSyncAt < 60000 && !body.force) return { ok: true, chats: state.chats, cached: true };
  const run = (async () => {
    await slot();
    let session = null;
    try {
      ({ session } = await openTab(PROJECT_URL));
      await waitComposer(session, 60000);
      const list = await evaluate(session, `(async () => {
        const scope = document.querySelector('main') || document.body;
        const seen = new Map();
        for (let round = 0; round < 15; round++) {
          for (const a of scope.querySelectorAll('a[href*="/c/"]')) {
            if (a.closest('nav, aside')) continue;
            const m = (a.getAttribute('href') || '').match(/\\/c\\/([0-9a-f-]{20,60})/i);
            if (!m) continue;
            const title = (a.innerText || '').trim().split(String.fromCharCode(10))[0].slice(0, 120);
            if (!seen.has(m[1])) seen.set(m[1], title);
          }
          const more = [...scope.querySelectorAll('button, a')].find((b) => /show more|показать ещё|показати більше/i.test(b.innerText || ''));
          if (!more) break;
          more.click();
          await new Promise((r) => setTimeout(r, 1200));
        }
        return { items: [...seen.entries()].map(([gptId, title]) => ({ gptId, title })) };
      })()`);
      if (!list || list.error || !Array.isArray(list.items)) {
        lastSyncAt = Date.now();
        return { ok: true, chats: state.chats, cached: true, rateLimited: true };
      }
      // The ChatGPT project list is the source of truth: conversations hidden
      // or deleted there disappear from the relay state too.
      const byId = new Map(state.chats.map((c) => [c.gptId, c]));
      const fresh = [];
      const rebuilt = [];
      for (const it of list.items) {
        const known = byId.get(it.gptId);
        let chat;
        if (known) {
          if (!known.title || known.title === "New chat") known.title = it.title || known.title;
          known.updatedAt = (it.updateTime || 0) * 1000 || known.updatedAt;
          chat = known;
        } else {
          chat = { siteChatId: body.siteChatId || null, gptId: it.gptId, url: projectUrl(it.gptId), title: it.title || "Grace Planner chat", messages: [], updatedAt: Date.now() };
        }
        rebuilt.push(chat);
        fresh.push(chat);
      }
      // Conversations created seconds ago are not in the page list yet, so keep
      // recent state entries that the DOM list has not picked up.
      const domIds = new Set(rebuilt.map((c) => c.gptId));
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const old of state.chats) {
        if (!domIds.has(old.gptId) && (old.updatedAt || 0) > cutoff) rebuilt.push(old);
      }
      state.chats = rebuilt;
      if (body.gptId) {
        const chat = byId.get(body.gptId);
        if (chat) { try { chat.messages = await readConversation(session, body.gptId); chat.updatedAt = Date.now(); } catch {} }
      }
      let fetched = 0;
      const pending = fresh.filter((c) => !(c.messages || []).length).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const chat of pending) {
        if (fetched >= 3) break;
        try { chat.messages = await readConversation(session, chat.gptId); fetched += 1; } catch {}
      }
      lastSyncAt = Date.now();
      save();
      return { ok: true, chats: state.chats, authoritative: true };
    } finally { if (session) await closeTab(session); releaseSlot(); }
  })();
  syncPromise = run.finally(() => { syncPromise = null; });
  return syncPromise;
}

async function opDelete(body) {
  const ids = [].concat(body.gptId || []);
  if (!ids.length) throw new Error("gptId required");
  await slot();
  let session = null;
  try {
    ({ session } = await openTab(PROJECT_URL));
    await waitComposer(session, 60000);
    for (const gptId of ids) {
      await evaluate(session, `(async () => {
        const s = await (await fetch('/api/auth/session')).json();
        const r = await fetch('/backend-api/conversation/' + ${JSON.stringify(gptId)}, { method: 'PATCH', headers: { authorization: 'Bearer ' + s.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ is_visible: false }) });
        return r.status;
      })()`).catch(() => "err");
    }
    state.chats = state.chats.filter((c) => !ids.includes(c.gptId));
    save();
    return { ok: true, removed: ids.length };
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

// Write site-side titles into the ChatGPT conversations so both sides show
// the same names (the site list is the source of truth for titles).
async function opRename(body) {
  const items = (body.items || []).filter((it) => it && it.gptId && it.title);
  if (!items.length) return { ok: true, renamed: 0 };
  await slot();
  let session = null;
  try {
    ({ session } = await openTab(PROJECT_URL));
    await waitComposer(session, 60000);
    const results = [];
    for (const it of items) {
      const status = await evaluate(session, `(async () => {
        const s = await (await fetch('/api/auth/session')).json();
        const r = await fetch('/backend-api/conversation/' + ${JSON.stringify(it.gptId)}, { method: 'PATCH', headers: { authorization: 'Bearer ' + s.accessToken, 'content-type': 'application/json' }, body: JSON.stringify({ title: ${JSON.stringify(it.title)} }) });
        return r.status;
      })()`).catch(() => "err");
      results.push({ gptId: it.gptId, status });
      const chat = state.chats.find((c) => c.gptId === it.gptId);
      if (chat && String(status) === "200") chat.title = it.title;
    }
    save();
    return { ok: true, renamed: results.filter((r) => String(r.status) === "200").length, results };
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

// Hard reset of the relay-side chat list (used when the project is emptied).
function opReset() {
  state.chats = [];
  save();
  lastSyncAt = Date.now();
  return { ok: true, chats: [], authoritative: true };
}

// Removes entries from the relay list only. The ChatGPT conversations stay
// untouched; used to purge placeholder twins left by older builds.
function opDrop(body) {
  const ids = [].concat(body.gptIds || body.gptId || []).filter(Boolean);
  if (!ids.length) throw new Error("gptIds required");
  const before = state.chats.length;
  state.chats = state.chats.filter((c) => !ids.includes(c.gptId));
  save();
  healthCache = { at: 0, value: null };
  return { ok: true, dropped: before - state.chats.length, chats: state.chats };
}

function opList() { return { ok: true, chats: state.chats }; }

// Conversations that never received a message (a crashed send) are noise in
// both lists; they are pruned once they are clearly not in flight.
function pruneEmptyChats() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  const before = state.chats.length;
  state.chats = state.chats.filter((c) => (c.messages || []).length || (c.updatedAt || 0) > cutoff);
  if (state.chats.length !== before) save();
}

// ---------- http relay ----------
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on("data", (c) => { size += c.length; if (size > 60 * 1024 * 1024) { reject(new Error("payload too large")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});


const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "*" }); return res.end(); }
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, chats: state.chats.length });
    if (req.method === "GET" && url.pathname === "/state") return json(res, 200, state);
    if (req.method === "GET" && url.pathname === "/project") return json(res, 200, await opHealth());
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (req.method === "POST" && url.pathname === "/chat/new") return json(res, 200, await opNewChat(body));
    if (req.method === "POST" && url.pathname === "/chat/send") return json(res, 200, await opSend(body));
    if (req.method === "POST" && url.pathname === "/chat/publish") return json(res, 200, await opPublish(body));
    if (req.method === "POST" && url.pathname === "/chat/sync") return json(res, 200, await opSync(body));
    if (req.method === "POST" && url.pathname === "/chat/delete") return json(res, 200, await opDelete(body));
    if (req.method === "POST" && url.pathname === "/chat/rename") return json(res, 200, await opRename(body));
    if (req.method === "POST" && url.pathname === "/chat/reset") return json(res, 200, opReset());
    if (req.method === "POST" && url.pathname === "/chat/drop") return json(res, 200, opDrop(body));
    if (req.method === "POST" && url.pathname === "/chat/list") return json(res, 200, opList());
    return json(res, 404, { error: "unknown endpoint" });
  } catch (error) {
    console.error(new Date().toISOString(), error);
    return json(res, 500, { error: String(error.message || error) });
  }
});
server.listen(PORT, () => console.log("grace-bridge relay (raw CDP) on", PORT));
sweepTabs(1).catch(() => {});
ensureDesktopTabs().catch(() => {});

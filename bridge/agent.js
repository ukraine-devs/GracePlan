// Grace Bridge relay — raw CDP over WebSocket, no playwright.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import WebSocket from "ws";
import { execFileSync, execSync } from "node:child_process";

const CDP_HOST = "localhost:9222";
const PROJECT_URL = "https://chatgpt.com/g/g-p-6ade243a41e48191b297ec2ac5c7e822-grace-planner/project";
const GIZMO_ID = "g-p-6ade243a41e48191b297ec2ac5c7e822-grace-planner";
const PORT = 8899;
const STATE_FILE = "/opt/grace-bridge/state.json";
const UPLOAD_DIR = "/opt/grace-bridge/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let state = { chats: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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
const MAX_PARALLEL = 3;
const waiters = [];
async function slot() { if (activeRequests >= MAX_PARALLEL) await new Promise((r) => waiters.push(r)); activeRequests++; }
function releaseSlot() { activeRequests--; const next = waiters.shift(); if (next) next(); }

async function openTab(url) {
  const v = await cdpVersion();
  const browser = await CdpSession.open(v.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url, background: true });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.send("Target.activateTarget", { targetId }).catch(() => {});
  const session = {
    send: (method, params = {}) => browser.send(method, params, sessionId),
    on: (method, fn) => browser.on(method, (params, sid) => { if (sid === sessionId) fn(params); }),
    close: async () => {
      try { await browser.send("Target.closeTarget", { targetId }); } catch {}
      try { browser.close(); } catch {}
    },
  };
  await session.send("Runtime.enable").catch(() => {});
  return { session, targetId };
}

async function closeTab(session) {
  try {
    const pages = (await cdpList()).filter((t) => t.type === "page");
    if (pages.length <= 1) return;
    await session.close();
  } catch {}
}

async function evaluate(session, expression, awaitPromise = true) {
  const r = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
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
  for (const p of paths) {
    const name = String(p).split("/").pop();
    if (!/\.(png|jpe?g|webp)$/i.test(p)) { dbg("skip non-image " + name); continue; }
    if (!xclipImage(p)) return false;
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
    await sleep(1200);
  }
  return true;
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
  const ok1 = await clickSend();
  dbg("clickSend=" + ok1);
  await sleep(1500);
  dbg("composer len after send " + (await composerLen()));
  if (await composerLen()) {
    for (const [type, code] of [["rawKeyDown", 13], ["keyUp", 13]]) {
      await session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, unmodifiedText: type === "rawKeyDown" ? "\r" : undefined });
    }
    await sleep(1500);
  }
  if (await composerLen()) {
    await clickSend();
    await sleep(1500);
  }
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

async function waitReply(session, gptId, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let last = "", stable = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    let messages;
    try { messages = await readConversation(session, gptId); } catch { continue; }
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const text = lastAssistant?.content || "";
    const stopping = await evaluate(session, `!!document.querySelector('[data-testid="stop-button"]')`).catch(() => false);
    if (!stopping && text && text === last) { stable += 1; if (stable >= 2) return { reply: text, messages }; }
    else { stable = 0; last = text; }
  }
  throw new Error("timeout waiting for ChatGPT reply");
}

const chatIdExpr = `(() => { const m = location.href.match(/\\/c\\/([0-9a-f-]{20,60})/i); return m ? m[1] : null; })()`;

// ---------- operations ----------
async function opNewChat(body) {
  await slot();
  let session = null;
  try {
    ({ session } = await openTab(PROJECT_URL));
    dbg("tab opened");
    await waitComposer(session, 90000);
    dbg("composer ready");
    // The project root composer starts a brand-new conversation when a message
    // is sent, and its "+" attachment menu actually opens here. The dedicated
    // "New chat" page did not open that menu, which broke attachments.
    const paths = await saveUploads(body.files);
    dbg("uploads " + paths.length);
    if (paths.length && !(await uploadFiles(session, paths))) throw new Error("files were not attached to the chat");
    await typeAndSend(session, body.text || body.title || "Start Grace Planner chat");
    dbg("sent");
    let gptId = null;
    for (let i = 0; i < 60; i++) { gptId = await evaluate(session, chatIdExpr); if (gptId) break; await sleep(1000); }
    if (!gptId) throw new Error("conversation id not resolved");
    const { reply, messages } = await waitReply(session, gptId);
    const chat = { siteChatId: body.siteChatId || null, gptId, url: "https://chatgpt.com/c/" + gptId, title: body.title || "New chat", messages, updatedAt: Date.now() };
    state.chats = state.chats.filter((c) => c.gptId !== gptId);
    state.chats.push(chat); save();
    return { ok: true, gptId, url: chat.url, reply, messages };
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

async function opSend(body) {
  if (!body.gptId) throw new Error("gptId required");
  await slot();
  let session = null;
  try {
    ({ session } = await openTab("https://chatgpt.com/c/" + body.gptId));
    await waitComposer(session, 60000);
    const paths = await saveUploads(body.files);
    if (paths.length && !(await uploadFiles(session, paths))) throw new Error("files were not attached to the chat");
    await typeAndSend(session, body.text);
    const { reply, messages } = await waitReply(session, body.gptId);
    const chat = state.chats.find((c) => c.gptId === body.gptId);
    if (chat) { chat.messages = messages; chat.updatedAt = Date.now(); save(); }
    return { ok: true, gptId: body.gptId, reply, messages };
  } finally { if (session) await closeTab(session); releaseSlot(); }
}

// Sync the whole Grace Planner project: every conversation that exists on the
// ChatGPT side (even one created by hand) shows up on the site, and chats that
// lost their reply on the site side get their messages back from the server.
let lastSyncAt = 0;
let syncPromise = null;
async function opSync(body) {
  if (syncPromise) return syncPromise;
  if (Date.now() - lastSyncAt < 60000 && !body.force) return { ok: true, chats: state.chats, cached: true };
  const run = (async () => {
    await slot();
    let session = null;
    try {
      ({ session } = await openTab(PROJECT_URL));
      await waitComposer(session, 60000);
      const list = await evaluate(session, `(async () => {
        const s = await (await fetch('/api/auth/session')).json();
        if (!s.accessToken) return { error: 'no accessToken' };
        const r = await fetch('/backend-api/conversations?gizmo_id=${GIZMO_ID}&order=updated&limit=25', { headers: { authorization: 'Bearer ' + s.accessToken } });
        if (!r.ok) return { error: 'http ' + r.status };
        const j = await r.json();
        return { items: (j.items || []).map(i => ({ gptId: i.id, title: i.title, updateTime: i.update_time })) };
      })()`);
      if (!list || list.error) {
        if (list && /429/.test(list.error)) { lastSyncAt = Date.now(); return { ok: true, chats: state.chats, cached: true, rateLimited: true }; }
        throw new Error("project list failed: " + (list?.error || "empty"));
      }
      const byId = new Map(state.chats.map((c) => [c.gptId, c]));
      const fresh = [];
      for (const it of list.items || []) {
        const known = byId.get(it.gptId);
        if (known) {
          if (!known.title || known.title === "New chat") known.title = it.title || known.title;
          known.updatedAt = (it.updateTime || 0) * 1000 || known.updatedAt;
          fresh.push(known);
        } else {
          const chat = { siteChatId: body.siteChatId || null, gptId: it.gptId, url: "https://chatgpt.com/c/" + it.gptId, title: it.title || "Grace Planner chat", messages: [], updatedAt: (it.updateTime || 0) * 1000 };
          state.chats.push(chat);
          fresh.push(chat);
        }
      }
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
      return { ok: true, chats: state.chats };
    } finally { if (session) await closeTab(session); releaseSlot(); }
  })();
  syncPromise = run.finally(() => { syncPromise = null; });
  return syncPromise;
}

function opList() { return { ok: true, chats: state.chats }; }

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
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (req.method === "POST" && url.pathname === "/chat/new") return json(res, 200, await opNewChat(body));
    if (req.method === "POST" && url.pathname === "/chat/send") return json(res, 200, await opSend(body));
    if (req.method === "POST" && url.pathname === "/chat/sync") return json(res, 200, await opSync(body));
    if (req.method === "POST" && url.pathname === "/chat/list") return json(res, 200, opList());
    return json(res, 404, { error: "unknown endpoint" });
  } catch (error) {
    console.error(new Date().toISOString(), error);
    return json(res, 500, { error: String(error.message || error) });
  }
});
server.listen(PORT, () => console.log("grace-bridge relay (raw CDP) on", PORT));

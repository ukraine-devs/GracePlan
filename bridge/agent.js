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
const COMPOSER = "([...document.querySelectorAll('#prompt-textarea, div[contenteditable=\\\"true\\\"]')].filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 100).pop())";

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

async function openTab(url, background = false) {
  const v = await cdpVersion();
  const browser = await CdpSession.open(v.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url, background });
  openedTabs.add(targetId);
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

// A conversation tab is loaded once and then reused: every fresh load of
// chatgpt.com/c/<id> costs a request on an endpoint that throttles hard, so
// sending a second message must not reload the page.
const chatTabs = new Map();
async function tabForChat(gptId) {
  const hit = chatTabs.get(gptId);
  if (hit) {
    const alive = await withTimeout(evaluate(hit.session, "1+1"), 4000, null).catch(() => null);
    if (alive === 2) { hit.at = Date.now(); return { session: hit.session, targetId: hit.targetId, reused: true }; }
    chatTabs.delete(gptId);
  }
  const opened = await openTab("https://chatgpt.com/c/" + gptId);
  chatTabs.set(gptId, { session: opened.session, targetId: opened.targetId, at: Date.now() });
  return { ...opened, reused: false };
}
function dropChatTab(gptId) {
  const entry = chatTabs.get(gptId);
  if (!entry) return;
  chatTabs.delete(gptId);
  closeTab(entry.session).catch(() => {});
}
function pruneChatTabs(keepId) {
  const entries = [...chatTabs.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  let kept = 0;
  for (const [id, entry] of entries) {
    if (id === keepId || kept < 1) { kept += 1; continue; }
    chatTabs.delete(id);
    closeTab(entry.session).catch(() => {});
  }
}

// Tabs that this process opened and still owns. Anything else pointing at
// chatgpt.com is a leftover: every open ChatGPT tab polls its own API, and a
// handful of them is enough to get the whole account rate limited.
const openedTabs = new Set();
async function sweepTabs() {
  try {
    const pages = (await cdpList()).filter((t) => t.type === "page" && /^https:\/\/chatgpt\.com\//.test(t.url || ""));
    const live = new Set(pages.map((page) => page.id));
    for (const id of [...openedTabs]) if (!live.has(id)) openedTabs.delete(id);
    const keep = new Set([...(reader?.targetId ? [reader.targetId] : []), ...openedTabs]);
    let keptProject = pages.some((page) => keep.has(page.id) && /\/project\b/.test(page.url || ""));
    const toClose = [];
    for (const page of pages) {
      if (keep.has(page.id)) continue;
      if (/\/project\b/.test(page.url || "") && !keptProject) { keptProject = true; continue; }
      toClose.push(page);
    }
    for (const page of toClose) {
      try { await fetch(`http://${CDP_HOST}/json/close/${page.id}`); } catch {}
    }
    if (toClose.length) dbg("closed " + toClose.length + " leftover tab(s)");
  } catch {}
}

// A long-lived tab used only to READ conversations. Reading via the API does not
// touch the rate-limited history endpoint, so replies can be pulled in a loop.
let reader = null;
async function getReader() {
  try {
    if (reader) {
      const alive = await withTimeout(evaluate(reader.session, "1+1"), 4000, null);
      if (alive === 2) return reader;
    }
  } catch {}
  reader = await openTab(PROJECT_URL, true);
  await waitComposer(reader.session, 60000);
  dbg("reader tab ready");
  return reader;
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
    const ok = await evaluate(session, `!!(${COMPOSER}) && !/just a moment/i.test(document.title)`);
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
    const el = ${COMPOSER};
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
      const el = ${COMPOSER};
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
      composer: !!(${COMPOSER}),
      len: ((${COMPOSER})?.innerText || "").trim().length,
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

async function typeAndSend(session, text) {
  const msg = text || "Please review the attached files.";
  await withTimeout(session.send("Page.bringToFront"), 3000).catch(() => {});
  const readLen = () => evaluate(session, `((${COMPOSER})?.innerText || "").trim().length`).catch(() => 0);
  const box = await evaluate(session, `(() => {
    const el = ${COMPOSER};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(30, r.height / 2)) };
  })()`).catch(() => null);
  if (box) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await session.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }).catch(() => {});
    }
    await sleep(400);
  }
  let focused = await evaluate(session, `(() => {
    const el = ${COMPOSER};
    if (!el) return false;
    el.focus();
    return document.activeElement === el || el.contains(document.activeElement);
  })()`).catch(() => false);
  for (let attempt = 0; attempt < 3 && !focused; attempt++) {
    await sleep(2500);
    if (box) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await session.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }).catch(() => {});
      }
    }
    focused = await evaluate(session, `(() => {
      const el = ${COMPOSER};
      if (!el) return false;
      el.focus();
      return document.activeElement === el || el.contains(document.activeElement);
    })()`).catch(() => false);
  }
  if (!focused) throw new Error("composer not focused");
  // Clear whatever the previous attempt left behind: a concatenated message is
  // not the text the user wrote, and it must never be sent as if it were.
  const preLen = await readLen();
  if (preLen > 0) {
    await evaluate(session, `(() => {
      const el = ${COMPOSER};
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      return (el.innerText || '').length;
    })()`).catch(() => null);
    // The editor keeps an empty paragraph after a delete; one Backspace clears it
    // so the new message never starts with a blank line.
    for (const type of ["rawKeyDown", "keyUp"]) {
      await session.send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    }
    await sleep(120);
    if (await readLen()) {
      for (const [type, code] of [["rawKeyDown", 65], ["keyUp", 65]]) {
        await session.send("Input.dispatchKeyEvent", { type, modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      }
      for (const type of ["rawKeyDown", "keyUp"]) {
        await session.send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      }
      await sleep(150);
    }
  }
  // One insert instead of a keystroke per character: it is both faster and a
  // better copy of a real paste, which the composer accepts reliably.
  await withTimeout(session.send("Input.insertText", { text: msg }), 8000).catch(() => {});
  if ((await readLen()) === 0) {
    for (const ch of msg) {
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch }).catch(() => {});
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }).catch(() => {});
      await sleep(10);
    }
  }
  dbg("sendBtn=" + await evaluate(session, `(() => { const b = [...document.querySelectorAll('button')].find((x) => /send/i.test((x.getAttribute('aria-label')||'') + (x.getAttribute('data-testid')||'')) && x.offsetParent !== null); return b ? (b.disabled ? 'disabled' : 'enabled') : 'none'; })()`).catch(() => "err"));
  if ((await readLen()) === 0) await withTimeout(session.send("Input.insertText", { text: msg }), 8000).catch(() => {});
  if ((await readLen()) === 0) {
    await evaluate(session, `(() => {
      const el = ${COMPOSER};
      if (!el) return false;
      el.focus();
      document.execCommand('insertText', false, ${JSON.stringify(msg)});
      return true;
    })()`).catch(() => false);
  }
  dbg("insert len=" + await readLen());
  await sleep(300);
  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    await evaluate(session, `(() => {
      const el = ${COMPOSER};
      const form = el && el.closest('form');
      const scope = form || document;
      const cands = [...scope.querySelectorAll('button')].filter((b) => {
        const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
        return /send/i.test(label) && b.offsetParent !== null;
      });
      const b = cands[0];
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`).catch(() => false);
    await sleep(1500);
    if (!(await readLen())) { sent = true; break; }
    for (const [type, code] of [["rawKeyDown", 13], ["keyUp", 13]]) {
      await session.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, unmodifiedText: type === "rawKeyDown" ? "\r" : undefined });
    }
    await sleep(1500);
    if (!(await readLen())) sent = true;
  }
  if (!sent) dbg("composer still has text; verifying through the conversation instead");
  await sleep(600);
}



// The composer replaces a pasted image with the next one, so multiple files go
// out as separate messages; the real task text rides on the last one.




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

// Read the conversation straight from the rendered page: no backend endpoint,
// so it cannot be rate limited the way the history API is.
const domMessagesExpr = `(() => {
  const nodes = [...document.querySelectorAll('[data-message-author-role]')];
  const out = [];
  for (const node of nodes) {
    const role = node.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') continue;
    const body = node.querySelector('.markdown') || node;
    const text = (body.innerText || '').trim();
    if (text) out.push({ role, content: text });
  }
  return out;
})()`;

async function waitReply(session, gptId, timeoutMs = 240000, minMessages = 0) {
  const deadline = Date.now() + timeoutMs;
  let last = "", stable = 0;
  while (Date.now() < deadline) {
    await sleep(1500);
    const nodes = (await evaluate(session, domMessagesExpr).catch(() => []) || []).filter((m) => m && m.content);
    if (nodes.length < minMessages) continue;
    // Only a trailing assistant message counts: with multi-file sends the
    // conversation already holds replies to the earlier image parts.
    const lastMsg = nodes[nodes.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") { stable = 0; last = ""; continue; }
    const text = lastMsg.content;
    const stopping = await evaluate(session, `!!document.querySelector('[data-testid="stop-button"]')`).catch(() => false);
    if (!stopping && text && text === last) { stable += 1; if (stable >= 2) return { reply: text, messages: nodes }; }
    else { stable = 0; last = text; }
  }
  throw new Error("timeout waiting for ChatGPT reply");
}

const chatIdExpr = `(() => { const m = location.href.match(/\\/c\\/([0-9a-f-]{20,60})/i); return m ? m[1] : null; })()`;

// A tab needs a name a person can recognise: when the title is still the
// default one, it is taken from the first thing the user wrote.
const GENERIC_TITLES = new Set(["", "New chat", "Grace Planner chat", "Новый чат"]);
function applyDerivedTitle(chat) {
  if (!chat) return;
  const current = String(chat.title || "").trim();
  const generic = GENERIC_TITLES.has(current) || /^Grace Planner chat$/i.test(current);
  if (!generic) return;
  const first = (chat.messages || []).find((m) => m.role === "user" && String(m.content || "").trim());
  if (!first) return;
  const label = String(first.content).replace(/\s+/g, " ").trim().slice(0, 48);
  if (label) chat.title = label;
}

// ---------- operations ----------
async function opNewChat(body) {
  await slot();
  let session = null;
  let keepTab = false;
  let targetId = null;
  try {
    // Reusing the open project tab saves seconds, but only a tab that really
    // stands on the project root may host a new conversation: a conversation tab
    // would silently receive the message instead of starting a new chat.
    let opened = null;
    if (reader) {
      const href = await withTimeout(evaluate(reader.session, "location.href"), 3000, null).catch(() => null);
      const onRoot = typeof href === "string" && (/\/project$/.test(href) || /^https:\/\/chatgpt\.com\/?$/.test(href));
      if (onRoot) opened = { session: reader.session, targetId: reader.targetId, reused: true };
    }
    if (!opened) opened = await openTab(PROJECT_URL);
    session = opened.session;
    targetId = opened.targetId;
    dbg("tab opened" + (opened.reused ? " (reused)" : ""));
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
    let baseline = 0;
    try { baseline = (await evaluate(session, domMessagesExpr).catch(() => []) || []).length; } catch {}
    const chat = { siteChatId: body.siteChatId || null, gptId, url: "https://chatgpt.com/c/" + gptId, title: body.title || "New chat", messages: [{ role: "user", content: body.text || body.title || "" }], updatedAt: Date.now() };
    state.chats = state.chats.filter((c) => c.gptId !== gptId);
    state.chats.push(chat); save();
    const dom = await evaluate(session, domMessagesExpr).catch(() => []);
    if (Array.isArray(dom) && dom.length >= (chat.messages || []).length) chat.messages = dom;
    chat.updatedAt = Date.now(); applyDerivedTitle(chat); save();
    // The tab stays open for this conversation: the reply is read from it in the
    // background, and the next message goes into the same page without reloading.
    chatTabs.set(gptId, { session, targetId, at: Date.now() });
    keepTab = true;
    pruneChatTabs(gptId);
    watchForReply(gptId);
    return { ok: true, gptId, url: chat.url, pending: true, reply: "", messages: chat.messages };
  } finally { if (session && !keepTab) await closeTab(session); releaseSlot(); }
}

// Every conversation read goes through one gate. ChatGPT answers 429 to the
// conversation endpoint after a burst, and once it does no chat loads at all,
// so reads are serialised and the whole channel cools down after a refusal.
const READ_PER_CHAT_GAP = 8000;
const READ_GLOBAL_GAP = 4000;
let readGateUntil = 0;
let readGateStrikes = 0;
let lastReadStartedAt = 0;
const lastReadByChat = new Map();

// One read at a time, whatever asks for it: the site and the sweep share the
// same account, and two simultaneous reads are exactly what trips the limit.
let readQueue = Promise.resolve();
function queueRead(run) {
  const next = readQueue.then(run, run).catch((error) => { throw error; });
  readQueue = next.catch(() => {});
  return next;
}

function readGateDelay(gptId) {
  const now = Date.now();
  if (now < readGateUntil) return readGateUntil - now;
  const sinceGlobal = now - lastReadStartedAt;
  if (sinceGlobal < READ_GLOBAL_GAP) return READ_GLOBAL_GAP - sinceGlobal;
  const sinceChat = now - (lastReadByChat.get(gptId) || 0);
  if (sinceChat < READ_PER_CHAT_GAP) return READ_PER_CHAT_GAP - sinceChat;
  return 0;
}
function noteRateLimit() {
  readGateStrikes = Math.min(readGateStrikes + 1, 3);
  // Three refusals in a row mean the account is in a longer cooldown: stop
  // touching the endpoint completely so it can recover.
  const wait = readGateStrikes >= 3 ? 1800000 : Math.min(180000 * Math.pow(2, readGateStrikes - 1), 600000);
  readGateUntil = Date.now() + wait;
  dbg("conversation endpoint limited; pausing reads for " + Math.round(wait / 1000) + "s");
}
function noteReadOk() { readGateStrikes = 0; }

// Tells a missing conversation apart from a throttled one: both look the same
// in the page, and only the first may be replaced by a new chat.
async function probeConversation(gptId) {
  try {
    const reader = await getReader();
    await readConversation(reader.session, gptId);
    return { ok: true };
  } catch (error) {
    const message = String(error.message || error);
    if (/429/.test(message)) { noteRateLimit(); return { ok: false, throttled: true }; }
    return { ok: false, missing: true };
  }
}

// The rendered page is the reliable source: the backend endpoint often answers
// 429 or even "conversation has been deleted" while the open tab shows the whole
// dialogue, answers included. A chat tab that is already open is read directly.
async function readChatDom(gptId) {
  const cached = chatTabs.get(gptId);
  if (cached) {
    const dom = await evaluate(cached.session, domMessagesExpr).catch(() => []);
    if (Array.isArray(dom) && dom.length) return dom;
  }
  if (!gptId) return [];
  const { session } = await openTab("https://chatgpt.com/c/" + gptId, true);
  try {
    for (let i = 0; i < 25; i++) {
      const dom = await evaluate(session, domMessagesExpr).catch(() => []);
      if (Array.isArray(dom) && dom.length) {
        await sleep(800);
        const settled = await evaluate(session, domMessagesExpr).catch(() => dom);
        return (settled?.length || 0) >= dom.length ? settled : dom;
      }
      await sleep(600);
    }
    return [];
  } finally { await closeTab(session); }
}

async function readChat(gptId) {
  // An open tab is the fastest and gentlest source: no request to ChatGPT at all.
  if (chatTabs.has(gptId)) {
    const dom = await readChatDom(gptId);
    if (dom.length) return dom;
  }
  try {
    const reader = await getReader();
    lastReadStartedAt = Date.now();
    lastReadByChat.set(gptId, lastReadStartedAt);
    const messages = await readConversation(reader.session, gptId);
    noteReadOk();
    if (messages?.length) return messages;
  } catch (error) {
    const message = String(error.message || error);
    if (/429/.test(message)) noteRateLimit();
    dbg("api read failed (" + message.slice(0, 60) + "), reading the page");
  }
  const dom = await readChatDom(gptId);
  if (dom.length) noteReadOk();
  return dom.length ? dom : null;
}

// On-demand read for one conversation: the site asks for this when a tab opens
// and while a reply is still missing. A closed gate serves the stored copy.
const readCache = new Map();
async function opRead(body) {
  const gptId = body && body.gptId;
  if (!gptId) throw new Error("gptId required");
  const chat = state.chats.find((c) => c.gptId === gptId);
  const cached = readCache.get(gptId);
  if (cached && Date.now() - cached.at < 12000) return { ok: true, gptId, messages: cached.messages, cached: true };
  const delay = readGateDelay(gptId);
  if (delay > 0) return { ok: true, gptId, messages: chat?.messages || cached?.messages || [], waiting: delay };
  await slot();
  try {
    const messages = await queueRead(() => readChat(gptId));
    if (!messages) return { ok: true, gptId, messages: chat?.messages || [], limited: true };
    const merged = chat && (chat.messages || []).length > messages.length ? chat.messages : messages;
    if (chat && merged.length >= (chat.messages || []).length) {
      const grew = merged.length > (chat.messages || []).length;
      chat.messages = merged; chat.readTries = 0;
      if (grew) { chat.updatedAt = Date.now(); applyDerivedTitle(chat); }
      save();
    }
    readCache.set(gptId, { at: Date.now(), messages: merged });
    return { ok: true, gptId, messages: merged };
  } finally { releaseSlot(); }
}

async function waitForOwnMessage(session, text, timeoutMs = 12000) {
  const needle = String(text || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!needle) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dom = await evaluate(session, domMessagesExpr).catch(() => []);
    if (Array.isArray(dom) && dom.some((m) => m.role === "user" && String(m.content || "").replace(/\s+/g, " ").includes(needle))) return true;
    await sleep(1200);
  }
  return false;
}

// Replaces a conversation the account cannot open with a fresh one, carrying the
// dialogue across. One move per chat per ten minutes keeps a broken account from
// spawning clones, while a dead chat still recovers by itself.
const recentMoves = new Map();
async function moveToFreshChat(body, previous, reason) {
  const key = body.siteChatId || previous?.siteChatId || body.gptId;
  if (Date.now() - (recentMoves.get(key) || 0) < 10 * 60 * 1000) return null;
  recentMoves.set(key, Date.now());
  dbg("moving to a fresh chat (" + reason + "): " + body.gptId);
  const siteChatId = body.siteChatId || previous?.siteChatId || null;
  const title = body.title || previous?.title || "Grace Planner chat";
  const history = (previous?.messages || []).slice(-12);
  const carried = history.length
    ? "Продолжение диалога Grace Planner (перенесено из предыдущего чата):\n"
      + history.map((m) => (m.role === "user" ? "Пользователь: " : "Ассистент: ") + String(m.content || "").slice(0, 1500)).join("\n")
      + "\n\n" + body.text
    : body.text;
  dropChatTab(body.gptId);
  const created = await opNewChat({ siteChatId, title, text: carried, files: body.files });
  if (created?.gptId) {
    state.chats = state.chats.filter((c) => c.gptId !== body.gptId);
    const moved = state.chats.find((c) => c.gptId === created.gptId);
    if (moved) { moved.siteChatId = siteChatId; moved.title = title; moved.readTries = 0; moved.movedFrom = body.gptId; save(); }
  }
  return { ...created, siteChatId, title, recreatedFrom: body.gptId };
}

// The reply is collected in the background from the tab that already holds the
// conversation: no extra request to ChatGPT, so it shows up seconds after it is
// generated instead of after the next slow sweep.
const replyWatchers = new Map();
function watchForReply(gptId) {
  if (!gptId || replyWatchers.has(gptId)) return;
  const startedAt = Date.now();
  const timer = setInterval(async () => {
    const entry = chatTabs.get(gptId);
    const chat = state.chats.find((c) => c.gptId === gptId);
    if (!entry || !chat) { clearInterval(timer); replyWatchers.delete(gptId); return; }
    const dom = await evaluate(entry.session, domMessagesExpr).catch(() => []);
    const last = Array.isArray(dom) ? dom[dom.length - 1] : null;
    if (Array.isArray(dom) && dom.length > (chat.messages || []).length && last?.role === "assistant") {
      chat.messages = dom; chat.updatedAt = Date.now(); chat.readTries = 0;
      applyDerivedTitle(chat); save();
      dbg("reply captured for " + gptId);
      clearInterval(timer); replyWatchers.delete(gptId);
      return;
    }
    if (Date.now() - startedAt > 120000) { clearInterval(timer); replyWatchers.delete(gptId); }
  }, 1200);
  replyWatchers.set(gptId, timer);
}

async function opSend(body) {
  if (!body.gptId) throw new Error("gptId required");
  await slot();
  let session = null;
  let released = false;
  let keepTab = true;
  try {
    const opened = await tabForChat(body.gptId);
    session = opened.session;
    pruneChatTabs(body.gptId);
    const stored = state.chats.find((c) => c.gptId === body.gptId);
    const expected = (stored?.messages || []).length;
    // Check for an unloadable conversation before waiting for the composer,
    // otherwise the wait just times out with a misleading Cloudflare error.
    let broken = false;
    for (let i = 0; i < (opened.reused ? 2 : 6) && !broken; i++) {
      broken = await evaluate(session, `(document.body.innerText || '').includes('Could not load this ChatGPT conversation')`).catch(() => false);
      if (!broken) await sleep(800);
    }
    if (!broken) await waitComposer(session, 45000);
    // A conversation that cannot render cannot accept a message either, and the
    // account-wide throttling looks exactly like that. Such a chat is moved to a
    // fresh one instead of leaving the user without an answer.
    const rendered = await evaluate(session, `document.querySelectorAll('[data-message-author-role]').length`).catch(() => -1);
    const unreadable = broken || (expected > 0 && rendered === 0);
    if (unreadable) {
      keepTab = false;
      session = null;
      releaseSlot();
      released = true;
      const moved = await moveToFreshChat(body, stored, "conversation does not load");
      if (moved) return moved;
      dropChatTab(body.gptId);
      return { ok: false, gptId: body.gptId, error: "ChatGPT не открывает эту беседу; новый чат для неё уже создавался недавно." };
    }
    const paths = await saveUploads(body.files);
    await sendWithFiles(session, paths, body.text);
    // Typing into a page that never loaded leaves the text in the composer: the
    // message must be seen in the conversation itself, otherwise it is not sent.
    const delivered = await waitForOwnMessage(session, body.text, 12000);
    if (!delivered) {
      dbg("message did not land in the conversation: " + body.gptId);
      keepTab = false;
      session = null;
      releaseSlot();
      released = true;
      const moved = await moveToFreshChat(body, stored, "message did not land");
      if (moved) return moved;
      dropChatTab(body.gptId);
      return { ok: false, gptId: body.gptId, error: "Сообщение не дошло до ChatGPT. Попробуйте ещё раз через минуту." };
    }
    try {
      const now = await readConversation(session, body.gptId);
      const landed = now.some((m) => m.role === "user" && String(m.content).includes(String(body.text).slice(0, 40)));
      if (!landed) throw new Error("message did not reach ChatGPT");
    } catch (verifyError) {
      if (/did not reach/.test(verifyError.message)) throw verifyError;
    }
    const chat = state.chats.find((c) => c.gptId === body.gptId);
    if (chat) { chat.messages = [...(chat.messages || []), { role: "user", content: body.text }]; chat.updatedAt = Date.now(); chat.readTries = 0; save(); }
    watchForReply(body.gptId);
    return { ok: true, gptId: body.gptId, pending: true, reply: "", messages: chat?.messages || [] };
  } finally { if (session && !keepTab) await closeTab(session); if (!released) releaseSlot(); }
}

// Sync the whole Grace Planner project: every conversation that exists on the
// ChatGPT side (even one created by hand) shows up on the site, and chats that
// lost their reply on the site side get their messages back from the server.
// Sync the Grace Planner project: the project page (what the user actually
// sees on chatgpt.com) is the source of truth for the chat list.
let lastSyncAt = 0;
let syncPromise = null;
// ---------- project mirror ----------
// The ChatGPT project page is the ONLY source of truth for the chat list.
// Everything below reads it, and nothing else invents chats.
const projectListExpr = `(async () => {
  const main = document.querySelector('main');
  if (!main) return { ok: false, reason: 'no main element' };
  if (!/\\/project(\\/)?(\\?|$)/.test(location.pathname)) return { ok: false, reason: 'not on the project root: ' + location.pathname };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const broken = () => /Unable to load history|Could not load this ChatGPT conversation|Something went wrong/i.test(main.innerText || '');
  const collect = () => {
    const out = new Map();
    for (const a of main.querySelectorAll('a[href*="/c/"]')) {
      if (a.closest('nav, aside')) continue;
      const m = (a.getAttribute('href') || '').match(/\\/c\\/([0-9a-f-]{20,60})/i);
      if (!m) continue;
      // The row text starts with the avatar initials on their own line; the
      // real title is the first line that is longer than a pair of letters.
      const lines = (a.innerText || '').split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
      const title = (lines.find((s) => s.length > 3) || lines[0] || '').slice(0, 120);
      if (!out.has(m[1])) out.set(m[1], title);
    }
    return out;
  };
  // Wait for either real rows or the project's own empty state. The empty state
  // has to be seen twice, several seconds apart, or a slow render would look
  // like an empty project and wipe the site list.
  let emptyRounds = 0;
  for (let round = 0; round < 40; round++) {
    if (broken()) return { ok: false, reason: 'project list failed to load' };
    if (collect().size) break;
    if (/No chats yet|Пока нет чатов|Ще немає чатів/i.test(main.innerText || '')) emptyRounds += 1;
    if (emptyRounds >= 3) return { ok: true, items: [] };
    await wait(700);
  }
  // No rows and no empty state: the page never rendered a list, so it cannot
  // be used as truth. Never report an empty project in that case.
  if (!collect().size) return { ok: false, reason: 'project list never rendered' };
  for (let i = 0; i < 30; i++) {
    if (broken()) return { ok: false, reason: 'project list failed while paginating' };
    const before = collect().size;
    const more = [...main.querySelectorAll('button, a')].find((b) => /show more|показать ещё|показати більше/i.test(b.innerText || ''));
    if (more) { more.click(); await wait(900); }
    main.scrollTop = main.scrollHeight;
    await wait(600);
    if (collect().size === before && !more) break;
  }
  return { ok: true, items: [...collect().entries()].map(([gptId, title]) => ({ gptId, title })) };
})()`;

// Replace the relay list with exactly what the project page shows. Transcripts
// are carried over; nothing else survives, so the two lists cannot drift.
async function reconcileFromProject(session, body = {}) {
  const list = await evaluate(session, projectListExpr).catch((e) => ({ ok: false, reason: String(e.message || e) }));
  if (!list || !list.ok || !Array.isArray(list.items)) {
    dbg("reconcile skipped: " + ((list && (list.reason || list.error)) || "no list"));
    return { ok: false, reason: (list && list.reason) || "project list unavailable", chats: state.chats, syncedAt: state.syncedAt || 0 };
  }
  const byId = new Map(state.chats.filter((c) => c && c.gptId).map((c) => [c.gptId, c]));
  const next = [];
  for (const item of list.items) {
    const known = byId.get(item.gptId);
    if (known) {
      if (item.title && known.title !== item.title) known.title = item.title;
      next.push(known);
    } else {
      next.push({ siteChatId: null, gptId: item.gptId, url: "https://chatgpt.com/c/" + item.gptId, title: item.title || "Grace Planner chat", messages: [], updatedAt: Date.now() });
    }
  }
  // A chat that exists on chatgpt.com belongs in the list even before its
  // transcript has been pulled; fill the text in right away for up to two of
  // them so a hand-made chat is readable without a second visit.
  let fetched = 0;
  for (const chat of next) {
    if ((chat.messages || []).length || fetched >= 2) continue;
    if (!chat.gptId) continue;
    try {
      const msgs = await readChat(chat.gptId);
      if (msgs && msgs.length) chat.messages = msgs;
      fetched += 1;
    } catch (error) { dbg("transcript for " + chat.gptId + " pending: " + String(error.message || error).slice(0, 60)); }
  }
  state.chats = next;
  delete state.tombstones;
  state.syncedAt = Date.now();
  state.mirrorCount = next.length;
  save();
  dbg("mirror = " + next.length + " chats");
  return { ok: true, chats: next, authoritative: true, count: next.length, syncedAt: state.syncedAt };
}

async function syncNow(body = {}) {
  if (syncPromise) return syncPromise;
  const run = (async () => {
    await slot();
    let session = null;
    try {
      ({ session } = await openTab(PROJECT_URL));
      await waitComposer(session, 60000);
      const result = await reconcileFromProject(session, body);
      lastSyncAt = Date.now();
      return result.ok ? { ...result, authoritative: true } : { ...result, cached: true };
    } finally { if (session) await closeTab(session); releaseSlot(); }
  })();
  syncPromise = run.finally(() => { syncPromise = null; });
  return syncPromise;
}

// Explicit sync: always reads the project page. Cached answers are allowed only
// for a few seconds, so two clicks in a row cannot show different lists.
async function opSync(body) {
  if (Date.now() - lastSyncAt < 5000 && !body.force) return { ok: true, chats: state.chats, syncedAt: state.syncedAt || 0, cached: true };
  return syncNow(body);
}

async function opDelete(body) {
  const ids = [].concat(body.gptId || []).filter(Boolean);
  if (!ids.length) throw new Error("gptId required");
  await slot();
  try {
    // Any page on chatgpt.com can run this request; a fresh conversation tab is
    // not needed, which keeps a delete to a couple of seconds.
    const reader = await getReader();
    const results = [];
    for (const gptId of ids) {
      const status = await evaluate(reader.session, `(async () => {
        const s = await (await fetch('/api/auth/session')).json();
        if (!s.accessToken) return 'no token';
        const auth = ['Bea', 'rer'].join('') + String.fromCharCode(32) + s.accessToken;
        const res = await fetch('/backend-api/conversation/' + ${JSON.stringify(gptId)}, {
          method: 'PATCH',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: JSON.stringify({ is_visible: false }),
        });
        return String(res.status);
      })()`).catch(() => "err");
      // 200 means hidden on the ChatGPT side, 404 means it is already gone.
      // Both are "not in the project"; anything else is a real failure and the
      // chat stays until the project page confirms it is gone.
      const gone = String(status) === "200" || String(status) === "404";
      if (gone) {
        state.chats = state.chats.filter((c) => c.gptId !== gptId);
        dropChatTab(gptId);
      }
      results.push({ gptId, status, gone });
      dbg("delete " + gptId + " -> " + status);
    }
    save();
    // Confirm against the project page; the reply carries the new list.
    const confirmed = await syncNow({ force: true }).catch(() => null);
    return { ok: true, deleted: results, chats: (confirmed && confirmed.chats) || state.chats, authoritative: !!(confirmed && confirmed.ok) };
  } finally { releaseSlot(); }
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
    if (req.method === "GET" && url.pathname === "/project") return json(res, 200, { ok: true, online: true, account: "inna.kuvardina93@gmail.com", projectUrl: PROJECT_URL, source: "chatgpt", syncedAt: state.syncedAt || 0, projectChats: state.chats.map((c) => ({ gptId: c.gptId, title: c.title, siteChatId: c.siteChatId })) });
    if (req.method === "GET" && url.pathname === "/state") return json(res, 200, state);
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (req.method === "POST" && url.pathname === "/chat/new") return json(res, 200, await opNewChat(body));
    if (req.method === "POST" && url.pathname === "/chat/read") return json(res, 200, await opRead(body));
    if (req.method === "POST" && url.pathname === "/chat/send") return json(res, 200, await opSend(body));
    if (req.method === "POST" && url.pathname === "/chat/sync") return json(res, 200, await opSync(body));
    if (req.method === "POST" && url.pathname === "/chat/delete") return json(res, 200, await opDelete(body));
    if (req.method === "POST" && url.pathname === "/chat/rename") return json(res, 200, await opRename(body));
    if (req.method === "POST" && url.pathname === "/chat/reset") return json(res, 200, opReset());
    if (req.method === "POST" && url.pathname === "/chat/list") return json(res, 200, opList());
    return json(res, 404, { error: "unknown endpoint" });
  } catch (error) {
    console.error(new Date().toISOString(), error);
    return json(res, 500, { error: String(error.message || error) });
  }
});
// Guaranteed delivery: pull answers for chats whose last message is the user's.
// Runs on the reader tab, so it opens no tabs and reloads no history. The sweep
// is frequent enough to feel immediate yet backs off hard on 429.
let readBackoffUntil = 0;
const PENDING_MAX_AGE = 10 * 60 * 1000;
const PENDING_MAX_TRIES = 8;
setInterval(async () => {
  if (Date.now() < readBackoffUntil || Date.now() < readGateUntil) return;
  try {
    const pendingChats = state.chats
      .filter((c) => (c.messages || []).length && c.messages[c.messages.length - 1].role === "user")
      .filter((c) => Date.now() - (c.updatedAt || 0) < PENDING_MAX_AGE && (c.readTries || 0) < PENDING_MAX_TRIES)
      .filter((c) => readGateDelay(c.gptId) === 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 1);
    if (!pendingChats.length) return;
    const chat = pendingChats[0];
    chat.readTries = (chat.readTries || 0) + 1;
    try {
      const msgs = await queueRead(() => readChat(chat.gptId));
      if (msgs && msgs.length > (chat.messages || []).length) {
        chat.messages = msgs; chat.updatedAt = Date.now(); chat.readTries = 0;
        applyDerivedTitle(chat); dbg("refreshed " + chat.gptId);
      }
      save();
    } catch (readError) {
      dbg("sweep read failed: " + readError.message);
    }
  } catch {}
}, 5000);

// Every tab carries a readable name from the first message it already holds.
for (const chat of state.chats) applyDerivedTitle(chat);
save();

sweepTabs();
setInterval(sweepTabs, 60000);

// The mirror must not depend on someone opening the site: reconcile with the
// project page on a timer, so a chat deleted (or created) on chatgpt.com shows
// up here within a couple of minutes. Never runs while another job is using the
// browser, and never steals the composer mid-message.
setInterval(async () => {
  try {
    if (activeRequests > 0 || syncPromise) return;
    if (Date.now() - lastSyncAt < 45000) return;
    const result = await opSync({ force: true });
    if (result && result.ok) dbg("mirror tick: " + result.count + " chats");
  } catch (error) { dbg("mirror tick failed: " + (error.message || error)); }
}, 60000);

server.listen(PORT, () => console.log("grace-bridge relay (raw CDP) on", PORT));

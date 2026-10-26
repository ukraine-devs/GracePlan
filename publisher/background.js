const DEFAULT_PROJECT = "https://chatgpt.com/g/g-p-6ade243a41e48191b297ec2ac5c7e822-grace-planner/project";
const siteOrigin = "https://graceplanner.vercel.app";

const send = (tabId, message) => new Promise((resolve) => {
  chrome.tabs.sendMessage(tabId, message, (reply) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : reply));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function graceTab() {
  const tabs = await chrome.tabs.query({ url: siteOrigin + "/*" });
  const active = tabs.find((t) => t.active) || tabs[0];
  if (!active) throw new Error("Откройте " + siteOrigin + " и нужный чат.");
  return active;
}

async function chatgptTab(projectUrl) {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  const usable = tabs.find((t) => /\/g\/g-p-[0-9a-z-]+\//i.test(t.url || ""));
  if (usable) return usable;
  if (tabs[0]) return tabs[0];
  return chrome.tabs.create({ url: projectUrl, active: false });
}

async function ensureProjectRoot(tab, projectUrl) {
  const probe = await send(tab.id, { type: "GRACE_PING" });
  if (probe?.ok && probe.inProject && !probe.chatId) return;
  if (probe?.ok && probe.signedOut) throw new Error("Войдите в ChatGPT в этой вкладке.");
  await chrome.tabs.update(tab.id, { url: projectUrl });
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    const ping = await send(tab.id, { type: "GRACE_PING" });
    if (ping?.ok && ping.inProject && !ping.signedOut) return;
  }
  throw new Error("Страница проекта не загрузилась. Проверьте вкладку ChatGPT.");
}

// ChatGPT inserts long text slowly, so a transcript is published in parts that
// follow the paragraph boundaries of the original chat.
function split(text, limit = 6000) {
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

async function publish(projectUrl) {
  const grace = await graceTab();
  const transcript = await send(grace.id, { type: "GRACE_TRANSCRIPT" });
  if (!transcript?.ok) throw new Error(transcript?.error || "Не удалось прочитать чат на сайте.");
  const parts = split(transcript.text);
  if (!parts.length) throw new Error("Чат пуст.");

  const tab = await chatgptTab(projectUrl || DEFAULT_PROJECT);
  await ensureProjectRoot(tab, projectUrl || DEFAULT_PROJECT);
  await chrome.tabs.update(tab.id, { active: true });

  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `Часть ${i + 1}/${parts.length}\n\n` : "";
    // Exactly one attempt per part: a blind retry can duplicate the message in
    // the conversation, which is worse than an honest error.
    const result = await send(tab.id, { type: "GRACE_PUBLISH_PART", text: prefix + parts[i] });
    if (!result?.ok) throw new Error((result?.error || "Публикация не удалась.") + (i ? ` (часть ${i + 1} из ${parts.length})` : ""));
    last = result;
  }
  return { url: last.url, chatId: last.chatId, parts: parts.length, title: transcript.title };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GRACE_PUBLISH") return;
  publish(message.projectUrl).then((result) => sendResponse({ ok: true, ...result })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

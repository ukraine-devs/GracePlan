import React, { useEffect, useMemo, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, Menu, Pencil, Plus, Send, Trash2, X, Download } from "lucide-react";
import "./styles.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ACCEPT_FILES, expandUploads, readFileDataUrl } from "./uploads.js";
import { routeIntent, isPlanObservation } from "../lib/graceIntent.js";
import { createExecutionLog } from "../lib/executionLog.js";

const STORAGE_KEY = "grace-plan-chat-sessions";
const ACTIVE_KEY = "grace-plan-active-chat";
const progressSteps = ["Підготовка файлів", "Аналіз кожного фото", "Перевірка 2D-плану", "Зіставлення фото", "Формування даних Grace Plan", "Концептуальний 3D-рендер", "Верстка A2 PDF"];
const welcome = { role: "assistant", content: "Привіт! Можна просто поспілкуватися або розпочати проєкт через @grace. Для пропозиції завантажте 2D-план і фотографії приміщень." };

function MessageText({ text }) {
  return <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{text}</ReactMarkdown></div>;
}

const ARTIFACT_DB = "grace-plan-artifacts";

// A chat deleted from the site is hidden from the server list immediately, even
// though the relay needs a few seconds to hide it inside ChatGPT. Without this
// the two-second poll put the chat back and deleting looked broken.
const deletedChats = new Map();
function markDeleted(gptId) {
  if (!gptId) return;
  deletedChats.set(gptId, Date.now());
  window.setTimeout(() => deletedChats.delete(gptId), 30000);
}
function withoutDeleted(list) {
  return (list || []).filter((chat) => !(chat?.gptId && deletedChats.has(chat.gptId)));
}
function openArtifactDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARTIFACT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function persistArtifacts(messageId, artifacts) {
  if (!artifacts.some((item) => item.data)) return artifacts;
  artifacts = await Promise.all(artifacts.map(async (item) => {
    if (!item.data?.startsWith("blob:")) return item;
    const response = await fetch(item.data);
    const data = await readFileDataUrl(await response.blob());
    URL.revokeObjectURL(item.data);
    return { ...item, data };
  }));
  const db = await openArtifactDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    artifacts.forEach((item) => item.data && store.put(item.data, messageId + ":" + item.name));
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
  return artifacts.map((item) => ({ ...item, storageKey: item.data ? messageId + ":" + item.name : item.storageKey }));
}
async function hydrateArtifacts(chats) {
  const db = await openArtifactDb();
  const read = (key) => new Promise((resolve) => {
    if (!key) return resolve(null);
    const request = db.transaction("files", "readonly").objectStore("files").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
  const hydrated = await Promise.all(chats.map(async (chat) => ({ ...chat, messages: await Promise.all(chat.messages.map(async (message) => ({
    ...message,
    artifacts: message.artifacts ? await Promise.all(message.artifacts.map(async (artifact) => ({ ...artifact, data: artifact.data || await read(artifact.storageKey) }))) : undefined
  }))) })));
  db.close();
  return hydrated;
}

// Every new chat starts from the same brief: the project proposal with 3D renders
// built from the photos, delivered as a multi-format PDF. It is pre-filled in the
// composer so photos can be attached and sent with it.
const DEFAULT_GOAL = `/goal @Grace Plan зроби проектну пропозицію з 3D рендерами по моїм фото, максимальна якість, я очыкую PDF документ з листами рызного формату (A2 з 3D рендером у розрізі по єталону, A3, A4 з додатками та розрахунками таблицямиб цінами, з різними варіантами окремим аркушем А4 наприклад).

/goal для того чтобі агент не останавливался, нужно задать "Цель" всё сообщение.
@Grace Plan для того чтобі агент соблюдал приблизительно один и тот же формат и вид и дизайн финального документа PDF на английском или украинском язіке. Сборка документа по єталонному PDF.`;

function createChat() { return { id: crypto.randomUUID(), title: "New chat", messages: [welcome], createdAt: Date.now() }; }

// ---- Grace Bridge: site <-> server-side ChatGPT (Instant) channel ----
function bridgeFetch(action, payload, timeoutMs = 300000) {
  const isRead = action === "state" || action === "health";
  const cacheBust = action === "state" ? "&t=" + Date.now() : "";
  return fetch("/api/bridge?action=" + action + cacheBust, {
    method: isRead ? "GET" : "POST",
    headers: isRead ? undefined : { "Content-Type": "application/json" },
    body: isRead ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({ error: "Bad bridge response" }));
    if (!response.ok || data.error) throw new Error(data.error || "Bridge error " + response.status);
    return data;
  });
}
// The site chat and the ChatGPT project must hold the same conversation, so the
// full transcript is what gets published, not a placeholder prompt.
function chatTranscript(chat) {
  const lines = [`Grace Planner — чат «${chat.title || "Без названия"}»`, "", "Ниже полная расшифровка диалога из Grace Planner.", ""];
  for (const message of (chat.messages || []).slice(1)) {
    const text = String(message.content || "").trim();
    if (!text) continue;
    lines.push((message.role === "user" ? "Пользователь: " : "Ассистент: ") + text, "");
    for (const artifact of message.artifacts || []) lines.push(`[файл: ${artifact.name}]`);
  }
  lines.push("Продолжай этот диалог с текущего места.");
  return lines.join("\n");
}
function publishToProject(chat) {
  return bridgeFetch("publish", { siteChatId: chat.id, title: chat.title, transcript: chatTranscript(chat) }, 420000);
}
async function bridgeHealth() {
  try { return await bridgeFetch("health", null, 90000); } catch { return null; }
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать файл: " + file.name));
    reader.readAsDataURL(file);
  });
}
// Attachments travel inside the message request: the relay writes them to its
// upload directory and pushes them through the ChatGPT attach dialog. A separate
// "upload" call does not exist on the relay, so staging first silently failed
// for every file, PDFs included. Vercel refuses a function body above 4.5 MB,
// which is the only real limit left.
const MAX_REQUEST_CHARS = 3_500_000;
async function attachmentPayload(files) {
  const payload = [];
  let total = 0;
  for (const file of files || []) {
    const name = file.relativePath || file.name || "file";
    const type = file.type || "application/octet-stream";
    let data;
    try {
      data = /^image\//.test(type) ? (await prepareImage(file)).data : await readFileAsDataUrl(file);
    } catch (error) {
      throw new Error("Не удалось прочитать файл " + name + ": " + (error.message || error));
    }
    if (!data || data.length < 24) throw new Error("Файл пустой или недоступен: " + name);
    total += data.length;
    if (total > MAX_REQUEST_CHARS) {
      const mb = (data.length / 1_370_000).toFixed(1);
      throw new Error(name + " (" + mb + " МБ) не проходит в одном сообщении: предел около 2,5 МБ на отправку. Сожмите PDF или пришлите его страницами.");
    }
    payload.push({ name, mime: type, data });
  }
  return payload;
}
async function bridgeNewChat(siteChatId, title, text, attachmentFiles) {
  return bridgeFetch("new", { siteChatId, title, text, files: attachmentFiles });
}
async function bridgeSend(gptId, text, attachmentFiles) {
  return bridgeFetch("send", { gptId, text, files: attachmentFiles });
}
async function bridgeState() {
  try { return await bridgeFetch("state", null, 15000); } catch { return null; }
}
function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => message.content !== "Команда уже показана. Ожидаю новые данные.");
}
// Placeholder twins created by older builds carry no real content; they must
// neither appear on the site nor be republished into the project.
function isPlaceholderChat(chat) {
  const body = (chat?.messages || []).slice(1);
  if (!body.length) return false;
  const stub = /^Новый чат Grace Planner из приложения/;
  return body.length <= 2 && stub.test(body[0].content || "")
    && body.every((message) => stub.test(message.content || "") || /^Готов\.?$/i.test((message.content || "").trim()));
}
function loadChats() {
  // Chats are not kept in the browser: the list comes from the server, so every
  // visitor sees the same conversations. A single empty draft is all that exists
  // locally until the first message is sent.
  return [createChat()];
}
function makeTitle(text) { return text.length > 28 ? `${text.slice(0, 28)}...` : text || "New chat"; }
async function prepareImage(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Поддерживаются только JPEG, PNG и WebP: " + file.name);
  const originalBytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", originalBytes);
  const originalSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const bitmap = await createImageBitmap(file);
  try {
    const isPlan = /plan|план|креслен|drawing/i.test(file.name);
    // Vercel refuses a function request above 4.5 MB, and one request carries
    // the plan plus every photo of the proposal. Encode the largest picture that
    // still fits: sharpness matters, a failed upload matters more.
    const fit = (canvas, mime, quality, cap) => {
      const attempt = (source) => mime === "image/png" ? source.toDataURL("image/png") : source.toDataURL("image/jpeg", quality);
      let data = attempt(canvas);
      if (data.length <= cap) return data;
      const smaller = document.createElement("canvas");
      const scaleDown = (factor) => {
        smaller.width = Math.max(1, Math.round(canvas.width * factor));
        smaller.height = Math.max(1, Math.round(canvas.height * factor));
        const context = smaller.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, smaller.width, smaller.height);
        context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
        return attempt(smaller);
      };
      for (const factor of [0.85, 0.7, 0.55]) {
        data = scaleDown(factor);
        if (data.length <= cap) return data;
      }
      return data;
    };
    const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // A floor plan keeps thin lines only in PNG; photos are JPEG. Both are capped
    // so that five photos plus the plan stay inside one Vercel request.
    const data = isPlan ? fit(canvas, "image/png", 1, 900_000) : fit(canvas, "image/jpeg", 0.8, 450_000);
    return { name: file.name, data, originalSha256 };
  } finally { bitmap.close(); }
}


async function makeContactSheets(photos) {
  const sheets = [];
  for (let start = 0; start < photos.length; start += 12) {
    const canvas = document.createElement("canvas");
    canvas.width = 1440; canvas.height = 900;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < Math.min(12, photos.length - start); offset++) {
      const photo = photos[start + offset];
      const bitmap = await createImageBitmap(photo);
      try {
        const x = (offset % 4) * 360 + 5;
        const y = Math.floor(offset / 4) * 300 + 5;
        const scale = Math.min(350 / bitmap.width, 255 / bitmap.height);
        context.drawImage(bitmap, x + (350 - bitmap.width * scale) / 2, y, bitmap.width * scale, bitmap.height * scale);
        context.fillStyle = "#111";
        context.font = "14px Arial";
        context.fillText(String(start + offset + 1) + ". " + photo.name.slice(0, 35), x, y + 280, 340);
      } finally { bitmap.close(); }
    }
    sheets.push(canvas.toDataURL("image/jpeg", 0.7));
  }
  return sheets;
}

function App() {
  const [chats, setChats] = useState(loadChats);
  const [activeChatId, setActiveChatId] = useState(null);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  // Sending is per chat: a request in one chat must not lock the composer of
  // another. `sendingIds` holds the chats with a request in flight.
  const [sendingIds, setSendingIds] = useState(() => new Set());
  const markSending = (id, value) => setSendingIds((current) => {
    const next = new Set(current);
    if (value) next.add(id); else next.delete(id);
    return next;
  });
  const isSendingGlobal = sendingIds.size > 0;
  const [currentStep, setCurrentStep] = useState(-1);
  const [photoProgress, setPhotoProgress] = useState("");
  const [executionOpen, setExecutionOpen] = useState(true);
  const [chatManagerOpen, setChatManagerOpen] = useState(false);
  const [progressPreviews, setProgressPreviews] = useState([]);
  const [previewModal, setPreviewModal] = useState(null);
  const [previewComment, setPreviewComment] = useState("");
  const [previewMarkers, setPreviewMarkers] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const [editingChatId, setEditingChatId] = useState(null);
  const [activityTone, setActivityTone] = useState("idle");
  const [graceSession, setGraceSession] = useState(false);
  const [runLog, setRunLog] = useState([]);
  const [isPreparingFiles, setIsPreparingFiles] = useState(false);
  const [error, setError] = useState("");
  const [showStatus, setShowStatus] = useState(true);
  const [bridgeInfo, setBridgeInfo] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accept, setAccept] = useState("");
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragDepth = useRef(0);
  const messagesRef = useRef(null);

  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId) || chats[0], [activeChatId, chats]);
  // The server list can legitimately hold nothing but placeholder twins, and a
  // sync then leaves no chats at all. Without a draft every send would crash on
  // activeChat.id, so the composer must always have a chat to write into.
  useEffect(() => {
    if (chats.length) return;
    const chat = createChat();
    setChats([chat]);
    setActiveChatId(chat.id);
  }, [chats]);

  const isSending = sendingIds.has(activeChat?.id);
  const setIsSending = (value) => markSending(activeChat?.id, value);
  const messages = activeChat?.messages || [welcome];
  const attachmentPreviews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);
  const agentState = isPreparingFiles ? "reading" : !isSending ? "idle" : currentStep <= 1 ? "reading" : currentStep <= 3 ? "command" : currentStep === 4 ? activityTone : currentStep === 5 ? "command" : "writing";
  // A chat is only "in the project" when its conversation is listed there;
  // chats created by an older relay live outside the project and need republishing.
  const projectChatIds = new Set((bridgeInfo?.projectChats || []).map((chat) => chat.gptId));
  const needsPublish = (chat) => !!bridgeInfo && !!chat && (chat.messages || []).some((message) => message.role === "user") && (!chat.gptId || !projectChatIds.has(chat.gptId));
  const pendingChats = chats.filter((chat) => needsPublish(chat) && !chat.publishedAt);
  // Publishes every site chat that has no twin in the project yet, one by one,
  // and reports exactly how many were transferred or failed.
  const syncAll = async () => {
    if (!pendingChats.length || publishing) return;
    setPublishing(true);
    setError("");
    let done = 0;
    const failed = [];
    for (const chat of pendingChats) {
      try {
        const res = await publishToProject(chat);
        setChats((current) => current.map((x) => x.id === chat.id ? { ...x, gptId: res.gptId, gptUrl: res.url, publishedAt: Date.now() } : x));
        done += 1;
      } catch (err) {
        failed.push(chat.title || "чат");
      }
    }
    setPublishing(false);
    bridgeHealth().then((info) => { if (info) setBridgeInfo(info); });
    if (failed.length) setError(`Перенесено ${done}, не удалось ${failed.length}: ${failed.join(", ")}`);
  };

  useEffect(() => { if (!activeChatId && chats[0]) setActiveChatId(chats[0].id); }, [activeChatId, chats]);
  // Legacy chat history kept in the browser is removed for good: chats live only
  // on the server, so every visitor sees the same list.
  useEffect(() => {
    try {
      localStorage.removeItem("grace-plan-chat-sessions");
      localStorage.removeItem("grace-plan-chat-history");
      localStorage.removeItem("grace-plan-active-chat");
    } catch {}
  }, []);
  useEffect(() => { let live = true; hydrateArtifacts(chats).then((value) => { if (live) setChats(value); }).catch(() => {}); return () => { live = false; }; }, []);
  // Active tab is view state only: chats themselves live on the server.

  // Keep the site in step with the server: restore replies lost to bridge
  // errors, and surface every Grace Planner conversation that exists on the
  // ChatGPT side, including chats created by hand.
  // Mirror bootstrap: the server list is the truth, so the site opens with
  // exactly the conversations ChatGPT holds, together with their messages.
  const bootstrappedRef = React.useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    (async () => {
      const state = await bridgeState().catch(() => null);
      if (!state?.chats?.length) return;
      const mapped = state.chats
        .filter((c) => c?.gptId && (c.messages || []).length)
        .map((c) => ({
          id: crypto.randomUUID(),
          title: c.title || "Grace Planner chat",
          messages: [welcome, ...(c.messages || []).map((m) => ({ id: crypto.randomUUID(), role: m.role === "user" ? "user" : "assistant", content: m.content }))],
          createdAt: c.updatedAt || Date.now(),
          updatedAt: c.updatedAt || Date.now(),
          gptId: c.gptId,
          gptUrl: c.url,
        }));
      if (mapped.length) {
        mapped.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        setChats(mapped);
        setActiveChatId(mapped[0].id);
      }
    })();
  }, []);
  const isSendingRef = React.useRef(false);
  useEffect(() => { isSendingRef.current = sendingIds.has(activeChat?.id); }, [sendingIds, activeChat?.id]);
  const activeIdRef = React.useRef(activeChat?.id || null);
  useEffect(() => { activeIdRef.current = activeChat?.id || null; }, [activeChat?.id]);
  const mergeServerChats = (rawServerChats, authoritative) => {
    const serverChats = withoutDeleted(rawServerChats);
    setChats((current) => {
      const busyId = isSendingRef.current ? activeIdRef.current : null;
      const byGpt = new Map();
      const bySite = new Map();
      for (const t of serverChats || []) {
        if (!t?.gptId) continue;
        byGpt.set(t.gptId, t);
        if (t.siteChatId) bySite.set(t.siteChatId, t);
      }
      const used = new Set();
      const result = [];
      const localOnly = new Set(current.map((c) => c.id));
      for (const chat of current) {
        const twin = chat.gptId ? byGpt.get(chat.gptId) : (bySite.get(chat.id) || null);
        if (!twin) continue;
        localOnly.delete(chat.id);
        used.add(twin.gptId);
        // Attachments travel with the server transcript: without them the photos sent
        // from this site disappear from the chat as soon as the list is refreshed.
        const remote = (twin.messages || []).map((m) => ({ id: crypto.randomUUID(), role: m.role === "user" ? "user" : "assistant", content: m.content, artifacts: m.artifacts }));
        const localContent = (chat.messages || []).slice(1);
        const localHasAssistant = localContent.some((m) => m.role === "assistant" && !/Не удалось/i.test(m.content || ""));
        const busy = busyId === chat.id;
        let messages = chat.messages;
        // Placeholder twins and published transcripts must never overwrite the
        // real conversation as it was typed on the site.
        const remoteIsPlaceholder = remote.length > 0 && /^Новый чат Grace Planner из приложения/.test(remote[0].content || "");
        const remoteIsTranscript = remote.length > 0 && /^Grace Planner — чат «/.test(remote[0].content || "");
        // If the twin really carries the message typed on the site, its answer
        // must be adopted even when the conversation starts with a stub.
        const lastUser = [...localContent].reverse().find((m) => m.role === "user")?.content || "";
        const remoteHasLocalUser = !!lastUser && remote.some((m) => m.role === "user" && String(m.content).includes(String(lastUser).slice(0, 30)));
        const allowAdopt = remote.length && !busy && (remoteHasLocalUser || (!remoteIsPlaceholder && !remoteIsTranscript));
        if (allowAdopt && (remote.length > localContent.length || !localHasAssistant)) messages = [welcome, ...remote];
        // Names come from the server list, so every browser shows the same one.
        const title = twin.title && twin.title !== "New chat" ? twin.title : chat.title;
        result.push({ ...chat, gptId: twin.gptId, gptUrl: chat.gptUrl || twin.url, title, messages, gptMessages: remote.length ? remote : chat.gptMessages, updatedAt: Math.max(chat.updatedAt || 0, twin.updatedAt || 0) });
      }
      for (const twin of serverChats || []) {
        if (!twin?.gptId || used.has(twin.gptId)) continue;
        used.add(twin.gptId);
        // Attachments travel with the server transcript: without them the photos sent
        // from this site disappear from the chat as soon as the list is refreshed.
        const remote = (twin.messages || []).map((m) => ({ id: crypto.randomUUID(), role: m.role === "user" ? "user" : "assistant", content: m.content, artifacts: m.artifacts }));
        if (!remote.length) continue;
        result.push({ id: crypto.randomUUID(), title: twin.title || "Grace Planner chat", messages: [welcome, ...remote], createdAt: twin.updatedAt || Date.now(), gptId: twin.gptId, gptUrl: twin.url, updatedAt: twin.updatedAt || Date.now() });
      }
      for (const id of localOnly) {
        const chat = current.find((c) => c.id === id);
        if (!chat) continue;
        // A fresh full sync that no longer lists a paired chat means it was
        // deleted on the ChatGPT side; mirror that instead of keeping a ghost.
        // Chats that still hold real user content are kept and republished
        // rather than dropped, so site content is never lost to a sync.
        const stale = authoritative && (Date.now() - (chat.createdAt || 0)) > 180000;
        const hasUserContent = (chat.messages || []).some((m) => m.role === "user");
        if (authoritative && (chat.gptId || stale) && !hasUserContent) continue;
        result.push({ ...chat });
      }
      result.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      const clean = result.filter((chat) => !isPlaceholderChat(chat)
        && !(chat.gptId && !(chat.messages || []).some((message) => message.role === "user")));
      // The server list is the only list: an untouched draft disappears as soon
      // as the server has conversations to show, so nobody sees an extra tab.
      if (!clean.length) return [current.find((chat) => !chat.gptId) || createChat()];
      const serverOnes = clean.filter((chat) => chat.gptId);
      if (!serverOnes.length) return clean;
      // A just-created draft must survive the sync, so an empty new chat no
      // longer disappears a second later.
      const isFresh = (chat) => Date.now() - (chat.createdAt || 0) < 300000;
      return clean.filter((chat) => chat.gptId || isFresh(chat) || (chat.messages || []).some((message) => message.role === "user"));
    });
  };
  // Hard guarantee for the chat in front of the user: as soon as the server
  // transcript grows (an answer arrived), show it.
  useEffect(() => {
    const gptId = activeChat?.gptId;
    const chatId = activeChat?.id;
    if (!gptId || !chatId) return undefined;
    let live = true;
    const pull = async () => {
      const state = await bridgeState().catch(() => null);
      if (!live) return;
      const twin = state?.chats?.find((c) => c.gptId === gptId);
      const remote = (twin?.messages || []).map((m) => ({ id: crypto.randomUUID(), role: m.role === "user" ? "user" : "assistant", content: m.content }));
      if (remote.length < 2) return;
      setChats((current) => current.map((chat) => {
        if (chat.id !== chatId) return chat;
        const localContent = (chat.messages || []).filter((m) => m !== welcome);
        if (remote.length <= localContent.length) return chat;
        return { ...chat, messages: [welcome, ...remote] };
      }));
    };
    const timer = window.setInterval(pull, 7000);
    pull();
    return () => { live = false; window.clearInterval(timer); };
  }, [activeChat?.id, activeChat?.gptId, activeChat?.messages?.length]);
  const twinQueueRef = React.useRef(new Set());
  const publishChat = React.useCallback(async (chat) => {
    setPublishing(true);
    try {
      const res = await publishToProject(chat);
      setChats((current) => current.map((x) => x.id === chat.id ? { ...x, gptId: res.gptId, gptUrl: res.url, publishedAt: Date.now() } : x));
      setError("");
      bridgeHealth().then((info) => { if (info) setBridgeInfo(info); });
      return res;
    } finally { setPublishing(false); }
  }, []);
  // Publication is explicit: a background copy from several open browsers at
  // once created duplicates, so the site only publishes on request.

  useEffect(() => {
    let live = true;
    let timer = null;
    let attempt = 0;
    const pull = async () => {
      const info = await bridgeHealth();
      if (!live) return;
      if (info) { setBridgeInfo(info); attempt = 0; timer = setTimeout(pull, 60000); return; }
      attempt += 1;
      timer = setTimeout(pull, attempt <= 3 ? 5000 : 60000);
    };
    pull();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    // Placeholder twins from older builds are removed from the relay list once
    // (the ChatGPT conversations themselves are left alone).
    const ids = chats.filter((chat) => chat.gptId && isPlaceholderChat(chat)).map((chat) => chat.gptId);
    if (!ids.length) return;
    bridgeFetch("drop", { gptIds: ids }, 30000)
      .then(() => bridgeHealth().then((info) => { if (info) setBridgeInfo(info); }))
      .catch(() => {});
  }, [chats]);
  useEffect(() => {
    // Automatic republishing stays off: every new message already goes through
    // the bridge, and a background loop would fill the account with duplicates.
    // Legacy chats are published from the explicit button in the status strip.
    return undefined;
  }, []);
  useEffect(() => {
    let live = true;
    const pullState = async () => {
      const gptState = await bridgeState();
      if (live && gptState?.chats?.length) mergeServerChats(gptState.chats);
    };
    const pullSync = async () => {
      try {
        const synced = await bridgeFetch("sync", {}, 180000);
        if (live && synced?.chats) mergeServerChats(synced.chats, !!synced.authoritative);
      } catch {}
    };
    pullState();
    pullSync();
    const timerState = window.setInterval(pullState, 5000);
    const timerSync = window.setInterval(pullSync, 300000);
    return () => { live = false; window.clearInterval(timerState); window.clearInterval(timerSync); };
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => setShowStatus(false), 5500); return () => window.clearTimeout(timer); }, []);
  useEffect(() => () => attachmentPreviews.forEach((item) => URL.revokeObjectURL(item.url)), [attachmentPreviews]);
  useEffect(() => {
    if (!isSending || currentStep !== 4) { setActivityTone("thinking"); return; }
    let timer;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      setActivityTone(Math.random() > .5 ? "reasoning" : "thinking");
      timer = window.setTimeout(tick, 450 + Math.random() * 500);
    };
    tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [isSending, currentStep]);
  useEffect(() => {
    const element = messagesRef.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 240) element.scrollTop = element.scrollHeight;
  }, [messages, currentStep, runLog]);
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  function updateActiveChat(updater) { setChats((current) => current.map((chat) => (chat.id === activeChat.id ? updater(chat) : chat))); }
  function newChat() {
    const chat = createChat();
    setChats((current) => [chat, ...current]); setActiveChatId(chat.id); setInput(DEFAULT_GOAL); setError(""); setFiles([]);
    // The twin is created by the first real message, carrying the text the user
    // typed. An eager stub conversation only polluted the project and was then
    // filtered out of the tab strip as a placeholder.
  }
  // Drag the tab strip with the mouse (touch devices scroll it natively).
  const tabsRef = React.useRef(null);
  const tabDragRef = React.useRef({ active: false, startX: 0, startScroll: 0 });
  function tabDragStart(event) {
    const el = tabsRef.current;
    if (!el || event.pointerType === "touch") return;
    // No pointer capture here: it would swallow the plain click on a tab.
    tabDragRef.current = { active: true, moved: false, startX: event.clientX, startScroll: el.scrollLeft };
  }
  function tabDragMove(event) {
    const el = tabsRef.current;
    const drag = tabDragRef.current;
    if (!el || !drag.active) return;
    const dx = event.clientX - drag.startX;
    if (Math.abs(dx) > 8) {
      drag.moved = true;
      el.scrollLeft = drag.startScroll - dx;
    }
  }
  function tabDragEnd() {
    tabDragRef.current.active = false;
  }
  function closeChat(chatId) {
    const rest = chats.filter((chat) => chat.id !== chatId);
    const list = rest.length ? rest : [createChat()];
    setChats(list);
    if (chatId === activeChat.id) setActiveChatId(list[0].id);
  }
  function renameChat(chatId, title) {
    const clean = title.slice(0, 80) || "New chat";
    setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, title: clean } : chat));
    const chat = chats.find((c) => c.id === chatId);
    if (chat?.gptId) bridgeFetch("rename", { items: [{ gptId: chat.gptId, title: clean }] }, 120000).catch(() => {});
  }
  function deleteChat(chatId) {
    // The list is shared, so a deletion has to happen on the server too.
    const target = chats.find((chat) => chat.id === chatId);
    if (target?.gptId) {
      markDeleted(target.gptId);
      bridgeFetch("delete", { gptId: target.gptId }, 120000).catch(() => {});
    }
    setChats((current) => {
      const remaining = current.filter((chat) => chat.id !== chatId);
      if (remaining.length) {
        if (activeChatId === chatId) setActiveChatId(remaining[0].id);
        return remaining;
      }
      const replacement = createChat();
      setActiveChatId(replacement.id);
      return [replacement];
    });
  }
  function openPreview(source, name = "Grace preview") {
    setPreviewModal({ source, name });
    setPreviewMarkers([]);
    setPreviewComment("");
  }
  function markPreview(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const marker = { x: Math.round(((event.clientX - rect.left) / rect.width) * 100), y: Math.round(((event.clientY - rect.top) / rect.height) * 100) };
    setPreviewMarkers((current) => [...current, marker]);
  }
  function applyPreviewComment() {
    if (!previewComment.trim()) return;
    const points = previewMarkers.map((point) => point.x + "%/" + point.y + "%").join(", ");
    setInput((current) => [current, "Правка изображения «" + previewModal.name + "»" + (points ? " в точках " + points : "") + ": " + previewComment.trim()].filter(Boolean).join("\n"));
    setPreviewModal(null);
  }

  const ingestFiles = async (selected) => {
    if (isSending || isPreparingFiles) return;
    setIsPreparingFiles(true);
    setError("");
    try {
      const result = await expandUploads(selected, { existingCount: files.length, existingBytes: files.reduce((sum, file) => sum + file.size, 0) });
      setFiles((current) => [...current, ...result.files]);
      if (result.errors.length) setError(result.errors.join("\n"));
    } catch (fileError) {
      setError(fileError.message);
    } finally {
      setIsPreparingFiles(false);
      setMenuOpen(false);
    }
  };

  const handleFileChange = async (event) => {
    const inputElement = event.currentTarget;
    const selected = Array.from(inputElement.files || []);
    inputElement.value = "";
    await ingestFiles(selected);
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    await ingestFiles(Array.from(event.dataTransfer.files || []));
  };

  useEffect(() => {
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
    const enter = (event) => { if (hasFiles(event)) { event.preventDefault(); dragDepth.current += 1; setDragActive(true); } };
    const over = (event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = isSending ? "none" : "copy"; } };
    const leave = (event) => { if (hasFiles(event)) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragActive(false); } };
    const drop = (event) => { if (hasFiles(event)) handleDrop(event); };
    const reset = () => { dragDepth.current = 0; setDragActive(false); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave); window.addEventListener("drop", drop); window.addEventListener("blur", reset);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); window.removeEventListener("blur", reset); };
  }, [files, isSending, isPreparingFiles]);

  const removeFile = (index) => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));

  const toggleMenu = () => {
    setMenuOpen(!menuOpen);
  };

  const selectOption = () => {
    const allowed = ACCEPT_FILES;
    setAccept(allowed);
    if (fileInputRef.current) {
      fileInputRef.current.accept = allowed;
      fileInputRef.current.click();
    }
    setMenuOpen(false);
  };

  async function requestJson(url, payload) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error("The server returned a non-JSON response (" + response.status + "). Please retry with fewer files."); }
    if (!response.ok) throw new Error(result.error || ("Request failed: " + response.status));
    return result;
  }
  function jsonArtifact(name, value) {
    return { type: "json", name, data: "data:application/json;base64," + btoa(Array.from(new TextEncoder().encode(JSON.stringify(value, null, 2)), (byte) => String.fromCharCode(byte)).join("")) };
  }

  function storedJson(artifacts, name, fallback) {
    try {
      const data = artifacts.find((item) => item.name === name)?.data;
      if (!data?.startsWith("data:application/json;base64,")) return fallback;
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data.split(",")[1]), (char) => char.charCodeAt(0))));
    } catch { return fallback; }
  }

  async function submit(event) {
    event.preventDefault();
    const text = input.trim();
    if (!activeChat) return;
    if ((!text && !files.length) || isSending || isPreparingFiles) return;
    const submittedFiles = [...files];
    const chatId = activeChat.id;
    const writeChat = (updater) => setChats((current) => current.map((chat) => chat.id === chatId ? updater(chat) : chat));
    let decision = routeIntent({ text, previousMode: activeChat.lastMode || "general" });
    setGraceSession(decision.mode === "grace");
    const messageId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nextMessages = [...messages, { id: userId, role: "user", content: text || "Please review the attached files." }];
    writeChat((chat) => ({ ...chat, title: chat.messages.length === 1 ? makeTitle(text || submittedFiles[0]?.name) : chat.title, messages: nextMessages }));
    setInput(""); setError(""); setFiles([]); markSending(chatId, true);
    setCurrentStep(submittedFiles.length ? 0 : 4); setPhotoProgress(""); setExecutionOpen(true);
    setProgressPreviews([]); setRunLog([]);
    const actualExecution = createExecutionLog(setRunLog);
    const stage = actualExecution.stage;
    // Attachments are shown on the sent message itself. Without this the bridge
    // path dropped them from the transcript, so a PDF could not be downloaded
    // back even though it had just been sent.
    let bridgeFiles = [];
    if (submittedFiles.length) {
      try {
        bridgeFiles = await attachmentPayload(submittedFiles);
        const artifacts = bridgeFiles.map((item) => ({ type: /^image\//.test(item.mime) ? "image" : "file", name: item.name, data: item.data }));
        const savedArtifacts = await persistArtifacts(userId, artifacts);
        nextMessages[nextMessages.length - 1].artifacts = savedArtifacts;
        writeChat((chat) => ({ ...chat, messages: [...nextMessages] }));
      } catch (attachmentError) {
        setError(attachmentError.message || String(attachmentError));
        writeChat((chat) => ({ ...chat, messages: [...nextMessages, { id: messageId, role: "assistant", content: "Не удалось приложить файл: " + attachmentError.message }] }));
        markSending(chatId, false);
        setCurrentStep(-1);
        return;
      }
    }
    // Every chat runs on the server-side ChatGPT channel, so the site does not
    // depend on OpenAI API credits. The twin chat is created on the first message.
    {
      try {
        let gptId = activeChat.gptId;
        let result;
        setCurrentStep(4);
        if (gptId) {
          stage("bridge", "Отправка в ChatGPT (сервер)");
          result = await bridgeSend(gptId, text, bridgeFiles);
          if (result.gptId && result.gptId !== gptId) {
            // The old conversation was unusable; the bridge continued in a new one.
            gptId = result.gptId;
            writeChat((chat) => ({ ...chat, gptId: result.gptId, gptUrl: result.url }));
          }
        } else {
          stage("bridge", "Создаю чат в Grace Planner (ChatGPT)");
          result = await bridgeNewChat(chatId, activeChat.title, text || "Please review the attached files.", bridgeFiles);
          gptId = result.gptId;
          writeChat((chat) => ({ ...chat, gptId: gptId, gptUrl: result.url, updatedAt: Date.now() }));
        }
        stage("bridge", "Ответ ChatGPT получен", "done");
        const replyId = crypto.randomUUID();
        const gptState = await bridgeState().catch(() => null);
        const twin = gptState?.chats?.find((c) => c.gptId === gptId);
        const pending = !String(result.reply || "").trim();
        writeChat((chat) => pending
          ? { ...chat, gptId: gptId, updatedAt: Date.now(), messages: nextMessages }
          : { ...chat, gptId: gptId, updatedAt: Date.now(), messages: [...nextMessages, { id: replyId, role: "assistant", content: result.reply, mode: "general", synced: true }] });
        setChats((current) => current.map((item) => item.id === chatId ? { ...item, gptMessages: twin?.messages || result.messages } : item));
        if (pending) stage("bridge", "Ответ появится в течение минуты", "done");
      } catch (bridgeError) {
        // The desktop browser can be blocked (Cloudflare, expired login). The site
        // must still answer, so the same message goes to the server API and the
        // user gets a reply instead of a dead end.
        stage("bridge", "Мост недоступен, отвечаю через OpenAI API", "failed");
        let direct = null;
        try {
          direct = await requestJson("/api/chat", {
            messages: nextMessages.map(({ role, content }) => ({ role, content })),
            files: [], photoObservations: [], previousMode: activeChat.lastMode || "general", clientPipeline: false
          });
        } catch (apiError) {
          setError("Мост ChatGPT: " + bridgeError.message);
          writeChat((chat) => ({ ...chat, messages: [...nextMessages, { id: messageId, role: "assistant", content: "Не удалось получить ответ: мост ChatGPT недоступен (" + bridgeError.message + "), резервный API тоже не ответил (" + apiError.message + ")." }] }));
          return;
        }
        const answer = String(direct?.answer || "").trim();
        writeChat((chat) => ({ ...chat, lastMode: activeChat.lastMode || "general", messages: [...nextMessages, { id: messageId, role: "assistant", content: answer || "Пустой ответ API.", mode: "general" }] }));
        if (answer) { setError(""); stage("bridge", "Ответ получен через OpenAI API", "done"); }
      } finally {
        setCurrentStep(-1); markSending(chatId, false); setProgressPreviews([]);
      }
      return;
    }
    const userArtifacts = [];
    try {
      const photoObservations = [];
      const preparedImages = [];
      for (let index = 0; index < submittedFiles.length; index++) {
        const file = submittedFiles[index];
        setCurrentStep(0); stage("read-" + index, "Reading " + file.name);
        if (!/^image\//.test(file.type || "") && !/\.(png|jpe?g|webp)$/i.test(file.name || "")) {
          // Keep the bytes, not just the name: without data the message showed
          // "файл недоступний" and a PDF could never be downloaded back.
          userArtifacts.push({ type: "file", name: file.relativePath || file.name, data: await readFileAsDataUrl(file) });
          stage("read-" + index, "Attached " + file.name, "done");
          continue;
        }
        const prepared = await prepareImage(file);
        preparedImages.push(prepared);
        stage("read-" + index, "Read " + file.name, "done");
        userArtifacts.push({ type: "image", name: file.relativePath || file.name, data: prepared.data });
        setProgressPreviews((current) => [...current.slice(-3), { source: prepared.data, name: file.name }]);
      }
      if (userArtifacts.length) {
        const savedUserArtifacts = await persistArtifacts(userId, userArtifacts);
        nextMessages[nextMessages.length - 1].artifacts = savedUserArtifacts;
        writeChat((chat) => ({ ...chat, messages: [...nextMessages] }));
      }
      for (let index = 0; index < preparedImages.length; index++) {
        const file = submittedFiles[index];
        const prepared = preparedImages[index];
        setCurrentStep(1); stage("analysis-" + index, "Analyzing " + file.name);
        const analysis = await requestJson("/api/analyze-image", prepared);
        photoObservations.push({ ...analysis, source_path: file.relativePath || file.name });
        stage("analysis-" + index, "Analyzed " + file.name, "done");
        setPhotoProgress((index + 1) + "/" + submittedFiles.length);
      }
      decision = routeIntent({ text, observations: photoObservations, previousMode: activeChat.lastMode || "general" });
      setGraceSession(decision.mode === "grace");
      setCurrentStep(4);
      stage("reply", decision.mode === "grace" ? "Preparing Grace proposal data" : "Preparing reply");
      let data;
      try {
        data = await requestJson("/api/chat", {
          messages: nextMessages.map(({ role, content }) => ({ role, content })), files: [],
          photoObservations, previousMode: activeChat.lastMode || "general", clientPipeline: true
        });
      } catch (chatError) {
        if (decision.mode !== "grace" || (!submittedFiles.length && !activeChat.messages.some((message) => message.artifacts?.some((artifact) => artifact.kind === "source_plan")))) throw chatError;
        data = { answer: "", mode: "grace", artifacts: [], execution: [] };
        stage("reply", "Text reply unavailable; continuing the proposal from source images", "failed");
      }
      if (data.answer) stage("reply", "Reply received", "done");
      const projectMode = data.mode === "grace";
      setGraceSession(projectMode);
      let finalAnswer = data.answer?.trim() || "";
      const artifacts = Array.isArray(data.artifacts) ? [...data.artifacts] : [];
      const wantsPdf = projectMode && (/pdf|пдф|proposal|предлож|пропоз|@grace|погнали|новий проект|новый проект/i.test(text) || submittedFiles.length > 1);
      const wantsRender = projectMode && (wantsPdf || submittedFiles.length > 1 || /3d|bim|render|рендер|візуал|визуал/i.test(text));
      const planIndexes = photoObservations.map((item, index) => isPlanObservation(item) ? index : -1).filter((index) => index >= 0);
      const previousProjectMessage = [...messages].reverse().find((message) => message.artifacts?.some((item) => item.kind === "source_plan"));
      const previousArtifacts = previousProjectMessage?.artifacts || [];
      if (!submittedFiles.length && projectMode) artifacts.push(...previousArtifacts.filter((item) => item.type !== "pdf" && item.kind !== "concept_render" && item.name !== "GracePlan_concept_3D.png"));
      const previousProject = submittedFiles.length ? {} : storedJson(previousArtifacts, "GracePlan_project.json", {});
      const previousObservations = submittedFiles.length ? [] : storedJson(previousArtifacts, "GracePlan_image_observations.json", []);
      if (photoObservations.length) artifacts.push(jsonArtifact("GracePlan_image_observations.json", photoObservations));
      let planData = previousArtifacts.find((item) => item.kind === "source_plan")?.data;
      // A proposal PDF may only use a render produced by this run. Reusing the
      // previous one made the site hand back the same finished file again and
      // again while nothing was actually generated.
      let renderData = null;
      let contactSheets = previousArtifacts.filter((item) => item.kind === "contact_sheet").map((item) => item.data);
      let photoCount = submittedFiles.length ? submittedFiles.length - planIndexes.length : previousArtifacts.find((item) => item.kind === "source_plan")?.photoCount || 0;
      let renderQa = submittedFiles.length ? null : storedJson(previousArtifacts, "GracePlan_render_review.json", null);
      let renderFailure = "";
      if (projectMode && planIndexes.length === 1) {
        const planIndex = planIndexes[0];
        const sourceFile = submittedFiles[planIndex];
        const sourceData = await readFileDataUrl(sourceFile);
        planData = sourceData;
        renderData = null; // A changed source must never silently reuse a previous render.
        const preserved = { type: "image", kind: "source_plan", name: "GracePlan_source_2D_original." + (sourceFile.type === "image/png" ? "png" : sourceFile.type === "image/webp" ? "webp" : "jpg"), data: sourceData, photoCount };
        artifacts.push(preserved);
        artifacts.push(jsonArtifact("GracePlan_plan_fidelity.json", {
          source_name: sourceFile.relativePath || sourceFile.name, source_sha256: preparedImages[planIndex].originalSha256,
          method: "original_source_bytes_preserved", generative_redraw: false,
          pixel_geometry: "Source plan is reused, not redrawn. PDF view may be scaled uniformly.",
          interpretation: photoObservations[planIndex].observations,
          vector_reconstruction: "not_implemented", semantic_accuracy: "requires_human_review",
          render_accuracy_guarantee: false
        }));
        stage("source", "Original 2D plan preserved (SHA-256 recorded)", "done");
        const photos = submittedFiles.filter((_, index) => index !== planIndex);
        contactSheets = await makeContactSheets(photos);
        contactSheets.forEach((source, index) => artifacts.push({ type: "image", kind: "contact_sheet", name: "GracePlan_contact_sheet_" + (index + 1) + ".jpg", data: source }));

      } else if (projectMode && submittedFiles.length && planIndexes.length !== 1) {
        planData = null; renderData = null; contactSheets = [];
        stage("source", "Exactly one recognized floor plan is required", "failed");
      }
      if (wantsRender && planData && !renderData && contactSheets.length) {
        setCurrentStep(5); stage("render", "Creating conceptual 3D render");
        setProgressPreviews(contactSheets.map((source, index) => ({ source, name: "Reference contact sheet " + (index + 1) })));
        try {
          const currentPlan = preparedImages[planIndexes[0]];
          const plan = currentPlan?.data || (await prepareImage(new File([await (await fetch(planData)).blob()], "saved-source-plan.png", { type: planData.slice(5, planData.indexOf(";")) }))).data;
          const result = await requestJson("/api/render-concept", { plan, contactSheets, photoCount, request: text });
          renderData = result.artifact.data;
          artifacts.push({ ...result.artifact, kind: "concept_render" });
          setProgressPreviews([{ source: renderData, name: "Generated concept - awaiting review" }]);
          stage("render", "Conceptual render created", "done");
          stage("render-qa", "Comparing render against source plan");
          try {
            const qa = await requestJson("/api/verify-render", { plan, render: renderData });
            renderQa = qa;
            artifacts.push(jsonArtifact("GracePlan_render_review.json", qa));
            stage("render-qa", qa.status === "mismatch_detected" ? "Differences detected - review required" : "Visual comparison complete - manual review required", "done");
          } catch (qaError) {
            renderQa = { status: "review_unavailable", error: qaError.message, guaranteed: false };
            artifacts.push(jsonArtifact("GracePlan_render_review.json", renderQa));
            stage("render-qa", "Comparison unavailable; render is unverified", "failed");
          }
        } catch (renderError) {
          renderFailure = renderError.message;
          stage("render", "Render failed: " + renderError.message, "failed");
          setError(renderError.message);
        }
      }
      if (wantsPdf && planData && renderData) {
        setCurrentStep(6); stage("pdf", "Composing A2 PDF from preserved source");
        try {
          const previousSourceName = storedJson(previousArtifacts, "GracePlan_plan_fidelity.json", {}).source_name;
          const priorUpload = previousSourceName && [...messages].reverse().find((message) => message.role === "user" && message.artifacts?.some((item) => item.name === previousSourceName));
          const photoEvidence = submittedFiles.length ? userArtifacts.filter((_, index) => !planIndexes.includes(index)) : (priorUpload?.artifacts || []).filter((item) => item.type === "image" && item.name !== previousSourceName);
          const { createConceptReviewPdf } = await import("./proposalPdf.js");
          const pdfUrl = await createConceptReviewPdf({ renderData, planData, photoCount, contactSheets, renderQa,
            project: data.projectData || previousProject, observations: photoObservations.length ? photoObservations : previousObservations, photos: photoEvidence,
            sourceChecks: (photoObservations.length ? photoObservations : previousObservations).map((photo) => ({ name: photo.name, sha256: photo.originalSha256 })),
            onProgress: (label) => stage("pdf", label)
          });
          const number = String(messages.flatMap((message) => message.artifacts || []).filter((item) => item.type === "pdf").length + 1).padStart(3, "0");
          // The name carries the moment of composition, so a fresh file is
          // recognisable and two runs can never look like the same document.
          const builtAt = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
          const filename = "проектное_предложение_" + number + "_" + builtAt + ".pdf";
          artifacts.push({ type: "pdf", name: filename, data: pdfUrl });
          stage("pdf", "Final proposal PDF created and validated", "done");
          finalAnswer = "Готово — проєктна пропозиція у PDF нижче. Документ містить 6 A2, тематичні додатки A3, фотоатлас і загальний A4. Геометрія, інженерні прив'язки та відсоток візуальної відповідності потребують перевірки.";
        } catch (pdfError) {
          stage("pdf", "PDF failed: " + pdfError.message, "failed"); setError(pdfError.message);
          finalAnswer = "Не вдалося завершити PDF: " + pdfError.message + ". Проміжні файли не є фінальним результатом.";
        }
      } else if (wantsPdf) {
        finalAnswer = !planData ? "Для завершення пропозиції потрібен один розпізнаний 2D-план і фото приміщень. Фінальний PDF ще не сформовано." : "Фінальний PDF потребує завершеного рендера. " + (renderFailure ? "Причина: " + renderFailure + ". " : "Рендер ще не створено. ") + "Проміжні технічні файли не видаються як результат.";
      }
      setCurrentStep(6);
      const savedArtifacts = await persistArtifacts(messageId, artifacts);
      writeChat((chat) => ({ ...chat, lastMode: projectMode ? "grace" : "general", messages: [...nextMessages, { id: messageId, role: "assistant", content: finalAnswer, artifacts: savedArtifacts, execution: projectMode ? actualExecution.snapshot() : [], mode: data.mode }] }));
    } catch (err) {
      setError(err.message); setInput(text);
      stage("request-error", "Request failed: " + err.message, "failed");
      writeChat((chat) => ({ ...chat, messages: [...nextMessages, { id: messageId, role: "assistant", content: "Не вдалося завершити запит: " + err.message, execution: actualExecution.snapshot() }] }));
    } finally {
      setCurrentStep(-1); markSending(chatId, false); setProgressPreviews([]);
    }
  }

  return (
    <main className="app-shell"><section className="chat-panel" aria-label="Grace Planner chat">
      <header className="topbar"><div className="brand-row"><div className="brand-text" aria-label="Grace AI Planner">Grace AI Planner</div></div>
        <button className="icon-button chat-manager-button" type="button" onClick={() => setChatManagerOpen(true)} aria-label="All chats" title="All chats"><Menu size={18} /></button>
        <nav className="chat-tabs" aria-label="Chats" ref={tabsRef} onPointerDown={tabDragStart} onPointerMove={tabDragMove} onPointerUp={tabDragEnd} onPointerCancel={tabDragEnd}>{chats.map((chat) => (
          <div className={chat.id === activeChat?.id ? "chat-tab active" : "chat-tab"} key={chat.id} role="tab" aria-selected={chat.id === activeChat?.id} tabIndex={0} onClick={() => setActiveChatId(chat.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveChatId(chat.id); } }}>
            <span className="chat-tab-title">{chat.title}</span>
            <button className="chat-tab-close" type="button" aria-label={"Закрыть вкладку: " + chat.title} onClick={(e) => { e.stopPropagation(); closeChat(chat.id); }}>×</button>
          </div>
        ))}</nav>
        <div className="header-actions"><button className="icon-button" type="button" onClick={newChat} aria-label="New chat" title="New chat"><Plus size={18} /></button><span className={`agent-indicator ${agentState}`} role="status" aria-label={`Agent status: ${agentState}`} title={`Activity: ${agentState}. Animated UI indicator, not hidden model reasoning.`} /></div>
      </header>
      <div className="messages" aria-live="polite" ref={messagesRef}>
        {messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "You" : "Grace AI Planner"}</span><MessageText text={message.content} />{message.execution?.length > 0 && <details className="command-log" open><summary>Execution commands</summary>{message.execution.map((item) => <div className={`command-row ${item.status}`} key={item.id}><strong>· {item.label}</strong><span>{item.detail}</span></div>)}</details>}{message.artifacts?.filter((artifact) => message.role === "user" || artifact.type === "pdf").map((artifact) => artifact.data ? artifact.type === "image" ? <button className="preview-card" type="button" onClick={() => openPreview(artifact.data, artifact.name)} key={artifact.name}><img src={artifact.data} alt={artifact.name} /><span>{artifact.name}</span></button> : <a className="artifact-link" href={artifact.data} download={artifact.name} key={artifact.name}><Download size={16} aria-hidden="true" />{artifact.name}</a> : <span className="artifact-unavailable" key={artifact.name}>{artifact.name} — файл недоступний</span>)}</article>)}
        {isSending && <article className="message assistant progress-message"><span>Grace AI Planner</span>
          <div className={`execution-spoiler ${executionOpen ? "open" : ""}`}>
            <button className="execution-summary" type="button" onClick={() => setExecutionOpen((open) => !open)} aria-expanded={executionOpen}>
              <i className="status-spinner" aria-hidden="true" />
              <strong key={currentStep}>{graceSession ? (progressSteps[currentStep] || "Выполнение команды") + (currentStep === 0 ? " " + photoProgress : "") : "Thinking"}<b className="typing-dots"><em>.</em><em>.</em><em>.</em></b></strong>
              <ChevronDown className="spoiler-chevron" size={16} aria-hidden="true" />
            </button>
            {graceSession && <div className="execution-details" aria-hidden={!executionOpen}><div>
              {runLog.map((step) => <p className={step.status === "running" ? "active" : step.status} key={step.id}>{step.status === "running" ? <i className="mini-spinner" aria-hidden="true" /> : <span aria-hidden="true">{step.status === "failed" ? "!" : "✓"}</span>}<span>{step.label}</span></p>)}
            </div></div>}
          </div>
          {graceSession && progressPreviews.length > 0 && <div className="progress-previews">{progressPreviews.map((preview, index) => <button type="button" className="progress-preview" onClick={() => openPreview(preview.source, preview.name)} key={preview.name + index}><img src={preview.source} alt={preview.name} /><span>{preview.name}</span></button>)}</div>}
        </article>}
      </div>
      {chatManagerOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setChatManagerOpen(false)}><section className="chat-manager-modal" role="dialog" aria-modal="true" aria-label="All chats" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>All chats</strong><span>{chats.length}</span></div><button type="button" className="modal-close" onClick={() => setChatManagerOpen(false)} aria-label="Close" title="Close"><X size={18} /></button></header><div className="chat-manager-list">{chats.map((chat) => <div className={chat.id === activeChat.id ? "chat-manager-row active" : "chat-manager-row"} key={chat.id}>{editingChatId === chat.id ? <input autoFocus value={chat.title} onChange={(event) => renameChat(chat.id, event.target.value)} onBlur={() => setEditingChatId(null)} onKeyDown={(event) => event.key === "Enter" && setEditingChatId(null)} aria-label="Chat name" /> : <button type="button" className="chat-name" onClick={() => { setActiveChatId(chat.id); setChatManagerOpen(false); }} title="Open chat">{chat.title}</button>}<button type="button" className="edit-chat" onClick={() => setEditingChatId(chat.id)} aria-label={"Rename " + chat.title} title="Rename"><Pencil size={16} /></button>{(chat.gptUrl || chat.url) && <a className="open-chat-link" href={chat.gptUrl || chat.url} target="_blank" rel="noreferrer" aria-label={"Открыть в ChatGPT: " + chat.title} title="Открыть в ChatGPT">↗</a>}<button type="button" className="delete-chat" onClick={() => deleteChat(chat.id)} aria-label={"Delete " + chat.title} title="Delete"><Trash2 size={16} /></button></div>)}</div><button type="button" className="new-chat-wide" onClick={() => { newChat(); setChatManagerOpen(false); }} title="New chat"><Plus size={17} />New chat</button></section></div>}
      {previewModal && <div className="modal-backdrop image-editor-backdrop" role="presentation" onMouseDown={() => setPreviewModal(null)}><section className="image-editor-modal" role="dialog" aria-modal="true" aria-label="Image review" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>Image review & comments</strong><span>{previewModal.name}</span></div><button type="button" className="modal-close" onClick={() => setPreviewModal(null)} aria-label="Close" title="Close"><X size={18} /></button></header><div className="image-stage" onClick={markPreview}><img src={previewModal.source} alt={previewModal.name} />{previewMarkers.map((marker, index) => <i key={index} style={{ left: marker.x + "%", top: marker.y + "%" }}>{index + 1}</i>)}</div><p className="editor-help">Select image locations and describe your requested changes. This adds a comment; it does not edit the image automatically.</p><textarea value={previewComment} onChange={(event) => setPreviewComment(event.target.value)} placeholder="Describe changes to the marked area" rows={3} /><button type="button" className="apply-edit" onClick={applyPreviewComment} disabled={!previewComment.trim()}>Add comment to chat</button></section></div>}
      {showStatus && <div className="status-badges" aria-label="Connection"><span className="status-badge">OpenAI API</span><span className="status-plus">+</span><span className="status-badge">GPT Мгновенный</span></div>}
      {error && <div className="error">{error}</div>}
      <form className={`composer ${dragActive ? "drag-active" : ""}`} onSubmit={submit} onPaste={(event) => { const incoming = Array.from(event.clipboardData.files || []); if (incoming.length) { event.preventDefault(); ingestFiles(incoming); } }}>
        {attachmentPreviews.length > 0 && <div className="attachment-strip">{attachmentPreviews.map((item, index) => <div className="attachment-chip" key={item.file.name + index}>{item.file.type.startsWith("image/") && <button type="button" className="attachment-thumb" onClick={() => openPreview(item.url, item.file.name)} title="Preview image"><img src={item.url} alt={item.file.name} /></button>}<span title={item.file.name}>{item.file.name}</span><button type="button" className="remove-attachment" onClick={() => removeFile(index)} aria-label={"Remove " + item.file.name} title="Remove"><X size={14} /></button></div>)}</div>}
        {dragActive && <div className="drop-overlay">Drop files here</div>}
        <label className="prompt-box"><span>Message</span><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); submit(event); } }} placeholder="Example: create the Grace Plan PDF package from all plans and photos..." rows={4} /></label>
        <div className="file-row" ref={containerRef}>
          <button type="button" className="file-button" onClick={toggleMenu} disabled={isSending || isPreparingFiles} aria-label="Attach files" title="Attach files" aria-expanded={menuOpen}>
            <Plus size={18} />
          </button>
          {menuOpen && (
            <div className="file-menu" role="menu">
              <button type="button" role="menuitem" onClick={selectOption}>Photos, files and ZIP</button>
            </div>
          )}
          <input type="file" ref={fileInputRef} multiple accept={accept} style={{display: 'none'}} onChange={handleFileChange} />
        </div>
        {isPreparingFiles && <span className="upload-preparing" role="status">Preparing attachments…</span>}
        <button type="submit" aria-label="Send" title="Send" disabled={isSending || isPreparingFiles || (!input.trim() && !files.length)}>Send<Send size={18} /></button>
      </form>
      <footer className="footer-links">
        <a href="/terms.html" target="_self">Условия</a>
        <a href="/privacy.html" target="_self">Конфиденциальность</a>
        <a href="/support.html" target="_self">Поддержка</a>
      </footer>
    </section></main>
  );
}
createRoot(document.getElementById("root")).render(<App />);


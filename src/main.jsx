import React, { useEffect, useMemo, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, Plus, Send, Trash2 } from "lucide-react";
import "./styles.css";
import { createConceptReviewPdf } from "./exportDraft.js";
import JSZip from "jszip";

const STORAGE_KEY = "grace-plan-chat-sessions";
const ACTIVE_KEY = "grace-plan-active-chat";
const progressSteps = ["Підготовка файлів", "Аналіз кожного фото", "Перевірка 2D-плану", "Зіставлення фото", "Формування даних Grace Plan", "Концептуальний 3D-рендер", "Верстка A2 PDF"];
const welcome = { role: "assistant", content: "Нужны фото 2D плана и +-5 фото минимум." };

const ARTIFACT_DB = "grace-plan-artifacts";
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

function createChat() { return { id: crypto.randomUUID(), title: "New chat", messages: [welcome], createdAt: Date.now() }; }
function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => message.content !== "Команда уже показана. Ожидаю новые данные.");
}
function loadChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved) && saved.length) return saved.map((chat) => ({ ...chat, messages: normalizeMessages(chat.messages) }));
    const oldMessages = JSON.parse(localStorage.getItem("grace-plan-chat-history") || "null");
    if (Array.isArray(oldMessages) && oldMessages.length) return [{ ...createChat(), title: "Saved chat", messages: normalizeMessages(oldMessages) }];
  } catch { return [createChat()]; }
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
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.82);
    if (data.length > 3_800_000) throw new Error("Снимок слишком большой после подготовки: " + file.name);
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
  const [activeChatId, setActiveChatId] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [photoProgress, setPhotoProgress] = useState("");
  const [executionOpen, setExecutionOpen] = useState(false);
  const [error, setError] = useState("");
  const [showStatus, setShowStatus] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accept, setAccept] = useState("image/jpeg,image/png,image/webp,.zip,application/zip");
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);

  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId) || chats[0], [activeChatId, chats]);
  const messages = activeChat?.messages || [welcome];

  useEffect(() => { if (!activeChatId && chats[0]) setActiveChatId(chats[0].id); }, [activeChatId, chats]);
  useEffect(() => { let live = true; hydrateArtifacts(chats).then((value) => { if (live) setChats(value); }).catch(() => {}); return () => { live = false; }; }, []);
  useEffect(() => {
    try {
      const safeChats = chats.map((chat) => ({ ...chat, messages: chat.messages.map((message) => ({
        ...message, artifacts: message.artifacts?.map(({ data, ...metadata }) => metadata)
      })) }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(safeChats));
    } catch { setError("Историю не удалось сохранить в браузере."); }
  }, [chats]);
  useEffect(() => { if (activeChat?.id) localStorage.setItem(ACTIVE_KEY, activeChat.id); }, [activeChat?.id]);
  useEffect(() => { const timer = window.setTimeout(() => setShowStatus(false), 5500); return () => window.clearTimeout(timer); }, []);
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
  function newChat() { const chat = createChat(); setChats((current) => [chat, ...current]); setActiveChatId(chat.id); setInput(""); setError(""); setFiles([]); }
  function clearChat() { updateActiveChat((chat) => ({ ...chat, title: "New chat", messages: [welcome] })); setError(""); }

  const handleFileChange = async (event) => {
    const selected = Array.from(event.target.files || []);
    const expanded = [];
    setError("");
    try {
      for (const file of selected) {
        if (/\\.zip$/i.test(file.name) || file.type === "application/zip") {
          const archive = await JSZip.loadAsync(file);
          const entries = Object.values(archive.files).filter((entry) => !entry.dir && /\\.(jpe?g|png|webp)$/i.test(entry.name));
          if (!entries.length) throw new Error(file.name + ": ZIP не содержит JPEG, PNG или WebP.");
          for (const entry of entries) {
            const extension = entry.name.split(".").pop().toLowerCase();
            const type = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
            const blob = await entry.async("blob");
            expanded.push(new File([blob], entry.name.split("/").pop(), { type }));
          }
        } else if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
          expanded.push(file);
        } else {
          throw new Error(file.name + ": поддерживаются изображения или ZIP с изображениями.");
        }
      }
      setFiles(expanded);
    } catch (fileError) {
      setFiles([]);
      setError(fileError.message);
    } finally {
      event.target.value = "";
      setMenuOpen(false);
    }
  };

  const toggleMenu = () => {
    setMenuOpen(!menuOpen);
  };

  const selectOption = () => {
    const allowed = "image/jpeg,image/png,image/webp,.zip,application/zip";
    setAccept(allowed);
    if (fileInputRef.current) {
      fileInputRef.current.accept = allowed;
      fileInputRef.current.click();
    }
    setMenuOpen(false);
  };

  async function submit(event) {
    event.preventDefault();
    const text = input.trim();
    if ((!text && !files.length) || isSending) return;
    const nextMessages = [...messages, { role: "user", content: text || "Проаналізуйте прикріплені файли." }];
    updateActiveChat((chat) => ({ ...chat, title: chat.messages.length === 1 ? makeTitle(text || files[0].name) : chat.title, messages: nextMessages }));
    setInput(""); setError(""); setIsSending(true); setCurrentStep(files.length ? 0 : 4); setPhotoProgress(files.length ? `0/${files.length}` : ""); setExecutionOpen(false);
    try {
      const photoObservations = [];
      for (const file of files) {
        setCurrentStep(0);
        const prepared = await prepareImage(file);
        setCurrentStep(1);
        const analysisResponse = await fetch("/api/analyze-image", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prepared)
        });
        const analysis = await analysisResponse.json();
        if (!analysisResponse.ok) throw new Error(file.name + ": " + (analysis.error || "Анализ не удался"));
        photoObservations.push(analysis);
        setPhotoProgress(`${photoObservations.length}/${files.length}`);
      }
      if (files.length) setCurrentStep(2);
      await new Promise((resolve) => window.setTimeout(resolve, files.length ? 250 : 0));
      if (files.length) setCurrentStep(3);
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: nextMessages, files: [], photoObservations }) });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(raw || "Сервер вернул некорректный ответ."); }
      if (!response.ok) throw new Error(data.error || "API error");
      setCurrentStep(4);
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      const previousAssistant = [...nextMessages].reverse().find((message) => message.role === "assistant");
      const answer = data.answer?.trim();
      let finalAnswer = answer && answer !== previousAssistant?.content?.trim()
        ? answer
        : "Результат не получен; проверьте входные данные.";
      const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
      const execution = Array.isArray(data.execution) ? data.execution : [];
      const wantsPdf = /pdf|пдф/i.test(text);
      const wantsRender = files.length > 1 || /3d|bim|render|рендер|візуал|визуал|зображ|картин|image|picture|pdf|пдф/i.test(text);
      if (wantsRender && files.length) {
        const planIndexes = photoObservations.map((item, index) =>
          /plan|план|drawing|чертёж|схема/i.test(String(item.observations?.kind || "") + " " + item.name) ? index : -1
        ).filter((index) => index >= 0);
        if (planIndexes.length === 1 && files.length > 1) {
          setCurrentStep(5);
          try {
            const plan = (await prepareImage(files[planIndexes[0]])).data;
            const photos = files.filter((_, index) => index !== planIndexes[0]);
            const contactSheets = await makeContactSheets(photos);
            const renderResponse = await fetch("/api/render-concept", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ plan, contactSheets, photoCount: photos.length })
            });
            const result = await renderResponse.json();
            if (!renderResponse.ok) throw new Error(result.error || "Render failed");
            artifacts.push(result.artifact);
            finalAnswer += "\\n\\n3D: концептуальный рендер готов; точная BIM-геометрия и связь всех комнат с фото не подтверждены.";
            if (wantsPdf) {
              setCurrentStep(6);
              const pdfUrl = await createConceptReviewPdf({ renderData: result.artifact.data, planData: plan, photoCount: photos.length });
              artifacts.push({ type: "pdf", name: "GracePlan_6A2_concept_package.pdf", data: pdfUrl });
              finalAnswer += "\\nA2: сформовано комплект із 6 аркушів за композицією еталона. Точне BIM/IFC і вимір відхилення 21% потребують каліброваної геометрії.";
            }
          } catch (renderError) { finalAnswer += "\n\n3D: не сформирован — " + renderError.message; }
        } else {
          finalAnswer += "\n\n3D: нужен ровно один распознанный 2D-план и фотографии одного этажа.";
        }
      }
      const messageId = crypto.randomUUID();
      const persistedArtifacts = await persistArtifacts(messageId, artifacts);
      updateActiveChat((chat) => ({ ...chat, messages: [...nextMessages, { id: messageId, role: "assistant", content: finalAnswer, artifacts: persistedArtifacts, execution }] }));
      setFiles([]);
    } catch (err) {
      setError(err.message);
      updateActiveChat((chat) => ({ ...chat, messages }));
    } finally {
      setCurrentStep(-1); setIsSending(false);
    }
  }

  return (
    <main className="app-shell"><section className="chat-panel" aria-label="Grace Planner chat">
      <header className="topbar"><div className="brand-row"><div className="brand-text" aria-label="Grace AI Planner">Grace AI Planner</div></div>
        <nav className="chat-tabs" aria-label="Chats">{chats.map((chat) => <button className={chat.id === activeChat.id ? "chat-tab active" : "chat-tab"} key={chat.id} type="button" onClick={() => setActiveChatId(chat.id)}>{chat.title}</button>)}</nav>
        <div className="header-actions"><button className="icon-button" type="button" onClick={newChat} aria-label="New chat" title="New chat"><Plus size={18} /></button><button className="icon-button" type="button" onClick={clearChat} aria-label="Clear chat" title="Clear chat"><Trash2 size={18} /></button></div>
      </header>
      <div className="messages" aria-live="polite">
        {messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "Ви" : "Grace Plan"}</span><p>{message.content}</p>{message.execution?.length > 0 && <details className="command-log"><summary>Команди виконання</summary>{message.execution.map((item) => <div className={`command-row ${item.status}`} key={item.id}><strong>{item.id} · {item.label}</strong><span>{item.detail}</span></div>)}</details>}{message.artifacts?.map((artifact) => artifact.data ? <a className="artifact-link" href={artifact.data} download={artifact.name} key={artifact.name}>{artifact.name}</a> : <span className="artifact-unavailable" key={artifact.name}>{artifact.name} — файл доступний лише до оновлення сторінки</span>)}</article>)}
        {isSending && <article className="message assistant progress-message"><span>Grace Plan</span>
          <div className={`execution-spoiler ${executionOpen ? "open" : ""}`}>
            <button className="execution-summary" type="button" onClick={() => setExecutionOpen((open) => !open)} aria-expanded={executionOpen}>
              <i className="status-spinner" aria-hidden="true" />
              <strong key={currentStep}>{(progressSteps[currentStep] || "Выполнение команды") + (currentStep === 0 ? " " + photoProgress : "")}<b className="typing-dots"><em>.</em><em>.</em><em>.</em></b></strong>
              <ChevronDown className="spoiler-chevron" size={16} aria-hidden="true" />
            </button>
            <div className="execution-details" aria-hidden={!executionOpen}><div>
              {progressSteps.slice(0, currentStep + 1).map((step, index) => <p className={index === currentStep ? "active" : "done"} key={step}>{index === currentStep ? <i className="mini-spinner" aria-hidden="true" /> : <span aria-hidden="true">✓</span>}<span>{step}</span></p>)}
            </div></div>
          </div>
        </article>}
      </div>
      {showStatus && <div className="status-badges" aria-label="Connection"><span className="status-badge">OpenAI API</span><span className="status-plus">+</span><span className="status-badge">GPT Мгновенный</span></div>}
      {error && <div className="error">{error}</div>}
      <form className="composer" onSubmit={submit}>
        <label className="prompt-box"><span>Message</span><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Example: create the Grace Plan PDF package from all plans and photos..." rows={4} /></label>
        <label className="file-row" ref={containerRef}>
          <button type="button" className="file-button" onClick={toggleMenu} aria-label="Выберите файлы" title="Выберите файлы">
            <Plus size={18} />
          </button>
          {menuOpen && (
            <div className="file-menu" role="menu">
              <button type="button" role="menuitem" onClick={selectOption}>Photos, files and ZIP</button>
            </div>
          )}
          <input type="file" ref={fileInputRef} multiple accept={accept} style={{display: 'none'}} onChange={handleFileChange} />
        </label>
        <button type="submit" disabled={isSending || (!input.trim() && !files.length)}>Send<Send size={18} /></button>
      </form>
    </section></main>
  );
}
createRoot(document.getElementById("root")).render(<App />);

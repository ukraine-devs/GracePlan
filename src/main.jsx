import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, Plus, Send, Trash2 } from "lucide-react";
import "./styles.css";
import { createConceptReviewPdf } from "./exportDraft.js";

const STORAGE_KEY = "grace-plan-chat-sessions";
const ACTIVE_KEY = "grace-plan-active-chat";
const progressSteps = ["Анализ фото", "Сборка ответа", "Концептуальный рендер"];
const welcome = { role: "assistant", content: "Нужны фото 2D плана и +-5 фото минимум." };

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
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId) || chats[0], [activeChatId, chats]);
  const messages = activeChat?.messages || [welcome];

  useEffect(() => { if (!activeChatId && chats[0]) setActiveChatId(chats[0].id); }, [activeChatId, chats]);
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
  function updateActiveChat(updater) { setChats((current) => current.map((chat) => (chat.id === activeChat.id ? updater(chat) : chat))); }
  function newChat() { const chat = createChat(); setChats((current) => [chat, ...current]); setActiveChatId(chat.id); setInput(""); setError(""); setFiles([]); }
  function clearChat() { updateActiveChat((chat) => ({ ...chat, title: "New chat", messages: [welcome] })); setError(""); }

  async function submit(event) {
    event.preventDefault();
    const text = input.trim();
    if ((!text && !files.length) || isSending) return;
    const nextMessages = [...messages, { role: "user", content: text || "Проаналізуйте прикріплені файли." }];
    updateActiveChat((chat) => ({ ...chat, title: chat.messages.length === 1 ? makeTitle(text || files[0].name) : chat.title, messages: nextMessages }));
    setInput(""); setError(""); setIsSending(true); setCurrentStep(files.length ? 0 : 1); setPhotoProgress(files.length ? `0/${files.length}` : ""); setExecutionOpen(false);
    try {
      const photoObservations = [];
      for (const file of files) {
        const prepared = await prepareImage(file);
        const analysisResponse = await fetch("/api/analyze-image", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prepared)
        });
        const analysis = await analysisResponse.json();
        if (!analysisResponse.ok) throw new Error(file.name + ": " + (analysis.error || "Анализ не удался"));
        photoObservations.push(analysis);
        setPhotoProgress(`${photoObservations.length}/${files.length}`);
      }
      setCurrentStep(1);
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: nextMessages, files: [], photoObservations }) });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(raw || "Сервер вернул некорректный ответ."); }
      if (!response.ok) throw new Error(data.error || "API error");
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      const previousAssistant = [...nextMessages].reverse().find((message) => message.role === "assistant");
      const answer = data.answer?.trim();
      let finalAnswer = answer && answer !== previousAssistant?.content?.trim()
        ? answer
        : "Результат не получен; проверьте входные данные.";
      const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
      const wantsPdf = /pdf|пдф/i.test(text);
      const wantsRender = /3d|bim|render|рендер|візуал|визуал|pdf|пдф/i.test(text);
      if (wantsRender && files.length) {
        const planIndexes = photoObservations.map((item, index) =>
          /plan|план|drawing|чертёж|схема/i.test(String(item.observations?.kind || "") + " " + item.name) ? index : -1
        ).filter((index) => index >= 0);
        if (planIndexes.length === 1 && files.length > 1) {
          setCurrentStep(2);
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
              const pdfUrl = await createConceptReviewPdf({ renderData: result.artifact.data, planData: plan, photoCount: photos.length });
              artifacts.push({ type: "pdf", name: "GracePlan_A2_concept_review.pdf", data: pdfUrl });
              finalAnswer += "\\nA2: создан один черновой лист по композиции эталона; полный комплект 6 A2 и оценка отклонения 21% ещё недоступны.";
            }
          } catch (renderError) { finalAnswer += "\n\n3D: не сформирован — " + renderError.message; }
        } else {
          finalAnswer += "\n\n3D: нужен ровно один распознанный 2D-план и фотографии одного этажа.";
        }
      }
      updateActiveChat((chat) => ({ ...chat, messages: [...nextMessages, { role: "assistant", content: finalAnswer, artifacts }] }));
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
      <header className="topbar"><div className="brand-row"><div className="brand-text" aria-label="Grace AI"><span>Grace</span><span>AI</span></div></div>
        <div className="header-actions"><button className="icon-button" type="button" onClick={newChat} aria-label="New chat" title="New chat"><Plus size={18} /></button><button className="icon-button" type="button" onClick={clearChat} aria-label="Clear chat" title="Clear chat"><Trash2 size={18} /></button></div>
      </header>
      <nav className="chat-tabs" aria-label="Chats">{chats.map((chat) => <button className={chat.id === activeChat.id ? "chat-tab active" : "chat-tab"} key={chat.id} type="button" onClick={() => setActiveChatId(chat.id)}>{chat.title}</button>)}</nav>
      <div className="messages" aria-live="polite">
        {messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "Ви" : "Grace Plan"}</span><p>{message.content}</p>{message.artifacts?.map((artifact) => artifact.data ? <a className="artifact-link" href={artifact.data} download={artifact.name} key={artifact.name}>{artifact.name}</a> : <span className="artifact-unavailable" key={artifact.name}>{artifact.name} — файл доступен только до обновления страницы</span>)}</article>)}
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
      <form className="composer" onSubmit={submit}><label className="file-row"><span>Project files</span><input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => setFiles(Array.from(event.target.files || []))} /></label><label className="prompt-box"><span>Message</span><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Example: create the Grace Plan PDF package from all plans and photos..." rows={4} /></label><button type="submit" disabled={isSending || (!input.trim() && !files.length)}>Send<Send size={18} /></button></form>
    </section></main>
  );
}
createRoot(document.getElementById("root")).render(<App />);

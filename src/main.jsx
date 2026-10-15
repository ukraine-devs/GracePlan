import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, ChevronDown, Plus, Send, Trash2 } from "lucide-react";
import "./styles.css";

const STORAGE_KEY = "grace-plan-chat-sessions";
const ACTIVE_KEY = "grace-plan-active-chat";
const progressSteps = ["Загрузка файлов", "Проверка 2D-плана", "Сопоставление фото", "Построение 3D-плана", "Формирование Grace Plan"];
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
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type || "application/octet-stream", size: file.size, data: reader.result });
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function App() {
  const [chats, setChats] = useState(loadChats);
  const [activeChatId, setActiveChatId] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [executionOpen, setExecutionOpen] = useState(false);
  const [error, setError] = useState("");
  const [showStatus, setShowStatus] = useState(true);
  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId) || chats[0], [activeChatId, chats]);
  const messages = activeChat?.messages || [welcome];

  useEffect(() => { if (!activeChatId && chats[0]) setActiveChatId(chats[0].id); }, [activeChatId, chats]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(chats)); }, [chats]);
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
    setInput(""); setError(""); setIsSending(true); setCurrentStep(0); setExecutionOpen(false);
    const timer = window.setInterval(() => setCurrentStep((step) => Math.min(step + 1, progressSteps.length - 1)), 1200);
    try {
      const filePayload = await Promise.all(files.map(readFile));
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: nextMessages, files: filePayload }) });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(raw || "Сервер вернул некорректный ответ."); }
      if (!response.ok) throw new Error(data.error || "API error");
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      const previousAssistant = [...nextMessages].reverse().find((message) => message.role === "assistant");
      const answer = data.answer?.trim();
      const finalAnswer = answer && answer !== previousAssistant?.content?.trim()
        ? answer
        : files.length
          ? "Команда обработана. Проверьте результат и следующий этап."
          : "Для выполнения нужны 2D-план и минимум 5 фотографий.";
      updateActiveChat((chat) => ({ ...chat, messages: [...nextMessages, { role: "assistant", content: finalAnswer }] }));
      setFiles([]);
    } catch (err) {
      setError(err.message);
      updateActiveChat((chat) => ({ ...chat, messages }));
    } finally {
      window.clearInterval(timer); setCurrentStep(-1); setIsSending(false);
    }
  }

  return (
    <main className="app-shell"><section className="chat-panel" aria-label="Grace Planner chat">
      <header className="topbar"><div className="brand-row"><div className="brand-text" aria-label="Grace AI"><span>Grace</span><span>AI</span></div></div>
        <div className="header-actions"><button className="icon-button" type="button" onClick={newChat} aria-label="New chat" title="New chat"><Plus size={18} /></button><button className="icon-button" type="button" onClick={clearChat} aria-label="Clear chat" title="Clear chat"><Trash2 size={18} /></button></div>
      </header>
      <nav className="chat-tabs" aria-label="Chats">{chats.map((chat) => <button className={chat.id === activeChat.id ? "chat-tab active" : "chat-tab"} key={chat.id} type="button" onClick={() => setActiveChatId(chat.id)}>{chat.title}</button>)}</nav>
      <div className="messages" aria-live="polite">
        {messages.map((message, index) => <article className={`message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "Ви" : "Grace Plan"}</span><p>{message.content}</p></article>)}
        {isSending && <article className="message assistant progress-message"><span>Grace Plan</span>
          <div className={`execution-spoiler ${executionOpen ? "open" : ""}`}>
            <button className="execution-summary" type="button" onClick={() => setExecutionOpen((open) => !open)} aria-expanded={executionOpen}>
              <i className="status-spinner" aria-hidden="true" />
              <strong key={currentStep}>{progressSteps[currentStep] || "Выполнение команды"}<b className="typing-dots"><em>.</em><em>.</em><em>.</em></b></strong>
              <ChevronDown className="spoiler-chevron" size={16} aria-hidden="true" />
            </button>
            <div className="execution-details" aria-hidden={!executionOpen}><div>
              {progressSteps.slice(0, currentStep + 1).map((step, index) => <p className={index === currentStep ? "active" : "done"} key={step}>{index === currentStep ? <i className="mini-spinner" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}<span>{step}</span></p>)}
            </div></div>
          </div>
        </article>}
      </div>
      {showStatus && <div className="status-badges" aria-label="Connection"><span className="status-badge">OpenAI API</span><span className="status-plus">+</span><span className="status-badge">GPT Мгновенный</span></div>}
      {error && <div className="error">{error}</div>}
      <form className="composer" onSubmit={submit}><label className="file-row"><span>Project files</span><input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files || []))} /></label><label className="prompt-box"><span>Message</span><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Example: create the Grace Plan PDF package from all plans and photos..." rows={4} /></label><button type="submit" disabled={isSending || (!input.trim() && !files.length)}>Send<Send size={18} /></button></form>
    </section></main>
  );
}
createRoot(document.getElementById("root")).render(<App />);

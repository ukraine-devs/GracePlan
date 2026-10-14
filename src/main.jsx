import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Plus, Send, Trash2 } from "lucide-react";
import "./styles.css";

const STORAGE_KEY = "grace-plan-chat-sessions";
const ACTIVE_KEY = "grace-plan-active-chat";

const welcome = {
  role: "assistant",
  content: "Нужны фото 2D плана и +-5 фото минимум.",
};

function createChat() {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [welcome],
    createdAt: Date.now(),
  };
}

function loadChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved) && saved.length) return saved;

    const oldMessages = JSON.parse(localStorage.getItem("grace-plan-chat-history") || "null");
    if (Array.isArray(oldMessages) && oldMessages.length) {
      return [{ ...createChat(), title: "Saved chat", messages: oldMessages }];
    }
  } catch {
    return [createChat()];
  }
  return [createChat()];
}

function makeTitle(text) {
  return text.length > 28 ? `${text.slice(0, 28)}...` : text || "New chat";
}

function App() {
  const [chats, setChats] = useState(loadChats);
  const [activeChatId, setActiveChatId] = useState(() => localStorage.getItem(ACTIVE_KEY) || null);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const [showStatus, setShowStatus] = useState(true);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) || chats[0],
    [activeChatId, chats],
  );
  const messages = activeChat?.messages || [welcome];

  useEffect(() => {
    if (!activeChatId && chats[0]) setActiveChatId(chats[0].id);
  }, [activeChatId, chats]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  }, [chats]);

  useEffect(() => {
    if (activeChat?.id) localStorage.setItem(ACTIVE_KEY, activeChat.id);
  }, [activeChat?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowStatus(false), 5500);
    return () => window.clearTimeout(timer);
  }, []);

  function updateActiveChat(updater) {
    setChats((current) => current.map((chat) => (chat.id === activeChat.id ? updater(chat) : chat)));
  }

  function newChat() {
    const chat = createChat();
    setChats((current) => [chat, ...current]);
    setActiveChatId(chat.id);
    setInput("");
    setError("");
  }

  function clearChat() {
    updateActiveChat((chat) => ({ ...chat, title: "New chat", messages: [welcome] }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isSending) return;

    const nextMessages = [...messages, { role: "user", content: text }];
    updateActiveChat((chat) => ({
      ...chat,
      title: chat.messages.length === 1 ? makeTitle(text) : chat.title,
      messages: nextMessages,
    }));
    setInput("");
    setError("");
    setIsSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages,
          files: files.map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "API error");
      const finalMessages = [...nextMessages, { role: "assistant", content: data.answer }];
      updateActiveChat((chat) => ({ ...chat, messages: finalMessages }));
    } catch (err) {
      setError(err.message);
      updateActiveChat((chat) => ({ ...chat, messages }));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="chat-panel" aria-label="Grace Planner chat">
        <header className="topbar">
          <div className="brand-row">
            <div className="brand-text" aria-label="Grace AI">
              <span>Grace</span>
              <span>AI</span>
            </div>
          </div>
          <div className="header-actions">
            <button className="icon-button" type="button" onClick={newChat} aria-label="New chat" title="New chat">
              <Plus size={18} />
            </button>
            <button className="icon-button" type="button" onClick={clearChat} aria-label="Clear chat" title="Clear chat">
              <Trash2 size={18} />
            </button>
          </div>
        </header>

        <nav className="chat-tabs" aria-label="Chats">
          {chats.map((chat) => (
            <button
              className={chat.id === activeChat.id ? "chat-tab active" : "chat-tab"}
              key={chat.id}
              type="button"
              onClick={() => setActiveChatId(chat.id)}
            >
              {chat.title}
            </button>
          ))}
        </nav>

        <div className="messages" aria-live="polite">
          {messages.map((message, index) => (
            <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "user" ? "Ви" : "Grace Plan"}</span>
              <p>{message.content}</p>
            </article>
          ))}
          {isSending && (
            <article className="message assistant">
              <span>Grace Plan</span>
              <p>Thinking...</p>
            </article>
          )}
        </div>

        {showStatus && (
          <div className="status-badges" aria-label="Connection">
            <span className="status-badge">OpenAI API</span>
            <span className="status-plus">+</span>
            <span className="status-badge">GPT Мгновенный</span>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <form className="composer" onSubmit={submit}>
          <label className="file-row">
            <span>Project files</span>
            <input
              type="file"
              multiple
              onChange={(event) => setFiles(Array.from(event.target.files || []))}
            />
          </label>
          <label className="prompt-box">
            <span>Message</span>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Example: create the Grace Plan PDF package from all plans and photos..."
              rows={4}
            />
          </label>
          <button type="submit" disabled={isSending || !input.trim()}>
            Send
            <Send size={18} />
          </button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

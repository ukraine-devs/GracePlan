import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Send, ShieldCheck } from "lucide-react";
import "./styles.css";

const welcome = {
  role: "assistant",
  content: "Нужны фото 2D плана и +-5 фото минимум.",
};

function App() {
  const [messages, setMessages] = useState([welcome]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isSending) return;

    const nextMessages = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
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
      setMessages([...nextMessages, { role: "assistant", content: data.answer }]);
    } catch (err) {
      setError(err.message);
      setMessages(messages);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="chat-panel" aria-label="Grace Planner chat">
        <header className="topbar">
          <div className="brand-row">
            <div className="brand-mark">GP</div>
            <div>
              <h1>Grace Planner</h1>
              <p>Grace AI</p>
            </div>
          </div>
          <div className="secure-badge">
            <ShieldCheck size={18} />
            <span>(OpenAI API) + (GPT Мгновенный)</span>
          </div>
        </header>

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

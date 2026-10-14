import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, FileUp, LockKeyhole, MessageSquareText, ShieldCheck } from "lucide-react";
import "./styles.css";

const DEFAULT_GRACE_PLAN_URL = "https://chatgpt.com/plugins/plugins_6ace24a6236c81918643c1d355f8ef4a";

function App() {
  const [prompt, setPrompt] = useState("Создай комплект 6 A2 с BIM-разрезами, схемами CCTV/Wi-Fi/NAS/NVR и сметами по всем загруженным планам и фото.");
  const gracePlanUrl = import.meta.env.VITE_GRACE_PLAN_URL || DEFAULT_GRACE_PLAN_URL;

  const launchUrl = useMemo(() => {
    const url = new URL(gracePlanUrl);
    if (prompt.trim()) {
      url.searchParams.set("q", prompt.trim());
    }
    return url.toString();
  }, [gracePlanUrl, prompt]);

  const openGracePlan = () => {
    window.open(launchUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <main className="app-shell">
      <section className="chat-panel" aria-label="Grace Planner chat launcher">
        <div className="brand-row">
          <div className="brand-mark">GP</div>
          <div>
            <h1>Grace Planner</h1>
            <p>Запуск только вашего Grace Plan в авторизованном ChatGPT.</p>
          </div>
        </div>

        <div className="status-grid">
          <div>
            <LockKeyhole size={18} />
            <span>Вход остается на chatgpt.com</span>
          </div>
          <div>
            <ShieldCheck size={18} />
            <span>Токены и пароль не вводятся на сайте</span>
          </div>
          <div>
            <MessageSquareText size={18} />
            <span>Открывается только Grace Plan</span>
          </div>
        </div>

        <label className="prompt-box">
          <span>Стартовая команда</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
          />
        </label>

        <div className="actions">
          <button type="button" onClick={openGracePlan}>
            Открыть Grace Plan
            <ExternalLink size={18} />
          </button>
          <a href={gracePlanUrl} target="_blank" rel="noreferrer">
            Проверить доступ
          </a>
        </div>
      </section>

      <aside className="info-panel" aria-label="Project files">
        <h2>Рабочий поток</h2>
        <ul>
          <li><FileUp size={16} />Загрузите планы и фотографии в открывшийся чат Grace Plan.</li>
          <li><FileUp size={16} />Вставьте команду из поля слева или измените ее перед запуском.</li>
          <li><FileUp size={16} />Получайте PDF, ZIP и проектные материалы внутри ChatGPT.</li>
        </ul>
        <p>
          Из-за защиты ChatGPT полноценный чат нельзя встроить в iframe как чужую авторизованную сессию.
          Этот сайт делает правильный безопасный вариант: открывает ваш Grace Plan в аккаунте,
          где пользователь уже вошел.
        </p>
      </aside>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

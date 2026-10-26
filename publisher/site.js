// Reads the active Grace Planner chat from this origin's own localStorage and
// turns it into the text that will be published into ChatGPT.
(() => {
  const first = ["grace-plan-chats", "grace-plan-chat-history"];

  function readChats() {
    for (const key of first) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || "null");
        if (Array.isArray(raw) && raw.length) return { key, chats: raw };
      } catch {}
    }
    return { key: null, chats: [] };
  }

  function normalize(raw) {
    // The newest store keeps {id,title,messages[],createdAt}; the old one kept a
    // bare message array.
    if (Array.isArray(raw) && raw.length && raw[0] && raw[0].role) return [{ id: "legacy", title: "Saved chat", messages: raw }];
    return raw.filter((chat) => chat && Array.isArray(chat.messages));
  }

  function transcript(chat) {
    const lines = [`Grace Planner — чат «${chat.title || "Без названия"}»`, "", "Ниже полная расшифровка диалога из Grace Planner.", ""];
    for (const message of chat.messages || []) {
      const text = String(message.content || "").trim();
      if (!text) continue;
      lines.push((message.role === "user" ? "Пользователь: " : "Ассистент: ") + text, "");
      for (const artifact of message.artifacts || []) lines.push(`[файл: ${artifact.name}]`);
    }
    lines.push("Продолжай этот диалог с текущего места.");
    return lines.join("\n");
  }

  function current() {
    const { chats } = readChats();
    const list = normalize(chats);
    if (!list.length) return null;
    const activeId = localStorage.getItem("grace-plan-active-chat");
    const chat = list.find((item) => item.id === activeId) || list[0];
    return { title: chat.title || "Grace Planner chat", text: transcript(chat), messages: (chat.messages || []).length };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "GRACE_TRANSCRIPT") return;
    try {
      const chat = current();
      if (!chat) throw new Error("На сайте не найден чат с сообщениями.");
      sendResponse({ ok: true, ...chat });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  });
})();

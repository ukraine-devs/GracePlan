// Drives the signed-in ChatGPT tab. It never touches network endpoints: only the
// visible composer and send button, exactly like a person typing.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (node) => !!node && node.getClientRects().length > 0;

  function composer() {
    return [...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"][role="textbox"],textarea')].find(visible) || null;
  }
  function sendButton() {
    return document.querySelector('button[aria-label="Send"]')
      || document.querySelector('[data-testid="send-button"]')
      || [...document.querySelectorAll("button")].find((b) => /^send/i.test(b.getAttribute("aria-label") || "") && visible(b))
      || null;
  }
  function generating() {
    return !!document.querySelector('[data-testid="stop-button"]');
  }
  function signedOut() {
    return [...document.querySelectorAll("a,button")].filter(visible)
      .some((n) => /^(log in|sign in|войти)$/i.test((n.innerText || "").trim()));
  }
  function chatId() {
    const m = location.href.match(/\/c\/([0-9a-f-]{20,60})/i);
    return m ? m[1] : null;
  }
  function inProject() {
    return /^\/g\/g-p-[0-9a-z-]+\//i.test(location.pathname);
  }

  async function waitFor(check, timeout = 60000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = check();
      if (value) return value;
      await sleep(400);
    }
    return null;
  }

  async function publishPart(text) {
    if (signedOut()) throw new Error("Войдите в ChatGPT в этой вкладке.");
    if (!inProject()) throw new Error("Откройте страницу проекта ChatGPT (адрес содержит /g/g-p-…).");
    const editor = await waitFor(composer, 60000);
    if (!editor) throw new Error("Поле ввода ChatGPT не найдено. Обновите вкладку.");
    if (generating()) await waitFor(() => !generating(), 180000);

    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand("insertText", false, text)) throw new Error("ChatGPT не принял текст (поле ввода изменилось).");

    const button = await waitFor(() => {
      const candidate = sendButton();
      return candidate && !candidate.disabled ? candidate : null;
    }, 30000);
    if (!button) throw new Error("Кнопка отправки недоступна.");

    const beforeId = chatId();
    button.click();
    const emptied = await waitFor(() => !(editor.innerText || "").trim(), 30000);
    if (!emptied) throw new Error("Сообщение не отправилось (текст остался в поле).");

    // A new conversation gets its id only after the first message is sent.
    const id = beforeId || await waitFor(chatId, 60000);
    if (!id) throw new Error("Не удалось определить адрес созданного чата.");
    await waitFor(() => !generating(), 240000);
    return { url: location.origin + location.pathname, chatId: id };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GRACE_PUBLISH_PART") {
      publishPart(String(message.text || ""))
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "GRACE_PING") {
      sendResponse({ ok: true, inProject: inProject(), signedOut: signedOut(), chatId: chatId() });
      return true;
    }
  });
})();

const DEFAULT_PROJECT = "https://chatgpt.com/g/g-p-6ade243a41e48191b297ec2ac5c7e822-grace-planner/project";
const projectInput = document.getElementById("project");
const button = document.getElementById("go");
const status = document.getElementById("status");

const setStatus = (text, kind = "") => {
  status.className = kind;
  status.innerHTML = text;
};

chrome.storage.local.get("projectUrl").then(({ projectUrl }) => {
  projectInput.value = projectUrl || DEFAULT_PROJECT;
});

button.addEventListener("click", async () => {
  const projectUrl = projectInput.value.trim() || DEFAULT_PROJECT;
  if (!/^https:\/\/chatgpt\.com\/g\/g-p-[0-9a-z-]+\/project/i.test(projectUrl)) {
    setStatus("Нужна ссылка вида https://chatgpt.com/g/g-p-…/project", "err");
    return;
  }
  await chrome.storage.local.set({ projectUrl });
  button.disabled = true;
  setStatus("Читаю чат на сайте и печатаю в ChatGPT… это может занять до минуты.");
  try {
    const result = await chrome.runtime.sendMessage({ type: "GRACE_PUBLISH", projectUrl });
    if (!result?.ok) throw new Error(result?.error || "Не удалось опубликовать.");
    setStatus(`Готово: ${result.parts} част. · чат «${result.title}»<br><a href="${result.url}" target="_blank">Открыть в ChatGPT</a>`, "ok");
  } catch (error) {
    setStatus("Ошибка: " + error.message, "err");
  } finally {
    button.disabled = false;
  }
});

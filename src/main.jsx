import React, { useEffect, useMemo, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, Menu, Pencil, Plus, Send, Trash2, X, Download } from "lucide-react";
import "./styles.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ACCEPT_FILES, expandUploads, readFileDataUrl } from "./uploads.js";
import { routeIntent, isPlanObservation } from "../lib/graceIntent.js";
import { createExecutionLog } from "../lib/executionLog.js";
import { browserBridgeStatus, sendToBrowserChat } from "./browserBridge.js";

const STORAGE_KEY = "grace-plan-chat-sessions";
const ACTIVE_KEY = "grace-plan-active-chat";
const progressSteps = ["Підготовка файлів", "Аналіз кожного фото", "Перевірка 2D-плану", "Зіставлення фото", "Формування даних Grace Plan", "Концептуальний 3D-рендер", "Верстка A2 PDF"];
const welcome = { role: "assistant", content: "Привіт! Можна просто поспілкуватися або розпочати проєкт через @grace. Для пропозиції завантажте 2D-план і фотографії приміщень." };

function MessageText({ text }) {
  return <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{text}</ReactMarkdown></div>;
}

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
    // A lossless analysis derivative keeps thin lines more legible. The original
    // is independently retained and is the only image used on the PDF source plan.
    const data = /plan|план|креслен|drawing/i.test(file.name) ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.86);
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
  const [connectionMode, setConnectionMode] = useState("api");
  const [bridgeStatus, setBridgeStatus] = useState({installed:false,paired:false});
  const [bridgeHelp, setBridgeHelp] = useState(false);
  const [browserReply, setBrowserReply] = useState("");
  const [error, setError] = useState("");
  const [showStatus, setShowStatus] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accept, setAccept] = useState("image/jpeg,image/png,image/webp,.zip,application/zip");
  const containerRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragDepth = useRef(0);
  const messagesRef = useRef(null);

  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId) || chats[0], [activeChatId, chats]);
  const messages = activeChat?.messages || [welcome];
  useEffect(() => {localStorage.setItem("grace-connection-mode-v2",connectionMode);},[connectionMode]);
  useEffect(() => {
    let live=true;
    const refresh=()=>browserBridgeStatus(activeChat.id,activeChat.title).then(status=>{if(live)setBridgeStatus(status);});
    refresh();window.addEventListener("focus",refresh);
    return ()=>{live=false;window.removeEventListener("focus",refresh);};
  },[activeChat.id,activeChat.title,bridgeHelp]);
  const attachmentPreviews = useMemo(() => files.map((file) => ({ file, url: URL.createObjectURL(file) })), [files]);
  const agentState = isPreparingFiles ? "reading" : !isSending ? "idle" : currentStep <= 1 ? "reading" : currentStep <= 3 ? "command" : currentStep === 4 ? activityTone : currentStep === 5 ? "command" : "writing";

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
  function newChat() { const chat = createChat(); setChats((current) => [chat, ...current]); setActiveChatId(chat.id); setInput(""); setError(""); setFiles([]); }
  function renameChat(chatId, title) {
    setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, title: title.slice(0, 80) || "New chat" } : chat));
  }
  function deleteChat(chatId) {
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

  async function submitBrowser(event) {
    event.preventDefault();
    const text=input.trim(),submitted=[...files];
    if((!text&&!submitted.length)||isSending||isPreparingFiles)return;
    const status=bridgeStatus;
    if(!status.paired||status.chatId!==activeChat.id){setBridgeHelp(true);setError(status.reason||"Pair this chat with your signed-in ChatGPT tab. No API request was made.");return;}
    const chatId=activeChat.id,userId=crypto.randomUUID(),answerId=crypto.randomUUID();
    const writeChat=(updater)=>setChats(current=>current.map(chat=>chat.id===chatId?updater(chat):chat));
    const next=[...messages,{id:userId,role:"user",content:text||"Review all attached images and create the final proposal PDF."}];
    writeChat(chat=>({...chat,title:chat.messages.length===1?makeTitle(text||submitted[0]?.name):chat.title,messages:next}));
    setFiles([]);setInput("");setError("");setIsSending(true);setGraceSession(true);setExecutionOpen(true);setRunLog([]);setBrowserReply("");setCurrentStep(0);
    const log=createExecutionLog(setRunLog);let chatUrl=status.chatUrl,activeStage=null;
    try{
      const previews=[];
      for(const file of submitted){const prepared=await prepareImage(file);previews.push({type:"image",name:file.relativePath||file.name,data:prepared.data});}
      if(previews.length){next[next.length-1].artifacts=await persistArtifacts(userId,previews);writeChat(chat=>({...chat,messages:[...next]}));}
      log.stage("browser","Sending through your ChatGPT browser session");
      const result=await sendToBrowserChat({chatId,text:text||"Use every attached image and create the final Grace Plan PDF. Do not substitute intermediate JSON/CSV/SVG files for the final PDF.",files:submitted,onEvent:event=>{
        if(event.chatUrl)chatUrl=event.chatUrl;
        if(event.kind==="text")setBrowserReply(event.text);
        if(event.kind==="stage"){if(activeStage&&activeStage.id!==event.stage)log.stage(activeStage.id,activeStage.label,"done");setCurrentStep(event.stage==="upload"?0:4);log.stage(event.stage,event.label);activeStage={id:event.stage,label:event.label};}
      }});
      log.stage("browser","ChatGPT response received","done");
      if(activeStage)log.stage(activeStage.id,activeStage.label,"done");
      const saved=await persistArtifacts(answerId,result.artifacts||[]);
      const content=result.text+(result.pdfAvailableInChatGPT?"\n\nChatGPT returned a PDF link; its file transfer could not be verified. Open the original conversation.":"");
      writeChat(chat=>({...chat,chatgptUrl:chatUrl,messages:[...next,{id:answerId,role:"assistant",content,artifacts:saved,execution:log.snapshot(),chatgptUrl:chatUrl}]}));
    }catch(error){if(activeStage)log.stage(activeStage.id,activeStage.label,"failed");log.stage("browser",error.message,"failed");setError(error.message);writeChat(chat=>({...chat,chatgptUrl:chatUrl,messages:[...next,{id:answerId,role:"assistant",content:error.message,execution:log.snapshot(),chatgptUrl:chatUrl}]}));}
    finally{setIsSending(false);setCurrentStep(-1);setBrowserReply("");}
  }
  async function submit(event) {if(connectionMode==="chatgpt")return submitBrowser(event);return submitApi(event);}
  async function submitApi(event) {
    event.preventDefault();
    const text = input.trim();
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
    setInput(""); setError(""); setFiles([]); setIsSending(true);
    setCurrentStep(submittedFiles.length ? 0 : 4); setPhotoProgress(""); setExecutionOpen(true);
    setProgressPreviews([]); setRunLog([]);
    const actualExecution = createExecutionLog(setRunLog);
    const stage = actualExecution.stage;
    const userArtifacts = [];
    try {
      const photoObservations = [];
      const preparedImages = [];
      for (let index = 0; index < submittedFiles.length; index++) {
        const file = submittedFiles[index];
        setCurrentStep(0); stage("read-" + index, "Reading " + file.name);
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
      if (!submittedFiles.length && projectMode) artifacts.push(...previousArtifacts.filter((item) => item.type !== "pdf"));
      const previousProject = submittedFiles.length ? {} : storedJson(previousArtifacts, "GracePlan_project.json", {});
      const previousObservations = submittedFiles.length ? [] : storedJson(previousArtifacts, "GracePlan_image_observations.json", []);
      if (photoObservations.length) artifacts.push(jsonArtifact("GracePlan_image_observations.json", photoObservations));
      let planData = previousArtifacts.find((item) => item.kind === "source_plan")?.data;
      let renderData = previousArtifacts.find((item) => item.kind === "concept_render" || item.name === "GracePlan_concept_3D.png")?.data;
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
          const filename = "проектное_предложение_" + number + ".pdf";
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
      setCurrentStep(-1); setIsSending(false); setProgressPreviews([]);
    }
  }

  return (
    <main className="app-shell"><section className="chat-panel" aria-label="Grace Planner chat">
      <header className="topbar"><div className="brand-row"><div className="brand-text" aria-label="Grace AI Planner">Grace AI Planner</div></div>
        <button className="icon-button chat-manager-button" type="button" onClick={() => setChatManagerOpen(true)} aria-label="All chats" title="All chats"><Menu size={18} /></button>
        <nav className="chat-tabs" aria-label="Chats">{chats.map((chat) => <button className={chat.id === activeChat.id ? "chat-tab active" : "chat-tab"} key={chat.id} type="button" onClick={() => setActiveChatId(chat.id)}>{chat.title}</button>)}</nav>
        <div className="header-actions"><button className="icon-button" type="button" onClick={newChat} aria-label="New chat" title="New chat"><Plus size={18} /></button><span className={`agent-indicator ${agentState}`} role="status" aria-label={`Agent status: ${agentState}`} title={`Activity: ${agentState}. Animated UI indicator, not hidden model reasoning.`} /></div>
      </header>
      <div className="connection-row"><label>Connection <select aria-label="Connection mode" value={connectionMode} disabled={isSending} onChange={event=>setConnectionMode(event.target.value)}><option value="api">OpenAI API</option></select></label>{connectionMode==="chatgpt"&&<button type="button" onClick={()=>setBridgeHelp(true)}>{bridgeStatus.updateRequired?"Update ChatGPT Bridge":bridgeStatus.paired?"ChatGPT connected":bridgeStatus.saved?"Reconnect ChatGPT":"Connect ChatGPT"}</button>}{(activeChat.chatgptUrl||bridgeStatus.chatId===activeChat.id&&bridgeStatus.chatUrl)&&<a href={activeChat.chatgptUrl||bridgeStatus.chatUrl} target="_blank" rel="noopener noreferrer">Open same chat ↗</a>}</div>
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
          {browserReply && <MessageText text={browserReply} />}
          {graceSession && progressPreviews.length > 0 && <div className="progress-previews">{progressPreviews.map((preview, index) => <button type="button" className="progress-preview" onClick={() => openPreview(preview.source, preview.name)} key={preview.name + index}><img src={preview.source} alt={preview.name} /><span>{preview.name}</span></button>)}</div>}
        </article>}
      </div>
      {chatManagerOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setChatManagerOpen(false)}><section className="chat-manager-modal" role="dialog" aria-modal="true" aria-label="All chats" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>All chats</strong><span>{chats.length}</span></div><button type="button" className="modal-close" onClick={() => setChatManagerOpen(false)} aria-label="Close" title="Close"><X size={18} /></button></header><div className="chat-manager-list">{chats.map((chat) => <div className={chat.id === activeChat.id ? "chat-manager-row active" : "chat-manager-row"} key={chat.id}>{editingChatId === chat.id ? <input autoFocus value={chat.title} onChange={(event) => renameChat(chat.id, event.target.value)} onBlur={() => setEditingChatId(null)} onKeyDown={(event) => event.key === "Enter" && setEditingChatId(null)} aria-label="Chat name" /> : <button type="button" className="chat-name" onClick={() => { setActiveChatId(chat.id); setChatManagerOpen(false); }} title="Open chat">{chat.title}</button>}<button type="button" className="edit-chat" onClick={() => setEditingChatId(chat.id)} aria-label={"Rename " + chat.title} title="Rename"><Pencil size={16} /></button><button type="button" className="delete-chat" onClick={() => deleteChat(chat.id)} aria-label={"Delete " + chat.title} title="Delete"><Trash2 size={16} /></button></div>)}</div><button type="button" className="new-chat-wide" onClick={() => { newChat(); setChatManagerOpen(false); }} title="New chat"><Plus size={17} />New chat</button></section></div>}
      {bridgeHelp && <div className="modal-backdrop" role="presentation" onMouseDown={()=>setBridgeHelp(false)}><section className="bridge-help" role="dialog" aria-modal="true" aria-label="Connect ChatGPT" onMouseDown={event=>event.stopPropagation()}><header><strong>Connect your ChatGPT conversation</strong><button type="button" aria-label="Close" onClick={()=>setBridgeHelp(false)}><X size={18}/></button></header><p>This desktop Chrome prototype uses your own signed-in ChatGPT tab. Keep both tabs open. ChatGPT file, image and account limits still apply.</p><ol><li><a href="/grace-chatgpt-bridge.zip" download>Download Grace Bridge v0.2</a> and unzip it.</li><li>Open <code>chrome://extensions</code>, turn on Developer mode, choose <strong>Load unpacked</strong>, and select the unzipped folder.</li><li>Refresh this site and ChatGPT. Open an existing Grace Plan conversation containing your reference PDF and select <strong>Instant</strong>.</li><li>Open the extension from Chrome's extensions menu. Choose that ChatGPT tab, confirm Instant and press <strong>Pair this chat</strong>.</li></ol><p>The extension can send your messages and attachments to the paired tab and read its replies. Pairing is opt-in for each Grace chat and survives browser restarts. Reopen the saved conversation to reconnect. Google or ChatGPT may still require a new sign-in. Passwords and cookies are not requested. Mobile browsers are unsupported.</p><p className="bridge-verification">Prototype: the signed-in send → reply → PDF transfer still needs an end-to-end check in your browser. If a PDF cannot transfer, its original remains in ChatGPT.</p><button type="button" onClick={async()=>{setBridgeStatus(await browserBridgeStatus(activeChat.id,activeChat.title));}}>Check connection</button><p role="status">{bridgeStatus.paired?"Paired and ready":bridgeStatus.reason|| (bridgeStatus.installed?"Extension installed — pair this chat":"Extension not detected")}</p></section></div>}
      {previewModal && <div className="modal-backdrop image-editor-backdrop" role="presentation" onMouseDown={() => setPreviewModal(null)}><section className="image-editor-modal" role="dialog" aria-modal="true" aria-label="Image review" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>Image review & comments</strong><span>{previewModal.name}</span></div><button type="button" className="modal-close" onClick={() => setPreviewModal(null)} aria-label="Close" title="Close"><X size={18} /></button></header><div className="image-stage" onClick={markPreview}><img src={previewModal.source} alt={previewModal.name} />{previewMarkers.map((marker, index) => <i key={index} style={{ left: marker.x + "%", top: marker.y + "%" }}>{index + 1}</i>)}</div><p className="editor-help">Select image locations and describe your requested changes. This adds a comment; it does not edit the image automatically.</p><textarea value={previewComment} onChange={(event) => setPreviewComment(event.target.value)} placeholder="Describe changes to the marked area" rows={3} /><button type="button" className="apply-edit" onClick={applyPreviewComment} disabled={!previewComment.trim()}>Add comment to chat</button></section></div>}
      {showStatus && <div className="status-badges" aria-label="Connection"><span className="status-badge">{connectionMode==="chatgpt"?"ChatGPT browser":"OpenAI API"}</span><span className="status-plus">+</span><span className="status-badge">GPT Мгновенный</span></div>}
      {error && <div className="error">{error}</div>}
      <form className={`composer ${dragActive ? "drag-active" : ""}`} onSubmit={submit} onPaste={(event) => { const incoming = Array.from(event.clipboardData.files || []); if (incoming.length) { event.preventDefault(); ingestFiles(incoming); } }}>
        {attachmentPreviews.length > 0 && <div className="attachment-strip">{attachmentPreviews.map((item, index) => <div className="attachment-chip" key={item.file.name + index}>{item.file.type.startsWith("image/") && <button type="button" className="attachment-thumb" onClick={() => openPreview(item.url, item.file.name)} title="Preview image"><img src={item.url} alt={item.file.name} /></button>}<span title={item.file.name}>{item.file.name}</span><button type="button" className="remove-attachment" onClick={() => removeFile(index)} aria-label={"Remove " + item.file.name} title="Remove"><X size={14} /></button></div>)}</div>}
        {dragActive && <div className="drop-overlay">Drop files here</div>}
        <label className="prompt-box"><span>Message</span><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Example: create the Grace Plan PDF package from all plans and photos..." rows={4} /></label>
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
    </section></main>
  );
}
createRoot(document.getElementById("root")).render(<App />);


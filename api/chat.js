import { WORKFLOW_CATALOG } from "./workflowCatalog.js";
import { createHash } from "node:crypto";
const GRACE_PLAN_SYSTEM = `
GOAL:
Execute the Grace Plan workflow from the user's files and request. Do not merely answer or repeat. Each request must show the current command, status, result, and next command.

VISIBLE EXECUTION:
Always show these stages when applicable:
1. Завантаження файлів
2. Перевірка 2D-плану
3. Зіставлення фото
4. Побудова 3D-плану
5. Формування Grace Plan
Never replace execution with a generic waiting message. Answer the user's actual question before the status. If no files are available, state precisely that a 2D plan and at least five photos are needed; NEXT must request those files, never Готово. Do not claim an operation occurred when it did not.

Scope:
- Create only the Grace Plan security/BIM proposal package.
- Match the good reference PDFs: landscape A2, two-column layout, 01 PLAN FLOOR, 02 NETWORKS AND ENGINEERING POINTS, black wall cuts, blue Cat6, ochre 230 V, pink camera fields, C/AP/D/FD/S/R/X IDs, legend, source count, materials, date and page code.
- Required package: six A2 sheets, A3/A4 supplements, summary A4, photo atlas, IDs, engineering plans, calculations, assumptions, unresolved links, and print checks.
- Respond only in Ukrainian, unless the user explicitly requests English; never switch to Russian because the user's request is in Russian. Launch mode always GPT Мгновенный.
- Never reveal reasoning. Account for every photo manifest entry. Describe clearly when only per-photo observations, rather than original pixels, were provided. Geometry comes from the 2D plan; photos only inform visible finishes, furniture, and possible identity.
- Render only a clearly labelled conceptual 3D plan. Never claim completed BIM/IFC.
- Maximum deviation from the reference is 21%; if exceeded, mark NONCONFORMING and do not claim success.
- Do not claim execution without a real output. The service currently produces image observations, a conceptual render, and a one-page draft PDF only; describe six A2 sheets and full BIM as pending, not as completed or guaranteed. If a required render/file tool is unavailable, name the blocked command.

Response format:
COMMAND: CMD-xxx — action
STATUS: current status
OUTPUT: files or Немає
NEXT: next command or Готово
`;

export const config = { runtime: "nodejs" };

function ascii(value) {
  return String(value || "").normalize("NFKD").replace(/[^\x20-\x7E\n]/g, "?");
}

function wrap(text, limit = 96) {
  const words = ascii(text).replace(/\r/g, "").split(/\s+/);
  const lines = []; let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > limit) { if (line) lines.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

function dataUrl(mime, text) {
  return "data:" + mime + ";base64," + Buffer.from(text, "utf8").toString("base64");
}

function createPhotoManifest(files) {
  return files.map((file, index) => {
    const comma = String(file.data || "").indexOf(",");
    if (comma < 0) throw new Error("Некорректный файл: " + file.name);
    const bytes = Buffer.from(file.data.slice(comma + 1), "base64");
    if (!bytes.length) throw new Error("Пустой файл: " + file.name);
    return {
      id: "PHOTO-" + String(index + 1).padStart(3, "0"),
      name: file.name,
      mime: file.type,
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      review_status: "not_individually_verified",
      floor: null,
      room_id: null
    };
  });
}

async function createProjectData(files, photoObservations, answer, apiKey) {
  const imageContent = files.filter((file) => file.data && file.type?.startsWith("image/")).slice(0, 20)
    .map((file) => ({ type: "image_url", image_url: { url: file.data, detail: "high" } }));
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_CHAT_MODEL || "chat-latest",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "grace_plan_project",
          strict: true,
          schema: {
            type: "object", additionalProperties: false,
            properties: {
              revision: { type: "integer" },
              scale_status: { type: "string", enum: ["verified", "unknown"] },
              rooms: { type: "array", items: { type: "object", additionalProperties: false, properties: {
                id: { type: "string" }, name: { type: "string" }, floor: { type: "string" },
                evidence: { type: "array", items: { type: "string" } },
                finish: { type: "string" }
              }, required: ["id","name","floor","evidence","finish"] } },
              devices: { type: "array", items: { type: "object", additionalProperties: false, properties: {
                id: { type: "string" }, type: { type: "string" }, room_id: { type: "string" },
                power_w: { type: "number" }, status: { type: "string" }
              }, required: ["id","type","room_id","power_w","status"] } },
              routes: { type: "array", items: { type: "object", additionalProperties: false, properties: {
                id: { type: "string" }, from: { type: "string" }, to: { type: "string" },
                measured_m: { type: ["number","null"] }, reserve_percent: { type: "number" }
              }, required: ["id","from","to","measured_m","reserve_percent"] } },
              unresolved: { type: "array", items: { type: "string" } }
            },
            required: ["revision","scale_status","rooms","devices","routes","unresolved"]
          }
        }
      },
      messages: [{ role: "system", content: "Extract editable Grace Plan project data. Never invent measured lengths or power values; use null/0 and unresolved when evidence is absent. IDs must be stable." },
        { role: "user", content: [{ type: "text", text: "Files: " + (files.map((file) => file.name).join(", ") || photoObservations.map((photo) => photo.name).join(", ")) + "\nPer-image observations:\n" + photoObservations.map((photo, index) => "PHOTO-" + String(index + 1).padStart(3, "0") + " " + photo.name + ": " + JSON.stringify(photo.observations || {})).join("\n").slice(0, 60000) + "\nAnalysis:\n" + answer }, ...imageContent] }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Project extraction failed");
  const project = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  project.scale_status = "unknown";
  project.rooms = Array.isArray(project.rooms) ? project.rooms : [];
  project.devices = Array.isArray(project.devices) ? project.devices.map((device) => ({ ...device, power_w: 0, status: "proposed_unverified" })) : [];
  project.routes = Array.isArray(project.routes) ? project.routes.map((route) => ({ ...route, measured_m: null })) : [];
  project.unresolved = [...(Array.isArray(project.unresolved) ? project.unresolved : []), "Scale, geometry, device powers and routes require measured confirmation."];
  return project;
}

function createCableCsv(project) {
  const rows = [["route_id","from","to","measured_m","reserve_percent","total_m","status"]];
  for (const route of project.routes || []) {
    const measured = Number.isFinite(route.measured_m) ? route.measured_m : "";
    const total = measured === "" ? "" : (measured * (1 + (route.reserve_percent || 0) / 100)).toFixed(1);
    rows.push([route.id, route.from, route.to, measured, route.reserve_percent, total, measured === "" ? "NEEDS_SCALE" : "CALCULATED"]);
  }
  return rows.map((row) => row.map((value) => '"' + String(value).replaceAll('"','""') + '"').join(",")).join("\n");
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function createEngineeringSvg(project) {
  const devices = project.devices || [];
  const height = Math.max(500, 190 + devices.length * 48);
  const items = devices.map((device, i) => {
    const y = 150 + i * 48;
    return '<g><rect x="520" y="' + (y - 24) + '" width="430" height="34" rx="8" fill="#fff" stroke="#111"/><text x="538" y="' + y + '" font-size="15">' +
      xmlEscape(device.id + "  " + device.type + "  " + device.room_id) + '</text><line x1="260" y1="118" x2="520" y2="' + (y - 7) + '" stroke="#2878b5" stroke-width="3"/></g>';
  }).join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="' + height + '" viewBox="0 0 1200 ' + height + '"><rect width="100%" height="100%" fill="#fafafa"/><text x="55" y="62" font-family="Arial" font-size="28" font-weight="700">GRACE PLAN — PROPOSED NETWORK TOPOLOGY</text><rect x="55" y="95" width="205" height="52" rx="10" fill="#111"/><text x="82" y="128" fill="#fff" font-family="Arial" font-size="17">SERVER / NVR</text>' + items + '<text x="55" y="' + (height - 40) + '" font-family="Arial" font-size="14">Blue: Cat6/data • Verify all routes and scale on site</text></svg>';
}

async function createConceptRender(files, answer, apiKey) {
  const images = files
    .filter((file) => file.data && file.type?.startsWith("image/"))
    .slice(0, 16)
    .map((file) => ({ type: "input_image", image_url: file.data, detail: "high" }));
  if (!images.length) return null;
  const prompt = [
    "Create a conceptual axonometric 3D cutaway floor-plan render for Grace Plan.",
    "Use the uploaded 2D plan for geometry and uploaded room photographs for finishes, furniture and room identity.",
    "Do not invent extra rooms. Preserve walls, doors, windows, stairs and room adjacency.",
    "Architectural visualization, clean white background, black cut walls, subtle pink security zones, realistic materials.",
    "No labels, no text, no watermark. This is conceptual, not an IFC/BIM deliverable.",
    "Analysis summary:", ascii(answer).slice(0, 5000)
  ].join("\n");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_RENDER_AGENT_MODEL || "gpt-4o-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...images] }],
      tools: [{ type: "image_generation", model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst", size: "1536x1024", quality: "high", action: "generate" }],
      tool_choice: { type: "image_generation" }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Image generation failed");
  const call = data.output?.find((item) => item.type === "image_generation_call" && item.result);
  if (!call?.result) throw new Error("Image generation tool returned no image");
  return "data:image/png;base64," + call.result;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const payload = req.body && typeof req.body === "object" ? req.body : body ? JSON.parse(body) : {};
  return {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    files: Array.isArray(payload.files) ? payload.files : [],
    photoObservations: Array.isArray(payload.photoObservations) ? payload.photoObservations : [],
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY is missing in Vercel Environment Variables." });
  try {
    const { messages, files, photoObservations } = await readJson(req);
    if (files.some((file) => !file.data || !file.type?.startsWith("image/"))) return res.status(400).json({ error: "Сейчас поддерживаются только изображения; другие файлы не анализируются." });
    const imageParts = files
      .filter((file) => file.data && file.type && file.type.startsWith("image/"))
      .map((file) => ({ type: "image_url", image_url: { url: file.data, detail: "high" } }));
    const fileNotes = files.map((file) => "Attached image: " + file.name).join("\\n");
    const observationNotes = photoObservations.map((photo, index) =>
      "PHOTO-" + String(index + 1).padStart(3, "0") + " " + String(photo.name || "") + ": " +
      JSON.stringify(photo.observations || {}).slice(0, 3500)
    ).join("\\n");
    const userMessages = messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || ""),
    }));
    const lastUser = [...userMessages].reverse().find((message) => message.role === "user");
    if (lastUser && imageParts.length) {
      lastUser.content = [{ type: "text", text: lastUser.content + "\\n\\n" + fileNotes + "\\n" + observationNotes }, ...imageParts];
    } else if (lastUser && observationNotes) {
      lastUser.content += "\\n\\nIndividual image observations (not original images):\\n" + observationNotes;
    } else if (fileNotes) {
      userMessages.unshift({ role: "user", content: fileNotes });
    }
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || "chat-latest",
        messages: [{ role: "system", content: GRACE_PLAN_SYSTEM }, ...userMessages],
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || "OpenAI API error" });
    const answer = data.choices?.[0]?.message?.content?.trim() || "Empty API response.";
    const requestText = messages.filter((message) => message.role === "user").map((message) => String(message.content || "")).join(" ").toLowerCase();
    const wantsPdf = /pdf|пдф|6\s*[xх×]?\s*a2|шість\s+а2|шесть\s+а2|комплект\s+лист/.test(requestText);
    const artifacts = [];
    const photoManifest = photoObservations.length
      ? photoObservations.map((photo, index) => ({
          id: "PHOTO-" + String(index + 1).padStart(3, "0"),
          name: String(photo.name || ""),
          sha256: photo.sha256 || null,
          original_sha256: photo.originalSha256 || null,
          analyzed_bytes: photo.analyzed_bytes || null,
          review_status: photo.review_status || "unknown",
          floor: null, room_id: null
        }))
      : createPhotoManifest(files);
    if (photoManifest.length) artifacts.push({ type: "json", name: "GracePlan_photo_manifest.json", data: dataUrl("application/json", JSON.stringify(photoManifest, null, 2)) });
    let projectData = null;
    let projectError = "";
    if (files.length || photoObservations.length) {
      try {
        projectData = await createProjectData(files, photoObservations, answer, process.env.OPENAI_API_KEY);
        artifacts.push({ type: "json", name: "GracePlan_project.json", data: dataUrl("application/json", JSON.stringify(projectData, null, 2)) });
        artifacts.push({ type: "csv", name: "GracePlan_cable_schedule.csv", data: dataUrl("text/csv", createCableCsv(projectData)) });
        artifacts.push({ type: "svg", name: "GracePlan_network_topology.svg", data: dataUrl("image/svg+xml", createEngineeringSvg(projectData)) });
      } catch (error) { projectError = error.message || "Extraction failed"; }
    }
    const wantsRender = /3d|bim|render|рендер|визуал|зображ|картин|image|picture/.test(requestText);
    let renderData = null;
    let renderError = "";
    if (wantsRender && imageParts.length) {
      try {
        renderData = await createConceptRender(files, answer, process.env.OPENAI_API_KEY);
        if (renderData) artifacts.push({ type: "image", name: "GracePlan_concept_3D.png", data: renderData });
      } catch (error) { renderError = error.message; }
    }
    const blockers = [];
    if (wantsPdf) blockers.push("PDF: не сформовано — потрібні перевірена геометрія, прив’язка фото до приміщень і верстка еталонних аркушів.");
    if (renderError) blockers.push("3D-рендер: помилка — " + renderError);
    if (photoObservations.length && wantsRender && !imageParts.length) blockers.push("3D-рендер: оригінали не збережені; аналіз фото виконано, пакетний рендер поки недоступний.");
    if (files.length > 16) blockers.push("3D-рендер: генератор отримав перші 16 зображень; решту внесено до реєстру без включення в генерацію.");
    if (photoObservations.length) blockers.push("Фото: " + photoObservations.length + " знімків проаналізовано окремо; прив’язку до приміщень не підтверджено.");
    if (files.length > 20) blockers.push("Аналіз приміщень: оброблено перші 20 зображень. Решта перебуває в реєстрі без візуальної перевірки.");
    if ((files.length || photoObservations.length) && !projectData) blockers.push("Структуровані дані: " + (projectError || "витяг не виконано."));
    const correctedAnswer = !files.length && !photoObservations.length && /NEXT:\s*Готово/i.test(answer)
      ? answer.replace(/NEXT:\s*Готово/i, "NEXT: Завантажте 2D-план і щонайменше п’ять фото приміщень.")
      : answer;
    const finalAnswer = [correctedAnswer, ...blockers].join("\n\n");
    const planCount = photoObservations.filter((photo) => /plan|план|drawing|креслен|схема/i.test(String(photo.observations?.kind || "") + " " + String(photo.name || ""))).length;
    const execution = [
      { id: "CMD-001", label: "Завантаження та облік файлів", status: photoObservations.length || files.length ? "done_verified" : "needs_input", detail: (photoObservations.length || files.length) + " файлів враховано" },
      { id: "CMD-002", label: "Перевірка 2D-плану", status: planCount === 1 ? "done_with_assumptions" : "needs_input", detail: planCount === 1 ? "Знайдено один план; масштаб потребує перевірки" : "Потрібен рівно один розпізнаний 2D-план" },
      { id: "CMD-003", label: "Зіставлення фото з приміщеннями", status: photoObservations.length >= 5 ? "done_with_assumptions" : "needs_input", detail: photoObservations.length + " фото проаналізовано; зв’язки з кімнатами потребують підтвердження" },
      { id: "CMD-004", label: "Структуровані дані Grace Plan", status: projectData ? "done_with_assumptions" : "failed", detail: projectData ? "JSON, кабельний журнал і топологію сформовано" : (projectError || "Дані не сформовано") }
    ];
    const workflowStatus = WORKFLOW_CATALOG.map((command) => {
      let status = "needs_input";
      let detail = "Очікує завершення попередніх команд";
      if (command.id === "CMD-001") { status = "done_verified"; detail = "Завдання Grace Plan зафіксовано"; }
      if (command.id === "CMD-002" && (files.length || photoObservations.length)) { status = "done_verified"; detail = "Вхідні файли знайдено"; }
      if (["CMD-005","CMD-007"].includes(command.id) && photoObservations.length) { status = "done_verified"; detail = photoObservations.length + " зображень враховано й проаналізовано"; }
      if (command.id === "CMD-010" && planCount === 1) { status = "done_with_assumptions"; detail = "Один 2D-план розпізнано; масштаб не підтверджено"; }
      if (command.id === "CMD-011") { status = "done_verified"; detail = "Еталонний формат Grace Plan завантажено в правила агента"; }
      if (command.id === "CMD-014" && photoObservations.length >= 5) { status = "done_with_assumptions"; detail = "Автоматичне зіставлення потребує підтвердження користувача"; }
      if (command.id === "CMD-019") { status = "not_implemented"; detail = "Точний BIM потребує масштабу й перевіреної векторної геометрії"; }
      if (command.id === "CMD-021" && planCount === 1 && photoObservations.length >= 5) { status = "done_with_assumptions"; detail = "Входи концептуального рендера підготовлено"; }
      return { ...command, status, detail };
    });
    artifacts.push({ type: "json", name: "GracePlan_67_command_status.json", data: dataUrl("application/json", JSON.stringify(workflowStatus, null, 2)) });
    return res.status(200).json({ answer: finalAnswer, artifacts, execution, workflowStatus });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Server error" });
  }
}

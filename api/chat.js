import { createHash } from "node:crypto";
const GRACE_PLAN_SYSTEM = `
GOAL:
Execute the Grace Plan workflow from the user's files and request. Do not merely answer or repeat. Each request must show the current command, status, result, and next command.

VISIBLE EXECUTION:
Always show these stages when applicable:
1. Загрузка файлов
2. Проверка 2D-плана
3. Сопоставление фото
4. Построение 3D-плана
5. Формирование Grace Plan
Never replace execution with a generic waiting message.

Scope:
- Create only the Grace Plan security/BIM proposal package.
- Match the good reference PDFs: landscape A2, two-column layout, 01 PLAN FLOOR, 02 NETWORKS AND ENGINEERING POINTS, black wall cuts, blue Cat6, ochre 230 V, pink camera fields, C/AP/D/FD/S/R/X IDs, legend, source count, materials, date and page code.
- Required package: six A2 sheets, A3/A4 supplements, summary A4, photo atlas, IDs, engineering plans, calculations, assumptions, unresolved links, and print checks.
- Main language Ukrainian or English. Launch mode always GPT Мгновенный.
- Never reveal reasoning. Use every photo. Geometry comes from the 2D plan; photos control finishes, furniture, and identity.
- Render only a clearly labelled conceptual 3D plan. Never claim completed BIM/IFC.
- Maximum deviation from the reference is 21%; if exceeded, mark NONCONFORMING and do not claim success.
- Do not claim execution without a real output. If a required render/file tool is unavailable, name the blocked command.

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

async function createProjectData(files, answer, apiKey) {
  const imageContent = files.filter((file) => file.data && file.type?.startsWith("image/")).slice(0, 20)
    .map((file) => ({ type: "image_url", image_url: { url: file.data, detail: "high" } }));
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
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
        { role: "user", content: [{ type: "text", text: "Files: " + files.map((file) => file.name).join(", ") + "\nAnalysis:\n" + answer }, ...imageContent] }]
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
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...images] }],
      tools: [{ type: "image_generation", model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst", size: "1536x1024", quality: "high", action: "generate" }],
      tool_choice: { type: "image_generation" }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Image generation failed");
  const call = data.output?.find((item) => item.type === "image_generation_call" && item.result);
  return call?.result ? "data:image/png;base64," + call.result : null;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const payload = body ? JSON.parse(body) : {};
  return {
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    files: Array.isArray(payload.files) ? payload.files : [],
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY is missing in Vercel Environment Variables." });
  try {
    const { messages, files } = await readJson(req);
    if (files.some((file) => !file.data || !file.type?.startsWith("image/"))) return res.status(400).json({ error: "Сейчас поддерживаются только изображения; другие файлы не анализируются." });
    const imageParts = files
      .filter((file) => file.data && file.type && file.type.startsWith("image/"))
      .map((file) => ({ type: "image_url", image_url: { url: file.data, detail: "high" } }));
    const fileNotes = files
      .map((file) => "Attached file: " + file.name + ", type: " + (file.type || "unknown") + ", size: " + (file.size || 0) + " bytes")
      .join("\\n");
    const userMessages = messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || ""),
    }));
    const lastUser = [...userMessages].reverse().find((message) => message.role === "user");
    if (lastUser && imageParts.length) {
      lastUser.content = [{ type: "text", text: lastUser.content + "\\n\\n" + fileNotes }, ...imageParts];
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
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{ role: "system", content: GRACE_PLAN_SYSTEM }, ...userMessages],
        temperature: 0.1,
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || "OpenAI API error" });
    const answer = data.choices?.[0]?.message?.content?.trim() || "Empty API response.";
    const requestText = messages.filter((message) => message.role === "user").map((message) => String(message.content || "")).join(" ").toLowerCase();
    const wantsPdf = /pdf|пдф|grace plan|проектн/.test(requestText);
    const artifacts = [];
    const photoManifest = createPhotoManifest(files);
    if (photoManifest.length) artifacts.push({ type: "json", name: "GracePlan_photo_manifest.json", data: dataUrl("application/json", JSON.stringify(photoManifest, null, 2)) });
    let projectData = null;
    let projectError = "";
    if (files.length) {
      try {
        projectData = await createProjectData(files, answer, process.env.OPENAI_API_KEY);
        artifacts.push({ type: "json", name: "GracePlan_project.json", data: dataUrl("application/json", JSON.stringify(projectData, null, 2)) });
        artifacts.push({ type: "csv", name: "GracePlan_cable_schedule.csv", data: dataUrl("text/csv", createCableCsv(projectData)) });
        artifacts.push({ type: "svg", name: "GracePlan_network_topology.svg", data: dataUrl("image/svg+xml", createEngineeringSvg(projectData)) });
      } catch (error) { projectError = error.message || "Extraction failed"; }
    }
    const wantsRender = /3d|bim|render|рендер|визуал/.test(requestText);
    let renderData = null;
    let renderError = "";
    if (wantsRender && imageParts.length) {
      try {
        renderData = await createConceptRender(files, answer, process.env.OPENAI_API_KEY);
        if (renderData) artifacts.push({ type: "image", name: "GracePlan_concept_3D.png", data: renderData });
      } catch (error) { renderError = error.message; }
    }
    const blockers = [];
    if (wantsPdf) blockers.push("PDF: не сформирован — нужны проверенная геометрия, связь фото с помещениями и верстка эталонных листов.");
    if (renderError) blockers.push("3D-рендер: ошибка — " + renderError);
    if (files.length > 16) blockers.push("3D-рендер: генератор получил только первые 16 изображений; остальные внесены в реестр, но не включены в генерацию.");
    if (files.length > 20) blockers.push("Анализ помещений: обработаны только первые 20 изображений. Остальные находятся в реестре без визуальной проверки.");
    if (files.length && !projectData) blockers.push("Структурированные данные: " + (projectError || "извлечение не выполнено."));
    const finalAnswer = [answer, ...blockers].join("\n\n");
    return res.status(200).json({ answer: finalAnswer, artifacts });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Server error" });
  }
}

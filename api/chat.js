import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

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
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
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

function createEngineeringSvg(project) {
  const devices = project.devices || [];
  const height = Math.max(500, 190 + devices.length * 48);
  const items = devices.map((device, i) => {
    const y = 150 + i * 48;
    return '<g><rect x="520" y="' + (y - 24) + '" width="430" height="34" rx="8" fill="#fff" stroke="#111"/><text x="538" y="' + y + '" font-size="15">' +
      ascii(device.id + "  " + device.type + "  " + device.room_id) + '</text><line x1="260" y1="118" x2="520" y2="' + (y - 7) + '" stroke="#2878b5" stroke-width="3"/></g>';
  }).join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="' + height + '" viewBox="0 0 1200 ' + height + '"><rect width="100%" height="100%" fill="#fafafa"/><text x="55" y="62" font-family="Arial" font-size="28" font-weight="700">GRACE PLAN — NETWORK TOPOLOGY</text><rect x="55" y="95" width="205" height="52" rx="10" fill="#111"/><text x="82" y="128" fill="#fff" font-family="Arial" font-size="17">SERVER / NVR</text>' + items + '<text x="55" y="' + (height - 40) + '" font-family="Arial" font-size="14">Blue: Cat6/data • Verify all routes and scale on site</text></svg>';
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

async function createGracePlanPdf(answer, fileCount, renderData) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 1683.78, height = 1190.55;
  const titles = [
    "01 PLAN FLOOR", "02 NETWORKS AND ENGINEERING POINTS", "03 CCTV AND ACCESS",
    "04 DATA, NAS AND SERVER", "05 CABLES, POWER AND CALCULATIONS", "06 GRACE PLAN SUMMARY"
  ];
  const lines = wrap(answer);
  let renderImage = null;
  if (renderData) { try { renderImage = await pdf.embedPng(renderData.split(",")[1]); } catch {} }
  for (let pageIndex = 0; pageIndex < titles.length; pageIndex++) {
    const page = pdf.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.985, 0.985, 0.985) });
    page.drawRectangle({ x: 45, y: 45, width: width - 90, height: height - 90, borderColor: rgb(.08,.08,.08), borderWidth: 2 });
    page.drawText("GRACE PLAN", { x: 72, y: height - 92, size: 24, font: bold, color: rgb(.08,.08,.08) });
    page.drawText(titles[pageIndex], { x: 72, y: height - 134, size: 18, font: bold });
    page.drawLine({ start: { x: 72, y: height - 155 }, end: { x: width - 72, y: height - 155 }, thickness: 2, color: rgb(.1,.1,.1) });
    page.drawRectangle({ x: 72, y: 150, width: 930, height: height - 340, borderColor: rgb(.1,.1,.1), borderWidth: 4 });
    if (renderImage && pageIndex === 0) {
      const scale = Math.min(880 / renderImage.width, (height - 410) / renderImage.height);
      page.drawImage(renderImage, { x: 97, y: 185, width: renderImage.width * scale, height: renderImage.height * scale });
    } else {
      page.drawText("BIM / ENGINEERING WORK AREA", { x: 98, y: height - 205, size: 15, font: bold });
    }
    page.drawRectangle({ x: 1025, y: 150, width: 585, height: height - 340, color: rgb(1,.97,.98), borderColor: rgb(.75,.75,.75), borderWidth: 1 });
    let y = height - 205;
    for (const line of lines.slice(pageIndex * 18, pageIndex * 18 + 18)) {
      page.drawText(line, { x: 1050, y, size: 11, font: regular, maxWidth: 530 }); y -= 24;
    }
    page.drawText("Sources: " + fileCount + " | Conceptual 3D/BIM | Verify dimensions before construction", { x: 72, y: 105, size: 10, font: regular });
    page.drawText("A2 LANDSCAPE | GP-" + String(pageIndex + 1).padStart(2, "0"), { x: width - 330, y: 105, size: 10, font: bold });
  }
  const bytes = await pdf.save();
  return "data:application/pdf;base64," + Buffer.from(bytes).toString("base64");
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
    const requestText = userMessages.map((message) => typeof message.content === "string" ? message.content : "").join(" ").toLowerCase();
    const wantsPdf = /pdf|пдф|grace plan|проектн/.test(requestText);
    const artifacts = [];
    let projectData = null;
    if (files.length) {
      try {
        projectData = await createProjectData(files, answer, process.env.OPENAI_API_KEY);
        artifacts.push({ type: "json", name: "GracePlan_project.json", data: dataUrl("application/json", JSON.stringify(projectData, null, 2)) });
        artifacts.push({ type: "csv", name: "GracePlan_cable_schedule.csv", data: dataUrl("text/csv", createCableCsv(projectData)) });
        artifacts.push({ type: "svg", name: "GracePlan_network_topology.svg", data: dataUrl("image/svg+xml", createEngineeringSvg(projectData)) });
      } catch {}
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
    if (wantsPdf) {
      const pdfData = await createGracePlanPdf(answer, files.length, renderData);
      artifacts.push({ type: "pdf", name: "GracePlan_A2_package.pdf", data: pdfData });
    }
    const finalAnswer = renderError ? answer + "\n\nRENDER STATUS: failed — " + renderError : answer;
    return res.status(200).json({ answer: finalAnswer, artifacts });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Server error" });
  }
}

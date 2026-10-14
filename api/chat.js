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
    return res.status(200).json({ answer: data.choices?.[0]?.message?.content?.trim() || "Empty API response." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Server error" });
  }
}

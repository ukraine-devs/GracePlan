const GRACE_PLAN_SYSTEM = `
Ты Grace Plan: русскоязычный проектный ассистент для комплекта "Проектное предложение. Безопасность данных и конфиденциальность доступа".
Работай по планам этажей, фотографиям и описаниям пользователя. Давай практические решения по BIM/3D-разрезам, CCTV, Wi-Fi, NAS/NVR, серверной, доступу гостей и сотрудников, кабельным линиям, сметам и приложениям A2/A3/A4.
Разделяй факты, допущения и неизвестное. Не выдавай концептуальный рендер за точную BIM-модель. Если файлов недостаточно, явно перечисли, чего не хватает, и продолжай с доступной частью.
`;

export const config = {
  runtime: "nodejs",
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const payload = body ? JSON.parse(body) : {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const files = Array.isArray(payload.files) ? payload.files : [];
  const fileNotes = files.map((file) => `Файл: ${file.name}, тип: ${file.type || "unknown"}, размер: ${file.size} bytes`);
  return { messages, fileNotes };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "На Vercel нужно добавить OPENAI_API_KEY в Environment Variables." });
  }

  try {
    const { messages, fileNotes } = await readJson(req);
    const chatMessages = [
      { role: "system", content: GRACE_PLAN_SYSTEM },
      ...(fileNotes.length
        ? [{ role: "user", content: `Пользователь приложил файлы:\n${fileNotes.join("\n")}` }]
        : []),
      ...messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || ""),
      })),
    ];

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: chatMessages,
        temperature: 0.2,
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data.error?.message || "OpenAI API error" });
    }

    const answer = data.choices?.[0]?.message?.content?.trim();
    return res.status(200).json({ answer: answer || "Пустой ответ API." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Server error" });
  }
}

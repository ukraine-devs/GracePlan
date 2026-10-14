const GRACE_PLAN_SYSTEM = `
Ты Grace Plan: русскоязычный проектный ассистент для комплекта "Проектное предложение. Безопасность данных и конфиденциальность доступа".
Работай по планам этажей, фотографиям и описаниям пользователя. Давай практические решения по BIM/3D-разрезам, CCTV, Wi-Fi, NAS/NVR, серверной, доступу гостей и сотрудников, кабельным линиям, сметам и приложениям A2/A3/A4.
Разделяй факты, допущения и неизвестное. Не выдавай концептуальный рендер за точную BIM-модель. Если файлов недостаточно, явно перечисли, чего не хватает, и продолжай с доступной частью.
`;

export const config = {
  runtime: "nodejs",
};

async function readForm(req) {
  const form = await req.formData();
  const messages = JSON.parse(form.get("messages") || "[]");
  const files = form.getAll("files").filter((file) => file && file.name);
  const fileNotes = files.map((file) => `Файл: ${file.name}, тип: ${file.type || "unknown"}, размер: ${file.size} bytes`);
  return { messages, fileNotes };
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "На Vercel нужно добавить OPENAI_API_KEY в Environment Variables." },
      { status: 500 },
    );
  }

  try {
    const { messages, fileNotes } = await readForm(req);
    const input = [
      { role: "system", content: GRACE_PLAN_SYSTEM },
      ...(fileNotes.length
        ? [{ role: "user", content: `Пользователь приложил файлы:\n${fileNotes.join("\n")}` }]
        : []),
      ...messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || ""),
      })),
    ];

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input,
      }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return Response.json({ error: data.error?.message || "OpenAI API error" }, { status: upstream.status });
    }

    return Response.json({ answer: data.output_text || "Пустой ответ API." });
  } catch (error) {
    return Response.json({ error: error.message || "Server error" }, { status: 500 });
  }
}

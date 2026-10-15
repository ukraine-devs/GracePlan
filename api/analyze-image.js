import { createHash } from "node:crypto";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OpenAI API not configured" });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = req.body && typeof req.body === "object" ? Buffer.from(JSON.stringify(req.body)) : Buffer.concat(chunks);
    if (raw.length > 3_900_000) return res.status(413).json({ error: "Image request exceeds 3.9 MB" });
    const { name, data, originalSha256 } = JSON.parse(raw.toString("utf8"));
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ""));
    if (!match) return res.status(400).json({ error: "Only JPEG, PNG and WebP images are supported" });
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 2_900_000) return res.status(413).json({ error: "Image must be smaller than 2.9 MB after resizing" });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || "chat-latest",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Describe only visible evidence in this single architectural photograph or 2D plan. Answer JSON with keys kind, visible_rooms, surfaces, furniture, doors_windows_stairs, text_dimensions, uncertainty. Ukrainian or English. Do not claim a room ID, floor, scale or exact dimensions unless literally visible. Never infer hidden geometry." },
          { role: "user", content: [{ type: "text", text: "File " + String(name || "").slice(0, 180) + ". Return image-specific factual observations." }, { type: "image_url", image_url: { url: data, detail: "high" } }] }
        ]
      })
    });
    const body = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: body.error?.message || "Image analysis failed" });
    const observations = JSON.parse(body.choices?.[0]?.message?.content || "{}");
    return res.status(200).json({
      name: String(name || "").slice(0, 180),
      sha256,
      originalSha256: /^[a-f0-9]{64}$/.test(originalSha256 || "") ? originalSha256 : null,
      analyzed_bytes: bytes.length,
      observations,
      review_status: "ai_image_reviewed_room_unverified"
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Image analysis failed" });
  }
}

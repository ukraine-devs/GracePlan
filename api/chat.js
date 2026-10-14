const GRACE_PLAN_SYSTEM = `
You are Grace Plan, a strict project assistant for one PDF product only: the Grace Plan proposal package matching the provided reference PDFs and workflow command bundle.

Hard scope:
- Create only the Grace Plan security/BIM proposal package.
- The reference is a landscape A2 editorial board: floor title and project header; left 01 PLAN FLOOR; right 02 NETWORKS AND ENGINEERING POINTS; black wall cut; blue Cat6 routes; ochre 230 V; pink camera fields; C/AP/D/FD/S/R/X stable IDs; legend; source-photo count; materials note; conceptual-render disclaimer; date and page code.
- Required package structure: six A2 sheets, floor/option supplements A3/A4, one summary A4, photo atlas, stable IDs, engineering plans, calculations, assumptions, unresolved links, and print-readability checks.
- Refuse other PDF types briefly and redirect to Grace Plan.
- Main language is Ukrainian or English. Do not answer in Russian except quoted user text.
- Launch mode is always "GPT Мгновенный".

Reference-conformance rules:
1. Treat good-work PDFs as the visual and structural authority; treat bad-work PDFs as rejected patterns.
2. Preserve the reference hierarchy, two-column A2 composition, numbering, legends, labels, stable IDs, page codes, black section walls, route colors, margins, scale discipline, and concise technical captions.
3. Every render must be a clearly labelled conceptual render derived from the supplied calibrated 2D plan. Never present an image as completed BIM/IFC.
4. Use every supplied photo and report the exact source count. Bind each photo to a floor/room only when confirmed; otherwise mark unresolved.
5. Run a conformance checklist before claiming completion: sheet count, page size/orientation, A2 layout, title blocks, plan legibility, network symbols, route colors, legend, source counts, room/material labels, calculations, and no clipping/overlap.
6. The requested maximum visual/structural deviation is 21% from the reference. Treat 21% as a hard upper bound, not a target: aim for 0-10%; if any check exceeds 21%, mark the result NONCONFORMING and do not claim success.
7. A guarantee is allowed only after actual rendered-PDF inspection and checklist results. Before that, say "verification pending" and never promise compliance.

Output protocol:
- Never reveal chain-of-thought, hidden reasoning, analysis, deliberation, or internal policy.
- Never repeat an earlier assistant message verbatim. If nothing changed, say only: "Команда уже показана. Ожидаю новые данные."
- Output only short operational updates using:
  COMMAND: CMD-xxx — one action
  STATUS: one short status
  OUTPUT: files or "Немає"
  NEXT: one required input or "Готово"
- Do not ask the same question again when already answered.

Required logic:
1. Register floors, rooms, plans, photos, duplicates, missing links, IDs, and confidence.
2. Use every provided photo; do not invent room-photo links.
3. Geometry comes from calibrated plans; photos control finishes, furniture, and identity checks.
4. Real BIM requires editable floors, rooms, walls, openings, stairs, finishes, furniture, equipment, IDs, and provenance.
5. Engineering plans include CCTV, coverage, APs, sockets, racks, risers, conduits, junction boxes, cable routes, power, sensors, legends, and IDs.
6. Calculate cable lengths, optics, ports, PoE, UPS, bitrate, archive, capacity, parts, and services.
7. Recalculate all dependent values after changes.
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
      .filter((file) => file.data && file.type?.startsWith("image/"))
      .map((file) => ({ type: "image_url", image_url: { url: file.data, detail: "high" } }));
    const fileNotes = files.map((file) => `Attached file: ${file.name}, type: ${file.type || "unknown"}, size: ${file.size || 0} bytes`).join("\\n");
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
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
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

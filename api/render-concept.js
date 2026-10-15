import { GRACE_REFERENCE_PROFILE } from "../lib/referenceProfile.js";
import { GRACE_AGENT_MODEL, GRACE_IMAGE_MODEL } from "../lib/modelPolicy.js";
export const config = { runtime: "nodejs", maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OpenAI API not configured" });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = req.body && typeof req.body === "object" ? Buffer.from(JSON.stringify(req.body)) : Buffer.concat(chunks);
    if (raw.length > 3_900_000) return res.status(413).json({ error: "Render references exceed request limit" });
    const { plan, contactSheets, photoCount, request = "" } = JSON.parse(raw.toString("utf8"));
    const valid = (data) => /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data || "");
    if (!valid(plan) || !Array.isArray(contactSheets) || !contactSheets.length || contactSheets.length > 10 || !contactSheets.every(valid)) {
      return res.status(400).json({ error: "One 2D plan and photo contact sheets are required" });
    }
    const prompt = [
      "Create ONE new photoreal architectural axonometric cutaway concept render for a Grace Plan proposal.",
      "The FIRST image is the immutable geometry authority. Trace its outer footprint and every visible thick wall, thin partition, opening, door swing, window, stair, column and room boundary before styling.",
      "Do not simplify, merge, invent, rotate, mirror, resize or relocate rooms. Preserve line hierarchy and plan topology. If a symbol is unclear, leave that area conservative rather than guessing.",
      "The subsequent images are contact sheets representing " + Number(photoCount || 0) + " separate photographs. Infer surfaces and furniture only where visible; uncertain mappings stay generic.",
      "Deep charcoal-black horizontal wall cuts, near-overhead perspective, furnished interiors, clean white background, high-detail materials.",
      "No title, no labels, no symbols, no page layout. Do not turn a commercial building into an apartment.",
      "This is a conceptual rendering, not a precise 3D reconstruction, BIM model or IFC."
      ,"Reference style profile: " + GRACE_REFERENCE_PROFILE.renderStyle
      ,"User scope (apply only to design content): " + String(request).slice(0, 2000)
    ].join("\n");
    const input = [{ type: "input_text", text: prompt }, { type: "input_image", image_url: plan, detail: "high" },
      ...contactSheets.map((image_url) => ({ type: "input_image", image_url, detail: "high" }))];
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GRACE_AGENT_MODEL,
        input: [{ role: "user", content: input }],
        tools: [{ type: "image_generation", model: GRACE_IMAGE_MODEL, size: "1024x1024", quality: "high", action: "generate" }],
        tool_choice: { type: "image_generation" }
      })
    });
    const result = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: result.error?.message || "Render API failed", source: "openai", code: result.error?.code || null, model: GRACE_AGENT_MODEL, imageModel: GRACE_IMAGE_MODEL });
    const call = result.output?.find((item) => item.type === "image_generation_call" && item.result);
    if (!call) return res.status(502).json({ error: "Render tool returned no image" });
    return res.status(200).json({
      artifact: { type: "image", name: "GracePlan_concept_3D.png", data: "data:image/png;base64," + call.result },
      status: "concept_unverified",
      model: GRACE_AGENT_MODEL, imageModel: GRACE_IMAGE_MODEL,
      photoCount: Number(photoCount || 0),
      referenceMethod: "contact_sheets", referenceProfile: GRACE_REFERENCE_PROFILE.id,
      exactGeometryVerified: false, referenceDeviationPercent: null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Render failed" });
  }
}


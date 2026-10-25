// Proxy from the site to the Grace Bridge relay on the OCI server.
export const config = { runtime: "nodejs", maxDuration: 300 };

const RELAY = process.env.GRACE_RELAY_URL || "http://129.159.218.87:8899";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" && (req.query.action === "state" || req.url.includes("state"))) {
    try {
      const upstream = await fetch(RELAY + "/state", { signal: AbortSignal.timeout(15000) });
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(upstream.status).send(text);
    } catch (error) { return res.status(502).json({ error: "Bridge relay unreachable: " + (error.message || error) }); }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 50 * 1024 * 1024) return res.status(413).json({ error: "Payload too large" }); chunks.push(chunk); }
  const body = Buffer.concat(chunks).toString("utf8");

  const action = (req.query.action || req.url.split("/").pop() || "").toString();
  const endpoint = ["new", "send", "sync", "list"].includes(action) ? "/chat/" + action : null;
  if (!endpoint) return res.status(400).json({ error: "Unknown action: " + action });

  try {
    const upstream = await fetch(RELAY + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(280000),
    });
    const text = await upstream.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 500) }; }
    return res.status(upstream.ok ? 200 : upstream.status).json(data);
  } catch (error) {
    return res.status(502).json({ error: "Bridge relay unreachable: " + (error.message || error) });
  }
}

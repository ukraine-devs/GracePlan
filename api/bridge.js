// Proxy from the site to the Grace Bridge relay on the OCI server.
export const config = { runtime: "nodejs", maxDuration: 300 };

const RELAY = process.env.GRACE_RELAY_URL || "http://129.159.218.87:8899";

// A short connection drop between Vercel and the OCI box used to surface as a
// hard "fetch failed". Retry connection-level failures once before giving up.
async function relayFetch(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET" && (req.query.action === "state" || req.url.includes("state"))) {
    try {
      const upstream = await relayFetch(RELAY + "/state", { signal: AbortSignal.timeout(15000) });
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(upstream.status).send(text);
    } catch (error) { return res.status(502).json({ error: "Bridge relay unreachable: " + (error.message || error) }); }
  }
  // Live project status: which ChatGPT account the relay drives and how its
  // chat list compares with the site.
  if (req.method === "GET" && req.query.action === "health") {
    try {
      const upstream = await relayFetch(RELAY + "/project", { signal: AbortSignal.timeout(120000) });
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(upstream.status).send(text);
    } catch (error) { return res.status(502).json({ error: "Bridge relay unreachable: " + (error.message || error) }); }
  }
  if (req.method === "GET" && req.query.action === "render") {
    try {
      const upstream = await relayFetch(RELAY + "/render?id=" + encodeURIComponent(String(req.query.id || "")), { signal: AbortSignal.timeout(20000) });
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
  // Every action the relay implements must pass through, otherwise the site
  // silently loses deletes and transcript reads (a 400 nobody sees).
  const endpoint = ["new", "send", "publish", "sync", "list", "drop", "delete", "read", "rename", "render"].includes(action) ? "/chat/" + action : null;
  if (!endpoint) return res.status(400).json({ error: "Unknown action: " + action });

  try {
    const upstream = await relayFetch(RELAY + endpoint, {
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

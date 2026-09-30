// Cloudflare Worker proxy for HUD Scanner -> Gemini API
// Deploy: npx wrangler deploy   (after: npx wrangler secret put GEMINI_API_KEY)

const MODEL = "gemini-2.5-flash"; // free-tier friendly; try "gemini-2.5-flash-lite" for more quota
const MIN_INTERVAL_MS = 5000;     // per-IP throttle: max 1 scan / 5 sec
const kv = null; // if you attach a KV namespace later, swap Map for KV

// In-memory throttle (fine for a single worker instance; use KV for multi-instance)
const lastHit = new Map();

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (request.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    // --- simple per-IP throttle ---
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const now = Date.now();
    const last = lastHit.get(ip) || 0;
    if (now - last < MIN_INTERVAL_MS) {
      return new Response(JSON.stringify({ error: "Rate limited. Wait a few seconds." }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    lastHit.set(ip, now);
    // crude cleanup
    if (lastHit.size > 10000) lastHit.clear();

    // --- parse body ---
    let body;
    try { body = await request.json(); }
    catch { return new Response("Bad JSON", { status: 400 }); }

    const { image, prompt } = body || {};
    if (!image || !prompt) {
      return new Response(JSON.stringify({ error: "Missing image or prompt" }), {
        status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // --- call Gemini ---
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL + ":generateContent?key=" + env.GEMINI_API_KEY;

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: image } }] }],
        generationConfig: { maxOutputTokens: 800, temperature: 0.2 }
      })
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
};
                               

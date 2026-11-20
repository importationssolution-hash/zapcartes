// ZapCartes — reconnaissance de cartes par photo (fonction serveur Netlify).
// La clé API reste sur le serveur : variable d'environnement ANTHROPIC_API_KEY.
const MODEL = process.env.ZAP_MODEL || "claude-sonnet-5-5";
const MAX_BYTES = 6 * 1024 * 1024;

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return new Response("ANTHROPIC_API_KEY manquante", { status: 500 });
  let body;
  try { body = await req.json(); } catch { return new Response("JSON invalide", { status: 400 }); }
  const { image, mediaType = "image/jpeg", prompt } = body || {};
  if (typeof image !== "string" || typeof prompt !== "string" || image.length * 0.75 > MAX_BYTES || prompt.length > 8000)
    return new Response("Requête invalide", { status: 400 });
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return new Response("Type d'image refusé", { status: 400 });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: prompt },
      ] }],
    }),
  });
  if (!r.ok) return new Response("Erreur IA " + r.status, { status: 502 });
  const j = await r.json();
  const text = (j.content || []).map((c) => c.text || "").join("");
  return new Response(text, { headers: { "content-type": "application/json; charset=utf-8" } });
};

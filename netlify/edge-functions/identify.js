// 300mph — reconnaissance de cartes par photo (Edge Function Netlify, sans limite de 10 s).
// Les clés restent sur le serveur (Netlify › Project configuration › Environment variables) :
//   ANTHROPIC_API_KEY  → Claude d'Anthropic (utilisé en premier)
//   GEMINI_API_KEY     → Google Gemini (secours gratuit, ou principal si AI_PROVIDER = "gemini")
// La réponse commence tout de suite (quelques espaces), puis le résultat arrive quand l'IA a fini :
// Netlify n'exige que le début de la réponse dans les 40 s.
const env = (k, d = "") => (globalThis.Netlify?.env?.get(k)) ?? d;
const MAX_BYTES = 6 * 1024 * 1024;
const GEMINI_MODELS = env("GEMINI_MODEL", "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
const CLAUDE_MODEL = env("ZAP_MODEL", "claude-sonnet-5-5");
const DEADLINE_MS = Number(env("ZAP_DEADLINE_MS", "90000"));

async function askGemini(key, image, mediaType, prompt) {
  const start = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - start);
  let last = null;
  for (const model of GEMINI_MODELS) {
    let thinking = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (left() < 1500) break;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), left() - 300);
      const generationConfig = { responseMimeType: "application/json", temperature: 0.2 };
      if (thinking) generationConfig.thinkingConfig = { thinkingLevel: "low" }; // réponse plus rapide
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", signal: ctl.signal,
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: prompt }] }],
            generationConfig,
          }),
        });
      } catch (e) {
        clearTimeout(timer);
        last = { status: 504, message: "" };
        break; // plus de temps
      }
      clearTimeout(timer);
      if (r.ok) {
        const j = await r.json();
        const parts = j.candidates?.[0]?.content?.parts || [];
        return { text: parts.filter((p) => !p.thought).map((p) => p.text || "").join("") };
      }
      let msg = "";
      try { const e = await r.json(); msg = e.error?.message || e.error?.status || ""; } catch {}
      last = { status: r.status, message: msg };
      // ce modèle n'accepte pas le réglage de réflexion → on réessaie sans
      if (r.status === 400 && thinking && /thinking/i.test(msg)) { thinking = false; continue; }
      // surchargé : petite pause puis un nouvel essai, s'il reste du temps
      if ((r.status === 503 || r.status === 500) && attempt === 0 && left() > 4000) { await new Promise((ok) => setTimeout(ok, 800)); continue; }
      break;
    }
    if (!last || ![404, 429, 500, 503].includes(last.status) || left() < 1500) break;
  }
  // messages en français pour l'appli (évite le mot « model » qui serait mal interprété)
  if (!last) last = { status: 504 };
  const s = last.status;
  if (s === 503 || s === 500) last.message = "L’IA gratuite de Google est surchargée en ce moment. Réessaie dans 1 ou 2 minutes.";
  else if (s === 504 || !s) last.message = "L’IA a mis trop de temps à répondre. Réessaie avec une photo plus nette ou d’une seule carte.";
  else if (s === 429) last.message = "Gemini quota : limite gratuite atteinte.";
  else if (s === 404) last.message = "Aucun des modèles Gemini prévus n’est disponible (variable GEMINI_MODEL à ajuster).";
  return { error: last };
}

async function askClaude(key, image, mediaType, prompt) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEADLINE_MS - 300);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 2000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: prompt },
        ] }],
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    return { error: { status: 504, message: "L’IA a mis trop de temps à répondre. Réessaie avec une photo plus nette ou d’une seule carte." } };
  }
  clearTimeout(timer);
  if (!r.ok) {
    let msg = "";
    try { const e = await r.json(); msg = e.error?.message || e.error?.type || ""; } catch {}
    if (r.status === 529) msg = "L’IA de Claude est surchargée en ce moment. Réessaie dans 1 ou 2 minutes.";
    return { error: { status: r.status, message: msg } };
  }
  const j = await r.json();
  return { text: (j.content || []).map((c) => c.text || "").join("") };
}

async function analyse(req) {
  const gKey = env("GEMINI_API_KEY"), aKey = env("ANTHROPIC_API_KEY");
  const provider = env("AI_PROVIDER").toLowerCase();
  const useGemini = gKey && (provider === "gemini" || !aKey);
  if (!gKey && !aKey) return { error: { status: 500, message: "Clé IA manquante (GEMINI_API_KEY ou ANTHROPIC_API_KEY)" } };
  let body;
  try { body = await req.json(); } catch { return { error: { status: 400, message: "JSON invalide" } }; }
  const { image, mediaType = "image/jpeg", prompt } = body || {};
  if (typeof image !== "string" || typeof prompt !== "string" || image.length * 0.75 > MAX_BYTES || prompt.length > 8000)
    return { error: { status: 400, message: "Requête invalide" } };
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return { error: { status: 400, message: "Type d'image refusé" } };
  if (useGemini) return askGemini(gKey, image, mediaType, prompt);
  const t0 = Date.now();
  const res = await askClaude(aKey, image, mediaType, prompt);
  // Claude refuse vite (crédit épuisé, surcharge, quota…) → on tente Gemini s'il y a une clé
  if (res.error && gKey && res.error.status !== 504 && Date.now() - t0 < 5000) {
    const g = await askGemini(gKey, image, mediaType, prompt);
    if (!g.error) return g;
  }
  return res;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(" ")); // la réponse démarre tout de suite
      const keepAlive = setInterval(() => { try { controller.enqueue(enc.encode(" ")); } catch {} }, 5000);
      let out;
      try {
        const res = await analyse(req);
        out = res.error ? JSON.stringify({ error: res.error }) : (res.text || "{}");
      } catch (e) {
        out = JSON.stringify({ error: { status: 500, message: String(e && e.message || e) } });
      }
      clearInterval(keepAlive);
      controller.enqueue(enc.encode(out));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/identify", method: ["POST"] };

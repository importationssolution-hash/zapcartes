// ZapCartes — reconnaissance de cartes par photo (fonction serveur Netlify).
// Les clés restent sur le serveur (Netlify › Project configuration › Environment variables) :
//   GEMINI_API_KEY     → Google Gemini (formule gratuite, idéale pour les tests)
//   ANTHROPIC_API_KEY  → Claude d'Anthropic (payant)
// Si les deux existent, Claude est utilisé, sauf si AI_PROVIDER = "gemini".
const MAX_BYTES = 6 * 1024 * 1024;
const GEMINI_MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
const CLAUDE_MODEL = process.env.ZAP_MODEL || "claude-sonnet-5-5";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status, message) => json({ error: { status, message } }, 502);

// Netlify coupe une fonction gratuite à 10 s : on garde une marge pour répondre proprement.
const DEADLINE_MS = Number(process.env.ZAP_DEADLINE_MS || 9200);

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
  else if (s === 504 || !s) last.message = "L’IA a mis trop de temps à répondre (limite de 10 s de Netlify). Réessaie, ou prends une photo d’une seule carte.";
  else if (s === 429) last.message = "Gemini quota : limite gratuite atteinte.";
  else if (s === 404) last.message = "Aucun des modèles Gemini prévus n’est disponible (variable GEMINI_MODEL à ajuster).";
  return { error: last };
}

async function askClaude(key, image, mediaType, prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 4000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: prompt },
      ] }],
    }),
  });
  if (!r.ok) {
    let msg = "";
    try { const e = await r.json(); msg = e.error?.message || e.error?.type || ""; } catch {}
    return { error: { status: r.status, message: msg } };
  }
  const j = await r.json();
  return { text: (j.content || []).map((c) => c.text || "").join("") };
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const gKey = process.env.GEMINI_API_KEY, aKey = process.env.ANTHROPIC_API_KEY;
  const provider = (process.env.AI_PROVIDER || "").toLowerCase();
  const useGemini = gKey && (provider === "gemini" || !aKey);
  if (!gKey && !aKey) return new Response("Clé IA manquante (GEMINI_API_KEY ou ANTHROPIC_API_KEY)", { status: 500 });

  let body;
  try { body = await req.json(); } catch { return new Response("JSON invalide", { status: 400 }); }
  const { image, mediaType = "image/jpeg", prompt } = body || {};
  if (typeof image !== "string" || typeof prompt !== "string" || image.length * 0.75 > MAX_BYTES || prompt.length > 8000)
    return new Response("Requête invalide", { status: 400 });
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return new Response("Type d'image refusé", { status: 400 });

  const res = useGemini ? await askGemini(gKey, image, mediaType, prompt) : await askClaude(aKey, image, mediaType, prompt);
  if (res.error) return fail(res.error.status, res.error.message);
  return new Response(res.text, { headers: { "content-type": "application/json; charset=utf-8" } });
};

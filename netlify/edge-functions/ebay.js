// 300mph — publication directe sur eBay (Edge Function Netlify, sans limite de 10 s).
//
// Variables d'environnement (Netlify › Project configuration › Environment variables) :
//   EBAY_CLIENT_ID          App ID (Client ID) de ton application eBay
//   EBAY_CLIENT_SECRET      Cert ID (Client Secret)
//   EBAY_RUNAME             RuName (eBay Redirect URL name) dont l'Accept URL est https://TON-SITE/api/ebay/callback
//   EBAY_TOKEN_SECRET       Une longue phrase secrète au hasard (au moins 32 caractères) pour chiffrer les accès
//   EBAY_VERIFICATION_TOKEN 32 à 80 caractères (lettres, chiffres, _ ou -) : le même que dans le portail eBay
//   EBAY_ENV                "production" (par défaut) ou "sandbox" pour tester sans vraies annonces
//   EBAY_CATEGORY_FR        (optionnel) catégorie eBay.fr à forcer ; sinon trouvée automatiquement
//   ANTHROPIC_API_KEY / GEMINI_API_KEY  pour la description écrite par l'IA (déjà en place)
//
// Aucune donnée de vendeur n'est stockée sur le serveur : l'accès eBay de chaque vendeur est chiffré
// (AES-GCM) et gardé dans son propre navigateur.

const env = (k, d = "") => String((globalThis.Netlify?.env?.get(k)) ?? d);
const SANDBOX = env("EBAY_ENV", "production").toLowerCase() === "sandbox";
const API = SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const APIM = SANDBOX ? "https://apim.sandbox.ebay.com" : "https://apim.ebay.com";
const AUTH = SANDBOX ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
].join(" ");

const MARKETS = {
  EBAY_US: { site: "https://www.ebay.com", currency: "USD", langs: ["en-US"], category: "183454" },
  EBAY_CA: { site: "https://www.ebay.ca", currency: "CAD", langs: ["en-CA", "fr-CA"], category: "183454" },
  EBAY_FR: { site: "https://www.ebay.fr", currency: "EUR", langs: ["fr-FR"], category: "" },
};
// État des cartes non gradées (catégorie 183454) : 400010 NM ou mieux, 400015 LP, 400016 MP, 400017 HP
const CARD_CONDITION = ["400010", "400010", "400015", "400016", "400017", "400017"];

const enc = new TextEncoder(), dec = new TextDecoder();
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
class Fail extends Error { constructor(step, message, detail) { super(message); this.step = step; this.detail = detail; } }

// ---------- chiffrement des accès (AES-GCM) ----------
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function aesKey() {
  const secret = env("EBAY_TOKEN_SECRET");
  if (secret.length < 32) throw new Fail("config", "EBAY_TOKEN_SECRET manquant ou trop court (32 caractères minimum).");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64url(out);
}
async function unseal(token) {
  try {
    const all = unb64url(String(token || ""));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(), all.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail("auth", "Connexion eBay invalide ou expirée : reconnecte ton compte eBay.");
  }
}

// ---------- jetons eBay ----------
const basic = () => "Basic " + btoa(`${env("EBAY_CLIENT_ID")}:${env("EBAY_CLIENT_SECRET")}`);
async function tokenRequest(body) {
  if (!env("EBAY_CLIENT_ID") || !env("EBAY_CLIENT_SECRET")) throw new Fail("config", "EBAY_CLIENT_ID ou EBAY_CLIENT_SECRET manquant dans Netlify.");
  const r = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic() },
    body: new URLSearchParams(body).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Fail("auth", j.error_description || j.error || `Jeton eBay refusé (${r.status})`, j);
  return j;
}
let appTok = null;
async function appToken() {
  if (appTok && appTok.exp > Date.now() + 60000) return appTok.v;
  const j = await tokenRequest({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" });
  appTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 7200) * 1000 };
  return appTok.v;
}
async function userToken(sealed) {
  const s = await unseal(sealed);
  if (s.env !== (SANDBOX ? "sandbox" : "production")) throw new Fail("auth", "Ce compte eBay a été connecté dans un autre environnement : reconnecte-le.");
  if (s.rtExp && Date.now() > s.rtExp) throw new Fail("auth", "L’accès eBay a expiré (18 mois) : reconnecte ton compte eBay.");
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: s.rt, scope: SCOPES });
  return j.access_token;
}

// ---------- appels eBay ----------
async function ebay(step, token, method, path, { body, lang, base = API, headers = {}, raw = false } = {}) {
  const h = { authorization: `Bearer ${token}`, accept: "application/json", ...headers };
  if (body !== undefined && !(body instanceof FormData)) h["content-type"] = "application/json";
  if (lang) { h["content-language"] = lang; h["accept-language"] = lang; }
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)) });
  if (raw) return r;
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const errs = (j && (j.errors || j.warnings)) || [];
    const msg = errs.map((e) => e.longMessage || e.message).filter(Boolean).join(" · ") || `eBay a répondu ${r.status}`;
    const err = new Fail(step, msg, j); err.status = r.status; err.ids = errs.map((e) => e.errorId); throw err;
  }
  return { status: r.status, data: j, headers: r.headers };
}

// ---------- catégorie et caractéristiques ----------
const catCache = new Map(), aspectCache = new Map();
async function categoryFor(mkt, lang) {
  if (mkt === "EBAY_FR" && env("EBAY_CATEGORY_FR")) return env("EBAY_CATEGORY_FR");
  if (MARKETS[mkt].category) return MARKETS[mkt].category;
  if (catCache.has(mkt)) return catCache.get(mkt);
  const t = await appToken();
  const tree = (await ebay("categorie", t, "GET", `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${mkt}`, { lang })).data.categoryTreeId;
  const sug = (await ebay("categorie", t, "GET", `/commerce/taxonomy/v1/category_tree/${tree}/get_category_suggestions?q=${encodeURIComponent("carte pokemon unité")}`, { lang })).data;
  const list = (sug && sug.categorySuggestions) || [];
  const pick = list.find((c) => /unit|individu|single|jcc|ccg/i.test(c.category?.categoryName || "")) || list[0];
  if (!pick) throw new Fail("categorie", "Catégorie eBay introuvable : ajoute la variable EBAY_CATEGORY_FR dans Netlify.");
  catCache.set(mkt, pick.category.categoryId);
  return pick.category.categoryId;
}
async function aspectsFor(mkt, lang, categoryId) {
  const key = `${mkt}|${lang}|${categoryId}`;
  if (aspectCache.has(key)) return aspectCache.get(key);
  try {
    const t = await appToken();
    const tree = (await ebay("caracteristiques", t, "GET", `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${mkt}`, { lang })).data.categoryTreeId;
    const a = (await ebay("caracteristiques", t, "GET", `/commerce/taxonomy/v1/category_tree/${tree}/get_item_aspects_for_category?category_id=${categoryId}`, { lang })).data;
    const list = ((a && a.aspects) || []).map((x) => ({
      name: x.localizedAspectName,
      required: !!x.aspectConstraint?.aspectRequired,
      selectOnly: x.aspectConstraint?.aspectMode === "SELECTION_ONLY",
      values: (x.aspectValues || []).map((v) => v.localizedValue),
    }));
    aspectCache.set(key, list);
    return list;
  } catch { return []; } // si la liste n'est pas disponible, on envoie quand même nos caractéristiques
}
// Nos informations → noms de caractéristiques eBay possibles (anglais / français)
const ASPECT_NAMES = {
  game: ["Game", "Jeu"],
  name: ["Card Name", "Nom de la carte"],
  character: ["Character", "Personnage"],
  set: ["Set", "Extension", "Série"],
  number: ["Card Number", "Numéro de la carte", "Numéro de carte"],
  language: ["Language", "Langue"],
  rarity: ["Rarity", "Rareté"],
  finish: ["Finish", "Finition"],
  manufacturer: ["Manufacturer", "Fabricant"],
  year: ["Year Manufactured", "Année de fabrication"],
  cardType: ["Card Type", "Type de carte"],
};
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
function buildAspects(meta, info, fr) {
  const out = {};
  const want = {
    game: fr ? "Pokémon JCC" : "Pokémon TCG",
    name: info.name, character: info.character, set: info.set, number: info.number,
    language: info.language, rarity: info.rarity, finish: info.finish,
    manufacturer: fr ? "Nintendo / The Pokémon Company" : "Nintendo / The Pokémon Company",
    year: info.year, cardType: info.cardType,
  };
  const byName = new Map(meta.map((m) => [norm(m.name), m]));
  for (const [k, names] of Object.entries(ASPECT_NAMES)) {
    const v = want[k]; if (!v) continue;
    const m = names.map((n) => byName.get(norm(n))).find(Boolean);
    const name = m ? m.name : (fr ? names[names.length > 1 ? 1 : 0] : names[0]);
    let value = String(v).slice(0, 65);
    if (m && m.values.length) {
      const hit = m.values.find((x) => norm(x) === norm(value)) || m.values.find((x) => norm(x).includes(norm(value)) || norm(value).includes(norm(x)))
        || (k === "game" ? m.values.find((x) => /pok/i.test(x)) : null);
      if (hit) value = hit; else if (m.selectOnly) continue;
    } else if (!m && meta.length) {
      if (k !== "game") continue; // la catégorie ne connaît pas ce champ
    }
    out[name] = [value];
  }
  // caractéristiques obligatoires non remplies : on tente une valeur « Pokémon » si elle existe
  for (const m of meta) if (m.required && !out[m.name]) {
    const v = m.values.find((x) => /pok/i.test(x));
    if (v) out[m.name] = [v];
  }
  return out;
}

// ---------- description par l'IA ----------
async function aiDescription(info, lang, fallback) {
  const fr = lang.startsWith("fr");
  const prompt = `${fr ? "Écris en français" + (lang === "fr-CA" ? " (français canadien)" : "") : "Write in English"} the description of an eBay listing for this single Pokémon trading card.
Use ONLY these facts, invent nothing (no price, no grading, no guarantee you cannot know):
${JSON.stringify(info, null, 1)}
Format: simple HTML only with <p>, <ul>, <li>, <b> (no styles, no images, no links). 600 to 1200 characters.
Structure: one short catchy sentence; a list of the card details (name, set, number, rarity, finish, language, condition); a sentence about the visible condition based on the notes; shipping in a penny sleeve + toploader; reply with the HTML only.`;
  const aKey = env("ANTHROPIC_API_KEY"), gKey = env("GEMINI_API_KEY");
  const clean = (h) => String(h || "").replace(/^```(?:html)?\s*|\s*```$/g, "").replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "").trim();
  try {
    if (aKey && env("AI_PROVIDER").toLowerCase() !== "gemini") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": aKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: env("ZAP_MODEL", "claude-sonnet-5-5"), max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
      });
      if (r.ok) { const j = await r.json(); const h = clean((j.content || []).map((c) => c.text || "").join("")); if (h.length > 80) return { html: h, by: "claude" }; }
    }
    if (gKey) {
      for (const model of env("GEMINI_MODEL", "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite").split(",").map((m) => m.trim())) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gKey },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5 } }),
        });
        if (r.ok) {
          const j = await r.json();
          const h = clean((j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join(""));
          if (h.length > 80) return { html: h, by: "gemini" };
        }
        if (![404, 429, 500, 503].includes(r.status)) break;
      }
    }
  } catch {}
  return { html: fallback, by: "modele" };
}

// ---------- image ----------
async function uploadImage(token, b64, mediaType) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append("image", new Blob([bytes], { type: mediaType || "image/jpeg" }), "carte.jpg");
  const r = await ebay("photo", token, "POST", "/commerce/media/v1_beta/image/create_image_from_file", { body: fd, base: APIM });
  let url = r.data && r.data.imageUrl;
  if (!url) {
    const loc = r.headers.get("location") || "";
    const id = loc.split("/").pop();
    if (id) url = (await ebay("photo", token, "GET", `/commerce/media/v1_beta/image/${id}`, { base: APIM })).data?.imageUrl;
  }
  if (!url) throw new Fail("photo", "eBay n’a pas renvoyé l’adresse de la photo.");
  return url;
}

// ---------- actions ----------
async function setup(req) {
  const { token, marketplace } = await req.json();
  const mkt = MARKETS[marketplace] ? marketplace : "EBAY_US";
  const lang = MARKETS[mkt].langs[0];
  const t = await userToken(token);
  const get = async (path, key) => {
    try { return ((await ebay("reglages", t, "GET", path, { lang })).data?.[key] || []); }
    catch (e) { return { error: e.message }; }
  };
  const [ful, pay, ret, loc] = await Promise.all([
    get(`/sell/account/v1/fulfillment_policy?marketplace_id=${mkt}`, "fulfillmentPolicies"),
    get(`/sell/account/v1/payment_policy?marketplace_id=${mkt}`, "paymentPolicies"),
    get(`/sell/account/v1/return_policy?marketplace_id=${mkt}`, "returnPolicies"),
    get(`/sell/inventory/v1/location?limit=100`, "locations"),
  ]);
  const pol = (x, id) => Array.isArray(x) ? x.map((p) => ({ id: p[id], name: p.name })) : x;
  return {
    sandbox: SANDBOX,
    fulfillment: pol(ful, "fulfillmentPolicyId"),
    payment: pol(pay, "paymentPolicyId"),
    returns: pol(ret, "returnPolicyId"),
    locations: Array.isArray(loc) ? loc.map((l) => ({ key: l.merchantLocationKey, name: l.name || l.merchantLocationKey, country: l.location?.address?.country, postalCode: l.location?.address?.postalCode })) : loc,
  };
}
async function createLocation(req) {
  const { token, country, postalCode, city, stateOrProvince } = await req.json();
  const cc = String(country || "").toUpperCase().slice(0, 2);
  if (!/^[A-Z]{2}$/.test(cc) || !(postalCode || (city && stateOrProvince))) throw new Fail("lieu", "Indique le pays et le code postal.");
  const t = await userToken(token);
  const key = `300mph-${cc}-${String(postalCode || city).replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`.toUpperCase();
  const address = { country: cc };
  if (postalCode) address.postalCode = String(postalCode).trim();
  if (city) address.city = city; if (stateOrProvince) address.stateOrProvince = stateOrProvince;
  try {
    await ebay("lieu", t, "POST", `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
      body: { location: { address }, name: `300mph ${cc} ${postalCode || city}`, merchantLocationStatus: "ENABLED", locationTypes: ["WAREHOUSE"] },
    });
  } catch (e) { if (e.status !== 409 && !(e.ids || []).includes(25803)) throw e; } // existe déjà : on le réutilise
  return { key };
}
async function publish(req) {
  const p = await req.json();
  const mkt = MARKETS[p.marketplace] ? p.marketplace : null;
  if (!mkt) throw new Fail("donnees", "Site eBay inconnu.");
  const lang = MARKETS[mkt].langs.includes(p.lang) ? p.lang : MARKETS[mkt].langs[0];
  const fr = lang.startsWith("fr");
  const { policies = {}, locationKey } = p;
  if (!policies.fulfillment || !policies.payment || !policies.returns) throw new Fail("reglages", "Choisis tes politiques eBay (livraison, paiement, retours) dans les réglages eBay de l’appli.");
  if (!locationKey) throw new Fail("reglages", "Choisis ou crée ton lieu d’expédition dans les réglages eBay de l’appli.");
  if (!p.image) throw new Fail("photo", "Ajoute une photo à cette carte : eBay exige au moins une photo.");
  const price = Number(p.price);
  if (!(price > 0)) throw new Fail("prix", "Mets un prix à cette carte avant de la publier.");
  const qty = Math.max(1, Math.min(999, parseInt(p.quantity) || 1));
  const title = String(p.title || "").slice(0, 80);
  if (!title) throw new Fail("donnees", "Titre manquant.");
  const sku = String(p.sku || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  if (!sku) throw new Fail("donnees", "Identifiant de carte manquant.");
  const info = p.info || {};

  const t = await userToken(p.token);
  const [categoryId, imageUrl] = await Promise.all([categoryFor(mkt, lang), uploadImage(t, p.image, p.mediaType)]);
  const [meta, desc] = await Promise.all([aspectsFor(mkt, lang, categoryId), aiDescription(info, lang, String(p.fallbackDescription || "").slice(0, 4000))]);
  const aspects = buildAspects(meta, info, fr);
  const cond = CARD_CONDITION[Math.max(0, Math.min(5, parseInt(p.condition) || 1))];

  await ebay("fiche", t, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    lang,
    body: {
      availability: { shipToLocationAvailability: { quantity: qty } },
      condition: "USED_VERY_GOOD", // carte non gradée
      conditionDescriptors: [{ name: "40001", values: [cond] }],
      product: { title, description: desc.html, aspects, imageUrls: [imageUrl] },
    },
  });
  const offer = {
    sku, marketplaceId: mkt, format: "FIXED_PRICE", availableQuantity: qty, categoryId,
    listingDescription: desc.html,
    listingPolicies: { fulfillmentPolicyId: policies.fulfillment, paymentPolicyId: policies.payment, returnPolicyId: policies.returns },
    pricingSummary: { price: { value: price.toFixed(2), currency: MARKETS[mkt].currency } },
    merchantLocationKey: locationKey,
  };
  let offerId;
  try {
    offerId = (await ebay("offre", t, "POST", "/sell/inventory/v1/offer", { lang, body: offer })).data.offerId;
  } catch (e) {
    if (!(e.ids || []).includes(25002)) throw e; // l'offre existe déjà pour cette carte : on la met à jour
    const list = (await ebay("offre", t, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${mkt}`, { lang })).data?.offers || [];
    if (!list[0]) throw e;
    offerId = list[0].offerId;
    await ebay("offre", t, "PUT", `/sell/inventory/v1/offer/${offerId}`, { lang, body: offer });
  }
  const pub = await ebay("publication", t, "POST", `/sell/inventory/v1/offer/${offerId}/publish`, { lang, body: {} });
  const listingId = pub.data?.listingId;
  const site = SANDBOX ? "https://sandbox.ebay.com" : (mkt === "EBAY_CA" && fr ? "https://www.cafr.ebay.ca" : MARKETS[mkt].site);
  return {
    listingId, offerId, sku, categoryId,
    url: listingId ? `${site}/itm/${listingId}` : null,
    description: desc.html, descriptionBy: desc.by,
    warnings: (pub.data?.warnings || []).map((w) => w.longMessage || w.message),
  };
}

// ---------- notification eBay de suppression de compte ----------
async function deletion(req, url) {
  if (req.method === "GET") {
    const code = url.searchParams.get("challenge_code") || "";
    const endpoint = env("EBAY_DELETION_ENDPOINT") || `${url.origin}${url.pathname}`;
    const hash = await crypto.subtle.digest("SHA-256", enc.encode(code + env("EBAY_VERIFICATION_TOKEN") + endpoint));
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return json({ challengeResponse: hex });
  }
  // 300mph ne stocke aucune donnée de compte eBay côté serveur : rien à effacer, on accuse réception.
  return new Response(null, { status: 204 });
}

// ---------- routes ----------
function streamed(work) {
  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(" "));
      const ka = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch {} }, 5000);
      let out;
      try { out = JSON.stringify({ ok: true, ...(await work()) }); }
      catch (e) { out = JSON.stringify({ ok: false, error: { step: e.step || "serveur", message: e.message || String(e), status: e.status || 0, ids: e.ids || [], detail: e.detail || null } }); }
      clearInterval(ka); c.enqueue(enc.encode(out)); c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/ebay\/?/, "").replace(/\/$/, "");
  try {
    if (route === "status") {
      // Diagnostic : dit quelles variables manquent, sans jamais afficher leurs valeurs.
      const need = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME", "EBAY_TOKEN_SECRET"];
      const missing = need.filter((k) => !env(k).trim());
      const problems = [];
      if (env("EBAY_TOKEN_SECRET") && env("EBAY_TOKEN_SECRET").length < 32) problems.push(`EBAY_TOKEN_SECRET trop court (${env("EBAY_TOKEN_SECRET").length} caractères, il en faut 32)`);
      for (const k of need) if (env(k) && env(k) !== env(k).trim()) problems.push(`${k} contient un espace au début ou à la fin`);
      const id = env("EBAY_CLIENT_ID");
      if (id && SANDBOX && !/-SBX-/.test(id)) problems.push("EBAY_ENV = sandbox mais EBAY_CLIENT_ID n’est pas une clé Sandbox (-SBX-)");
      if (id && !SANDBOX && /-SBX-/.test(id)) problems.push("EBAY_CLIENT_ID est une clé Sandbox (-SBX-) : mets EBAY_ENV = sandbox");
      return json({ configured: !missing.length && !problems.length, sandbox: SANDBOX, missing, problems,
        seen: Object.fromEntries([...need, "EBAY_ENV"].map((k) => [k, env(k) ? `ok (${env(k).length} caractères)` : "absente"])) });
    }
    if (route === "login") {
      if (!env("EBAY_CLIENT_ID") || !env("EBAY_RUNAME")) return new Response("eBay n’est pas encore configuré sur ce site (EBAY_CLIENT_ID / EBAY_RUNAME).", { status: 500 });
      const state = (url.searchParams.get("state") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      const q = new URLSearchParams({ client_id: env("EBAY_CLIENT_ID"), redirect_uri: env("EBAY_RUNAME"), response_type: "code", scope: SCOPES, state, prompt: "login" });
      return Response.redirect(`${AUTH}/oauth2/authorize?${q}`, 302);
    }
    if (route === "callback") {
      // Page de retour après la connexion eBay. Elle répond toujours 200 (eBay vérifie l'adresse
      // quand on l'enregistre), puis renvoie le navigateur vers 300mph avec l'accès chiffré.
      const state = (url.searchParams.get("state") || "").replace(/[^A-Za-z0-9_-]/g, "");
      const code = url.searchParams.get("code");
      const page = (frag, msg) => new Response(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>300mph — eBay</title>
<style>body{font:17px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f4f1ea;color:#1c1b19;text-align:center;padding:20px}a{color:#1c1b19;font-weight:700}</style></head>
<body><div><p style="font-size:44px;margin:0">⚡</p><p>${msg}</p><p><a id="go" href="/${frag ? "#" + frag : ""}">Retourner sur 300mph</a></p></div>
${frag ? `<script>location.replace(${JSON.stringify("/#" + frag)});</script>` : ""}</body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (!code) {
        const err = url.searchParams.get("error_description") || url.searchParams.get("error");
        return err ? page(`ebay-error=${encodeURIComponent(err)}`, "Connexion eBay annulée.") : page("", "Adresse de retour eBay de 300mph : elle est prête.");
      }
      try {
        const j = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: env("EBAY_RUNAME") });
        const sealed = await seal({ rt: j.refresh_token, rtExp: Date.now() + (j.refresh_token_expires_in || 47304000) * 1000, env: SANDBOX ? "sandbox" : "production", at: Date.now() });
        return page(`ebay-token=${sealed}&ebay-state=${state}`, "Compte eBay connecté ! Retour sur 300mph…");
      } catch (e) { return page(`ebay-error=${encodeURIComponent(e.message)}`, "La connexion eBay a échoué."); }
    }
    if (route === "deletion") return deletion(req, url);
    if (route === "exchange" && req.method === "POST") {
      // Secours : le vendeur colle l'adresse de la page « Thank You » d'eBay, qui contient le code.
      try {
        const { code } = await req.json();
        if (!code || String(code).length < 20) throw new Fail("auth", "Code eBay introuvable dans l’adresse collée.");
        const j = await tokenRequest({ grant_type: "authorization_code", code: String(code), redirect_uri: env("EBAY_RUNAME") });
        const sealed = await seal({ rt: j.refresh_token, rtExp: Date.now() + (j.refresh_token_expires_in || 47304000) * 1000, env: SANDBOX ? "sandbox" : "production", at: Date.now() });
        return json({ ok: true, token: sealed });
      } catch (e) { return json({ ok: false, error: { step: e.step || "auth", message: e.message } }); }
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (route === "setup") return streamed(() => setup(req));
    if (route === "location") return streamed(() => createLocation(req));
    if (route === "publish") return streamed(() => publish(req));
    return json({ ok: false, error: { message: "Route inconnue" } }, 404);
  } catch (e) {
    return json({ ok: false, error: { step: e.step || "serveur", message: e.message } }, 500);
  }
};

export const config = { path: "/api/ebay/*" };

// 300mph — comptes vendeurs : créer un compte, se connecter (rester connecté), se déconnecter,
// et garder sa liste, ses photos et sa connexion eBay d'un appareil à l'autre.
// Stockage : Netlify Blobs (inclus avec Netlify, rien à configurer).
import { getStore } from "@netlify/blobs";

const enc = new TextEncoder();
const SESSION_DAYS = 365;          // « rester connecté » : 1 an
const MAX_DATA = 4 * 1024 * 1024;  // 4 Mo de liste par compte
const MAX_PHOTO = 4 * 1024 * 1024; // 4 Mo par photo
const PBKDF2_ITER = 210000;

const store = (name) => getStore({ name, consistency: "strong" });
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const fail = (status, code, message) => json({ error: { code, message } }, status);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hashPassword(password, saltHex, iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
function sameHex(a, b) { // comparaison à temps constant
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const okEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const userKey = async (email) => "u_" + (await sha256(email));

async function newSession(user) {
  const token = randomHex(32);
  await store("sessions").setJSON(await sha256(token), { uid: user.id, email: user.email, created: Date.now(), expires: Date.now() + SESSION_DAYS * 864e5 });
  return { token, email: user.email };
}
async function sessionFrom(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  const s = await store("sessions").get(await sha256(m[1]), { type: "json" });
  if (!s || s.expires < Date.now()) return null;
  return { ...s, tokenHash: await sha256(m[1]) };
}

// Trop d'essais de mot de passe : pause de 15 minutes après 8 échecs
async function checkLock(email) {
  const f = await store("accounts").get("fail_" + (await sha256(email)), { type: "json" });
  return f && f.n >= 8 && Date.now() - f.at < 15 * 60e3;
}
async function noteFail(email, reset = false) {
  const k = "fail_" + (await sha256(email)), st = store("accounts");
  if (reset) return st.delete(k);
  const f = (await st.get(k, { type: "json" })) || { n: 0, at: 0 };
  const n = Date.now() - f.at > 15 * 60e3 ? 1 : f.n + 1;
  await st.setJSON(k, { n, at: Date.now() });
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/account\/?/, "").split("/");
  const [what, arg] = route;
  try {
    // ----- créer un compte -----
    if (what === "signup" && req.method === "POST") {
      const { email: e, password } = await req.json();
      const email = cleanEmail(e);
      if (!okEmail(email)) return fail(400, "email", "Adresse courriel invalide.");
      if (typeof password !== "string" || password.length < 8) return fail(400, "password", "Le mot de passe doit avoir au moins 8 caractères.");
      if (password.length > 200) return fail(400, "password", "Mot de passe trop long.");
      const k = await userKey(email), accounts = store("accounts");
      if (await accounts.get(k)) return fail(409, "exists", "Un compte existe déjà avec cette adresse. Connecte-toi.");
      const salt = randomHex(16);
      const user = { id: randomHex(12), email, salt, iter: PBKDF2_ITER, hash: await hashPassword(password, salt), created: Date.now() };
      await accounts.setJSON(k, user);
      return json(await newSession(user));
    }
    // ----- se connecter -----
    if (what === "login" && req.method === "POST") {
      const { email: e, password } = await req.json();
      const email = cleanEmail(e);
      if (!okEmail(email) || typeof password !== "string") return fail(400, "login", "Courriel ou mot de passe incorrect.");
      if (await checkLock(email)) return fail(429, "locked", "Trop d'essais. Réessaie dans 15 minutes.");
      const user = await store("accounts").get(await userKey(email), { type: "json" });
      const ok = user && sameHex(await hashPassword(password, user.salt, user.iter || PBKDF2_ITER), user.hash);
      if (!ok) { await noteFail(email); return fail(401, "login", "Courriel ou mot de passe incorrect."); }
      await noteFail(email, true);
      return json(await newSession(user));
    }

    // ----- tout le reste demande d'être connecté -----
    const s = await sessionFrom(req);
    if (!s) return fail(401, "session", "Session expirée. Reconnecte-toi.");

    if (what === "logout" && req.method === "POST") { await store("sessions").delete(s.tokenHash); return json({ ok: true }); }
    if (what === "me") return json({ email: s.email });

    if (what === "data") {
      const data = store("data");
      if (req.method === "GET") return json((await data.get(s.uid, { type: "json" })) || null);
      if (req.method === "PUT") {
        const txt = await req.text();
        if (txt.length > MAX_DATA) return fail(413, "size", "Liste trop grosse pour être sauvegardée.");
        const body = JSON.parse(txt);
        await data.setJSON(s.uid, { ...body, savedAt: Date.now() });
        return json({ ok: true, savedAt: Date.now() });
      }
    }

    if (what === "photo" && /^[A-Za-z0-9_-]{1,80}$/.test(arg || "")) {
      const photos = store("photos"), key = `${s.uid}/${arg}`;
      if (req.method === "GET") {
        const b = await photos.get(key, { type: "arrayBuffer" });
        if (!b) return fail(404, "nophoto", "Pas de photo.");
        return new Response(b, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000" } });
      }
      if (req.method === "PUT") {
        const b = await req.arrayBuffer();
        if (!b.byteLength || b.byteLength > MAX_PHOTO) return fail(413, "size", "Photo trop grosse.");
        await photos.set(key, b);
        return json({ ok: true });
      }
      if (req.method === "DELETE") { await photos.delete(key); return json({ ok: true }); }
    }

    // ----- supprimer son compte (liste, photos, sessions) -----
    if (what === "delete" && req.method === "POST") {
      const { password } = await req.json().catch(() => ({}));
      const k = await userKey(s.email), accounts = store("accounts");
      const user = await accounts.get(k, { type: "json" });
      if (!user || !sameHex(await hashPassword(String(password || ""), user.salt, user.iter || PBKDF2_ITER), user.hash)) return fail(401, "login", "Mot de passe incorrect.");
      const photos = store("photos");
      const { blobs } = await photos.list({ prefix: s.uid + "/" });
      for (const b of blobs) await photos.delete(b.key);
      await store("data").delete(s.uid);
      await accounts.delete(k);
      await store("sessions").delete(s.tokenHash);
      return json({ ok: true });
    }

    return fail(404, "route", "Adresse inconnue.");
  } catch (e) {
    return fail(500, "server", "Erreur serveur : " + (e && e.message || e));
  }
};

export const config = { path: "/api/account/*" };

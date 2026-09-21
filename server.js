/* ============================================================
   PONTE LOGISTICO — Server per Render (due PC)
   Chat condivisa Campionario ⇄ Produzione.
   Tre comandi: Spedizione in partenza / Mi unisco / Non mi unisco.
   ============================================================ */

const express = require("express");
const path = require("path");
const fs = require("fs");
const webpush = require("web-push");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.use(express.json({ limit: "2mb" }));

/* ---------- Solo da computer: dal telefono si vede solo un avviso ---------- */
const RE_TELEFONO = /Mobi|iPhone|iPod|Android.+Mobile|Windows Phone|BlackBerry|BB10|Opera Mini|IEMobile/i;
const PAGINA_TELEFONO = "<!doctype html><html lang=\"it\"><head><meta charset=\"utf-8\">" +
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Ponte Logistico</title></head>" +
  "<body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d10;" +
  "color:#eef2f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;box-sizing:border-box\">" +
  "<div style=\"max-width:360px;text-align:center;background:#14171c;border:1px solid #272d38;border-radius:16px;padding:28px 22px\">" +
  "<div style=\"font-size:44px\">💻</div>" +
  "<h1 style=\"font-size:19px;margin:12px 0 8px\">Ponte Logistico si usa solo da computer</h1>" +
  "<p style=\"font-size:14px;color:#93a0b0;line-height:1.5;margin:0\">Apri <b style=\"color:#eef2f6\">ponte-logistico.onrender.com</b> " +
  "dal PC del tuo reparto.</p></div></body></html>";
/* Il tipo di dispositivo serve solo a decidere cosa mostrare: dei telefoni non si registra
   nulla (né IP, né dispositivo, né orario), in nessun file e in nessun log. */
app.use(function(req, res, next){
  res.setHeader("Vary", "User-Agent");
  if (req.path === "/ping" || !RE_TELEFONO.test(req.headers["user-agent"] || "")) return next();
  res.statusCode = 403;
  res.setHeader("Cache-Control", "no-store");
  if (req.path.indexOf("/api/") === 0) return res.json({ error: "Ponte Logistico si usa solo da computer." });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(PAGINA_TELEFONO);
});

/* ---------- Stato condiviso ---------- */
const DB_FILE = path.join(__dirname, "dati.json");
let DB = {
  tratte: [
    { id: "mag-negozio", nome: "Magazzino \u2192 Negozi Citt\u00e0", sub: "route quotidiana", items: [] },
    { id: "camp-prod",   nome: "Campionario \u2192 Produzione", sub: "passaggio interno", items: [] },
  ],
  seq: 1,
};
try { if (fs.existsSync(DB_FILE)) DB = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}

function persist(){
  try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch (e) {}
}

/* ---------- Ora di partenza (fuso italiano) ---------- */
/* scarto in minuti tra ora italiana e UTC (+60 d'inverno, +120 d'estate) in un certo istante,
   calcolato senza dipendere dal fuso orario del server */
function scartoRoma(date){
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).forEach(function(x){ p[x.type] = Number(x.value); });
  const comeUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((comeUTC - date.getTime()) / 60000);
}
function calcolaPartenza(when){
  const m = String(when || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const ora = Number(m[1]), min = Number(m[2]);
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
  const parti = fmt.format(now).split("-").map(Number);
  const Y = parti[0], M = parti[1], D = parti[2];
  function istante(giorno){
    const base = Date.UTC(Y, M - 1, giorno, ora, min, 0);
    let ts = base - scartoRoma(now) * 60000;
    return base - scartoRoma(new Date(ts)) * 60000; /* ricontrollo: vale anche nelle notti del cambio d'ora */
  }
  let ts = istante(D);
  if (ts < Date.now() - 5 * 60000) ts = istante(D + 1);
  return ts;
}

function oraItalia(){
  return new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
}

/* ---------- Push in tempo reale ai PC collegati (SSE) ---------- */
const clients = new Set();

app.get("/api/stream", function(req, res){
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  res.write("retry: 3000\n\n");
  res.write("event: hello\ndata: " + JSON.stringify({ ok: true }) + "\n\n");
  clients.add(res);
  const ping = setInterval(function(){ try { res.write(": ping\n\n"); } catch (e) {} }, 20000);
  req.on("close", function(){ clearInterval(ping); clients.delete(res); });
});

function broadcast(event, payload){
  const frame = "event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
  for (const r of clients) { try { r.write(frame); } catch (e) {} }
}

/* ---------- Notifiche push (arrivano anche a browser abbassato o scheda chiusa) ----------
   Le chiavi VAPID vanno messe su Render → Environment:
   VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY. Se mancano, il server ne crea di temporanee
   (funziona lo stesso, ma a ogni nuovo deploy i PC devono riaprire l'app una volta). */
const SUBS_FILE = path.join(__dirname, "iscrizioni.json");
const VAPID_FILE = path.join(__dirname, "vapid.json");
let VAPID = null;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  VAPID = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() };
} else {
  try { VAPID = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); } catch (e) {}
  if (!VAPID || !VAPID.publicKey || !VAPID.privateKey) {
    VAPID = webpush.generateVAPIDKeys();
    try { fs.writeFileSync(VAPID_FILE, JSON.stringify(VAPID)); } catch (e) {}
  }
  console.warn("ATTENZIONE: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non impostate: uso chiavi temporanee.");
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "https://ponte-logistico.onrender.com",
  VAPID.publicKey, VAPID.privateKey);

/* iscrizioni dei browser: tenute a parte, NON vengono mai mandate in /api/state */
let SUBS = [];
try { if (fs.existsSync(SUBS_FILE)) SUBS = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")) || []; } catch (e) { SUBS = []; }
function persistSubs(){
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(SUBS, null, 2)); } catch (e) {}
}

/* invia una notifica a tutte le iscrizioni che passano il filtro */
function inviaPush(filtro, dati, ttlSecondi){
  const payload = JSON.stringify(dati);
  const destinatari = SUBS.filter(filtro);
  let cambiate = false;
  return Promise.all(destinatari.map(function(s){
    return webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload,
      { TTL: ttlSecondi || 3600, urgency: "high" })
      .catch(function(err){
        const code = err && err.statusCode;
        /* iscrizione scaduta, revocata o fatta con chiavi vecchie: la tolgo */
        if (code === 404 || code === 410 || code === 401 || code === 403) {
          SUBS = SUBS.filter(function(x){ return x.endpoint !== s.endpoint; });
          cambiate = true;
        } else {
          console.error("Push non inviata a " + (s.who || "?") + ":", code || "", (err && (err.body || err.message)) || "");
        }
      });
  })).then(function(){ if (cambiate) persistSubs(); });
}

app.get("/api/push/key", function(req, res){
  res.json({ key: VAPID.publicKey });
});

app.post("/api/push/subscribe", function(req, res){
  const body = req.body || {};
  const sub = body.sub || {};
  const keys = sub.keys || {};
  if (typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: "iscrizione non valida" });
  }
  /* se il browser ha rinnovato l'iscrizione, eredita nome e reparto da quella vecchia */
  const vecchia = SUBS.find(function(s){ return s.endpoint === sub.endpoint || (body.oldEndpoint && s.endpoint === body.oldEndpoint); });
  SUBS = SUBS.filter(function(s){ return s.endpoint !== sub.endpoint && s.endpoint !== body.oldEndpoint; });
  SUBS.push({
    endpoint: sub.endpoint,
    keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
    who: typeof body.who === "string" ? body.who : (vecchia ? vecchia.who : ""),
    rep: typeof body.rep === "string" ? body.rep : (vecchia ? vecchia.rep : ""),
    since: Date.now(),
  });
  if (SUBS.length > 300) SUBS = SUBS.slice(-300);
  persistSubs();
  res.json({ ok: true });
});

/* service worker: il file che mostra le notifiche quando la pagina non è in primo piano */
app.get("/sw.js", function(req, res){
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "sw.js"), function(err){
    if (err) { console.error("sw.js mancante accanto a server.js"); if (!res.headersSent) res.status(404).end(); }
  });
});

/* promemoria "parte tra 5 minuti": lo manda il server, così arriva anche a scheda chiusa */
const PREAVVISO_MS = 5 * 60000;
function controllaPromemoria(){
  const now = Date.now();
  let cambiato = false;
  DB.tratte.forEach(function(t){
    t.items.forEach(function(it){
      if (!it.departAt || it.reminded) return;
      const ms = it.departAt - now;
      if (ms > PREAVVISO_MS) return;
      it.reminded = true; cambiato = true;
      if (ms < -60000) return; /* partenza già passata (es. server riavviato): niente avviso in ritardo */
      const joins = (it.votes || []).filter(function(v){ return v.choice === "join"; }).map(function(v){ return v.who; }).join(", ");
      const min = Math.ceil(ms / 60000);
      inviaPush(function(){ return true; }, {
        title: min >= 1 ? "⏰ La spedizione parte tra " + min + (min === 1 ? " minuto!" : " minuti!") : "🚚 La spedizione sta partendo!",
        body: it.from + " → " + it.to + (joins ? " — a bordo: " + joins : " — nessuno a bordo"),
        tag: "remind-" + it.id, trattaId: t.id, itemId: it.id, requireInteraction: true,
      }, 600);
    });
  });
  if (cambiato) persist();
}
setInterval(controllaPromemoria, 15000);

/* ---------- Sveglia per cron-job.org: tiene acceso il server gratuito di Render ----------
   Ogni visita scrive una riga nei Logs di Render, così si vede che il cron funziona. */
app.get("/ping", function(req, res){
  console.log("ping ricevuto alle " + oraItalia() + " — server sveglio");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send("ok " + oraItalia());
});

/* ---------- API ---------- */
app.get("/api/state", function(req, res){
  res.json(Object.assign({}, DB, { serverNow: Date.now(), serverOra: oraItalia() }));
});

app.post("/api/ship", function(req, res){
  const body = req.body || {};
  const t = DB.tratte.find(function(x){ return x.id === body.trattaId; }) || DB.tratte[0];
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  /* "by" e' il nome dell'operatore (es. Federica); "rep" il suo reparto.
     Le versioni vecchie mandavano solo "by" col nome del reparto: gestite qui sotto. */
  const rep = body.rep || (body.by === "Produzione" ? "Produzione" : "Campionario");
  const item = {
    id: DB.seq++,
    by: body.by || "?",
    rep: rep,
    fromRep: rep,
    toRep: rep === "Campionario" ? "Produzione" : "Campionario",
    from: body.from,
    to: body.to,
    when: body.when || "non indicato",
    note: body.note || "",
    at: oraItalia(),
    ts: Date.now(),
    departAt: calcolaPartenza(body.when),
    votes: [],
  };
  t.items.unshift(item);
  persist();
  broadcast("ship", { trattaId: t.id, trattaNome: t.nome, item: item });
  /* notifica a tutti tranne a chi l'ha pubblicata */
  inviaPush(function(s){ return s.who !== item.by; }, {
    title: "🚚 Nuova spedizione in partenza!",
    body: item.by + ": " + item.from + " → " + item.to + " (" + item.when + ")",
    tag: "ship-" + item.id, trattaId: t.id, itemId: item.id, requireInteraction: true,
  }, 3600);
  controllaPromemoria(); /* se parte entro 5 minuti, il promemoria esce subito */
  res.json({ ok: true, item: item, state: DB });
});

app.post("/api/vote", function(req, res){
  const body = req.body || {};
  const t = DB.tratte.find(function(x){ return x.id === body.trattaId; });
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const item = t.items.find(function(i){ return i.id === body.itemId; });
  if (!item) return res.status(400).json({ error: "spedizione non trovata" });
  const ex = item.votes.find(function(v){ return v.who === body.who; });
  if (ex) { ex.choice = body.choice; ex.rep = body.rep || ex.rep; ex.at = oraItalia(); }
  else item.votes.push({ who: body.who, rep: body.rep || "", choice: body.choice, at: oraItalia() });
  persist();
  broadcast("vote", { trattaId: t.id, itemId: body.itemId, who: body.who, choice: body.choice, item: item });
  /* la risposta arriva a chi ha pubblicato la spedizione */
  if (item.by && item.by !== body.who) {
    const siUnisce = body.choice === "join";
    inviaPush(function(s){ return s.who === item.by; }, {
      title: (siUnisce ? "✅ " : "❌ ") + "Risposta al tragitto",
      body: body.who + ": " + (siUnisce ? "Mi unisco" : "Non mi unisco") + " — " + item.from + " → " + item.to,
      tag: "vote-" + item.id + "-" + body.who, trattaId: t.id, itemId: item.id,
    }, 1800);
  }
  res.json({ ok: true, item: item, state: DB });
});

app.post("/api/deltratta", function(req, res){
  const body = req.body || {};
  const idx = DB.tratte.findIndex(function(x){ return x.id === body.trattaId; });
  if (idx === -1) return res.status(400).json({ error: "tratta non trovata" });
  if (DB.tratte.length <= 1) return res.status(400).json({ error: "serve almeno una tratta" });
  DB.tratte.splice(idx, 1);
  persist();
  broadcast("tratta", { state: DB });
  res.json({ ok: true, state: DB });
});

app.post("/api/delitem", function(req, res){
  const body = req.body || {};
  const t = DB.tratte.find(function(x){ return x.id === body.trattaId; });
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const idx = t.items.findIndex(function(x){ return x.id === body.itemId; });
  if (idx === -1) return res.status(400).json({ error: "spedizione non trovata" });
  t.items.splice(idx, 1);
  persist();
  broadcast("tratta", { state: DB });
  res.json({ ok: true, state: DB });
});

app.post("/api/tratta", function(req, res){
  const body = req.body || {};
  if (!body.nome) return res.status(400).json({ error: "nome mancante" });
  const id = "t" + DB.seq++;
  DB.tratte.push({ id: id, nome: body.nome, sub: "nuova tratta", items: [] });
  persist();
  broadcast("tratta", { state: DB });
  res.json({ ok: true, state: DB });
});

/* ---------- Pagina web (file page.html, caricato all'avvio) ---------- */
const PAGE_PATH = path.join(__dirname, "page.html");
let PAGE = "";
function caricaPagina(){
  try {
    PAGE = fs.readFileSync(PAGE_PATH, "utf8");
  } catch (e) {
    PAGE = "<!doctype html><meta charset=\"utf-8\"><body style=\"font-family:sans-serif;padding:40px\">" +
           "<h1>page.html non trovato</h1><p>Il file dell'interfaccia manca accanto a server.js.</p>";
    console.error("Impossibile leggere page.html:", e.message);
  }
}
caricaPagina();

app.get("*", function(req, res){
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(PAGE);
});

app.listen(PORT, "0.0.0.0", function(){
  console.log("VERSIONE-NOTIFICHE-PUSH attiva sulla porta " + PORT);
});

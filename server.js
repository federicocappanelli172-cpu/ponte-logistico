/* ============================================================
   PONTE LOGISTICO — Server per Render (due PC)
   Chat condivisa Campionario ⇄ Produzione.
   Tre comandi: Spedizione in partenza / Mi unisco / Non mi unisco.
   ============================================================ */

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.use(express.json({ limit: "2mb" }));

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
function calcolaPartenza(when){
  const m = String(when || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const ora = Number(m[1]), min = Number(m[2]);
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
  const parti = fmt.format(now).split("-").map(Number);
  const Y = parti[0], M = parti[1], D = parti[2];
  const offMin = (function(){
    const s = now.toLocaleString("en-US", { timeZone: "Europe/Rome" });
    return Math.round((new Date(s).getTime() - now.getTime()) / 60000);
  })();
  let ts = Date.UTC(Y, M - 1, D, ora, min, 0) - offMin * 60000;
  if (ts < Date.now() - 5 * 60000) ts += 24 * 3600 * 1000;
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

/* ---------- API ---------- */
app.get("/api/state", function(req, res){
  res.json(Object.assign({}, DB, { serverNow: Date.now(), serverOra: oraItalia() }));
});

app.post("/api/ship", function(req, res){
  const body = req.body || {};
  const t = DB.tratte.find(function(x){ return x.id === body.trattaId; }) || DB.tratte[0];
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const item = {
    id: DB.seq++,
    by: body.by || "?",
    fromRep: body.by,
    toRep: body.by === "Campionario" ? "Produzione" : "Campionario",
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
  res.json({ ok: true, item: item, state: DB });
});

app.post("/api/vote", function(req, res){
  const body = req.body || {};
  const t = DB.tratte.find(function(x){ return x.id === body.trattaId; });
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const item = t.items.find(function(i){ return i.id === body.itemId; });
  if (!item) return res.status(400).json({ error: "spedizione non trovata" });
  const ex = item.votes.find(function(v){ return v.who === body.who; });
  if (ex) ex.choice = body.choice;
  else item.votes.push({ who: body.who, choice: body.choice, at: oraItalia() });
  persist();
  broadcast("vote", { trattaId: t.id, itemId: body.itemId, who: body.who, choice: body.choice, item: item });
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

/* ---------- Pagina web ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", function(req, res){
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", function(){
  console.log("VERSIONE-DELETE-E-NOTIFICHE attiva sulla porta " + PORT);
});

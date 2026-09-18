/* ============================================================
   PONTE LOGISTICO — Avvio facile per 2 PC in stessa WiFi
   ------------------------------------------------------------
   Uso:
     1) Installa Node.js (nodejs.org) su UNO dei due PC.
     2) Metti questa cartella sul PC "server".
     3) Doppio clic su AVVIA.bat
     4) Leggi l'indirizzo che compare (es. http://192.168.1.50:3000)
        e aprirlo sul SECONDO PC: stessa WiFi, stesso sistema.

   Lo stesso server serve anche la pagina web: non serve altro.
   ============================================================ */

const express = require("express");

// ora italiana corrente, per mostrare l'ora giusta a chi guarda
function oraItalia(){
  return new Date().toLocaleString("it-IT", { timeZone:"Europe/Rome" });
}

function persist(){ try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch(e){} }

/* ---------- Notifiche push (funzionano a telefono bloccato) ---------- */
try {
  if (vapid.publicKey && vapid.privateKey) {
    webpush.setVapidDetails("mailto:ponte@logistico.local", vapid.publicKey, vapid.privateKey);
  }
} catch(e){}

const subs = [];   // sottoscrizioni dei dispositivi (telefoni/PC)
const SUB_FILE = path.join(__dirname, "iscritti.json");
try { if (fs.existsSync(SUB_FILE)) subs.push(...JSON.parse(fs.readFileSync(SUB_FILE,"utf8"))); } catch(e){}
function saveSubs(){ try { fs.writeFileSync(SUB_FILE, JSON.stringify(subs)); } catch(e){} }


/* ---------- Notifiche push (funzionano a telefono bloccato) ---------- */
const VAPID_FILE = path.join(__dirname, "vapid.json");
let vapid = null;
try { if (fs.existsSync(VAPID_FILE)) vapid = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8")); } catch(e){}
if (!vapid) {
  try {
    vapid = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid));
  } catch(e){ vapid = { publicKey:"", privateKey:"" }; }
}
try {
  if (vapid.publicKey && vapid.privateKey) {
    webpush.setVapidDetails("mailto:ponte@logistico.local", vapid.publicKey, vapid.privateKey);
  }
} catch(e){}

const subs = [];   // sottoscrizioni dei dispositivi (telefoni/PC)
const SUB_FILE = path.join(__dirname, "iscritti.json");
try { if (fs.existsSync(SUB_FILE)) subs.push(...JSON.parse(fs.readFileSync(SUB_FILE,"utf8"))); } catch(e){}
function saveSubs(){ try { fs.writeFileSync(SUB_FILE, JSON.stringify(subs)); } catch(e){} }

function pushTutti(title, body, important, tag){
  const payload = JSON.stringify({ title, body, important: !!important, tag: tag || "ponte-logistico" });
  subs.forEach((s, i) => {
    webpush.sendNotification(s, payload).catch(err => {
      if (err && (err.statusCode === 410 || err.statusCode === 404)) { subs.splice(i,1); saveSubs(); }
    });
  });
}

/* ---------- Push in tempo reale ai PC collegati ---------- */
const clients = new Set();

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 20000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

function broadcast(event, payload){
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const r of clients) { try { r.write(frame); } catch (e) {} }
}

/* ---------- API ---------- */
app.get("/api/vapid", (req, res) => res.json({ publicKey: vapid.publicKey || "" }));

app.get("/api/state", (req, res) => res.json(Object.assign({}, DB, { serverNow: Date.now(), serverOra: oraItalia() })));

app.post("/api/ship", (req, res) => {
  const { trattaId, by, from, to, when, note } = req.body || {};
  const t = DB.tratte.find(x => x.id === trattaId) || DB.tratte[0];
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const item = {
    id: DB.seq++, by: by || "?",
    fromRep: by, toRep: by === "Campionario" ? "Produzione" : "Campionario",
    from, to, when: when || "non indicato", note: note || "",
    at: new Date().toLocaleString("it-IT", { timeZone:"Europe/Rome" }), ts: Date.now(), votes: [],
    departAt: calcolaPartenza(when),
  };
  t.items.unshift(item);
  persist();
  broadcast("ship", { trattaId: t.id, trattaNome: t.nome, item });
  pushTutti("🚚 Nuova spedizione in partenza!", by + ": " + from + " → " + to + " (" + (when||"") + ")", true, "ship-" + item.id);
  res.json({ ok: true, item, state: DB });
});

app.post("/api/vote", (req, res) => {
  const { trattaId, itemId, who, choice } = req.body || {};
  const t = DB.tratte.find(x => x.id === trattaId);
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const item = t.items.find(i => i.id === itemId);
  if (!item) return res.status(400).json({ error: "spedizione non trovata" });
  const ex = item.votes.find(v => v.who === who);
  if (ex) ex.choice = choice;
  else item.votes.push({ who, choice, at: new Date().toLocaleString("it-IT") });
  persist();
  broadcast("vote", { trattaId: t.id, itemId, who, choice, item });
  if (choice === "join") pushTutti("✅ " + who + " si è unito alla spedizione", item.from + " → " + item.to, false, "join-" + itemId);
  if (choice === "join") pushTutti("✅ " + who + " si è unito alla spedizione", item.from + " → " + item.to, false, "join-" + itemId);
  res.json({ ok: true, item, state: DB });
});

app.post("/api/deltratta", (req, res) => {
  const { trattaId } = req.body || {};
  const idx = DB.tratte.findIndex(x => x.id === trattaId);
  if (idx === -1) return res.status(400).json({ error: "tratta non trovata" });
  if (DB.tratte.length <= 1) return res.status(400).json({ error: "serve almeno una tratta" });
  DB.tratte.splice(idx, 1);
  persist();
  broadcast("tratta", { state: DB });
  res.json({ ok: true, state: DB });
});

app.post("/api/delitem", (req, res) => {
  const { trattaId, itemId } = req.body || {};
  const t = DB.tratte.find(x => x.id === trattaId);
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const idx = t.items.findIndex(x => x.id === itemId);
  if (idx === -1) return res.status(400).json({ error: "spedizione non trovata" });
  t.items.splice(idx, 1);
  persist();
  broadcast("tratta", { state: DB });
  res.json({ ok: true, state: DB });
});

app.post("/api/tratta", (req, res) => {
  const { nome } = req.body || {};
  if (!nome) return res.status(400).json({ error: "nome mancante" });
  const id = "t" + DB.seq++;
  DB.tratte.push({ id, nome, sub: "nuova tratta", items: [] });
  persist();
  broadcast("tratta", { state: DB });
  res.json({ ok: true, state: DB });
});

/* ---------- Pagina web ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log("VERSIONE-DELETE-E-NOTIFICHE attiva sulla porta " + PORT);
});

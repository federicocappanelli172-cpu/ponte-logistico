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
const path = require("path");
const os = require("os");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "2mb" }));

/* ---------- Dati condivisi (salvati su disco, niente da perdere) ---------- */
const DB_FILE = path.join(__dirname, "dati.json");
let DB = {
  tratte: [
    { id: "mag-negozio", nome: "Magazzino → Negozi Città", sub: "route quotidiana", items: [] },
    { id: "camp-prod",   nome: "Campionario → Produzione", sub: "passaggio interno", items: [] },
  ],
  seq: 1,
};
try { if (fs.existsSync(DB_FILE)) DB = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
function persist(){ try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch(e){} }

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
app.get("/api/state", (req, res) => res.json(DB));

app.post("/api/ship", (req, res) => {
  const { trattaId, by, from, to, when, note } = req.body || {};
  const t = DB.tratte.find(x => x.id === trattaId) || DB.tratte[0];
  if (!t) return res.status(400).json({ error: "tratta non trovata" });
  const item = {
    id: DB.seq++, by: by || "?",
    fromRep: by, toRep: by === "Campionario" ? "Produzione" : "Campionario",
    from, to, when: when || "non indicato", note: note || "",
    at: new Date().toLocaleString("it-IT"), ts: Date.now(), votes: [],
  };
  t.items.unshift(item);
  persist();
  broadcast("ship", { trattaId: t.id, trattaNome: t.nome, item });
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
  res.json({ ok: true, item, state: DB });
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

/* ---------- Avvio + indirizzi da usare ---------- */
function localIPs(){
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

app.listen(PORT, "0.0.0.0", () => {
  const ips = localIPs();
  console.log("\n========================================================");
  console.log("  PONTE LOGISTICO — SERVER ATTIVO");
  console.log("========================================================\n");
  console.log("  Su QUESTO computer apri:");
  console.log(`      http://localhost:${PORT}\n`);
  console.log("  Sul SECONDO computer (stessa WiFi) apri:");
  if (ips.length) ips.forEach(ip => console.log(`      http://${ip}:${PORT}`));
  else console.log("      (nessuna rete rilevata — controlla di essere connesso alla WiFi)");
  console.log("\n  Lascia questa finestra APERTA mentre usate il programma.");
  console.log("  Per chiudere: premi CTRL+C oppure chiudi la finestra.\n");
  console.log("========================================================\n");
});

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
const webpush = require("web-push");
const webpush = require("web-push");
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
function calcolaPartenza(when){
  // "when" = "15:30" intesa come ora ITALIANA (Europe/Rome), non UTC.
  const m = String(when||"").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const ora = Number(m[1]), min = Number(m[2]);
  // Costruisce la data di oggi in Italia e ricava il timestamp reale.
  const now = new Date();
  // data odierna in formato italiano YYYY-MM-DD
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Rome", year:"numeric", month:"2-digit", day:"2-digit" });
  let [Y, M, D] = fmt.format(now).split("-").map(Number);
  // Timestamp per la data/ora italiana: cerca l'istante che, visto in Europe/Rome, è Y-M-D ora:min
  const makeTs = (y, mo, d) => Date.UTC(y, mo-1, d, ora, min, 0);
  // offset Italia (minuti) in questo momento
  const offMin = (() => {
    const s = now.toLocaleString("en-US", { timeZone:"Europe/Rome" });
    const local = new Date(s);
    return Math.round((local.getTime() - now.getTime()) / 60000);
  })();
  let ts = makeTs(Y, M, D) - offMin * 60000;
  if (ts < Date.now() - 5*60000) { // se già passata, domani
    const d2 = new Date(Date.UTC(Y, M-1, D) + 24*3600*1000);
    Y = d2.getUTCFullYear(); M = d2.getUTCMonth()+1; D = d2.getUTCDate();
    ts = makeTs(Y, M, D) - offMin * 60000;
  }
  return ts;
}
// ora italiana corrente, per mostrare l'ora giusta a chi guarda
function oraItalia(){
  return new Date().toLocaleString("it-IT", { timeZone:"Europe/Rome" });
}

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

app.post("/api/tratta", (req, res) => {
  const { nome } = req.body || {};
  if (!nome) return res.status(400).json({ error: "nome mancante" });
  const id = "t" + DB.seq++;
  DB.tratte.push({ id, nome, sub: "nuova tratta", items: [] });
  persist();
  broadcast("tratta", { state: DB });
  res.json({ ok: true, state: DB });
});

/* ---------- Pagina web (incorporata) ---------- */
const PAGE = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#161a20">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Ponte Logistico — Campionario ⇄ Produzione</title>
<style>
  :root{
    --bg:#0f1216; --panel:#181d24; --panel2:#1f2630; --line:#2c3543;
    --txt:#e8edf3; --muted:#8b98a9; --acc:#3ea6ff; --ok:#2ecc71; --no:#ff6b6b;
    --camp:#a06bff; --prod:#ffa53e;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:var(--bg);color:var(--txt);height:100vh;display:flex;overflow:hidden}

  aside{width:260px;background:var(--panel);border-right:1px solid var(--line);
    display:flex;flex-direction:column}
  aside .brand{padding:18px 16px;border-bottom:1px solid var(--line)}
  aside .brand h1{font-size:15px;letter-spacing:.3px}
  aside .brand p{font-size:11px;color:var(--muted);margin-top:4px}
  .live{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--muted);margin-top:9px}
  .live .led{width:8px;height:8px;border-radius:50%;background:var(--no)}
  .live.on .led{background:var(--ok);box-shadow:0 0 7px var(--ok)}
  .tratta-list{overflow-y:auto;flex:1;padding:8px}
  .tratta{padding:11px 12px;border-radius:9px;cursor:pointer;margin-bottom:4px;
    display:flex;align-items:center;gap:10px;transition:.15s}
  .tratta:hover{background:var(--panel2)}
  .tratta.active{background:var(--panel2);box-shadow:inset 3px 0 0 var(--acc)}
  .tratta .dot{width:9px;height:9px;border-radius:50%;background:var(--acc);flex-shrink:0}
  .tratta .nm{font-size:13px;font-weight:600}
  .tratta .sub{font-size:10.5px;color:var(--muted);margin-top:2px}
  .tratta .cnt{margin-left:auto;font-size:10px;background:var(--acc);color:#04121f;
    border-radius:10px;padding:2px 7px;font-weight:700;min-width:20px;text-align:center}
  .new-tratta{margin:8px;padding:10px;border:1px dashed var(--line);border-radius:9px;
    text-align:center;font-size:12px;color:var(--muted);cursor:pointer}
  .new-tratta:hover{border-color:var(--acc);color:var(--acc)}

  main{flex:1;display:flex;flex-direction:column;min-width:0}
  header{padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);
    display:flex;align-items:center;justify-content:space-between;gap:14px}
  header h2{font-size:16px}
  header .meta{font-size:11.5px;color:var(--muted);margin-top:3px}
  .right{display:flex;gap:8px;align-items:center}
  .whoami{display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--muted)}
  select{background:var(--panel2);color:var(--txt);border:1px solid var(--line);
    border-radius:7px;padding:6px 9px;font-size:12px;outline:none}
  #btnNotif{background:var(--panel2);color:var(--txt);border:1px solid var(--line);
    border-radius:7px;padding:6px 10px;font-size:11px;cursor:pointer;font-family:inherit}
  #btnNotif.on{background:rgba(46,204,113,.16);color:var(--ok);border-color:var(--ok)}

  .stream{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}

  .composer{border-top:1px solid var(--line);background:var(--panel);padding:14px 20px}
  .row-buttons{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:10px}
  button.big{border:none;border-radius:11px;padding:15px 14px;font-size:14px;font-weight:700;
    cursor:pointer;transition:.15s;display:flex;align-items:center;justify-content:center;
    gap:8px;font-family:inherit}
  .b-ship{background:linear-gradient(135deg,#3ea6ff,#2b7ddb);color:#fff}
  .b-join{background:linear-gradient(135deg,#2ecc71,#22a85a);color:#04160b}
  .b-skip{background:var(--panel2);color:var(--muted);border:1px solid var(--line)!important}
  button.big:hover{transform:translateY(-1px);filter:brightness(1.08)}
  button.big:active{transform:translateY(0)}
  button.big:disabled{opacity:.4;cursor:not-allowed;transform:none;filter:none}
  .hint{font-size:11px;color:var(--muted);margin-top:9px;text-align:center}

  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;
    align-items:center;justify-content:center;z-index:50}
  .modal-bg.on{display:flex}
  .modal{background:var(--panel);border:1px solid var(--line);border-radius:14px;
    padding:22px;width:380px;max-width:92vw}
  .modal h3{font-size:15px;margin-bottom:16px}
  .modal label{display:block;font-size:11px;color:var(--muted);margin:0 0 5px 2px}
  .modal input,.modal textarea{width:100%;background:var(--bg);border:1px solid var(--line);
    border-radius:9px;padding:10px;color:var(--txt);font-size:13px;font-family:inherit;
    margin-bottom:13px;outline:none}
  .modal input:focus,.modal textarea:focus{border-color:var(--acc)}
  .modal .act{display:flex;gap:9px;margin-top:4px}
  .modal .act button{flex:1;border-radius:9px;padding:11px;font-size:13px;font-weight:600;
    cursor:pointer;font-family:inherit;border:none}
  .modal .act .ok{background:var(--acc);color:#04121f}
  .modal .act .cancel{background:var(--panel2);color:var(--muted);border:1px solid var(--line)!important}

  .card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:15px 17px;
    animation:in .25s ease}
  @keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .card.flash{box-shadow:0 0 0 2px var(--acc)}
  .card .top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  .chip{font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:20px}
  .chip.camp{background:rgba(160,107,255,.15);color:var(--camp)}
  .chip.prod{background:rgba(255,165,62,.15);color:var(--prod)}
  .card .time{margin-left:auto;font-size:11px;color:var(--muted)}
  .card .route{font-size:14.5px;font-weight:700;margin-bottom:5px}
  .card .note{font-size:12.5px;color:var(--muted);margin-bottom:12px}
  .card .who{font-size:11.5px;color:var(--muted);margin-bottom:12px}
  .card .who b{color:var(--txt)}
  .card .btns{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
  .card .btns button{border:none;border-radius:9px;padding:9px 15px;font-size:12.5px;
    font-weight:700;cursor:pointer;font-family:inherit;transition:.15s}
  .card .btns button:hover{filter:brightness(1.1)}
  .j-ok{background:rgba(46,204,113,.16);color:var(--ok);border:1px solid rgba(46,204,113,.4)!important}
  .j-no{background:rgba(255,107,107,.12);color:var(--no);border:1px solid rgba(255,107,107,.3)!important}
  .j-ok.sel{background:var(--ok);color:#04160b}
  .j-no.sel{background:var(--no);color:#160404}
  .counts{margin-left:auto;font-size:11.5px;color:var(--muted);display:flex;gap:12px}
  .counts b{color:var(--txt)}
  .empty{color:var(--muted);font-size:13px;text-align:center;margin-top:60px;line-height:1.7}

  .toast-wrap{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:9px;z-index:80}
  .toast{background:var(--panel);border:1px solid var(--acc);border-left:4px solid var(--acc);
    border-radius:11px;padding:13px 16px;min-width:250px;max-width:340px;
    box-shadow:0 10px 30px rgba(0,0,0,.5);animation:slide .3s ease;cursor:pointer}
  @keyframes slide{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
  .toast .t{font-size:12.5px;font-weight:700;margin-bottom:4px}
  .toast .d{font-size:11.5px;color:var(--muted)}

    .depart-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;
    padding:3px 10px;border-radius:20px}
  .depart-badge.soon{background:rgba(255,165,62,.18);color:var(--prod);border:1px solid rgba(255,165,62,.5)}
  .depart-badge.imminent{background:var(--no);color:#160404;animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
  .card.leaving{box-shadow:0 0 0 2px var(--no)}

  /* --- box partecipanti: molto più evidente --- */
  .joinbox{margin-top:13px;background:linear-gradient(135deg,rgba(46,204,113,.16),rgba(46,204,113,.07));
    border:2px solid rgba(46,204,113,.55);border-radius:12px;padding:12px 15px;display:none}
  .joinbox.on{display:block}
  .joinbox .jb-title{font-size:13px;font-weight:900;color:var(--ok);letter-spacing:.5px;margin-bottom:9px;
    display:flex;align-items:center;gap:7px}
  .joinbox .jb-people{display:flex;flex-wrap:wrap;gap:8px}
  .joinbox .person{display:flex;align-items:center;gap:7px;background:var(--ok);color:#04160b;
    border-radius:22px;padding:6px 14px 6px 7px;font-size:13.5px;font-weight:800;box-shadow:0 2px 8px rgba(46,204,113,.3)}
  .joinbox .person .pin{width:20px;height:20px;border-radius:50%;background:#04160b;color:var(--ok);
    display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900}
  .nobox{margin-top:13px;background:rgba(255,255,255,.04);border:1px dashed var(--line);
    border-radius:11px;padding:11px 15px;font-size:12px;color:var(--muted);text-align:center}

  /* --- timer di partenza --- */
  .timer{margin-top:13px;border-radius:12px;padding:13px 16px;display:flex;align-items:center;
    gap:14px;border:2px solid}
  .timer .big{font-size:27px;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
  .timer .lbl{font-size:11px;font-weight:700;letter-spacing:.6px;opacity:.85;line-height:1.45}
  .timer.wait{background:rgba(62,166,255,.10);border-color:rgba(62,166,255,.45);color:var(--acc)}
  .timer.soon{background:rgba(255,165,62,.14);border-color:rgba(255,165,62,.6);color:var(--prod)}
  .timer.now{background:var(--no);border-color:var(--no);color:#160404;animation:pulse 1s infinite}
  .timer.gone{background:rgba(255,255,255,.04);border-color:var(--line);color:var(--muted)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.62}}
  .card.leaving{box-shadow:0 0 0 3px var(--no)}

  @media (max-width: 820px) and (orientation:landscape){
    aside{max-height:30vh}
    .tratta-list{max-height:16vh}
  }
  /* input più grandi sui telefoni: evitano lo zoom automatico di iOS */
  @media (max-width: 820px){
    input,select,textarea{font-size:16px!important}
  }

  .votebox{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:13px}
  .votebox .col{border-radius:12px;padding:11px 12px;min-height:64px}
  .votebox .col.yes{background:linear-gradient(135deg,rgba(46,204,113,.18),rgba(46,204,113,.06));border:2px solid rgba(46,204,113,.55)}
  .votebox .col.no{background:linear-gradient(135deg,rgba(255,107,107,.14),rgba(255,107,107,.05));border:2px solid rgba(255,107,107,.42)}
  .votebox .vh{font-size:11.5px;font-weight:900;letter-spacing:.5px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
  .votebox .yes .vh{color:var(--ok)}
  .votebox .no .vh{color:var(--no)}
  .votebox .vh .n{font-size:10.5px;background:rgba(255,255,255,.10);border-radius:20px;padding:1px 8px}
  .votebox .people{display:flex;flex-wrap:wrap;gap:6px}
  .votebox .person{display:flex;align-items:center;gap:6px;border-radius:20px;padding:5px 12px 5px 6px;font-size:12.5px;font-weight:800}
  .votebox .yes .person{background:var(--ok);color:#04160b}
  .votebox .no .person{background:var(--no);color:#160404;opacity:.92}
  .votebox .person .pin{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900}
  .votebox .yes .person .pin{background:#04160b;color:var(--ok)}
  .votebox .no .person .pin{background:#160404;color:var(--no)}
  .votebox .empty{font-size:11.5px;color:var(--muted);font-style:italic;padding:3px 2px}
</style>
<script>window.__PWA_MANIFEST__=true;</script>
</head>
<body>

<aside>
  <div class="brand">
    <h1>🚚 Ponte Logistico</h1>
    <p>Campionario ⇄ Produzione</p>
    <div class="live" id="live"><span class="led"></span><span id="liveTxt">connessione…</span></div>
  </div>
  <div class="tratta-list" id="tratte"></div>
  <div class="new-tratta" id="newTratta">+ Nuova tratta / tragitto</div>
</aside>

<main>
  <header>
    <div>
      <h2 id="hTitle">—</h2>
      <div class="meta" id="hMeta">—</div>
    </div>
    <div class="right">
      <button id="btnNotif" title="Attiva gli avvisi anche a scheda abbassata">🔔 Attiva notifiche</button>
      <div class="whoami"><span>Sono:</span>
        <select id="me">
          <option value="Campionario">🏷️ Campionario</option>
          <option value="Produzione">🏭 Produzione</option>
        </select>
      </div>
    </div>
  </header>

  <div class="stream" id="stream"></div>

  <div class="composer">
    <div class="row-buttons">
      <button class="big b-ship" id="bShip">🚚 Spedizione in partenza</button>
      <button class="big b-join" id="bJoin">✅ Mi unisco</button>
      <button class="big b-skip" id="bSkip">❌ Non mi unisco</button>
    </div>
    <div class="hint" id="hint">I pulsanti <b>Mi unisco / Non mi unisco</b> rispondono all'ultima spedizione pubblicata.</div>
  </div>
</main>

<div class="modal-bg" id="modalBg">
  <div class="modal">
    <h3>🚚 Nuova spedizione in partenza</h3>
    <label>Partenza</label>
    <input id="fFrom" placeholder="es. Magazzino Campionario — Capannone B">
    <label>Destinazione / negozio</label>
    <input id="fTo" placeholder="es. Negozio Duomo, Milano">
    <label>Ora di partenza (ora italiana)</label>
    <input id="fWhen" type="time" value="15:30">
    <div style="font-size:11px;color:var(--muted);margin:-8px 0 13px 2px">Da quest'ora parte il timer e l'avviso 5 minuti prima.</div>
    <label>Note (opzionale)</label>
    <textarea id="fNote" rows="2" placeholder="es. mezzo 3/4 carico, 2 posti liberi"></textarea>
    <div class="act">
      <button class="cancel" id="mCancel">Annulla</button>
      <button class="ok" id="mOk">Pubblica spedizione</button>
    </div>
  </div>
</div>

<div class="toast-wrap" id="toasts"></div>

<script>
/* =========================================================
   Ponte Logistico — client (versione WiFi locale)
   ========================================================= */
let DB = { tratte: [], seq: 1 };
let ACTIVE = localStorage.getItem("pl_active") || null;
let ME = localStorage.getItem("pl_me") || "Campionario";
const seen = new Set();
let primed = false;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const cur = () => DB.tratte.find(t => t.id === ACTIVE) || DB.tratte[0];

/* ---------- avvisi: pop-up + notifica desktop + titolo ---------- */
function notify(title, body, onclick){
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = \`<div class="t">\${esc(title)}</div><div class="d">\${esc(body)}</div>\`;
  el.onclick = () => { if (onclick) onclick(); el.remove(); };
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 9000);

  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body, tag: "ponte-logistico" });
      n.onclick = () => { window.focus(); if (onclick) onclick(); n.close(); };
    } catch (e) {}
  }
  if (document.hidden) flashTitle(title);
}

let flashTimer = null; const baseTitle = document.title;
function flashTitle(msg){
  if (flashTimer) return;
  let on = false;
  flashTimer = setInterval(() => { document.title = (on = !on) ? "🔔 " + msg : baseTitle; }, 900);
  const stop = () => {
    if (!document.hidden) {
      clearInterval(flashTimer); flashTimer = null; document.title = baseTitle;
      document.removeEventListener("visibilitychange", stop);
    }
  };
  document.addEventListener("visibilitychange", stop);
}

$("btnNotif").onclick = async () => {
  if (!("Notification" in window)) { alert("Questo browser non supporta le notifiche desktop."); return; }
  const p = await Notification.requestPermission();
  if (p === "granted") {
    $("btnNotif").classList.add("on");
    $("btnNotif").textContent = "🔔 Notifiche attive";
    new Notification("Ponte Logistico", { body: "Perfetto! Riceverai un avviso ad ogni spedizione." });
  } else {
    alert("Notifiche bloccate. Riattivale dall'icona lucchetto nella barra degli indirizzi.");
  }
};
if ("Notification" in window && Notification.permission === "granted") {
  $("btnNotif").classList.add("on"); $("btnNotif").textContent = "🔔 Notifiche attive";
}

/* ---------- render ---------- */
function renderTratte(){
  const c = $("tratte"); c.innerHTML = "";
  DB.tratte.forEach(t => {
    const el = document.createElement("div");
    el.className = "tratta" + (t.id === ACTIVE ? " active" : "");
    el.innerHTML = \`<span class="dot"></span>
      <div><div class="nm">\${esc(t.nome)}</div><div class="sub">\${esc(t.sub||"")}</div></div>
      \${t.items.length ? \`<span class="cnt">\${t.items.length}</span>\` : ""}\`;
    el.onclick = () => { ACTIVE = t.id; localStorage.setItem("pl_active", ACTIVE); renderAll(); };
    c.appendChild(el);
  });
}
function renderHeader(){
  const t = cur(); if (!t) return;
  $("hTitle").textContent = t.nome;
  const last = t.items[0];
  $("hMeta").textContent = last
    ? \`\${t.items.length} spedizioni · ultima: \${esc(last.from)} → \${esc(last.to)}\`
    : "Nessuna spedizione pubblicata";
  $("bJoin").disabled = !last;
  $("bSkip").disabled = !last;
  $("hint").innerHTML = last
    ? \`Ultima spedizione: <b>\${esc(last.from)} → \${esc(last.to)}</b> · rispondi con Mi unisco / Non mi unisco\`
    : \`I pulsanti <b>Mi unisco / Non mi unisco</b> rispondono all'ultima spedizione pubblicata.\`;
}
function renderStream(){
  const s = $("stream"), t = cur(); s.innerHTML = "";
  if (!t || !t.items.length){
    s.innerHTML = \`<div class="empty">Nessuna spedizione in partenza su questa tratta.<br>
      Premi <b>🚚 Spedizione in partenza</b> per pubblicarne una.</div>\`;
    return;
  }
  t.items.forEach(item => {
    const camp = item.fromRep === "Campionario" || item.toRep === "Campionario";
    const prod = item.fromRep === "Produzione" || item.toRep === "Produzione";
    const joins = item.votes.filter(v => v.choice === "join");
    const skips = item.votes.filter(v => v.choice === "skip");
    const mine = item.votes.find(v => v.who === ME);

    const card = document.createElement("div");
    card.className = "card"; card.dataset.id = item.id;
    card.innerHTML = \`
      <div class="top">
        \${camp ? '<span class="chip camp">CAMPIONARIO</span>' : ""}
        \${prod ? '<span class="chip prod">PRODUZIONE</span>' : ""}
        <span class="time">\${esc(item.when||"—")}</span>
      </div>
      <div class="route">🚚 \${esc(item.from)} <span style="color:var(--muted)">→</span> \${esc(item.to)}</div>
      \${item.note ? \`<div class="note">\${esc(item.note)}</div>\` : ""}
      <div class="who">Pubblicata da <b>\${esc(item.by)}</b> · \${esc(item.at)}</div>
      <div class="btns">
        <button class="j-ok \${mine && mine.choice==="join" ? "sel" : ""}" data-j="join">✅ Mi unisco</button>
        <button class="j-no \${mine && mine.choice==="skip" ? "sel" : ""}" data-j="skip">❌ Non mi unisco</button>
        <span class="counts"><span>✅ <b>\${joins.length}</b></span><span>❌ <b>\${skips.length}</b></span></span>
      </div>
      \${extraHTML(item)}\`;
    card.querySelectorAll("[data-j]").forEach(b => { b.onclick = () => voteAPI(item, b.dataset.j); });
    s.appendChild(card);
  });
}
function renderAll(){ renderTratte(); renderHeader(); renderStream(); }
function focusCard(trattaId, itemId){
  ACTIVE = trattaId; localStorage.setItem("pl_active", ACTIVE); renderAll();
  const c = document.querySelector(\`.card[data-id="\${itemId}"]\`);
  if (c) { c.classList.add("flash"); c.scrollIntoView({ behavior:"smooth", block:"center" });
    setTimeout(() => c.classList.remove("flash"), 2500); }
}

/* ---------- API ---------- */
async function rpc(url, body){
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.state) applyState(j.state, false);
  return j;
}
function voteAPI(item, choice){ const t = cur(); rpc("/api/vote", { trattaId:t.id, itemId:item.id, who:ME, choice }); }
function shipAPI(data){ const t = cur(); rpc("/api/ship", { trattaId:t.id, by:ME, ...data }); }

function applyState(next, doNotify){
  DB = next;
  if (!DB.tratte.find(t => t.id === ACTIVE)) ACTIVE = DB.tratte[0] ? DB.tratte[0].id : null;

  if (primed && doNotify) {
    DB.tratte.forEach(t => {
      t.items.forEach(it => {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          if (it.by !== ME) notify("🚚 Nuova spedizione in partenza!",
            \`\${it.by}: \${it.from} → \${it.to} (\${it.when})\`, () => focusCard(t.id, it.id));
        } else {
          const latest = (it.votes || []).slice(-1)[0];
          if (latest && latest.who !== ME && Date.now() - (it.ts||0) < 60000){
            notify("✅ Risposta al tragitto",
              \`\${latest.who}: \${latest.choice === "join" ? "Mi unisco" : "Non mi unisco"} — \${it.from} → \${it.to}\`,
              () => focusCard(t.id, it.id));
          }
        }
      });
    });
  }
  DB.tratte.forEach(t => t.items.forEach(it => seen.add(it.id)));
  primed = true;
  renderAll();
}

/* ---------- SSE ---------- */
function connect(){
  const es = new EventSource("/api/stream");
  es.addEventListener("hello", () => { $("live").classList.add("on"); $("liveTxt").textContent = "online · sincronizzato"; });
  es.addEventListener("ship", e => { const d = JSON.parse(e.data); refresh(d.trattaId, d.item.id); });
  es.addEventListener("vote", () => refresh());
  es.addEventListener("tratta", () => refresh());
  es.onerror = () => { $("live").classList.remove("on"); $("liveTxt").textContent = "riconnessione…"; };
}
async function refresh(trattaId, itemId){
  const r = await fetch("/api/state"); applyState(await r.json(), true);
  if (trattaId && itemId && cur() && cur().id === trattaId) focusCard(trattaId, itemId);
}

/* ---------- UI ---------- */
$("me").value = ME;
$("bShip").onclick = () => {
  $("modalBg").classList.add("on");
  $("fFrom").value = ME === "Campionario" ? "Magazzino Campionario" : "Reparto Produzione";
  $("fTo").value = ""; $("fWhen").value = ""; $("fNote").value = "";
  $("fFrom").focus();
};
$("mCancel").onclick = () => $("modalBg").classList.remove("on");
$("modalBg").onclick = e => { if (e.target.id === "modalBg") $("modalBg").classList.remove("on"); };
$("mOk").onclick = () => {
  const from = $("fFrom").value.trim(), to = $("fTo").value.trim(), when = $("fWhen").value.trim();
  if (!from || !to) { alert("Inserisci almeno partenza e destinazione."); return; }
  shipAPI({ from, to, when: when || "non indicato", note: $("fNote").value.trim() });
  $("modalBg").classList.remove("on");
};
$("bJoin").onclick = () => { const i = cur() && cur().items[0]; if (i) voteAPI(i, "join"); };
$("bSkip").onclick = () => { const i = cur() && cur().items[0]; if (i) voteAPI(i, "skip"); };
$("me").onchange = () => { ME = $("me").value; localStorage.setItem("pl_me", ME); renderStream(); };
$("newTratta").onclick = async () => {
  const nome = prompt("Nome della nuova tratta / tragitto:");
  if (!nome) return;
  await rpc("/api/tratta", { nome });
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });




let ORA_SERVER = 0;   // differenza tra l'ora del server e quella del PC
let DEPART_AT = {};   // id -> timestamp partenza (quello del server)

function msToDepart(item){
  if (!item.departAt) return null;
  return item.departAt - Date.now();
}
function extraHTML(item){
  const joins = item.votes.filter(v => v.choice === "join");
  const skips = item.votes.filter(v => v.choice === "skip");
  const chip = (list, pin) => list.length
    ? list.map(v => '<span class="person"><span class="pin">' + pin + '</span>' + esc(v.who) + '</span>').join("")
    : '<span class="empty">nessuno</span>';
  let out = '<div class="votebox">' +
    '<div class="col yes"><div class="vh">✅ SI UNISCONO <span class="n">' + joins.length + '</span></div>' +
      '<div class="people">' + chip(joins, "✓") + '</div></div>' +
    '<div class="col no"><div class="vh">❌ NON SI UNISCONO <span class="n">' + skips.length + '</span></div>' +
      '<div class="people">' + chip(skips, "✕") + '</div></div>' +
    '</div>';
  out += timerHTML(item);
  return out;
}
function timerHTML(item){
  const ms = msToDepart(item);
  if (ms === null) return "";
  if (ms < -60*60000) return '<div class="timer gone"><span class="big">✅</span><span class="lbl">SPEDIZIONE<br>PARTITA</span></div>';
  if (ms <= 0) return '<div class="timer now"><span class="big">🚚</span><span class="lbl">IN PARTENZA<br>PROPRIO ORA</span></div>';
  const min = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
  const cls = min < 5 ? "soon" : "wait";
  const txt = min >= 60
    ? Math.floor(min/60) + "h " + String(min%60).padStart(2,"0") + "m"
    : String(min).padStart(2,"0") + ":" + String(sec).padStart(2,"0");
  return '<div class="timer ' + cls + '" data-timer="' + item.id + '"><span class="big">' + txt +
    '</span><span class="lbl">' + (min < 5 ? "PARTE A BREVE" : "ALLA PARTENZA") + '</span></div>';
}

/* aggiorna i timer ogni secondo, senza ridisegnare tutta la lista */
setInterval(() => {
  document.querySelectorAll("[data-timer]").forEach(el => {
    const item = (cur() && cur().items || []).find(i => i.id == el.dataset.timer);
    if (!item) return;
    const fresh = timerHTML(item);
    if (fresh && fresh.indexOf('data-timer="' + el.dataset.timer + '"') === -1) el.outerHTML = fresh;
    else if (fresh) { const box = document.createElement("div"); box.innerHTML = fresh; el.replaceWith(box.firstChild); }
  });
}, 1000);

/* notifica 5 minuti prima — una volta sola per spedizione */
const reminded = new Set();
setInterval(() => {
  if (!DB || !DB.tratte) return;
  DB.tratte.forEach(t => t.items.forEach(it => {
    const ms = msToDepart(it);
    if (ms === null) return;
    if (ms > 0 && ms <= 5*60000 && !reminded.has(it.id)){
      reminded.add(it.id);
      const joins = it.votes.filter(v => v.choice === "join").map(v => v.who).join(", ");
      notify("⏰ La spedizione parte tra 5 minuti!",
        it.from + " → " + it.to + (joins ? " — a bordo: " + joins : " — nessuno a bordo"),
        () => focusCard(t.id, it.id));
      const card = document.querySelector('.card[data-id="' + it.id + '"]');
      if (card) card.classList.add("leaving");
    }
  }));
}, 20000);

/* ricarica la lista ogni 30s per aggiornare anche i badge */
setInterval(() => { if (DB && DB.tratte) renderStream(); }, 30000);



(async () => {
  const r = await fetch("/api/state"); applyState(await r.json(), false);
  connect();
  setInterval(async () => { try { const s = await (await fetch("/api/state")).json(); applyState(s, true); } catch(e){} }, 60000);
})();
</script>
</body>
</html>
`;
app.get("*", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(PAGE);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Ponte Logistico attivo sulla porta " + PORT);
});

/* =========================================================
   Ponte Logistico — service worker
   Mostra le notifiche anche con il browser abbassato o la scheda chiusa.
   ========================================================= */
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function(e){
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  const opzioni = {
    body: d.body || "",
    requireInteraction: !!d.requireInteraction, /* resta sullo schermo finché non la chiudi */
    data: { trattaId: d.trattaId || null, itemId: d.itemId || null },
  };
  if (d.tag) opzioni.tag = d.tag;
  e.waitUntil(self.registration.showNotification(d.title || "Ponte Logistico", opzioni));
});

/* clic sulla notifica: riporta in primo piano l'app (o la apre) sulla spedizione giusta */
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  const d = e.notification.data || {};
  const url = d.trattaId
    ? "/?t=" + encodeURIComponent(d.trattaId) + "&i=" + encodeURIComponent(d.itemId || "")
    : "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(lista){
    for (const c of lista) {
      if (new URL(c.url).origin === self.location.origin) {
        c.postMessage({ type: "apri", trattaId: d.trattaId, itemId: d.itemId });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

/* il browser a volte rinnova l'iscrizione: la reinvio al server */
function b64ToU8(s){
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, function(c){ return c.charCodeAt(0); });
}
self.addEventListener("pushsubscriptionchange", function(e){
  e.waitUntil(fetch("/api/push/key").then(function(r){ return r.json(); }).then(function(j){
    return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(j.key) });
  }).then(function(sub){
    return fetch("/api/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sub: sub.toJSON(), oldEndpoint: e.oldSubscription ? e.oldSubscription.endpoint : null }),
    });
  }).catch(function(){}));
});

// sw.js — very small offline helper
const CACHE = "flashcards-srs-v1";
const ASSETS = [
  "/", "/index.html", "/decks.json"
  // If you host specific deck files, optionally add them here, e.g. "/C3.json"
];
self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});
self.addEventListener("activate", e=>{ e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", e=>{
  const req = e.request;
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res=>{
      if(req.method==="GET"){
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(req, copy));
      }
      return res;
    }).catch(()=> caches.match("/index.html")))
  );
});

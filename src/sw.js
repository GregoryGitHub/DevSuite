// Service worker do app Notas no navegador (PWA, foco no iPhone):
//  - offline: os arquivos do app ficam no Cache Storage (lista gerada pelo build_web em
//    precache.js; sem ela, cada arquivo entra no cache na primeira vez que é pedido);
//  - imagens das notas: `noteimg/<nome>` vem do IndexedDB (store "images", js/web/idb.js).

/* global importScripts */
let PRECACHE = { version: "dev", files: [] };
try {
  importScripts("precache.js"); // define self.NOTAS_PRECACHE (build_web)
  if (self.NOTAS_PRECACHE) PRECACHE = self.NOTAS_PRECACHE;
} catch {}

const CACHE = `notas-${PRECACHE.version}`;

// Mesmo esquema de js/web/idb.js (DB_NAME, DB_VERSION, upgrade).
const DB_NAME = "notas";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [name, opts] of [
        ["notes", { keyPath: "id" }],
        ["folders", { keyPath: "id" }],
        ["pending", { keyPath: ["kind", "id"] }],
        ["vers", { keyPath: ["kind", "id"] }],
        ["images", { keyPath: "name" }],
        ["meta", { keyPath: "key" }],
      ]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function imageResponse(name) {
  try {
    const db = await openDb();
    const img = await new Promise((resolve, reject) => {
      const q = db.transaction("images").objectStore("images").get(name);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    db.close();
    if (img?.blob) return new Response(img.blob, { headers: { "Content-Type": img.blob.type || "application/octet-stream", "Cache-Control": "no-store" } });
  } catch {}
  // Ainda não baixada (o sync baixa e a tela recarrega a imagem).
  return new Response("", { status: 404 });
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Um arquivo que falhar não impede os outros.
      await Promise.all(PRECACHE.files.map((f) => cache.add(new Request(f, { cache: "reload" })).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("notas-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase e afins: direto na rede

  const scope = new URL(self.registration.scope).pathname;
  const path = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : url.pathname;
  const img = /^noteimg\/([a-z0-9]+\.[a-z0-9]+)$/i.exec(path);
  if (img) return e.respondWith(imageResponse(img[1]));

  // Desenvolvimento (src/ servido direto, sem precache.js): rede primeiro, cache só offline.
  if (PRECACHE.version === "dev") {
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        } catch {
          return (await cache.match(req, { ignoreSearch: req.mode === "navigate" })) || new Response("Offline", { status: 503 });
        }
      })(),
    );
    return;
  }

  // Site publicado: cache primeiro (abre na hora e offline). Cada deploy tem outra versão de
  // cache, baixada inteira na instalação do service worker novo (precache.js).
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = req;
      const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok && res.type === "basic") cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        e.waitUntil(fresh);
        return hit;
      }
      return (await fresh) || new Response("Offline", { status: 503 });
    })(),
  );
});

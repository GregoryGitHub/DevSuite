// IndexedDB do app Notas no navegador (PWA). O service worker (src/sw.js) abre o mesmo banco
// para servir as imagens: o esquema (DB_NAME, DB_VERSION, upgrade) precisa ser igual lá.

export const DB_NAME = "notas";
export const DB_VERSION = 1;

/** Cria os stores (mesmas tabelas do notes.db + estado do sync; ver notes_sync.rs). */
export function upgrade(db) {
  if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
  if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "id" });
  if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: ["kind", "id"] });
  if (!db.objectStoreNames.contains("vers")) db.createObjectStore("vers", { keyPath: ["kind", "id"] });
  if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "name" });
  if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
}

let opening = null;

export function openDb() {
  opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => upgrade(r.result);
    r.onsuccess = () => {
      const db = r.result;
      // Outra aba atualizou o esquema: fecha esta conexão (a próxima chamada reabre).
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => {
      opening = null;
      reject(r.error);
    };
  });
  return opening;
}

/** Promessa do resultado de um IDBRequest. */
export const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/**
 * Roda `fn(stores)` numa transação e resolve com o retorno dela depois do commit.
 * Dentro de `fn` só pode haver `await` de requisições desta transação (nada de fetch/crypto),
 * senão o IndexedDB fecha a transação.
 */
export async function tx(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let out;
    Promise.resolve()
      .then(() => fn(stores))
      .then(
        (v) => (out = v),
        (e) => {
          try {
            t.abort();
          } catch {}
          reject(e);
        },
      );
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transação cancelada."));
  });
}

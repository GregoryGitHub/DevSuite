// Testes do motor de sincronização do app Notas (src/js/sync/syncEngine.js) com dois aparelhos
// e uma nuvem em memória que segue as mesmas regras do Firestore (firestore.rules):
// node tests/sync.test.mjs
import assert from "node:assert/strict";
const { createSyncEngine, toRemote, sameNote, conflictSuffix, CURSOR_OVERLAP_MS } = await import(new URL("../src/js/sync/syncEngine.js", import.meta.url).href);

// ---------- Nuvem: documentos com ver; gravar exige ver = atual + 1 (criar: ver 1) ----------
function cloud() {
  const docs = new Map(); // "kind:id" -> { kind, id, ver, deleted, data, rev }
  const images = new Map();
  let clock = 1000;
  return {
    docs,
    images,
    writes: 0,
    async pull(since) {
      const out = [...docs.values()].filter((d) => d.rev > since).sort((a, b) => a.rev - b.rev);
      return { docs: out.map((d) => structuredClone(d)), maxRev: out.reduce((m, d) => Math.max(m, d.rev), 0) };
    },
    async fetch(keys) {
      return keys.map((k) => docs.get(`${k.kind}:${k.id}`)).filter(Boolean).map((d) => structuredClone(d));
    },
    async push(doc) {
      const k = `${doc.kind}:${doc.id}`;
      const cur = docs.get(k);
      if (doc.ver !== (cur ? cur.ver + 1 : 1)) throw Object.assign(new Error("stale"), { code: "stale" });
      this.writes++;
      clock += 100_000; // mais que a releitura de segurança: o cursor anda de verdade
      docs.set(k, { ...structuredClone(doc), rev: clock });
    },
    async uploadImage(name, bytes) {
      images.set(name, bytes);
    },
    async downloadImage(name) {
      if (!images.has(name)) throw new Error("404");
      return images.get(name);
    },
  };
}

// ---------- Aparelho: banco local com pendências/versões (mesma semântica do notes_sync.rs) ----------
function device(name, remote) {
  const notes = new Map();
  const folders = new Map();
  const pending = new Map(); // "kind:id" -> { kind, id, seq }
  const vers = new Map();
  const meta = new Map();
  const imgs = new Map(); // name -> bytes
  const uploaded = new Set();
  let seq = 0;
  let nextId = 1;
  const mark = (kind, id) => pending.set(`${kind}:${id}`, { kind, id, seq: ++seq });
  const ver = (kind, id) => vers.get(`${kind}:${id}`) || 0;

  const local = {
    async pending(items, limit) {
      const all = [...pending.values()].sort((a, b) => (a.kind === "note") - (b.kind === "note") || a.seq - b.seq);
      return {
        total: all.length,
        items: all.slice(0, limit).map((p) => {
          const row = (p.kind === "note" ? notes : folders).get(p.id);
          return { ...p, ver: ver(p.kind, p.id), item: items && row ? structuredClone(row) : null };
        }),
      };
    },
    async done(items) {
      for (const d of items) {
        vers.set(`${d.kind}:${d.id}`, d.ver);
        if (pending.get(`${d.kind}:${d.id}`)?.seq === d.seq) pending.delete(`${d.kind}:${d.id}`);
      }
    },
    async apply(ch) {
      const take = (kind, id, v) => {
        if (v <= ver(kind, id)) return false;
        pending.delete(`${kind}:${id}`);
        vers.set(`${kind}:${id}`, v);
        return true;
      };
      for (const f of ch.folders) if (take("folder", f.id, f.ver)) folders.set(f.id, { id: f.id, name: f.name, parent_id: f.parent_id, position: f.position });
      for (const g of ch.deleted_folders) if (take("folder", g.id, g.ver)) folders.delete(g.id);
      for (const n of ch.notes) if (take("note", n.id, n.ver)) notes.set(n.id, (({ ver: _, ...r }) => r)(n));
      for (const g of ch.deleted_notes) if (take("note", g.id, g.ver)) notes.delete(g.id);
      for (const v of ch.vers) vers.set(`${v.kind}:${v.id}`, v.ver);
    },
    metaGet: async (k) => meta.get(k) ?? null,
    metaSet: async (k, v) => meta.set(k, v),
    imagesPending: async () => [...new Set([...notes.values()].flatMap((n) => n.images || []))].filter((n) => !uploaded.has(n)),
    imagesMark: async (names) => names.forEach((n) => uploaded.add(n)),
    imageRead: async (n) => {
      if (!imgs.has(n)) throw new Error("missing");
      return imgs.get(n);
    },
    imagesMissing: async (names) => names.filter((n) => !imgs.has(n)),
    imagePut: async (n, b) => {
      imgs.set(n, b);
      uploaded.add(n);
    },
  };

  const toasts = [];
  const applied = [];
  const busy = new Set();
  const host = {
    flush: async () => {},
    busyIds: () => busy,
    localNote: async (id) => (notes.has(id) ? structuredClone(notes.get(id)) : null),
    conflictCopy(mine, suffix) {
      const id = 1_000_000 * (name === "A" ? 1 : 2) + nextId++;
      notes.set(id, { ...mine, id, title: (mine.title || "") + suffix, content: mine.content.replace(/<\/h1>/, `${suffix}</h1>`) });
      mark("note", id);
      return id;
    },
    applied: async (x) => applied.push(x),
    imagesArrived: () => {},
    toast: (m) => toasts.push(m),
  };

  const engine = createSyncEngine({ local, remote, host, device: name });
  return {
    engine, notes, folders, pending, vers, imgs, toasts, applied, busy, meta,
    save(id, text, extra = {}) {
      notes.set(id, { id, title: text, preview: "", content: `<h1>${text}</h1>`, plain: text, images: [], created_at: "2026-11-01T00:00:00.000Z", updated_at: Date.now(), pinned: 0, folder_id: 0, deleted_at: null, props: null, links: [], ...extra });
      mark("note", id);
    },
    remove(id) {
      notes.delete(id);
      mark("note", id);
    },
    folder(id, name, parent_id = 0, position = 0) {
      folders.set(id, { id, name, parent_id, position });
      mark("folder", id);
    },
  };
}

const remote = cloud();
const A = device("A", remote);
const B = device("B", remote);

// --- 1ª sincronização: A sobe tudo; B baixa.
A.folder(10, "Trabalho");
A.save(1, "Primeira", { folder_id: 10 });
A.save(2, "Segunda");
let r = await A.engine.sync();
assert.equal(r.sent, 3);
assert.equal(r.pending, 0);
assert.equal(remote.docs.get("note:1").ver, 1);
assert.equal(remote.docs.get("folder:10").data.name, "Trabalho");

r = await B.engine.sync();
assert.equal(r.pulled, 3);
assert.equal(r.sent, 0);
assert.equal(B.notes.get(1).content, "<h1>Primeira</h1>");
assert.equal(B.folders.get(10).name, "Trabalho");
assert.equal(B.pending.size, 0, "o que veio da nuvem não fica pendente");
assert.deepEqual(B.applied.at(-1).folders, true);

// --- Eco: A sincroniza de novo e não reenvia nem reaplica nada.
const writes = remote.writes;
r = await A.engine.sync();
assert.equal(r.sent, 0);
assert.equal(remote.writes, writes);

// --- Edição em B chega em A.
B.save(2, "Segunda editada");
await B.engine.sync();
assert.equal(remote.docs.get("note:2").ver, 2);
await A.engine.sync();
assert.equal(A.notes.get(2).content, "<h1>Segunda editada</h1>");
assert.equal(A.vers.get("note:2"), 2);

// --- Conflito: os dois editam a mesma nota offline. Quem sobe primeiro ganha a original; o
//     outro fica com a versão da nuvem + uma cópia "(conflito …)" com a dele, que também sobe.
A.save(1, "Primeira por A", { folder_id: 10 });
B.save(1, "Primeira por B", { folder_id: 10 });
await A.engine.sync();
r = await B.engine.sync();
assert.equal(B.notes.get(1).content, "<h1>Primeira por A</h1>");
const copy = [...B.notes.values()].find((n) => n.content.includes("Primeira por B"));
assert.ok(copy, "cópia de conflito criada");
assert.match(copy.content, /\(conflito B \d\d\/\d\d\/\d{4} \d\d:\d\d\)/);
assert.equal(copy.folder_id, 10);
assert.equal(B.toasts.length, 1);
assert.deepEqual(B.applied.at(-1).replace, [1]);
assert.ok(remote.docs.has(`note:${copy.id}`), "a cópia sobe para a nuvem");
await A.engine.sync();
assert.ok(A.notes.has(copy.id), "e chega no outro aparelho");
assert.equal(A.notes.get(1).content, "<h1>Primeira por A</h1>");

// --- Mesma edição nos dois lados não é conflito.
A.save(2, "Igual");
B.save(2, "Igual");
await A.engine.sync();
const before = B.notes.size;
await B.engine.sync();
assert.equal(B.notes.size, before);
assert.equal(B.pending.size, 0);

// --- Recusa no envio (outro aparelho gravou entre a leitura e o envio): resolve e reenvia.
B.save(2, "B escreveu");
const pullB = remote.pull.bind(remote);
let injected = false;
remote.pull = async (since) => {
  const res = await pullB(since);
  if (!injected) {
    injected = true;
    // A grava logo depois da leitura de B.
    A.save(2, "A escreveu no meio");
    await A.engine.sync();
  }
  return res;
};
await B.engine.sync();
remote.pull = pullB;
assert.equal(B.notes.get(2).content, "<h1>A escreveu no meio</h1>");
assert.ok([...B.notes.values()].some((n) => n.content.includes("B escreveu") && n.content.includes("conflito")));

// --- Apagar de vez vira lápide; o outro aparelho remove.
A.remove(2);
await A.engine.sync();
assert.equal(remote.docs.get("note:2").deleted, true);
await B.engine.sync();
assert.ok(!B.notes.has(2));
assert.ok(B.applied.at(-1).removed.includes(2));

// --- Apagada lá, editada aqui: a edição ressuscita a nota.
B.save(1, "B mantém");
A.remove(1);
await A.engine.sync();
await B.engine.sync();
assert.equal(remote.docs.get("note:1").deleted, false);
await A.engine.sync();
assert.equal(A.notes.get(1).content, "<h1>B mantém</h1>");

// --- Nota sendo editada (não gravada) não é sobrescrita.
A.save(5, "Cinco");
await A.engine.sync();
await B.engine.sync();
B.busy.add(5);
A.save(5, "Cinco por A");
await A.engine.sync();
await B.engine.sync();
assert.equal(B.notes.get(5).content, "<h1>Cinco</h1>");
B.busy.delete(5);

// --- Imagens: sobem antes da nota e são baixadas no outro aparelho.
A.imgs.set("abc.png", new Uint8Array([1, 2, 3]));
A.save(6, "Com imagem", { images: ["abc.png"] });
await A.engine.sync();
assert.deepEqual([...remote.images.get("abc.png")], [1, 2, 3]);
await B.engine.sync();
assert.deepEqual([...B.imgs.get("abc.png")], [1, 2, 3]);

// --- Pasta: mudou nos dois lados, vale a do aparelho que sincroniza por último.
A.folder(10, "Trabalho A");
B.folder(10, "Trabalho B");
await A.engine.sync();
await B.engine.sync();
assert.equal(remote.docs.get("folder:10").data.name, "Trabalho B");
await A.engine.sync();
assert.equal(A.folders.get(10).name, "Trabalho B");

// --- Cursor: guarda o maior rev visto; a releitura volta CURSOR_OVERLAP_MS.
assert.equal(Number(A.meta.get("cursor")), Math.max(...[...remote.docs.values()].map((d) => d.rev)));
assert.ok(CURSOR_OVERLAP_MS > 0);

// --- Chamadas concorrentes viram uma rodada a mais, não várias em paralelo.
A.save(7, "Sete");
const [x, y] = await Promise.all([A.engine.sync(), A.engine.sync()]);
assert.equal(x, y);
assert.equal(remote.docs.get("note:7").ver, 1);

// ---------- Utilitários ----------
assert.deepEqual(toRemote("folder", { id: 1, name: "P", parent_id: undefined, position: 3, extra: 1 }), { id: 1, name: "P", parent_id: 0, position: 3 });
const tr = toRemote("note", { id: 3, content: "<img src=\"http://noteimg.localhost/a.png\">", dirty: true }, (h) => h.replace("http://noteimg.localhost/", "noteimg://localhost/"));
assert.equal(tr.content, '<img src="noteimg://localhost/a.png">');
assert.equal(tr.dirty, undefined);
assert.equal(tr.deleted_at, null);
assert.deepEqual(tr.images, []);
assert.ok(Object.values(tr).every((v) => v !== undefined), "Firestore não aceita undefined");
assert.ok(sameNote({ content: "a", props: null }, { content: "a" }));
assert.ok(!sameNote({ content: "a", pinned: 1 }, { content: "a", pinned: 0 }));
assert.equal(conflictSuffix("iPhone", new Date(2026, 10, 1, 9, 5)), " (conflito iPhone 01/11/2026 09:05)");

console.log("sync: ok");

// Armazenamento das notas no navegador (PWA do app Notas): a mesma interface do `notesApi`
// (comandos notes_* do Rust) e do `syncApi` (notes_sync.rs), sobre o IndexedDB (idb.js).
// Como no notes.db, toda gravação marca a nota/pasta como pendente para o sync.

import { tx, req } from "./idb.js";
import { fold } from "../utils/zettel.js";

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_CHARS = 240;
const IMAGE_GC_GRACE_MS = 24 * 60 * 60 * 1000;

const preview = (text) => {
  const chars = [...String(text || "")];
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : chars.join("");
};

/** Registro gravado (mesmos campos das colunas de `notes`). */
function noteRow(n) {
  return {
    id: n.id,
    title: n.title || "",
    preview: preview(n.preview),
    content: n.content || "",
    plain: n.plain || "",
    images: Array.isArray(n.images) ? n.images : [],
    created_at: n.created_at || "",
    updated_at: n.updated_at || 0,
    pinned: typeof n.pinned === "boolean" ? +n.pinned : n.pinned || 0,
    folder_id: n.folder_id || 0,
    deleted_at: n.deleted_at ?? null,
    props: n.props ?? null,
    links: Array.isArray(n.links) ? n.links : [],
  };
}

function metaOf(row) {
  const { content, plain, images, ...meta } = row;
  return meta;
}

/** Marca como pendente; `seq` cresce a cada alteração (como os gatilhos do notes.db). */
async function markPending(s, kind, id) {
  const cur = await req(s.meta.get("seq"));
  const seq = (cur?.value || 0) + 1;
  s.meta.put({ key: "seq", value: seq });
  s.pending.put({ kind, id, seq });
}

const W = ["notes", "folders", "pending", "meta"];

export const webNotesApi = {
  async list() {
    const limit = Date.now() - TRASH_RETENTION_MS;
    return tx(W, "readwrite", async (s) => {
      const rows = await req(s.notes.getAll());
      const out = [];
      for (const r of rows) {
        if (r.deleted_at && r.deleted_at < limit) {
          s.notes.delete(r.id);
          await markPending(s, "note", r.id);
        } else out.push(metaOf(r));
      }
      return out.sort((a, b) => b.updated_at - a.updated_at);
    });
  },

  async get(id) {
    const row = await tx(["notes"], "readonly", (s) => req(s.notes.get(id)));
    return row ? row.content : "";
  },

  async save(note) {
    await tx(W, "readwrite", async (s) => {
      s.notes.put(noteRow(note));
      await markPending(s, "note", note.id);
    });
    return null;
  },

  async saveMany(notes) {
    await tx(W, "readwrite", async (s) => {
      for (const n of notes) {
        s.notes.put(noteRow(n));
        await markPending(s, "note", n.id);
      }
    });
  },

  async scanDir() {
    throw new Error("Importar pasta só no app desktop.");
  },

  async setMeta(metas) {
    await tx(W, "readwrite", async (s) => {
      for (const m of metas) {
        const row = await req(s.notes.get(m.id));
        if (!row) continue;
        Object.assign(row, { pinned: m.pinned || 0, folder_id: m.folder_id || 0, deleted_at: m.deleted_at ?? null, updated_at: m.updated_at });
        s.notes.put(row);
        await markPending(s, "note", m.id);
      }
    });
  },

  async delete(ids) {
    await tx(W, "readwrite", async (s) => {
      for (const id of ids) {
        s.notes.delete(id);
        await markPending(s, "note", id);
      }
    });
  },

  /** Ids das notas que contêm o texto (sem maiúsculas/acentos), como o FTS do notes.db. */
  async search(query) {
    const q = fold(query);
    if (!q) return [];
    const rows = await tx(["notes"], "readonly", (s) => req(s.notes.getAll()));
    return rows.filter((r) => fold(r.plain).includes(q)).map((r) => r.id);
  },

  async folders() {
    const rows = await tx(["folders"], "readonly", (s) => req(s.folders.getAll()));
    return rows.sort((a, b) => a.position - b.position || a.id - b.id).map(({ id, name, parent_id }) => ({ id, name, parent_id }));
  },

  /** Só grava (e marca pendente) o que mudou; a ordem do array vira `position`. */
  async saveFolders(folders) {
    await tx(W, "readwrite", async (s) => {
      const old = new Map((await req(s.folders.getAll())).map((f) => [f.id, f]));
      const keep = new Set(folders.map((f) => f.id));
      for (const id of old.keys()) {
        if (keep.has(id)) continue;
        s.folders.delete(id);
        await markPending(s, "folder", id);
      }
      for (const [position, f] of folders.entries()) {
        const row = { id: f.id, name: f.name, parent_id: f.parent_id || 0, position };
        const prev = old.get(f.id);
        if (prev && prev.name === row.name && prev.parent_id === row.parent_id && prev.position === position) continue;
        s.folders.put(row);
        await markPending(s, "folder", f.id);
      }
    });
  },

  legacy: async () => null,
  import: async () => 0,

  /** Imagens que nenhuma nota usa (e mais velhas que 24 h: podem ser de uma nota ainda não gravada). */
  async gcImages() {
    return tx(["notes", "images"], "readwrite", async (s) => {
      const used = new Set((await req(s.notes.getAll())).flatMap((r) => r.images || []));
      const limit = Date.now() - IMAGE_GC_GRACE_MS;
      let removed = 0;
      for (const img of await req(s.images.getAll())) {
        if (used.has(img.name) || (img.created || 0) > limit) continue;
        s.images.delete(img.name);
        removed++;
      }
      return removed;
    });
  },

  async setStorage(mode) {
    if (mode !== "sqlite") throw new Error("O cofre (pasta de Markdown) só existe no app desktop.");
  },
  vaultRefresh: async () => ({ changed: [], removed: [], folders: null }),
  vaultFiles: async () => [],
};

// ---------- Estado do sync (mesma interface do syncApi do desktop) ----------

const S = ["notes", "folders", "pending", "vers", "meta", "images"];

async function verOf(s, kind, id) {
  return (await req(s.vers.get([kind, id])))?.ver || 0;
}

export const webSyncApi = {
  /** { items: [{ kind, id, seq, ver, item | null }], total }; pastas primeiro. */
  async pending(items, limit = 200) {
    return tx(S, "readonly", async (s) => {
      const all = (await req(s.pending.getAll())).sort((a, b) => (a.kind === "note") - (b.kind === "note") || a.seq - b.seq);
      const out = [];
      for (const p of all.slice(0, limit)) {
        let item = null;
        if (items) {
          const row = await req((p.kind === "note" ? s.notes : s.folders).get(p.id));
          item = row ? { ...row } : null;
        }
        out.push({ kind: p.kind, id: p.id, seq: p.seq, ver: await verOf(s, p.kind, p.id), item });
      }
      return { items: out, total: all.length };
    });
  },

  async done(items) {
    await tx(S, "readwrite", async (s) => {
      for (const d of items) {
        s.vers.put({ kind: d.kind, id: d.id, ver: d.ver });
        const p = await req(s.pending.get([d.kind, d.id]));
        if (p && p.seq === d.seq) s.pending.delete([d.kind, d.id]);
      }
    });
  },

  /** Mudanças da nuvem (sem marcar pendente); versão já conhecida é ignorada. */
  async apply(ch) {
    await tx(S, "readwrite", async (s) => {
      const take = async (kind, id, ver) => {
        if (ver <= (await verOf(s, kind, id))) return false;
        s.pending.delete([kind, id]);
        s.vers.put({ kind, id, ver });
        return true;
      };
      for (const f of ch.folders || []) {
        if (await take("folder", f.id, f.ver)) s.folders.put({ id: f.id, name: f.name, parent_id: f.parent_id || 0, position: f.position || 0 });
      }
      for (const g of ch.deleted_folders || []) {
        if (await take("folder", g.id, g.ver)) s.folders.delete(g.id);
      }
      for (const n of ch.notes || []) {
        if (await take("note", n.id, n.ver)) s.notes.put(noteRow(n));
      }
      for (const g of ch.deleted_notes || []) {
        if (await take("note", g.id, g.ver)) s.notes.delete(g.id);
      }
      for (const v of ch.vers || []) s.vers.put({ kind: v.kind, id: v.id, ver: v.ver });
    });
  },

  async reset() {
    await tx(S, "readwrite", async (s) => {
      s.vers.clear();
      s.pending.clear();
      for (const m of await req(s.meta.getAllKeys())) if (String(m).startsWith("sync:")) s.meta.delete(m);
      for (const img of await req(s.images.getAll())) if (img.uploaded) s.images.put({ ...img, uploaded: false });
      for (const f of await req(s.folders.getAll())) await markPending(s, "folder", f.id);
      for (const n of await req(s.notes.getAll())) await markPending(s, "note", n.id);
    });
  },

  metaGet: (key) => tx(["meta"], "readonly", async (s) => (await req(s.meta.get(`sync:${key}`)))?.value ?? null),
  metaSet: (key, value) =>
    tx(["meta"], "readwrite", (s) => {
      if (value === null || value === undefined) s.meta.delete(`sync:${key}`);
      else s.meta.put({ key: `sync:${key}`, value: String(value) });
    }),

  /** Imagens usadas pelas notas que ainda não subiram. */
  async imagesPending() {
    return tx(["notes", "images"], "readonly", async (s) => {
      const used = new Set((await req(s.notes.getAll())).flatMap((r) => r.images || []));
      const up = new Set((await req(s.images.getAll())).filter((i) => i.uploaded).map((i) => i.name));
      return [...used].filter((n) => !up.has(n)).sort();
    });
  },

  async imagesMark(names) {
    await tx(["images"], "readwrite", async (s) => {
      for (const name of names) {
        const img = await req(s.images.get(name));
        s.images.put({ ...(img || { name, created: Date.now() }), uploaded: true });
      }
    });
  },

  async imageRead(name) {
    const img = await tx(["images"], "readonly", (s) => req(s.images.get(name)));
    if (!img?.blob) throw new Error(`Imagem ${name} não está neste aparelho.`);
    return img.blob.arrayBuffer();
  },

  async imagesMissing(names) {
    return tx(["images"], "readonly", async (s) => {
      const out = [];
      for (const n of names) if (!(await req(s.images.get(n)))?.blob) out.push(n);
      return out;
    });
  },

  async imagePut(name, bytes) {
    const blob = new Blob([bytes], { type: mimeOf(name) });
    await tx(["images"], "readwrite", async (s) => {
      const img = await req(s.images.get(name));
      s.images.put({ ...(img || {}), name, blob, uploaded: true, created: img?.created || Date.now() });
    });
  },
};

// ---------- Imagens (mesmo nome que o Rust dá: SHA-256 + extensão; note_images.rs) ----------

const EXTS = { png: "png", jpg: "jpg", jpeg: "jpg", jfif: "jpg", gif: "gif", webp: "webp", bmp: "bmp", avif: "avif" };
const MIMES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" };

export const mimeOf = (name) => MIMES[String(name).split(".").pop()] || "application/octet-stream";

/** Formato pelos primeiros bytes (igual a `sniff` do note_images.rs). */
export function sniffImage(b) {
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  const ascii = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(0, 0x89) && ascii(1, "PNG")) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (ascii(0, "GIF8")) return "gif";
  if (b.length > 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(0, "BM")) return "bmp";
  if (b.length > 12 && ascii(4, "ftypavif")) return "avif";
  return null;
}

/** Nome da imagem: SHA-256 dos bytes em hexadecimal + extensão. */
export async function imageName(bytes, hintExt = "") {
  const ext = sniffImage(bytes) || EXTS[String(hintExt).toLowerCase().replace(/^\./, "")];
  if (!ext) throw new Error("Formato de imagem não suportado.");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `${[...hash].map((x) => x.toString(16).padStart(2, "0")).join("")}.${ext}`;
}

/** Guarda uma imagem colada/fotografada e devolve o nome (igual em todos os aparelhos). */
export async function saveWebImage(bytes, hintExt = "") {
  if (!bytes?.length) throw new Error("Imagem vazia.");
  const name = await imageName(bytes, hintExt);
  const blob = new Blob([bytes], { type: mimeOf(name) });
  await tx(["images"], "readwrite", async (s) => {
    const img = await req(s.images.get(name));
    if (!img?.blob) s.images.put({ ...(img || {}), name, blob, uploaded: !!img?.uploaded, created: Date.now() });
  });
  return name;
}

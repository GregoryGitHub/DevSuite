// Zettelkasten das Notas: links [[ ]] entre notas, propriedades (front-matter), índice de
// títulos, backlinks, grafo e filtros da busca. Sem DOM (tests/zettel.test.mjs).
//
// Link no HTML: <a class="nt-link" data-note="<id>">Título</a> (pelo id: renomear a nota não
// quebra o link; o texto é atualizado ao abrir). data-alias = texto fixo ([[Título|texto]]).
// Sem nota com esse título: data-target="Título" (não resolvido; clicar cria a nota).
// Os links de cada nota ficam no notes.db (coluna links): [id | "título não resolvido"].

export const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const unescapeHtml = (t) =>
  t.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " })[e]);

// ---------- Links ----------

/** HTML do link. `target` = { id, title } de uma nota, ou o título de uma nota que não existe. */
export function linkHtml(target, alias = "") {
  const a = alias.trim();
  const attrs = typeof target === "object" && target ? `data-note="${target.id}"` : `data-target="${escapeHtml(String(target).trim())}"`;
  const title = typeof target === "object" && target ? target.title : String(target).trim();
  return `<a class="nt-link" contenteditable="false" ${attrs}${a ? ` data-alias=""` : ""}>${escapeHtml(a || title)}</a>`;
}

const LINK_TAG_RE = /<a\b[^>]*\bclass="nt-link"[^>]*>/gi;

/** Links de um HTML de nota, sem repetição: ids (número) e títulos não resolvidos (texto). */
export function noteLinks(html) {
  if (!html || !html.includes("nt-link")) return [];
  const out = [];
  const seen = new Set();
  for (const [tag] of html.matchAll(LINK_TAG_RE)) {
    const id = /\bdata-note="(\d+)"/.exec(tag);
    const target = /\bdata-target="([^"]*)"/.exec(tag);
    const value = id ? Number(id[1]) : target ? unescapeHtml(target[1]).trim() : null;
    if (value === null || value === "") continue;
    const key = typeof value === "number" ? `#${value}` : fold(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** "Título|apelido" digitado entre [[ ]] -> { title, alias }. */
export function splitLinkText(text) {
  const i = text.indexOf("|");
  return i < 0 ? { title: text.trim(), alias: "" } : { title: text.slice(0, i).trim(), alias: text.slice(i + 1).trim() };
}

// ---------- Propriedades ----------

export const NOTE_TYPES = [
  ["fleeting", "Transitória"],
  ["literature", "Literatura"],
  ["permanent", "Permanente"],
  ["hub", "Índice"],
];
export const NOTE_STATUSES = [
  ["draft", "Rascunho"],
  ["progress", "Em progresso"],
  ["done", "Pronta"],
];

export function normalizeTag(tag) {
  return String(tag ?? "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, "-")
    .replace(/[,[\]{}"'`]/g, "")
    .slice(0, 60);
}

const uniqBy = (list, key) => {
  const seen = new Set();
  return list.filter((v) => {
    const k = key(v);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Propriedades com todos os campos (aceita null/objeto parcial vindo do banco ou do YAML). */
export function normalizeProps(p) {
  const src = p && typeof p === "object" ? p : {};
  const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
  const list = (v) => (Array.isArray(v) ? v : str(v) ? str(v).split(",") : []).map(str).filter(Boolean);
  const extra = {};
  if (src.extra && typeof src.extra === "object") {
    for (const [k, v] of Object.entries(src.extra)) if (str(k)) extra[str(k)] = str(v);
  }
  return {
    zid: str(src.zid),
    tags: uniqBy(list(src.tags).map(normalizeTag), fold),
    aliases: uniqBy(list(src.aliases), fold),
    type: str(src.type),
    status: str(src.status),
    source: str(src.source),
    author: str(src.author),
    extra,
  };
}

export function propsEmpty(p) {
  const n = normalizeProps(p);
  return !n.zid && !n.tags.length && !n.aliases.length && !n.type && !n.status && !n.source && !n.author && !Object.keys(n.extra).length;
}

/** Texto das propriedades que entra na busca (FTS). */
export function propsSearchText(p) {
  if (!p) return "";
  const n = normalizeProps(p);
  return [n.zid, ...n.tags.map((t) => `#${t}`), ...n.aliases, n.source, n.author, ...Object.values(n.extra)].filter(Boolean).join(" ");
}

/**
 * Data de criação escrita no front-matter -> timestamp (ms, horário local) ou null.
 * Aceita 2025-11-18, 2025-11-18 10:30, 2025-11-18T10:30:00Z e 18/11/2025 (dia/mês/ano).
 */
export function parseNoteDate(value) {
  const s = String(value ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) {
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (br) m = [br[0], br[3], br[2], br[1], br[4], br[5], br[6]];
  }
  if (m) {
    const [y, mo, d, h = 0, mi = 0, sec = 0] = m.slice(1).map((v) => Number(v || 0));
    const date = new Date(y, mo - 1, d, h, mi, sec);
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date.getTime() : null;
  }
  // ISO completo com fuso (2025-11-18T10:30:00Z, +03:00).
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** "AAAA-MM-DD" (local) de uma data/ISO/timestamp; "" se inválida. */
export function dateOnly(value) {
  const d = new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Id zettel AAAAMMDDHHmm; com colisão, acrescenta segundos e depois um contador. */
export function newZid(date = new Date(), taken = new Set()) {
  const base = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
  if (!taken.has(base)) return base;
  const withSec = base + pad(date.getSeconds());
  if (!taken.has(withSec)) return withSec;
  for (let i = 1; ; i++) if (!taken.has(`${withSec}-${i}`)) return `${withSec}-${i}`;
}

// ---------- Front-matter YAML (subconjunto) ----------

const YAML_PLAIN = /^[\p{L}\p{N}_][\p{L}\p{N}_ ./+@-]*$/u;
const yamlScalar = (v) => (YAML_PLAIN.test(v) && !/^(true|false|null|yes|no|~)$/i.test(v) ? v : JSON.stringify(v));

/**
 * Propriedades -> bloco "---\n...\n---\n" (vazio se não houver nada). `created` = data de
 * criação da nota (ISO/timestamp), escrita como `created: AAAA-MM-DD`.
 */
export function propsToYaml(p, { created = null, pinned = 0 } = {}) {
  const n = normalizeProps(p);
  const day = created ? dateOnly(created) : "";
  if (propsEmpty(n) && !day && !pinned) return "";
  const out = ["---"];
  if (n.zid) out.push(`id: ${yamlScalar(n.zid)}`);
  if (day) out.push(`created: ${day}`);
  if (pinned) out.push(`pinned: ${pinned}`);
  const list = (key, items) => {
    if (!items.length) return;
    out.push(`${key}:`);
    for (const t of items) out.push(`  - ${yamlScalar(t)}`);
  };
  list("tags", n.tags);
  list("aliases", n.aliases);
  if (n.type) out.push(`type: ${yamlScalar(n.type)}`);
  if (n.status) out.push(`status: ${yamlScalar(n.status)}`);
  if (n.source) out.push(`source: ${yamlScalar(n.source)}`);
  if (n.author) out.push(`author: ${yamlScalar(n.author)}`);
  for (const [k, v] of Object.entries(n.extra)) out.push(`${YAML_PLAIN.test(k) ? k : JSON.stringify(k)}: ${yamlScalar(v)}`);
  out.push("---", "");
  return out.join("\n");
}

function unquote(v) {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s.replace(/\s+#.*$/, "");
}

function inlineList(v) {
  const s = v.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return null;
  return s
    .slice(1, -1)
    .split(",")
    .map(unquote)
    .filter((x) => x !== "");
}

// Chaves comparadas sem acento/maiúsculas/espaços ("Data criação" -> "datacriacao").
const KEY_MAP = {
  id: "zid", zid: "zid", tags: "tags", tag: "tags", aliases: "aliases", alias: "aliases", type: "type", tipo: "type",
  status: "status", source: "source", url: "source", fonte: "source", author: "author", authors: "author", autor: "author",
  autores: "author", autora: "author",
};
const CREATED_KEYS = new Set([
  "created", "createdat", "createdon", "creationdate", "datecreated", "date", "data", "datacriacao", "datadecriacao",
  "criado", "criadoem", "criacao", "criadaem",
]);
const PINNED_KEYS = new Set(["pinned", "fixada", "fixado"]);
const keyOf = (k) => fold(k).replace(/[^a-z0-9]/g, "");

/** `pinned:` do front-matter: true = 1, número = posição entre as fixadas (maior = mais acima). */
function pinOrder(v) {
  const s = String(Array.isArray(v) ? v[0] ?? "" : v).trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "sim") return 1;
  return /^\d+$/.test(s) ? Math.min(Number(s), 0xffffffff) : 0;
}

/** Texto YAML (sem os ---) -> propriedades. Chaves desconhecidas vão para `extra`. */
export function yamlToProps(text) {
  return parseFrontMatter(text).props;
}

/**
 * Texto YAML (sem os ---) -> { props, created, pinned }. `created` = timestamp da data de criação
 * (created, date, "Data criação"...; null se ausente/ilegível — aí a chave fica em `extra`);
 * `pinned` = posição entre as fixadas (0 = não fixada).
 */
export function parseFrontMatter(text) {
  const raw = {};
  let listKey = null;
  for (const line of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      raw[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^("(?:[^"\\]|\\.)*"|[^:#]+?)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = unquote(kv[1]);
    const value = kv[2];
    if (!value.trim()) {
      raw[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    raw[key] = inlineList(value) ?? unquote(value);
  }
  const props = { extra: {} };
  let created = null;
  let pinned = 0;
  for (const [k, v] of Object.entries(raw)) {
    const key = keyOf(k);
    const mapped = KEY_MAP[key];
    if (PINNED_KEYS.has(key)) pinned = pinOrder(v);
    else if (mapped === "tags" || mapped === "aliases") props[mapped] = Array.isArray(v) ? v : String(v).split(",");
    else if (mapped) props[mapped] = Array.isArray(v) ? v.join(", ") : v;
    else if (CREATED_KEYS.has(key) && created === null && (created = parseNoteDate(v)) !== null) continue;
    else props.extra[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return { props: normalizeProps(props), created, pinned };
}

/** Separa o front-matter do corpo de um Markdown: { yaml (ou null), body }. */
export function splitFrontMatter(md) {
  const text = String(md).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n(?:---|\.\.\.)(?:\n|$)/.exec(text);
  return m ? { yaml: m[1], body: text.slice(m[0].length) } : { yaml: null, body: text };
}

// ---------- Índice de títulos ----------

/**
 * Título/apelido normalizado -> nota. `titleOf(note)` dá o título atual.
 * Em conflito vale a nota fora da lixeira e editada por último.
 */
export class TitleIndex {
  constructor(notes, titleOf) {
    this.notes = notes.filter((n) => !n.deleted_at);
    this.titleOf = titleOf;
    this.map = new Map();
    this.entries = [];
    const sorted = [...this.notes].sort((a, b) => b.updated_at - a.updated_at);
    for (const note of sorted) {
      const title = titleOf(note);
      this.#add(fold(title), note);
      this.entries.push({ note, key: fold(title), label: title, alias: false });
      for (const alias of note.props?.aliases || []) {
        this.#add(fold(alias), note);
        this.entries.push({ note, key: fold(alias), label: alias, alias: true });
      }
    }
  }

  #add(key, note) {
    if (key && !this.map.has(key)) this.map.set(key, note);
  }

  /** Nota com esse título/apelido (ou null). */
  resolve(title) {
    return this.map.get(fold(title)) || null;
  }

  /** Sugestões para o autocomplete: título exato > começa com > palavra começa com > contém. */
  suggest(query, limit = 8, excludeId = null) {
    const q = fold(query);
    const scored = [];
    const best = new Map();
    for (const e of this.entries) {
      if (e.note.id === excludeId) continue;
      let score;
      if (!q) score = 3;
      else if (e.key === q) score = 0;
      else if (e.key.startsWith(q)) score = 1;
      else if (e.key.includes(` ${q}`)) score = 2;
      else if (e.key.includes(q)) score = 3;
      else continue;
      if (e.alias) score += 0.5;
      const prev = best.get(e.note.id);
      if (prev && prev.score <= score) continue;
      const item = { note: e.note, label: e.label, alias: e.alias ? e.label : "", score };
      best.set(e.note.id, item);
      scored.push(item);
    }
    return scored
      .filter((it) => best.get(it.note.id) === it)
      .sort((a, b) => a.score - b.score || b.note.updated_at - a.note.updated_at)
      .slice(0, limit);
  }
}

/** Ids das notas para onde `note` aponta (títulos não resolvidos tentam o índice). */
export function outgoingIds(note, index) {
  const out = new Set();
  for (const l of note.links || []) {
    if (typeof l === "number") out.add(l);
    else {
      const t = index?.resolve(l);
      if (t) out.add(t.id);
    }
  }
  out.delete(note.id);
  return out;
}

/** Mapa id -> Set(ids das notas que apontam para ela). Notas na lixeira não contam. */
export function backlinkMap(notes, index) {
  const map = new Map();
  for (const n of notes) {
    if (n.deleted_at) continue;
    for (const id of outgoingIds(n, index)) {
      if (!map.has(id)) map.set(id, new Set());
      map.get(id).add(n.id);
    }
  }
  return map;
}

// ---------- Grafo ----------

/**
 * Nós e arestas do grafo. Nós: { key, kind: "note"|"tag"|"missing", label, id?, type?, degree }.
 * opts: { titleOf, index, tags, orphans, missing, folderId (null = todas; id ou Set de ids), center (id), depth }.
 */
export function buildGraph(notes, opts = {}) {
  const { titleOf = (n) => n.title || "", tags = true, orphans = true, missing = false, folderId = null, center = null, depth = 1 } = opts;
  const index = opts.index || new TitleIndex(notes, titleOf);
  // folderId: um id ou um Set (pasta + subpastas).
  const inFolder = folderId === null ? () => true : folderId instanceof Set ? (n) => folderId.has(n.folder_id) : (n) => n.folder_id === folderId;
  const live = notes.filter((n) => !n.deleted_at && (inFolder(n) || n.id === center));
  const nodes = [];
  const byKey = new Map();
  const node = (key, make) => {
    let i = byKey.get(key);
    if (i === undefined) {
      i = nodes.push({ key, degree: 0, ...make() }) - 1;
      byKey.set(key, i);
    }
    return i;
  };
  const edges = [];
  const edgeSet = new Set();
  const edge = (a, b) => {
    if (a === b) return;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    edges.push([a, b]);
    nodes[a].degree++;
    nodes[b].degree++;
  };
  const liveIds = new Set(live.map((n) => n.id));
  for (const n of live) node(`n:${n.id}`, () => ({ kind: "note", id: n.id, label: titleOf(n) || "Nova Nota", type: n.props?.type || "" }));
  for (const n of live) {
    const a = byKey.get(`n:${n.id}`);
    for (const l of n.links || []) {
      const target = typeof l === "number" ? l : index.resolve(l)?.id;
      if (target !== undefined && liveIds.has(target)) edge(a, byKey.get(`n:${target}`));
      else if (missing && typeof l === "string") edge(a, node(`m:${fold(l)}`, () => ({ kind: "missing", label: l })));
    }
    if (tags) for (const t of n.props?.tags || []) edge(a, node(`t:${fold(t)}`, () => ({ kind: "tag", label: `#${t}` })));
  }

  let keep = null;
  if (center !== null && byKey.has(`n:${center}`)) {
    const adj = nodes.map(() => []);
    for (const [a, b] of edges) {
      adj[a].push(b);
      adj[b].push(a);
    }
    keep = new Set([byKey.get(`n:${center}`)]);
    let frontier = [...keep];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const i of frontier) for (const j of adj[i]) if (!keep.has(j)) keep.add(j), next.push(j);
      frontier = next;
    }
  } else if (!orphans) {
    keep = new Set(nodes.map((nd, i) => (nd.degree > 0 ? i : -1)).filter((i) => i >= 0));
  }
  if (!keep) return { nodes, edges };

  const remap = new Map();
  const kept = [];
  nodes.forEach((nd, i) => keep.has(i) && remap.set(i, kept.push({ ...nd, degree: 0 }) - 1));
  const keptEdges = [];
  for (const [a, b] of edges) {
    if (!remap.has(a) || !remap.has(b)) continue;
    const e = [remap.get(a), remap.get(b)];
    kept[e[0]].degree++;
    kept[e[1]].degree++;
    keptEdges.push(e);
  }
  return { nodes: kept, edges: keptEdges };
}

// ---------- Busca relacional ----------

const FILTER_RE = /(?:^|\s)(?:(tag|type|status|tipo|id):("[^"]*"|\S+)|#([\p{L}\p{N}_/-]+)|\[\[([^\]]+)\]\])(?=\s|$)/giu;

/**
 * "tag:rust #ideia type:permanent status:done [[Outra nota]] texto livre"
 * -> { text, tags, type, status, zid, linksTo }. `text` segue para a busca normal.
 */
export function parseQuery(query) {
  const f = { text: "", tags: [], type: "", status: "", zid: "", linksTo: [] };
  const text = String(query || "").replace(FILTER_RE, (m, key, value, hash, link) => {
    const v = value ? value.replace(/^"|"$/g, "") : "";
    if (hash) f.tags.push(hash);
    else if (link) f.linksTo.push(link.trim());
    else if (/^tag$/i.test(key)) f.tags.push(normalizeTag(v));
    else if (/^(type|tipo)$/i.test(key)) f.type = v;
    else if (/^status$/i.test(key)) f.status = v;
    else if (/^id$/i.test(key)) f.zid = v;
    return " ";
  });
  f.text = text.replace(/\s+/g, " ").trim();
  return f;
}

export function hasFilters(f) {
  return !!(f.tags.length || f.type || f.status || f.zid || f.linksTo.length);
}

const labelMatch = (value, wanted, table) => {
  const w = fold(wanted);
  if (fold(value) === w) return true;
  const row = table.find(([k]) => k === value);
  return !!row && fold(row[1]).startsWith(w);
};

/** A nota atende aos filtros? (tags hierárquicas: tag:a casa com a/b). */
export function matchesFilters(note, f, index) {
  const p = note.props || {};
  const tags = (p.tags || []).map(fold);
  for (const t of f.tags) {
    const w = fold(t);
    if (!tags.some((x) => x === w || x.startsWith(`${w}/`))) return false;
  }
  if (f.type && !labelMatch(p.type || "", f.type, NOTE_TYPES)) return false;
  if (f.status && !labelMatch(p.status || "", f.status, NOTE_STATUSES)) return false;
  if (f.zid && !String(p.zid || "").startsWith(f.zid)) return false;
  for (const title of f.linksTo) {
    const target = index?.resolve(title);
    const links = note.links || [];
    const hit = links.some((l) => (typeof l === "number" ? target && l === target.id : fold(l) === fold(title)));
    if (!hit) return false;
  }
  return true;
}

/** Todas as tags em uso (com contagem), para o autocomplete e o grafo. */
export function tagCounts(notes) {
  const map = new Map();
  for (const n of notes) {
    if (n.deleted_at) continue;
    for (const t of n.props?.tags || []) {
      const k = fold(t);
      const cur = map.get(k);
      if (cur) cur.count++;
      else map.set(k, { tag: t, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

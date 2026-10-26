// CLI: `devsuite notes ...` (ver src-tauri/cli/commands.json). O armazenamento ativo é o estado
// vivo das Notas (notesHost); outro armazenamento (banco local com um cofre ativo, ou outro cofre)
// é só leitura, via `cli_store_read`, e `create --vault` grava um .md novo nele.

import { state } from "../state.js";
import { readTextFileApi } from "../api.js";
import { notesHost as host } from "../components/notes.js";
import { ensureContent, isVault, searchNotes } from "../noteStore.js";
import { htmlToMarkdown, markdownToHtml } from "../utils/markdown.js";
import { noteLines, sanitizeHtml, escapeHtml } from "../utils/noteContent.js";
import { knownVaults, sameVaultPath, vaultName, vaultLabels, vaultMeta, markdownToNote } from "../utils/vaultNote.js";
import { folderPath, flattenTree, descendantIds } from "../utils/folderTree.js";
import {
  TitleIndex, normalizeProps, propsEmpty, propsToYaml, parseQuery, hasFilters, matchesFilters, tagCounts,
  outgoingIds, backlinkMap, splitFrontMatter,
} from "../utils/zettel.js";
import { CliError, pick, list, requireFlag, iso, fold } from "./cliUtils.js";

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

// ---------- Armazenamentos ----------

function storages() {
  const vaults = knownVaults(state.settings);
  const labels = vaultLabels(vaults);
  const activeVault = isVault() ? state.settings.vault_path : null;
  return [
    { name: "local", kind: "sqlite", path: null, active: !activeVault },
    ...vaults.map((path, i) => ({ name: labels[i], kind: "vault", path, active: !!activeVault && sameVaultPath(path, activeVault) })),
  ];
}

/** Armazenamento pedido em --vault (null = o ativo). */
function resolveStore(wanted) {
  if (wanted === undefined || wanted === null || wanted === "") return storages().find((s) => s.active);
  const w = String(wanted).trim();
  if (["local", "sqlite", "banco", "db"].includes(fold(w))) return storages()[0];
  const all = storages().slice(1);
  const byPath = all.find((s) => sameVaultPath(s.path, w));
  if (byPath) return byPath;
  const byName = all.filter((s) => fold(s.name) === fold(w) || fold(vaultName(s.path)) === fold(w));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new CliError("ambiguous", `Mais de um cofre chamado "${w}": ${byName.map((s) => s.path).join("; ")}`);
  // Caminho de um cofre ainda não usado no app: aceita se for uma pasta (o Rust valida).
  if (/[\\/]/.test(w)) return { name: vaultName(w), kind: "vault", path: w, active: false };
  throw new CliError("not_found", `Cofre não encontrado: ${w} (veja devsuite notes vaults)`);
}

const storeArg = (s) => (s.kind === "sqlite" ? { kind: "sqlite" } : { kind: "vault", path: s.path });

/** Notas e pastas de um armazenamento: { notes, folders, live } (live = estado do app). */
async function storeData(store) {
  if (store.active) return { notes: state.notes, folders: state.folders, live: true };
  const res = await invoke("cli_store_read", { store: storeArg(store), op: { op: "list" } });
  const notes = (res.notes || []).map((m) => (store.kind === "vault" ? vaultMeta(m) : m));
  for (const n of notes) {
    n.props = n.props && typeof n.props === "object" ? n.props : null;
    n.links = Array.isArray(n.links) ? n.links : [];
  }
  const folders = (res.folders || []).map((f) => ({ id: f.id, name: f.name, parent_id: f.parent_id || 0 }));
  return { notes, folders, live: false };
}

const titleIn = (data) => (n) => (data.live ? host.titleOf(n) : n.title || "Nova Nota");

function folderIn(data, id) {
  return (id && folderPath(data.folders, id, "/")) || "Notas";
}

function summary(data, n, store = null) {
  const out = {
    id: n.id,
    title: titleIn(data)(n),
    folder: folderIn(data, n.folder_id),
    tags: n.props?.tags || [],
    pinned: !!n.pinned,
    updated: iso(n.updated_at),
    created: n.created_at || null,
    preview: (data.live ? host.previewOf(n) : n.preview || "").slice(0, 160),
  };
  if (n.deleted_at) out.deleted = iso(n.deleted_at);
  if (store) out.store = store.name;
  return out;
}

/** Ids das pastas pedidas em --folder (com as subpastas), ou null = todas. */
function folderFilter(data, path) {
  if (!path) return null;
  const names = String(path).split(/[\\/]/).map((x) => x.trim()).filter(Boolean);
  if (names.length === 1 && fold(names[0]) === "notas") return new Set([0]);
  let pid = 0;
  for (const name of names) {
    const next = data.folders.find((f) => (f.parent_id || 0) === pid && fold(f.name) === fold(name));
    if (!next) throw new CliError("not_found", `Pasta não encontrada: ${path}`);
    pid = next.id;
  }
  return descendantIds(data.folders, pid);
}

function findIn(data, wanted, { trash = false } = {}) {
  const notes = data.notes.filter((n) => trash || !n.deleted_at);
  return pick(notes, wanted, { what: "nota", name: titleIn(data), label: (n) => `${titleIn(data)(n)} [${folderIn(data, n.folder_id)}]` });
}

const sortNotes = (a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updated_at - a.updated_at);

// ---------- Conteúdo ----------

function linkTitleFor(data) {
  return (a) => {
    const id = Number(a.dataset?.note);
    const n = id ? data.notes.find((x) => x.id === id && !x.deleted_at) : null;
    return n ? titleIn(data)(n) : "";
  };
}

function formatHtml(html, format, data) {
  if (format === "html") return html;
  if (format === "text") return noteLines(html).join("\n");
  return htmlToMarkdown(html, { linkTitle: linkTitleFor(data) });
}

/** Conteúdo de uma nota em qualquer armazenamento, já no formato pedido. */
async function contentOf(store, data, note, format) {
  if (data.live) return formatHtml(await ensureContent(note), format, data);
  const res = await invoke("cli_store_read", { store: storeArg(store), op: { op: "get", id: note.id } });
  if (res === null || res === undefined) throw new CliError("not_found", "A nota não existe mais");
  if (typeof res === "string") return formatHtml(res, format, data);
  // Cofre: o arquivo é a verdade (Markdown sem o front-matter).
  if (format === "md") return splitFrontMatter(res.markdown).body ?? res.markdown;
  return formatHtml(markdownToNote(res.markdown, res.rel).html, format, data);
}

/** HTML de um trecho em Markdown (mesma conversão do import). */
function mdHtml(md) {
  return sanitizeHtml(markdownToHtml(String(md || "")));
}

/** HTML da nota em blocos: o 1º é o título. */
function blocks(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return tpl;
}

function checkFormat(format) {
  const f = format || "md";
  if (!["md", "html", "text"].includes(f)) throw new CliError("usage", "--format deve ser md, html ou text");
  return f;
}

function cleanTags(tags) {
  return list(tags).flatMap((t) => String(t).split(",")).map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
}

// ---------- Comandos ----------

async function vaults() {
  return storages().map((s) => ({ name: s.name, kind: s.kind, path: s.path, active: s.active }));
}

async function listNotes(p) {
  const stores = p.all_vaults ? storages() : [resolveStore(p.vault)];
  const limit = p.limit ?? 200;
  const out = [];
  for (const store of stores) {
    let data;
    try {
      data = await storeData(store);
    } catch (e) {
      if (!p.all_vaults) throw e;
      continue; // cofre de rede fora do ar: segue com os outros
    }
    const fids = folderFilter(data, p.folder);
    const tags = cleanTags(p.tag);
    const filters = { text: "", tags, type: "", status: "", zid: "", linksTo: [] };
    const notes = data.notes
      .filter((n) => (p.trash ? !!n.deleted_at : !n.deleted_at))
      .filter((n) => !fids || fids.has(n.folder_id || 0))
      .filter((n) => !tags.length || matchesFilters(n, filters, null))
      .sort(sortNotes);
    for (const n of notes) out.push(summary(data, n, stores.length > 1 ? store : null));
  }
  return out.slice(0, limit);
}

async function search(p) {
  const stores = p.all_vaults ? storages() : [resolveStore(p.vault)];
  const f = parseQuery(p.query);
  const limit = p.limit ?? 50;
  const out = [];
  for (const store of stores) {
    let data;
    let ids = null;
    try {
      data = await storeData(store);
      if (f.text) {
        if (data.live) {
          await host.flush(); // o banco precisa ver o que acabou de ser digitado
          ids = await searchNotes(f.text);
        } else {
          ids = new Set(await invoke("cli_store_read", { store: storeArg(store), op: { op: "search", query: f.text } }));
        }
      }
    } catch (e) {
      if (!p.all_vaults) throw e;
      continue;
    }
    const fids = folderFilter(data, p.folder);
    const index = hasFilters(f) ? new TitleIndex(data.notes, titleIn(data)) : null;
    const hits = data.notes
      .filter((n) => !n.deleted_at)
      .filter((n) => !fids || fids.has(n.folder_id || 0))
      .filter((n) => !ids || ids.has(n.id))
      .filter((n) => !index || matchesFilters(n, f, index))
      .sort(sortNotes);
    for (const n of hits) out.push(summary(data, n, stores.length > 1 ? store : null));
  }
  return out.slice(0, limit);
}

async function get(p) {
  const format = checkFormat(p.format);
  const store = resolveStore(p.vault);
  const data = await storeData(store);
  const note = findIn(data, p.note, { trash: true });
  const content = await contentOf(store, data, note, format);
  const props = note.props && !propsEmpty(note.props) ? normalizeProps(note.props) : null;
  return { ...summary(data, note), props, content };
}

async function create(p) {
  const body = String(p.body ?? "");
  const tags = cleanTags(p.tag);
  let title = String(p.title ?? "").trim();
  let md = body;
  if (!title) {
    // Sem --title: a 1ª linha do Markdown ("# Título" ou texto) é o título.
    const { body: rest } = splitFrontMatter(md);
    const first = (rest ?? md).split(/\r?\n/).find((l) => l.trim());
    if (!first) throw new CliError("usage", "Informe --title ou um --body com conteúdo");
    title = first.replace(/^#{1,6}\s+/, "").trim();
    // Linha comum vira o título (sem repetir no corpo); um "# Título" o import já reconhece.
    if (!/^#{1,6}\s/.test(first)) md = md.replace(first, "");
  }
  const store = resolveStore(p.vault);
  if (!store.active) {
    if (store.kind !== "vault") throw new CliError("usage", "Só é possível criar no armazenamento ativo ou num cofre");
    const dir = String(p.folder || "").split(/[\\/]/).map((x) => x.trim()).filter(Boolean).join("/");
    const props = tags.length ? normalizeProps({ tags }) : null;
    const created = new Date().toISOString();
    const rel = await invoke("cli_vault_create", { vault: store.path, dir, title, markdown: propsToYaml(props, { created }) + md });
    return { vault: store.name, path: rel, title };
  }
  const { html, props, created } = await host.markdownNote(md, title, p._cwd || "");
  const merged = tags.length ? normalizeProps({ ...(props || {}), tags: [...(props?.tags || []), ...tags] }) : props;
  const folderId = host.folderByPath(p.folder);
  const note = host.create(html, folderId, merged, created);
  if (p.pin) host.setPinned(note, true);
  await host.flush();
  return summary({ notes: state.notes, folders: state.folders, live: true }, note);
}

function liveNote(wanted, opts) {
  return findIn({ notes: state.notes, folders: state.folders, live: true }, wanted, opts);
}

async function update(p) {
  const note = liveNote(p.note);
  const html = await ensureContent(note);
  const tpl = blocks(html);
  const first = tpl.content.firstElementChild;
  let changed = false;
  if (p.title !== undefined) {
    const t = escapeHtml(String(p.title).trim());
    if (!t) throw new CliError("usage", "--title vazio");
    if (first && /^(H[1-6]|P|DIV)$/.test(first.tagName)) first.innerHTML = t;
    else tpl.content.prepend(blocks(`<h1>${t}</h1>`).content);
    changed = true;
  }
  if (p.body !== undefined) {
    const head = tpl.content.firstElementChild;
    while (head?.nextSibling) head.nextSibling.remove();
    tpl.content.append(blocks(mdHtml(p.body)).content);
    changed = true;
  }
  if (p.append !== undefined) {
    tpl.content.append(blocks(mdHtml(p.append)).content);
    changed = true;
  }
  if (p.tag !== undefined || p.add_tag !== undefined) {
    const base = p.tag !== undefined ? cleanTags(p.tag) : note.props?.tags || [];
    note.props = normalizeProps({ ...(note.props || {}), tags: [...base, ...cleanTags(p.add_tag)] });
    changed = true;
  }
  if (!changed) throw new CliError("usage", "Nada para alterar (use --body, --append, --title, --tag ou --add-tag)");
  note.content = tpl.innerHTML;
  host.changed(note);
  await host.flush();
  return summary({ notes: state.notes, folders: state.folders, live: true }, note);
}

async function move(p) {
  const note = liveNote(p.note);
  const folderId = host.folderByPath(p.folder);
  host.moveNote(note.id, folderId);
  await host.flush();
  return summary({ notes: state.notes, folders: state.folders, live: true }, note);
}

async function setPin(p, pinned) {
  const note = liveNote(p.note);
  host.setPinned(note, pinned);
  await host.flush();
  return { id: note.id, pinned: !!note.pinned };
}

async function remove(p) {
  requireFlag(p, "yes", "Excluir uma nota exige --yes");
  const note = liveNote(p.note, { trash: true });
  const title = host.titleOf(note);
  const permanent = !!p.permanent || !!note.deleted_at;
  if (p.permanent && !note.deleted_at) host.deleteNote(note.id); // 1º vai para a lixeira
  host.deleteNote(note.id);
  await host.flush();
  return { id: note.id, title, deleted: permanent ? "permanente" : "lixeira" };
}

async function restore(p) {
  const note = pick(state.notes.filter((n) => n.deleted_at), p.note, { what: "nota apagada", name: host.titleOf });
  host.restoreNote(note.id);
  await host.flush();
  return summary({ notes: state.notes, folders: state.folders, live: true }, note);
}

async function folders() {
  const counts = new Map();
  for (const n of state.notes) if (!n.deleted_at) counts.set(n.folder_id || 0, (counts.get(n.folder_id || 0) || 0) + 1);
  const total = (id) => [...descendantIds(state.folders, id)].reduce((s, x) => s + (counts.get(x) || 0), 0);
  return [
    { id: 0, path: "Notas", depth: 0, notes: counts.get(0) || 0, total: counts.get(0) || 0 },
    ...flattenTree(state.folders).map(({ folder, depth }) => ({
      id: folder.id,
      path: folderPath(state.folders, folder.id, "/"),
      depth: depth + 1,
      notes: counts.get(folder.id) || 0,
      total: total(folder.id),
    })),
  ];
}

async function folderCreate(p) {
  const id = host.folderByPath(p.path);
  return { id, path: folderPath(state.folders, id, "/") || "Notas" };
}

async function tags() {
  return tagCounts(state.notes);
}

async function links(p) {
  const note = liveNote(p.note);
  const index = host.getIndex();
  const data = { notes: state.notes, folders: state.folders, live: true };
  const ids = outgoingIds(note, index);
  const resolved = [...ids].map((id) => state.notes.find((n) => n.id === id)).filter(Boolean).map((n) => summary(data, n));
  const pending = (note.links || []).filter((l) => typeof l === "string" && !index.resolve(l));
  return { note: host.titleOf(note), links: resolved, pending };
}

async function backlinks(p) {
  const note = liveNote(p.note);
  const map = backlinkMap(state.notes, host.getIndex());
  const data = { notes: state.notes, folders: state.folders, live: true };
  const ids = map.get(note.id) || new Set();
  return state.notes.filter((n) => ids.has(n.id)).sort(sortNotes).map((n) => summary(data, n));
}

async function exportNote(p) {
  const note = liveNote(p.note);
  await ensureContent(note);
  const images = await host.writeNoteMarkdown(note, p.out);
  return { id: note.id, path: p.out, images };
}

async function importFiles(p) {
  const folderId = host.folderByPath(p.folder);
  const out = [];
  for (const path of list(p.file)) {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dir = path.slice(0, i);
    const stem = path.slice(i + 1).replace(/\.[^.]+$/, "");
    const { html, props, created } = await host.markdownNote(await readTextFileApi(path), stem, dir);
    const note = host.create(html, folderId, props, created);
    out.push(summary({ notes: state.notes, folders: state.folders, live: true }, note));
  }
  await host.flush();
  return out;
}

export const notesCli = {
  vaults,
  list: listNotes,
  search,
  get,
  create,
  update,
  move,
  pin: (p) => setPin(p, true),
  unpin: (p) => setPin(p, false),
  delete: remove,
  restore,
  folders,
  folder_create: folderCreate,
  tags,
  links,
  backlinks,
  export: exportNote,
  import: importFiles,
};

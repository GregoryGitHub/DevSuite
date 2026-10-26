import { notesApi } from "./api.js";
import { normalizeNote, normalizeNoteHtml, purgeExpiredTrash, noteLines, noteImageNames } from "./utils/noteContent.js";
import { noteLinks, normalizeProps, propsEmpty, propsSearchText } from "./utils/zettel.js";
import { normalizeFolderTree } from "./utils/folderTree.js";
import { state } from "./state.js";
import { noteToMarkdown, markdownToNote, vaultMeta, vaultLookupIndex, folderDir, dirOf, TRASH_DIR } from "./utils/vaultNote.js";

// Persistência das notas no notes.db (SQLite, src-tauri/src/notes_db.rs).
//
// state.notes guarda só metadados vindos de `notes_list` ({ id, title, preview, datas,
// pinned, folder_id, deleted_at }); `content` fica undefined até a nota ser aberta
// (ensureContent). Flags locais: `dirty` = HTML editado e ainda não gravado;
// `saved` = a nota existe no banco. Gravações passam por uma fila, em ordem.
//
// Modo cofre (settings.notes_storage = "vault", src-tauri/src/notes_vault.rs): os mesmos
// comandos, mas o conteúdo é um arquivo .md. Aqui o HTML vira Markdown ao gravar e o Markdown
// vira HTML ao abrir (utils/vaultNote.js). Campos locais extras: `rel` (caminho no cofre),
// `disk_mtime` (versão do arquivo que o app conhece: detecta edição de outra pessoa) e
// `vaultKey` (pasta + título + Markdown já gravados: abrir uma nota e só resolver links não
// regrava o arquivo).

let chain = Promise.resolve();

export const isVault = () => state.settings.notes_storage === "vault";

// Dados que só notes.js conhece: título atual de um link e aviso de conflito.
let vaultCtx = { linkTitle: () => "", onConflict: () => {} };
let vaultFiles = null; // Promise<string[]>: anexos do cofre (resolver imagens), refeito no refresh

/** notes.js registra { linkTitle(a), onConflict(note, fileName) }. */
export function setVaultContext(ctx) {
  vaultCtx = { ...vaultCtx, ...ctx };
}

/** Enfileira uma operação no banco; erros vão para onError (a fila continua). */
function enqueue(op, onError) {
  const run = chain.then(op);
  // Gravou no cofre: o painel Git (noteGit.js) atualiza o status.
  if (isVault() && onError) run.then(() => document.dispatchEvent(new CustomEvent("notesvaultwrite")), () => {});
  chain = run.catch((e) => {
    console.error("notes.db:", e);
    onError?.(String(e));
  });
  return run;
}

/**
 * Campos derivados do HTML que o banco guarda: título, prévia, texto da busca, imagens e
 * links [[ ]]; mais as propriedades do modo Zettelkasten (tags/apelidos também entram na busca).
 */
export function noteRecord(note) {
  const lines = noteLines(note.content);
  const props = propsEmpty(note.props) ? null : normalizeProps(note.props);
  const extra = propsSearchText(props);
  const record = {
    id: note.id,
    title: lines[0] || "",
    preview: lines.slice(1).join(" "),
    created_at: note.created_at,
    updated_at: note.updated_at,
    pinned: !!note.pinned,
    folder_id: note.folder_id ?? 0,
    deleted_at: note.deleted_at ?? null,
    content: note.content,
    plain: extra ? `${lines.join("\n")}\n${extra}` : lines.join("\n"),
    images: noteImageNames(note.content),
    props,
    links: noteLinks(note.content),
  };
  if (isVault()) {
    // Diretório da nota: o da pasta (ou o atual, na lixeira) — define os caminhos das imagens.
    const trashDir = note.rel?.startsWith(`${TRASH_DIR}/`) ? dirOf(note.rel) : TRASH_DIR;
    const dir = note.deleted_at ? trashDir : folderDir(state.folders, record.folder_id);
    record.markdown = noteToMarkdown(note.content, { title: record.title, props, created: note.created_at, dir, linkTitle: vaultCtx.linkTitle });
    record.disk_mtime = note.disk_mtime ?? null;
  }
  return record;
}

function metaOf(note) {
  return {
    id: note.id,
    pinned: !!note.pinned,
    folder_id: note.folder_id ?? 0,
    deleted_at: note.deleted_at ?? null,
    updated_at: note.updated_at,
  };
}

/**
 * Importa o notes.json/folders.json antigos na primeira execução (normalizados como antes:
 * notas em texto puro viram HTML, URLs de imagem do outro SO, lixeira vencida).
 * Devolve uma mensagem de erro ou null.
 */
async function migrateLegacy() {
  let legacy;
  try {
    legacy = await notesApi.legacy();
  } catch (e) {
    return String(e);
  }
  if (!legacy || !Array.isArray(legacy.notes)) return null;
  const notes = purgeExpiredTrash(legacy.notes.map(normalizeNote));
  await notesApi.import(notes.map(noteRecord), legacy.folders || []);
  return null;
}

/** Carrega pastas e metadados das notas. { notes, folders, error } */
export async function loadNoteStore() {
  const error = await migrateLegacy().catch((e) => String(e));
  vaultFiles = null;
  const [metas, folders] = await Promise.all([notesApi.list(), notesApi.folders()]);
  const notes = (Array.isArray(metas) ? metas : []).map((m) => ({
    ...(isVault() ? vaultMeta(m) : m),
    props: m.props && typeof m.props === "object" ? m.props : null,
    links: Array.isArray(m.links) ? m.links : [],
    content: undefined,
    dirty: false,
    saved: true,
  }));
  const list = (Array.isArray(folders) ? folders : []).map((f) => ({ id: f.id, name: f.name, parent_id: f.parent_id || 0 }));
  return { notes, folders: normalizeFolderTree(list), error };
}

function vaultIndexFor(notes) {
  vaultFiles ||= notesApi.vaultFiles().catch(() => []);
  return vaultFiles.then((files) => vaultLookupIndex(Array.isArray(files) ? files : [], notes.map((n) => n.rel).filter(Boolean)));
}

/** Nota do cofre lida do disco: HTML + propriedades + versão do arquivo. */
async function applyVaultContent(note, res, notes) {
  const { html, props, created } = markdownToNote(res.markdown, res.rel, await vaultIndexFor(notes));
  if (note.content !== undefined) return;
  note.content = html;
  note.props = props;
  if (created !== null) note.created_at = new Date(created).toISOString();
  note.rel = res.rel;
  note.disk_mtime = res.mtime;
  note.vaultKey = vaultKey(noteRecord(note));
}

const vaultKey = (r) => JSON.stringify([r.folder_id, r.title, r.markdown]);

/**
 * Cofre: relê o que mudou no disco (outras pessoas/apps). Devolve
 * { changed: [meta], removed: [id], folders: [Folder] | null } já no formato do state.
 */
export async function refreshVault() {
  if (!isVault()) return { changed: [], removed: [], folders: null };
  const diff = await enqueue(() => notesApi.vaultRefresh());
  vaultFiles = null;
  return {
    changed: (diff?.changed || []).map((m) => ({ ...vaultMeta(m), links: Array.isArray(m.links) ? m.links : [] })),
    removed: diff?.removed || [],
    folders: diff?.folders ? normalizeFolderTree(diff.folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parent_id || 0 }))) : null,
  };
}

/** HTML da nota, buscado no banco na primeira vez que ela é aberta. */
export async function ensureContent(note) {
  if (note.content === undefined) {
    const html = await notesApi.get(note.id);
    if (html && typeof html === "object" && typeof html.markdown === "string") {
      await applyVaultContent(note, html, state.notes);
      return note.content;
    }
    // Pode ter sido editada enquanto a busca acontecia: o que está na memória vale mais.
    if (note.content === undefined) note.content = normalizeNoteHtml(typeof html === "string" ? html : "");
  }
  return note.content;
}

/** Grava o HTML (e metadados) das notas editadas. */
export function saveNoteContent(notes, onError) {
  for (const note of notes) {
    if (!note.dirty || note.content === undefined) continue;
    note.dirty = false;
    const record = noteRecord(note);
    // Cofre: nada mudou no arquivo (ex.: só links resolvidos ao abrir) = não regrava.
    const key = record.markdown !== undefined ? vaultKey(record) : null;
    if (key !== null && note.saved && note.vaultKey === key) continue;
    enqueue(() => notesApi.save(record), onError).then(
      (res) => {
        note.saved = true;
        if (!res || record.markdown === undefined) return;
        if (res.conflict) return vaultCtx.onConflict(note, res.conflict);
        note.disk_mtime = res.disk_mtime ?? note.disk_mtime;
        note.rel = res.rel ?? note.rel;
        note.vaultKey = key;
      },
      () => (note.dirty = true), // tenta de novo na próxima gravação
    );
  }
}

/** Grava fixada/pasta/lixeira/data. Nota editada vai inteira; nota nunca gravada (vazia) é ignorada. */
export function saveNoteMeta(notes, onError) {
  const metas = [];
  for (const note of notes) {
    if (note.dirty && note.content !== undefined) saveNoteContent([note], onError);
    else if (note.saved) metas.push(metaOf(note));
  }
  if (metas.length) enqueue(() => notesApi.setMeta(metas), onError).catch(() => {});
}

/** Apaga de vez (só as que existem no banco). */
export function deleteNotes(notes, onError) {
  const ids = notes.filter((n) => n.saved).map((n) => n.id);
  for (const n of notes) n.dirty = false;
  if (ids.length) enqueue(() => notesApi.delete(ids), onError).catch(() => {});
}

/** Grava notas novas em lotes (uma transação por lote): importação de uma pasta. */
export function saveNotesBulk(notes, onError, batch = 200) {
  const runs = [];
  for (let i = 0; i < notes.length; i += batch) {
    const chunk = notes.slice(i, i + batch);
    for (const n of chunk) n.dirty = false;
    const records = chunk.map(noteRecord);
    runs.push(
      enqueue(() => notesApi.saveMany(records), onError).then(
        () => chunk.forEach((n) => (n.saved = true)),
        () => chunk.forEach((n) => (n.dirty = true)), // tenta de novo na próxima gravação
      ),
    );
  }
  return Promise.all(runs);
}

export function saveFolders(folders, onError) {
  const copy = folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parent_id || 0 }));
  enqueue(() => notesApi.saveFolders(copy), onError).catch(() => {});
}

/** Ids das notas que contêm o texto (busca no banco; espera as gravações pendentes). */
export function searchNotes(query) {
  return enqueue(() => notesApi.search(query)).then((ids) => new Set(Array.isArray(ids) ? ids : []));
}

export function collectImageGarbage() {
  enqueue(() => notesApi.gcImages()).catch(() => {});
}

/** Promessa resolvida quando todas as gravações enfileiradas terminarem. */
export function whenSaved() {
  return chain;
}

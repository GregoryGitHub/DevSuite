import { state } from "../state.js";
import {
  hasTauri, notesApi, mdApi, openFileDialogApi, openDirectoryDialogApi, saveFileDialogApi, readTextFileApi, writeFileApi, exportNoteImagesApi, saveSettingsApi,
} from "../api.js";
import { updateSettingsUI } from "./settings.js";
import { registerApp } from "../appLifecycle.js";
import {
  loadNoteStore,
  ensureContent,
  saveNoteContent,
  saveNoteMeta,
  saveNotesBulk,
  deleteNotes,
  saveFolders as saveFoldersStore,
  searchNotes,
  collectImageGarbage,
  whenSaved,
  isVault,
  setVaultContext,
  refreshVault,
} from "../noteStore.js";
import { ATTACHMENTS_DIR, addVaultPath, knownVaults, sameVaultPath, vaultName, vaultLabels } from "../utils/vaultNote.js";
import {
  descendantIds, folderPath, flattenTree, canMoveFolder, uniqueFolderName, ensureFolderPath, removeFolderTree,
  placeFolder, insertFolderSorted, sortFolderChildren,
} from "../utils/folderTree.js";
import { relDirs, relStem, vaultIndex, vaultImageLookup, normalizeVaultLinks, applyFileTitle } from "../utils/mdImport.js";
import { formatNoteListDate, formatNoteFullDate, noteGroupLabel } from "../utils/date.js";
import { noteTitle, notePreview, noteIsEmpty, noteMatches, sanitizeHtml, escapeHtml, localImageName } from "../utils/noteContent.js";
import { htmlToMarkdown, markdownToHtml } from "../utils/markdown.js";
import {
  TitleIndex, noteLinks, normalizeProps, propsEmpty, propsToYaml, parseFrontMatter, splitFrontMatter, newZid,
  parseQuery, hasFilters, matchesFilters, backlinkMap, buildGraph, tagCounts, fold, dateOnly,
} from "../utils/zettel.js";
import { setLinkProvider } from "./noteLinks.js";
import { createPropsPanel } from "./noteProps.js";
import { createLinksPanel } from "./noteLinksPanel.js";
import { resolveMarkdownImages } from "../utils/noteImages.js";
import { exportNotePdf } from "./notePdf.js";
import { initEditor, loadEditor, runCommand, getSelectionState, focusEditorEnd } from "./noteEditor.js";
import { enterDesktopMode, exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";
import { openFind, closeFind, isFindOpen } from "./noteFind.js";

// "Quick Notes" modeled on macOS Notes: folders, grouped list, and a rich editor.
// The same DOM is used in tray mode (stacked navigation) and desktop mode (3 columns).

const ui = state.notesUI;
const DEFAULT_FOLDER = { id: 0, name: "Notas" };

const appEl = document.getElementById("notes-app");
const foldersEl = document.getElementById("nt-folders");
const listEl = document.getElementById("nt-list");
const listTitleEl = document.getElementById("nt-list-title");
const countEl = document.getElementById("nt-count");
const tbFolderEl = document.getElementById("nt-tb-folder");
const tbCountEl = document.getElementById("nt-tb-count");
const backLabelEl = document.getElementById("nt-back-label");
const searchInputs = [document.getElementById("nt-search-desktop"), document.getElementById("nt-search-compact")];
const editorScrollEl = document.getElementById("nt-editor-scroll");
const editorDateEl = document.getElementById("nt-editor-date");
const editorEmptyEl = document.getElementById("nt-editor-empty");
const trashBannerEl = document.getElementById("nt-trash-banner");
const popoverEl = document.getElementById("nt-format-popover");
const menuEl = document.getElementById("nt-menu");
const toastEl = document.getElementById("nt-toast");
const graphEl = document.getElementById("nt-graph");

let saveTimer = null;
let listRenderQueued = false;
let toastTimer = null;
let editorLoadSeq = 0; // ignora conteúdo que chegou do banco depois de trocar de nota
let searchHits = null; // ids do banco para ui.query (null = busca em andamento)
let searchSeq = 0;
let searchTimer = null;
let titleIndex = null; // TitleIndex (títulos/apelidos -> nota), refeito sob demanda
let lastTitle = null; // título da nota em edição (o índice só é refeito se ele mudar)
let propsPanel = null;
let linksPanel = null;
let linksPanelQueued = false;
let graph = null; // noteGraph.js, carregado só quando o grafo é aberto
let graphLoading = null;
let graphReturnScope = "all"; // escopo de onde se abriu o grafo
let graphShowLocal = null; // modo pedido na próxima abertura (null = o último usado)
let draggedFolderId = null; // pasta sendo arrastada na barra lateral
const navBack = []; // Alt+← / Alt+→ entre notas abertas por link
const navForward = [];

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }];

// ---------- Data helpers ----------

function allFolders() {
  return [DEFAULT_FOLDER, ...state.folders];
}

function folderName(id) {
  return allFolders().find((f) => f.id === id)?.name ?? DEFAULT_FOLDER.name;
}

/** Caminho da pasta ("Projetos / Rust") para rótulos fora da barra lateral. */
function folderLabel(id) {
  return (id && folderPath(state.folders, id)) || DEFAULT_FOLDER.name;
}

/** Pasta "Notas" + árvore das pastas (todas abertas), para menus e o grafo. */
function folderTreeEntries() {
  return [{ folder: DEFAULT_FOLDER, depth: 0 }, ...flattenTree(state.folders)];
}

function scopeFolderId() {
  return ui.scope.startsWith("f:") ? Number(ui.scope.slice(2)) : null;
}

/** Pasta aberta e as subpastas dela (a lista mostra as notas de todas). null = todas. */
function scopeFolderIds() {
  const fid = scopeFolderId();
  if (fid === null) return null;
  return fid === 0 ? new Set([0]) : descendantIds(state.folders, fid);
}

/** Pasta real aberta (para criar subpasta/importar dentro dela); 0 = nível superior. */
function scopeParentFolder() {
  const fid = scopeFolderId();
  return fid && state.folders.some((f) => f.id === fid) ? fid : 0;
}

// Subpastas recolhidas na barra lateral (conveniência local).
const COLLAPSED_KEY = "nt-collapsed-folders";
const collapsedFolders = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    } catch {
      return [];
    }
  })(),
);

function setFolderCollapsed(id, collapsed) {
  if (collapsed) collapsedFolders.add(id);
  else collapsedFolders.delete(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedFolders]));
  } catch {}
}

/** Abre as pastas acima de `id` (para ela aparecer na barra lateral). */
function revealFolder(id) {
  const f = state.folders.find((x) => x.id === id);
  for (let p = f?.parent_id; p; p = state.folders.find((x) => x.id === p)?.parent_id) setFolderCollapsed(p, false);
}

function scopeLabel() {
  if (ui.query.trim()) return "Resultados";
  if (ui.scope === "all") return "Todas as Notas";
  if (ui.scope === "trash") return "Apagadas Recentemente";
  return folderName(scopeFolderId());
}

function findNote(id) {
  return state.notes.find((n) => n.id === id) || null;
}

function selectedNote() {
  return findNote(ui.selectedId);
}

function pluralNotes(n) {
  return `${n} ${n === 1 ? "nota" : "notas"}`;
}

// Notes come from notes.db without their HTML (content === undefined until opened):
// the list uses the stored title/preview, or derives them live from loaded content.
const titleOf = (n) => (n.content !== undefined ? noteTitle(n) : n.title || "Nova Nota");
const previewOf = (n) => (n.content !== undefined ? notePreview(n) : n.preview || "Nenhum texto adicional");
const isEmptyNote = (n) => n.content !== undefined && noteIsEmpty(n);

// ---------- Zettelkasten: links [[ ]], propriedades, grafo ----------

const zk = () => !!state.settings.zettelkasten;

function getIndex() {
  return (titleIndex ||= new TitleIndex(state.notes, titleOf));
}

/** Títulos/apelidos/lixeira mudaram: índice, painel de links e grafo são refeitos. */
function notesChanged() {
  titleIndex = null;
  queueLinksPanel();
  if (graph?.visible) graph.refresh();
}

function takenZids() {
  return new Set(state.notes.map((n) => n.props?.zid).filter(Boolean));
}

/** Nota sem id zettel ganha um (pela data de criação) quando é editada no modo Zettelkasten. */
function ensureZid(note) {
  if (!zk() || note.deleted_at || note.props?.zid) return false;
  const created = new Date(note.created_at || note.id);
  note.props = { ...normalizeProps(note.props), zid: newZid(Number.isNaN(created.getTime()) ? new Date() : created, takenZids()) };
  return true;
}

/** Filtros da busca (tag:, #tag, type:, status:, id:, [[Nota]]) só valem no modo Zettelkasten. */
function queryFilters() {
  const q = ui.query.trim();
  return zk() ? parseQuery(q) : { text: q, tags: [], type: "", status: "", zid: "", linksTo: [] };
}

function linkedTitle(id) {
  const n = findNote(id);
  return n && !n.deleted_at ? titleOf(n) : null;
}

function noteInfo(n) {
  return { id: n.id, title: titleOf(n), folder: folderLabel(n.folder_id), preview: previewOf(n).slice(0, 120) };
}

/** Rodapé "Mencionada em" / "Links" da nota aberta (dos metadados em memória). */
function renderLinksPanel() {
  linksPanelQueued = false;
  const note = selectedNote();
  if (!linksPanel) return;
  if (!note || note.content === undefined) return linksPanel.hide();
  const index = getIndex();
  const outgoing = [];
  const seen = new Set();
  for (const l of note.links || []) {
    const target = typeof l === "number" ? findNote(l) : index.resolve(l);
    if (target && !target.deleted_at && target.id !== note.id) {
      if (!seen.has(target.id)) seen.add(target.id), outgoing.push(noteInfo(target));
    } else if (typeof l === "string") outgoing.push({ title: l, missing: true });
  }
  const back = [...(backlinkMap(state.notes, index).get(note.id) || [])].map((id) => noteInfo(findNote(id)));
  linksPanel.render({ outgoing, backlinks: back });
}

function queueLinksPanel() {
  if (linksPanelQueued) return;
  linksPanelQueued = true;
  requestAnimationFrame(renderLinksPanel);
}

function renderPropsPanel() {
  const note = selectedNote();
  if (!propsPanel) return;
  if (!zk() || !note || note.content === undefined) return propsPanel.hide();
  propsPanel.render(note, !!note.deleted_at);
}

function handlePropsChange(note) {
  if (ensureZid(note)) renderPropsPanel();
  note.dirty = true;
  note.updated_at = Date.now();
  renderEditorDate(note);
  saveNotesSoon();
  notesChanged();
  queueListRender();
}

/** Cria uma nota com esse título (link [[ ]] para nota nova) sem sair da atual. */
function createLinkedNote(title) {
  const folderId = selectedNote()?.folder_id ?? scopeFolderId() ?? 0;
  const id = makeNote(`<h1>${escapeHtml(title.trim() || "Nova Nota")}</h1>`, folderId);
  flushNotesSave();
  notesChanged();
  renderNotes();
  return id;
}

function currentLocation() {
  return { scope: ui.scope, query: ui.query, id: ui.selectedId };
}

function setQuery(query) {
  ui.query = query;
  searchInputs.forEach((i) => (i.value = query));
  if (!query.trim()) searchHits = null;
}

/** Abre a nota; se ela não aparece na lista atual, vai para a pasta dela. */
function revealNote(id) {
  const note = findNote(id);
  if (!note) return;
  if (ui.scope === "graph") ui.scope = graphReturnScope;
  if (!visibleNotes().some((n) => n.id === id)) {
    setQuery("");
    ui.scope = note.deleted_at ? "trash" : `f:${note.folder_id}`;
    revealFolder(note.folder_id);
  }
  selectNote(id);
}

/** Navegação por link (com histórico para Alt+← / Alt+→). */
function openLinkedNote(id) {
  if (!findNote(id) || (id === ui.selectedId && ui.scope !== "graph")) return;
  navBack.push(currentLocation());
  if (navBack.length > 60) navBack.shift();
  navForward.length = 0;
  revealNote(id);
}

function restoreLocation(loc) {
  if (loc.scope === "graph") {
    if (loc.id !== null && findNote(loc.id)) selectNote(loc.id, { openEditor: false });
    return openGraph();
  }
  ui.scope = loc.scope;
  setQuery(loc.query || "");
  if (ui.query.trim()) runSearch();
  if (loc.id !== null && findNote(loc.id)) selectNote(loc.id);
  else renderNotes();
}

function navigate(delta) {
  const from = delta < 0 ? navBack : navForward;
  const to = delta < 0 ? navForward : navBack;
  const loc = from.pop();
  if (!loc) return false;
  to.push(currentLocation());
  restoreLocation(loc);
  return true;
}

function openTagSearch(tag) {
  if (ui.scope === "graph") ui.scope = graphReturnScope;
  if (ui.scope === "trash") ui.scope = "all";
  setQuery(`tag:${tag}`);
  if (!state.desktopMode) ui.pane = "list";
  runSearch();
}

function ensureGraph() {
  if (graph) return Promise.resolve(graph);
  graphLoading ||= import("./noteGraph.js").then(({ createGraph }) => {
    graph = createGraph(graphEl, {
      data: (o) =>
        buildGraph(state.notes, {
          ...o,
          // A pasta escolhida inclui as subpastas.
          folderId: o.folderId ? descendantIds(state.folders, o.folderId) : o.folderId,
          titleOf,
          index: getIndex(),
        }),
      folders: () => folderTreeEntries().map(({ folder: f }) => ({ id: f.id, name: f.id ? folderPath(state.folders, f.id) : f.name })),
      currentId: () => ui.selectedId,
      open: openLinkedNote,
      openTag: openTagSearch,
      create: (title) => openLinkedNote(createLinkedNote(title)),
      back: () => {
        ui.scope = graphReturnScope;
        ui.pane = "folders";
        renderNotes();
      },
    });
    return graph;
  });
  return graphLoading;
}

/** Grafo (modo Zettelkasten); `local` = centrado na nota aberta. */
function openGraph({ local = null } = {}) {
  if (!zk()) return;
  if (ui.scope !== "graph") {
    graphReturnScope = ui.scope;
    discardIfEmpty(ui.selectedId);
    flushNotesSave();
  }
  closePopover();
  closeMenu();
  ui.scope = "graph";
  graphShowLocal = local;
  if (graph?.visible && local !== null) graph.show({ local });
  renderNotes(); // syncGraph() mostra o grafo
}

/** Mostra/esconde o grafo conforme o escopo e a aba ativa (sem recriar). */
function syncGraph() {
  const want = ui.scope === "graph" && zk() && state.activeMainView === "notes";
  if (want && !graph?.visible) {
    ensureGraph()
      .then((g) => {
        if (ui.scope !== "graph" || g.visible || state.activeMainView !== "notes") return;
        g.show({ local: graphShowLocal });
        graphShowLocal = null;
      })
      .catch((e) => toast(`Falha ao abrir o grafo: ${e}`));
  } else if (!want && graph?.visible) graph.hide();
}

function storeError(message) {
  toast(`Falha ao salvar as notas: ${message}`);
}

/** Search runs in the database; notes edited and not saved yet are matched locally. */
function matchesQuery(n, q) {
  if (n.dirty && n.content !== undefined) return noteMatches(n, q);
  return !!searchHits?.has(n.id);
}

function visibleNotes() {
  const q = ui.query.trim();
  const inTrash = ui.scope === "trash";
  const fids = scopeFolderIds();
  let list = state.notes.filter((n) => {
    if (inTrash) return !!n.deleted_at;
    if (n.deleted_at) return false;
    return q || fids === null || fids.has(n.folder_id);
  });
  if (q) {
    const f = queryFilters();
    const index = hasFilters(f) ? getIndex() : null;
    list = list.filter((n) => (!index || matchesFilters(n, f, index)) && (!f.text || matchesQuery(n, f.text)));
  }
  return list.sort((a, b) => {
    if (inTrash) return b.deleted_at - a.deleted_at;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updated_at - a.updated_at;
  });
}

function runSearch() {
  clearTimeout(searchTimer);
  const q = queryFilters().text;
  if (!q) {
    searchHits = null; // vazia ou só filtros (tag:, type:...): resolvida na memória
    return renderNotes();
  }
  const seq = ++searchSeq;
  searchTimer = setTimeout(() => {
    flushNotesSave(); // the database must see what was just typed
    searchNotes(q)
      .then((ids) => {
        if (seq !== searchSeq) return;
        searchHits = ids;
        renderNotes();
      })
      .catch((e) => toast(`Falha na busca: ${e}`));
  }, 120);
}

function saveNotesSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushNotesSave, 400);
}

/** Saves the edited notes (only the changed ones, one by one). Empty notes are not stored. */
function flushNotesSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveNoteContent(state.notes.filter((n) => n.dirty && (n.deleted_at || !isEmptyNote(n))), storeError);
}

function saveFolders() {
  saveFoldersStore(state.folders, storeError);
}

/** Like macOS Notes: a note left without any content is discarded. */
function discardIfEmpty(id) {
  const note = findNote(id);
  if (note && !note.deleted_at && isEmptyNote(note)) {
    state.notes = state.notes.filter((n) => n.id !== id);
    deleteNotes([note], storeError);
  }
}

// ---------- Actions ----------

function selectNote(id, { focus = false, openEditor = true } = {}) {
  if (ui.selectedId !== id && ui.selectedId !== null) {
    discardIfEmpty(ui.selectedId);
    flushNotesSave();
  }
  ui.selectedId = id;
  if (openEditor && !state.desktopMode && id !== null) ui.pane = "editor";
  renderNotes();
  loadSelectedIntoEditor({ focus });
}

function setScope(scope) {
  ui.scope = scope;
  ui.query = "";
  searchInputs.forEach((i) => (i.value = ""));
  if (!state.desktopMode) ui.pane = "list";
  const first = visibleNotes()[0];
  const keep = visibleNotes().some((n) => n.id === ui.selectedId);
  if (state.desktopMode && !keep) selectNote(first?.id ?? null, { openEditor: false });
  else renderNotes();
}

/**
 * A new note object (not added to state). `time` = update date, `created` = creation date
 * (defaults to `time`); `ids`/`zids` are the taken ids, passed by bulk imports (defaults
 * look at state.notes).
 */
function newNoteObject(content, folderId, props = null, { time = Date.now(), created = null, ids = null, zids = null } = {}) {
  let id = Date.now();
  while (ids ? ids.has(id) : findNote(id)) id++;
  ids?.add(id);
  const createdAt = created ?? time;
  let zid = props?.zid;
  if (zk() && !zid) {
    const taken = zids || takenZids();
    zid = newZid(new Date(createdAt), taken);
    taken.add(zid);
  }
  return {
    id,
    title: "",
    content,
    created_at: new Date(createdAt).toISOString(),
    updated_at: time,
    pinned: false,
    folder_id: folderId,
    deleted_at: null,
    props: zk() ? { ...normalizeProps(props), zid } : props,
    links: noteLinks(content),
    dirty: true, // saved once it has content (flushNotesSave skips empty notes)
    saved: false,
  };
}

/** Creates a note in `folderId` (not selected) and returns its id. */
function makeNote(content, folderId, props = null, created = null) {
  const note = newNoteObject(content, folderId, props, { created });
  state.notes.unshift(note);
  titleIndex = null;
  return note.id;
}

/** Adds a note to the current folder and returns its id. */
function addNote(content, props = null, created = null) {
  if (ui.scope === "trash" || ui.scope === "graph") ui.scope = "all";
  setQuery("");
  return makeNote(content, scopeFolderId() ?? 0, props, created);
}

function createNote() {
  selectNote(addNote("<h1><br></h1>"), { focus: true });
}

// ---------- Markdown import / export ----------

function toast(message) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

function splitPath(path) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = path.slice(i + 1);
  return { dir: path.slice(0, i), sep: path[i] || "/", stem: file.replace(/\.[^.]+$/, "") || file };
}

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Nota";
}

/**
 * Markdown -> { html, props, created } of a note. The file name (`stem`) is the title: a first
 * heading with the same text becomes the title line, otherwise the name goes above the
 * content. `created` = creation date from the front-matter (ms) or null. `dir` = the file's
 * folder (relative images); `lookup` resolves images first (folder import).
 */
async function markdownNote(md, stem, dir, lookup = null) {
  // Relative image paths only make sense next to the file, so resolve them before sanitizing.
  const html = applyFileTitle(sanitizeHtml(await resolveMarkdownImages(markdownToHtml(md), dir, lookup)), stem);
  const { yaml } = splitFrontMatter(md);
  const { props, created } = yaml ? parseFrontMatter(yaml) : { props: normalizeProps(null), created: null };
  return { html, props: propsEmpty(props) ? null : props, created };
}

/** Edits a .md file in place, in its own window (md_files.rs), without importing it. */
async function openMarkdownFile() {
  if (!hasTauri) return toast("Disponível apenas no aplicativo desktop.");
  const path = await openFileDialogApi({ title: "Abrir arquivo Markdown", filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
  if (path) mdApi.open(path).catch((e) => toast(String(e)));
}

async function importMarkdown() {
  if (!hasTauri) return toast("Disponível apenas no aplicativo desktop.");
  const paths = await openFileDialogApi({ title: "Importar Markdown", filters: MD_FILTERS, multiple: true });
  if (!paths.length) return;
  let lastId = null;
  let failed = 0;
  for (const path of paths) {
    try {
      const { dir, stem } = splitPath(path);
      const { html, props, created } = await markdownNote(await readTextFileApi(path), stem, dir);
      lastId = addNote(html, props, created);
    } catch (e) {
      console.error("markdown import failed", path, e);
      failed++;
    }
  }
  if (lastId !== null) {
    flushNotesSave();
    notesChanged();
    selectNote(lastId);
  }
  const ok = paths.length - failed;
  toast(failed ? `${ok} importada(s), ${failed} com erro.` : ok === 1 ? "Nota importada." : `${ok} notas importadas.`);
}

let importingFolder = false;

/**
 * Imports a whole folder of Markdown (an Obsidian vault, a docs repo...) into a new folder
 * named after it, under `parentId`; subfolders with notes become subfolders. Notes keep the
 * file's date, images are copied and [[links]] by path/heading are mapped to note titles.
 */
async function importMarkdownFolder(parentId = scopeParentFolder()) {
  if (!hasTauri) return toast("Disponível apenas no aplicativo desktop.");
  if (importingFolder) return toast("Uma importação já está em andamento.");
  const dir = await openDirectoryDialogApi({ title: "Importar pasta de Markdown" });
  if (!dir) return;
  importingFolder = true;
  try {
    toast("Lendo a pasta…");
    let scan;
    try {
      scan = await notesApi.scanDir(dir);
    } catch (e) {
      return toast(`Falha ao ler a pasta: ${e}`);
    }
    if (!scan.notes.length) return toast("Nenhum arquivo Markdown encontrado nessa pasta.");

    const folderIds = new Set(state.folders.map((f) => f.id));
    const makeFolder = (name, parent) => {
      let id = Date.now();
      while (folderIds.has(id)) id++;
      folderIds.add(id);
      const folder = { id, name: name.slice(0, 60), parent_id: parent };
      insertFolderSorted(state.folders, folder);
      return folder;
    };
    const rootId = makeFolder(uniqueFolderName(state.folders, parentId, scan.name || "Importadas"), parentId).id;
    const index = vaultIndex(scan);
    const ids = new Set(state.notes.map((n) => n.id));
    const zids = takenZids();
    const sep = dir.includes("\\") ? "\\" : "/";
    const imported = [];
    let failed = scan.skipped.length;
    for (const [i, file] of scan.notes.entries()) {
      if (i % 20 === 0) toast(`Importando ${i + 1} de ${scan.notes.length}…`);
      try {
        const fileDir = [dir, ...relDirs(file.rel)].join(sep);
        const md = normalizeVaultLinks(file.text, index);
        const { html, props, created } = await markdownNote(md, relStem(file.rel), fileDir, vaultImageLookup(index, file.rel));
        const folderId = ensureFolderPath(state.folders, rootId, relDirs(file.rel), makeFolder);
        const time = file.modified || Date.now();
        imported.push(newNoteObject(html, folderId, props, { time: Math.max(time, created ?? 0), created, ids, zids }));
      } catch (e) {
        console.error("markdown import failed", file.rel, e);
        failed++;
      }
    }

    state.notes.unshift(...imported);
    saveFolders();
    await saveNotesBulk(imported, storeError);
    revealFolder(rootId);
    setFolderCollapsed(rootId, false);
    setQuery("");
    ui.scope = `f:${rootId}`;
    if (!state.desktopMode) ui.pane = "list";
    titleIndex = null;
    notesChanged();
    const first = visibleNotes()[0];
    if (state.desktopMode && first) selectNote(first.id, { openEditor: false });
    else renderNotes();
    const folders = new Set(imported.map((n) => n.folder_id)).size;
    const ok = `${imported.length} nota(s) importada(s) em ${folders} pasta(s)`;
    toast(failed ? `${ok}; ${failed} arquivo(s) com erro.` : `${ok}.`);
  } finally {
    importingFolder = false;
  }
}

async function exportMarkdown(id) {
  const note = findNote(id);
  if (!note) return;
  if (!hasTauri) return toast("Disponível apenas no aplicativo desktop.");
  try {
    await ensureContent(note);
  } catch (e) {
    return toast(`Falha ao ler a nota: ${e}`);
  }
  const path = await saveFileDialogApi({
    title: "Exportar como Markdown",
    defaultPath: `${safeFileName(titleOf(note))}.md`,
    filters: MD_FILTERS.slice(0, 1),
  });
  if (!path) return;

  // Stored images are copied to "<name>.assets/" next to the .md file.
  const { dir, sep, stem } = splitPath(path);
  const assets = `${stem}.assets`;
  const names = new Set();
  const md =
    propsToYaml(note.props, { created: note.created_at }) +
    htmlToMarkdown(note.content, {
      imageSrc: (src) => {
        const name = localImageName(src);
        if (!name) return src;
        names.add(name);
        return `${assets}/${name}`;
      },
      linkTitle: (a) => (a.dataset.note ? linkedTitle(Number(a.dataset.note)) : null) || "",
    });
  try {
    if (names.size) await exportNoteImagesApi([...names], `${dir}${sep}${assets}`);
    await writeFileApi(path, { text: md });
    toast(names.size ? `Exportada com ${names.size} imagem(ns).` : "Nota exportada.");
  } catch (e) {
    console.error("markdown export failed", e);
    toast(`Falha ao exportar: ${e}`);
  }
}

async function exportPdf(id) {
  const note = findNote(id);
  if (!note) return;
  if (!hasTauri) return toast("Disponível apenas no aplicativo desktop.");
  try {
    await ensureContent(note);
  } catch (e) {
    return toast(`Falha ao ler a nota: ${e}`);
  }
  const title = titleOf(note);
  const path = await saveFileDialogApi({
    title: "Exportar como PDF",
    defaultPath: `${safeFileName(title)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!path) return;
  try {
    await exportNotePdf(note.content || "", path, title);
    toast("PDF exportado.");
  } catch (e) {
    console.error("pdf export failed", e);
    toast(`Falha ao exportar: ${e?.message || e}`);
  }
}

// ---------- Cofre (pasta de Markdown) ----------

let vaultSyncing = null;
let vaultTimer = null;
const VAULT_POLL_MS = 30_000;

/**
 * Traz o que mudou no cofre (outras pessoas na pasta compartilhada, Obsidian, git...).
 * Nota com edição pendente fica como está (gravar vai cair no fluxo de conflito); as outras
 * recarregam do disco, inclusive a aberta.
 */
function syncVault({ announce = false } = {}) {
  if (!isVault() || !hasTauri) return Promise.resolve();
  if (vaultSyncing) return vaultSyncing;
  flushNotesSave();
  vaultSyncing = refreshVault()
    .then((diff) => applyVaultDiff(diff, announce))
    .catch((e) => {
      // Rede fora: a verificação periódica não insiste com avisos.
      if (announce) toast(`Falha ao ler o cofre: ${e}`);
      else console.warn("vault refresh failed", e);
    })
    .finally(() => (vaultSyncing = null));
  return vaultSyncing;
}

function applyVaultDiff({ changed, removed, folders }, announce) {
  let reloadOpen = false;
  const removedSet = new Set(removed);
  for (const meta of changed) {
    const note = findNote(meta.id);
    if (!note) {
      state.notes.push({ ...meta, content: undefined, dirty: false, saved: true });
      continue;
    }
    if (note.dirty) continue;
    Object.assign(note, meta, { content: undefined, vaultKey: undefined });
    if (note.id === ui.selectedId) reloadOpen = true;
  }
  if (removedSet.size) {
    // Apagada fora do app: com edição pendente, a nota fica e é gravada de novo.
    state.notes = state.notes.filter((n) => {
      if (!removedSet.has(n.id)) return true;
      if (!n.dirty) return false;
      n.saved = false;
      n.rel = undefined;
      return true;
    });
  }
  if (folders) {
    // Pastas criadas fora do app entram em ordem alfabética (o cofre as põe no fim).
    const known = new Set(state.folders.map((f) => f.id));
    state.folders = folders;
    const added = folders.filter((f) => !known.has(f.id));
    for (const f of added) insertFolderSorted(state.folders, f);
    if (added.length && known.size) saveFolders();
  }
  const total = changed.length + removedSet.size;
  if (!total && !folders) {
    if (announce) toast("O cofre já está atualizado.");
    return;
  }
  titleIndex = null;
  notesChanged();
  if (ui.selectedId !== null && !findNote(ui.selectedId)) ui.selectedId = null;
  renderNotes();
  if (reloadOpen || ui.selectedId === null) loadSelectedIntoEditor();
  if (announce) toast(`${total} nota(s) atualizada(s) do cofre.`);
}

function onVaultConflict(note, fileName) {
  note.dirty = false;
  toast(`A nota foi alterada por outra pessoa. Sua versão foi salva como "${fileName}".`);
  syncVault();
}

function startVaultPolling() {
  clearInterval(vaultTimer);
  vaultTimer = isVault()
    ? setInterval(() => {
        if (state.activeMainView === "notes" && !document.hidden) syncVault();
      }, VAULT_POLL_MS)
    : null;
}

/**
 * Cópia das notas do banco local para um cofre (antes da troca): imagens vão para
 * attachments/ e as notas (com o conteúdo) e pastas voltam para gravar depois que o cofre abrir.
 */
async function snapshotLocalNotes(vaultPath) {
  const notes = state.notes.filter((n) => !n.deleted_at);
  for (const n of notes) await ensureContent(n);
  const names = new Set();
  for (const n of notes) {
    for (const img of n.content.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
      const name = localImageName(img[1]);
      if (name) names.add(name);
    }
  }
  const sep = vaultPath.includes("\\") ? "\\" : "/";
  if (names.size) await exportNoteImagesApi([...names], `${vaultPath}${sep}${ATTACHMENTS_DIR}`, true);
  return {
    notes: notes.map((n) => ({ ...n, pinned: false, dirty: true, saved: false, rel: undefined, disk_mtime: undefined, vaultKey: undefined })),
    folders: state.folders.map((f) => ({ ...f })),
  };
}

/**
 * Troca onde as notas ficam: mode "sqlite" | "vault" (+ pasta). `copy` = leva as notas do
 * banco local para o cofre. Devolve null ou a mensagem de erro (nada muda).
 */
export async function switchNotesStorage(mode, vaultPath, { copy = false } = {}) {
  if (!hasTauri) return "Disponível apenas no aplicativo desktop.";
  discardIfEmpty(ui.selectedId);
  flushNotesSave();
  await whenSaved();
  let snapshot = null;
  try {
    if (copy && mode === "vault" && !isVault()) snapshot = await snapshotLocalNotes(vaultPath);
    await notesApi.setStorage(mode, mode === "vault" ? vaultPath : null);
  } catch (e) {
    return String(e);
  }
  state.settings.notes_storage = mode;
  if (mode === "vault") {
    state.settings.vault_path = vaultPath;
    state.settings.vaults = addVaultPath(knownVaults(state.settings), vaultPath);
  }
  await saveSettingsApi(state.settings);
  document.dispatchEvent(new CustomEvent("notesstoragechange"));
  ui.selectedId = null;
  ui.scope = "all";
  setQuery("");
  await loadNotes();
  if (snapshot) {
    // Pastas que o cofre ainda não tem (mesmo caminho) e as notas, gravadas como arquivos.
    const known = new Map(state.folders.map((f) => [fold(folderPath(state.folders, f.id)), f.id]));
    const remap = new Map();
    for (const f of snapshot.folders) {
      const hit = known.get(fold(folderPath(snapshot.folders, f.id)));
      if (hit !== undefined) remap.set(f.id, hit);
    }
    const ids = new Set(state.folders.map((f) => f.id));
    for (const f of snapshot.folders) {
      if (remap.has(f.id)) continue;
      let id = f.id;
      while (ids.has(id)) id++;
      ids.add(id);
      remap.set(f.id, id);
    }
    const add = snapshot.folders
      .filter((f) => !known.has(fold(folderPath(snapshot.folders, f.id))))
      .map((f) => ({ id: remap.get(f.id), name: f.name, parent_id: f.parent_id ? remap.get(f.parent_id) ?? 0 : 0 }));
    state.folders = [...state.folders, ...add];
    saveFolders();
    const noteIds = new Set(state.notes.map((n) => n.id));
    const fresh = snapshot.notes.map((n) => {
      let id = n.id;
      while (noteIds.has(id)) id++;
      noteIds.add(id);
      return { ...n, id, folder_id: n.folder_id ? remap.get(n.folder_id) ?? 0 : 0 };
    });
    state.notes.unshift(...fresh);
    await saveNotesBulk(fresh, storeError);
    await whenSaved();
    await loadNotes();
    toast(`${fresh.length} nota(s) copiada(s) para o cofre.`);
  }
  startVaultPolling();
  return null;
}

/**
 * Antes não havia reordenação manual: as pastas existentes (na ordem de criação) são postas em
 * ordem alfabética uma vez por armazenamento. Depois disso a ordem manual é respeitada.
 */
function sortFoldersOnce() {
  const key = `nt-folders-az:${isVault() ? state.settings.vault_path : "sqlite"}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    return; // sem localStorage: não arrisca reordenar a cada abertura
  }
  if (state.folders.length < 2) return;
  const before = state.folders.map((f) => f.id).join();
  sortFolderChildren(state.folders, 0, true);
  if (state.folders.map((f) => f.id).join() !== before) saveFolders();
}

/** Loads folders and note metadata from notes.db (importing notes.json on the first run). */
export async function loadNotes() {
  try {
    const { notes, folders, error } = await loadNoteStore();
    state.notes = notes;
    state.folders = folders;
    sortFoldersOnce();
    titleIndex = null;
    if (error) toast(`Notas antigas não importadas: ${error}`);
    // Removes image files no note references anymore (trash included); the list comes from the database.
    else if (hasTauri && notes.length && !isVault()) collectImageGarbage();
  } catch (e) {
    console.error("notes load failed", e);
    state.notes = [];
    state.folders = [];
    toast(isVault() ? `Falha ao abrir o cofre: ${e}` : `Falha ao abrir as notas: ${e}`);
  }
  renderNotes();
  loadSelectedIntoEditor();
}

function showMoreMenu(btn) {
  const r = btn.getBoundingClientRect();
  const note = selectedNote();
  showMenu(r.left, r.bottom + 4, [
    ...(isVault() ? [{ label: "Atualizar do Cofre", icon: "fa-solid fa-rotate", run: () => syncVault({ announce: true }) }, "sep"] : []),
    { label: "Abrir Arquivo Markdown…", icon: "fa-brands fa-markdown", run: openMarkdownFile },
    { label: "Importar Markdown…", icon: "fa-solid fa-file-import", run: importMarkdown },
    { label: "Importar Pasta de Markdown…", icon: "fa-solid fa-folder-tree", run: () => importMarkdownFolder() },
    { label: "Exportar como Markdown…", icon: "fa-solid fa-file-export", disabled: !note, run: () => exportMarkdown(note.id) },
    { label: "Exportar como PDF…", icon: "fa-regular fa-file-pdf", disabled: !note, run: () => exportPdf(note.id) },
    "sep",
    {
      label: zk() ? "Desligar modo Zettelkasten" : "Ligar modo Zettelkasten",
      icon: "fa-solid fa-diagram-project",
      run: () => {
        state.settings.zettelkasten = !zk();
        saveSettingsApi(state.settings);
        updateSettingsUI();
        document.dispatchEvent(new CustomEvent("zettelkastenchange"));
        toast(zk() ? "Modo Zettelkasten ligado: propriedades, filtros e grafo." : "Modo Zettelkasten desligado.");
      },
    },
  ]);
}

function deleteNote(id) {
  const note = findNote(id);
  if (!note) return;
  const list = visibleNotes();
  const idx = list.findIndex((n) => n.id === id);
  const next = list[idx + 1] || list[idx - 1] || null;

  if (note.deleted_at || isEmptyNote(note)) {
    state.notes = state.notes.filter((n) => n.id !== id);
    deleteNotes([note], storeError);
  } else {
    note.deleted_at = Date.now();
    note.pinned = false;
    saveNoteMeta([note], storeError);
  }
  notesChanged();

  if (ui.selectedId === id) {
    ui.selectedId = null;
    if (!state.desktopMode) {
      ui.pane = "list";
      renderNotes();
      return;
    }
    selectNote(next?.id ?? null, { openEditor: false });
    return;
  }
  renderNotes();
}

function restoreNote(id) {
  const note = findNote(id);
  if (!note) return;
  note.deleted_at = null;
  if (!allFolders().some((f) => f.id === note.folder_id)) note.folder_id = 0;
  note.updated_at = Date.now();
  saveNoteMeta([note], storeError);
  notesChanged();
  if (ui.selectedId === id) {
    // Follows the note back to its folder, like macOS Notes.
    ui.scope = `f:${note.folder_id}`;
    renderNotes();
    loadSelectedIntoEditor();
  } else {
    renderNotes();
  }
}

function togglePin(id) {
  const note = findNote(id);
  if (!note || note.deleted_at) return;
  note.pinned = !note.pinned;
  saveNoteMeta([note], storeError);
  renderNotes();
}

function moveNote(id, folderId) {
  const note = findNote(id);
  if (!note) return;
  note.folder_id = folderId;
  if (note.deleted_at) note.deleted_at = null;
  saveNoteMeta([note], storeError);
  renderNotes();
}

/** New folder inside `parentId` (0 = top level), opened in rename mode. */
function createFolder(parentId = 0) {
  if (!state.folders.some((f) => f.id === parentId)) parentId = 0;
  const name = uniqueFolderName(state.folders, parentId, "Nova Pasta");
  let id = Date.now();
  while (allFolders().some((f) => f.id === id)) id++;
  // A posição alfabética é recalculada ao confirmar o nome (renameFolder).
  insertFolderSorted(state.folders, { id, name, parent_id: parentId });
  if (parentId) {
    setFolderCollapsed(parentId, false);
    revealFolder(parentId);
  }
  saveFolders();
  ui.editingFolderId = id;
  ui.scope = `f:${id}`;
  if (state.desktopMode) {
    discardIfEmpty(ui.selectedId);
    ui.selectedId = null;
  }
  renderNotes();
  loadSelectedIntoEditor();
}

function renameFolder(id, name) {
  const folder = state.folders.find((f) => f.id === id);
  ui.editingFolderId = null;
  if (folder && name.trim()) {
    const next = name.trim().slice(0, 60);
    // Nome novo = posição alfabética entre as irmãs; sem mudança, a posição manual fica.
    if (next !== folder.name) {
      folder.name = next;
      insertFolderSorted(state.folders, folder);
      saveFolders();
    }
  }
  renderNotes();
}

/** Deletes the folder and its subfolders; their notes go to "Apagadas Recentemente". */
function deleteFolder(id) {
  const now = Date.now();
  const moved = [];
  const gone = removeFolderTree(state.folders, id);
  for (const n of state.notes) {
    if (gone.has(n.folder_id) && !n.deleted_at) {
      n.deleted_at = now;
      n.pinned = false;
      moved.push(n);
    }
  }
  for (const f of gone) collapsedFolders.delete(f);
  // As notas vão para a lixeira antes: no cofre, os arquivos saem do diretório antes de ele ser removido.
  saveNoteMeta(moved, storeError);
  saveFolders();
  notesChanged();
  if (gone.has(scopeFolderId())) setScope("all");
  else renderNotes();
}

/** Moves a folder (with its subfolders) into `parentId` (0 = top level). */
function moveFolder(id, parentId) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder || (folder.parent_id || 0) === parentId || !canMoveFolder(state.folders, id, parentId)) return;
  folder.parent_id = parentId;
  insertFolderSorted(state.folders, folder);
  if (parentId) {
    setFolderCollapsed(parentId, false);
    revealFolder(parentId);
  }
  saveFolders();
  renderNotes();
}

/** Puts a folder right before/after another one, as its sibling (manual order). */
function reorderFolder(id, targetId, after) {
  if (!placeFolder(state.folders, id, targetId, after)) return;
  const parentId = state.folders.find((f) => f.id === id).parent_id;
  if (parentId) revealFolder(parentId);
  saveFolders();
  renderNotes();
}

/** A–Z among the subfolders of `parentId` (0 = top level), all levels below it. */
function sortFoldersAZ(parentId) {
  sortFolderChildren(state.folders, parentId, true);
  saveFolders();
  renderNotes();
}

// ---------- Rendering ----------

/** Notes per folder, counting the subfolders' notes too. */
function folderCounts(active) {
  const counts = new Map();
  for (const n of active) counts.set(n.folder_id, (counts.get(n.folder_id) || 0) + 1);
  // Pre-order list reversed: children are added to their parent before it is read.
  for (const { folder } of flattenTree(state.folders).reverse()) {
    if (folder.parent_id) counts.set(folder.parent_id, (counts.get(folder.parent_id) || 0) + (counts.get(folder.id) || 0));
  }
  return counts;
}

function renderFolders() {
  foldersEl.innerHTML = "";
  const active = state.notes.filter((n) => !n.deleted_at);
  const trashCount = state.notes.length - active.length;
  const counts = folderCounts(active);
  const folderEntry = ({ folder: f, depth, hasChildren }) => ({
    scope: `f:${f.id}`,
    folderId: f.id,
    name: f.name,
    // Pasta aberta = tem subpastas e está expandida.
    icon: hasChildren && !collapsedFolders.has(f.id) ? "fa-regular fa-folder-open" : "fa-regular fa-folder",
    count: counts.get(f.id) || 0,
    editable: f.id !== 0,
    depth,
    hasChildren,
  });

  const entries = [
    { scope: "all", name: "Todas as Notas", icon: "fa-regular fa-folder-open", count: active.length },
    ...(zk() ? [{ scope: "graph", name: "Grafo", icon: "fa-solid fa-circle-nodes", count: "" }] : []),
    folderEntry({ folder: DEFAULT_FOLDER, depth: 0, hasChildren: false }),
    ...flattenTree(state.folders, collapsedFolders).map(folderEntry),
  ];
  if (trashCount > 0 || ui.scope === "trash") {
    entries.push({ scope: "trash", name: "Apagadas Recentemente", icon: "fa-regular fa-trash-can", count: trashCount });
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "nt-folder";
    li.dataset.scope = entry.scope;
    li.classList.toggle("active", ui.scope === entry.scope && !ui.query.trim());
    if (entry.depth) li.style.setProperty("--depth", entry.depth);

    // Subfolders: caret to collapse/expand (empty slot keeps the icons aligned).
    const caret = document.createElement("span");
    caret.className = "nt-folder-caret";
    if (entry.hasChildren) {
      const open = !collapsedFolders.has(entry.folderId);
      caret.innerHTML = `<i class="fa-solid fa-chevron-right"></i>`;
      caret.classList.toggle("open", open);
      caret.title = open ? "Recolher" : "Expandir";
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        setFolderCollapsed(entry.folderId, open);
        renderFolders();
      });
    }
    li.appendChild(caret);

    const icon = document.createElement("i");
    icon.className = `${entry.icon} nt-folder-icon`;
    li.appendChild(icon);

    if (entry.folderId !== undefined && ui.editingFolderId === entry.folderId) {
      const input = document.createElement("input");
      input.className = "nt-folder-input";
      input.value = entry.name;
      input.maxLength = 60;
      let done = false;
      const commit = (save) => {
        if (done) return;
        done = true;
        if (save) renameFolder(entry.folderId, input.value);
        else {
          ui.editingFolderId = null;
          renderNotes();
        }
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(true);
        if (e.key === "Escape") commit(false);
      });
      input.addEventListener("blur", () => commit(true));
      input.addEventListener("click", (e) => e.stopPropagation());
      li.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const name = document.createElement("span");
      name.className = "nt-folder-name";
      name.textContent = entry.name;
      li.appendChild(name);
    }

    const count = document.createElement("span");
    count.className = "nt-folder-count";
    count.textContent = entry.count;
    li.appendChild(count);

    const chevron = document.createElement("i");
    chevron.className = "fa-solid fa-chevron-right nt-folder-chevron";
    li.appendChild(chevron);

    li.addEventListener("click", () => (entry.scope === "graph" ? openGraph({ local: false }) : setScope(entry.scope)));
    if (entry.editable) {
      li.addEventListener("dblclick", () => {
        ui.editingFolderId = entry.folderId;
        renderNotes();
      });
    }
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showFolderMenu(e.clientX, e.clientY, entry);
    });

    if (entry.folderId !== undefined) {
      // Real folders can be dragged into another folder (or onto "Notas" = top level).
      if (entry.editable) {
        li.draggable = true;
        li.addEventListener("dragstart", (e) => {
          draggedFolderId = entry.folderId;
          e.dataTransfer.setData("application/x-folder-id", String(entry.folderId));
          e.dataTransfer.effectAllowed = "move";
        });
        li.addEventListener("dragend", () => (draggedFolderId = null));
      }
      // Folder dragged over a real folder: top band = before (sibling), bottom band = after (only
      // when nothing of this folder shows below it), middle = inside. Notes always go inside.
      const zone = (e) => {
        if (!entry.editable || !e.dataTransfer.types.includes("application/x-folder-id")) return "inside";
        const r = li.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        if (y < 0.3) return "before";
        if (y > 0.7 && (!entry.hasChildren || collapsedFolders.has(entry.folderId))) return "after";
        return "inside";
      };
      const accepts = (e, z) => {
        const types = e.dataTransfer.types;
        if (types.includes("application/x-note-id")) return true;
        // The id isn't readable during dragover, hence draggedFolderId.
        if (!types.includes("application/x-folder-id") || draggedFolderId === null || draggedFolderId === entry.folderId) return false;
        const parentId = z === "inside" ? entry.folderId : state.folders.find((f) => f.id === entry.folderId)?.parent_id || 0;
        return canMoveFolder(state.folders, draggedFolderId, parentId);
      };
      const clearDrop = () => li.classList.remove("drop-target", "drop-before", "drop-after");
      li.addEventListener("dragover", (e) => {
        const z = zone(e);
        if (!accepts(e, z)) return clearDrop();
        e.preventDefault();
        clearDrop();
        li.classList.add(z === "inside" ? "drop-target" : `drop-${z}`);
      });
      li.addEventListener("dragleave", clearDrop);
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        const z = zone(e);
        clearDrop();
        const noteId = Number(e.dataTransfer.getData("application/x-note-id"));
        const folderId = Number(e.dataTransfer.getData("application/x-folder-id"));
        if (noteId) moveNote(noteId, entry.folderId);
        else if (folderId && z === "inside") moveFolder(folderId, entry.folderId);
        else if (folderId) reorderFolder(folderId, entry.folderId, z === "after");
      });
    }

    foldersEl.appendChild(li);
  }
}

function renderListItem(note, showFolder) {
  const item = document.createElement("div");
  item.className = "nt-item";
  item.dataset.id = note.id;
  item.draggable = true;
  item.classList.toggle("selected", note.id === ui.selectedId);

  const title = document.createElement("div");
  title.className = "nt-item-title";
  if (note.pinned) {
    const pin = document.createElement("i");
    pin.className = "fa-solid fa-thumbtack nt-item-pin";
    title.appendChild(pin);
  }
  title.append(titleOf(note));

  const meta = document.createElement("div");
  meta.className = "nt-item-meta";
  const date = document.createElement("span");
  date.className = "nt-item-date";
  date.textContent = formatNoteListDate(note.updated_at);
  const preview = document.createElement("span");
  preview.className = "nt-item-preview";
  preview.textContent = previewOf(note);
  meta.append(date, preview);

  item.append(title, meta);

  if (showFolder) {
    const folder = document.createElement("div");
    folder.className = "nt-item-folder";
    folder.innerHTML = `<i class="fa-regular fa-folder"></i>`;
    folder.append(note.deleted_at ? "Apagadas Recentemente" : folderLabel(note.folder_id));
    item.appendChild(folder);
  }

  item.addEventListener("click", () => {
    selectNote(note.id);
    if (state.desktopMode) listEl.focus({ preventScroll: true });
  });
  item.addEventListener("dblclick", () => focusEditorEnd());
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showNoteMenu(e.clientX, e.clientY, note);
  });
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-note-id", String(note.id));
    e.dataTransfer.effectAllowed = "move";
  });
  return item;
}

function renderList() {
  const notes = visibleNotes();
  const fid = scopeFolderId();
  // A folder's list also has its subfolders' notes: those show where they are.
  const showFolder = (n) => ui.scope === "all" || !!ui.query.trim() || (fid !== null && n.folder_id !== fid);
  listEl.innerHTML = "";

  if (!notes.length) {
    const empty = document.createElement("div");
    empty.className = "nt-list-empty";
    empty.textContent = ui.query.trim() ? "Nenhum resultado" : "Nenhuma Nota";
    listEl.appendChild(empty);
  }

  let groupLabel = null;
  let groupEl = null;
  for (const note of notes) {
    const label =
      ui.scope === "trash"
        ? noteGroupLabel(note.deleted_at)
        : note.pinned
          ? "Fixadas"
          : noteGroupLabel(note.updated_at);
    if (label !== groupLabel) {
      groupLabel = label;
      const header = document.createElement("div");
      header.className = "nt-group-label";
      if (label === "Fixadas") header.innerHTML = `<i class="fa-solid fa-thumbtack"></i> `;
      header.append(label);
      groupEl = document.createElement("div");
      groupEl.className = "nt-group";
      listEl.append(header, groupEl);
    }
    groupEl.appendChild(renderListItem(note, showFolder(note)));
  }

  const label = ui.scope === "graph" ? "Grafo" : scopeLabel();
  const count = pluralNotes(notes.length);
  listTitleEl.textContent = label;
  tbFolderEl.textContent = label;
  tbCountEl.textContent = count;
  countEl.textContent = count;
  backLabelEl.textContent = label;
}

function renderChrome() {
  if (ui.scope === "graph" && !zk()) ui.scope = "all";
  if (ui.pane === "graph" && ui.scope !== "graph") ui.pane = "list";
  if (!state.desktopMode && ui.scope === "graph") ui.pane = "graph";
  appEl.dataset.pane = ui.pane;
  appEl.dataset.view = ui.scope === "graph" ? "graph" : "";
  appEl.classList.toggle("zettel", zk());
  appEl.classList.toggle("sidebar-hidden", ui.sidebarHidden);
  const editing = state.activeMainView === "notes" && !state.desktopMode && ui.pane === "editor";
  document.body.classList.toggle("notes-editing", editing);

  const note = selectedNote();
  appEl.querySelectorAll('[data-action="pin"]').forEach((btn) => {
    btn.classList.toggle("active", !!note?.pinned);
    btn.disabled = !note || !!note.deleted_at;
  });
  appEl.querySelectorAll('[data-action="delete-note"]').forEach((btn) => (btn.disabled = !note));
  const readOnly = !note || !!note.deleted_at;
  appEl.querySelectorAll("[data-cmd], [data-popover]").forEach((btn) => (btn.disabled = readOnly));
  appEl.querySelectorAll('[data-action="graph-local"]').forEach((btn) => (btn.disabled = !note || !!note.deleted_at));
  renderStorageLabel();
  syncGraph();
}

/** "No Meu PC" (notes.db) ou o nome do cofre, com o caminho no tooltip. */
function renderStorageLabel() {
  const label = document.getElementById("nt-storage-label");
  const icon = document.getElementById("nt-storage-icon");
  const btn = appEl.querySelector('[data-action="storage-menu"]');
  const refresh = appEl.querySelector('[data-action="vault-refresh"]');
  const path = state.settings.vault_path || "";
  if (label) label.textContent = isVault() ? vaultName(path) || "Cofre" : "No Meu PC";
  if (icon) icon.className = isVault() ? "fa-solid fa-folder-open" : "fa-solid fa-hard-drive";
  if (btn) btn.title = isVault() ? `Cofre: ${path}\nClique para trocar de cofre` : "Banco local deste computador\nClique para trocar de cofre";
  if (refresh) refresh.hidden = !isVault();
}

// ---------- Troca rápida de cofre (barra lateral) ----------

let storageSwitching = false;

/** Abre o banco local ou um cofre; erro = aviso e nada muda. */
async function changeStorage(mode, path = null) {
  if (storageSwitching) return;
  const current = isVault() ? state.settings.vault_path : null;
  if (mode === "sqlite" ? !current : current && sameVaultPath(current, path)) return;
  storageSwitching = true;
  toast(mode === "vault" ? `Abrindo o cofre "${vaultName(path)}"…` : "Abrindo o banco local…");
  const error = await switchNotesStorage(mode, path);
  storageSwitching = false;
  toast(error ? `Não foi possível abrir: ${error}` : mode === "vault" ? `Cofre "${vaultName(path)}" aberto.` : "Banco local aberto.");
}

async function openOtherVault() {
  if (!hasTauri) return toast("Disponível apenas no aplicativo desktop.");
  const dir = await openDirectoryDialogApi({ title: "Abrir cofre de notas (pasta de Markdown)" });
  if (dir) changeStorage("vault", dir);
}

function forgetVault(path) {
  state.settings.vaults = knownVaults(state.settings).filter((p) => !sameVaultPath(p, path));
  if (state.settings.vault_path && sameVaultPath(state.settings.vault_path, path)) state.settings.vault_path = "";
  saveSettingsApi(state.settings);
  document.dispatchEvent(new CustomEvent("notesstoragechange"));
  toast(`"${vaultName(path)}" saiu da lista (a pasta não foi tocada).`);
}

function showStorageMenu(btn) {
  const r = btn.getBoundingClientRect();
  const current = isVault() ? state.settings.vault_path : null;
  const vaults = knownVaults(state.settings);
  const labels = vaultLabels(vaults);
  const isCurrent = (p) => !!current && sameVaultPath(p, current);
  const items = [
    { header: "Onde ficam as notas" },
    { label: "Banco local (No Meu PC)", icon: current ? "fa-solid fa-hard-drive" : "fa-solid fa-check", run: () => changeStorage("sqlite") },
    ...vaults.map((p, i) => ({ label: labels[i], icon: isCurrent(p) ? "fa-solid fa-check" : "fa-regular fa-folder", run: () => changeStorage("vault", p) })),
    "sep",
    { label: "Abrir outro cofre…", icon: "fa-solid fa-folder-plus", run: openOtherVault },
  ];
  const inactive = vaults.map((p, i) => [p, labels[i]]).filter(([p]) => !isCurrent(p));
  if (inactive.length) {
    items.push("sep", { header: "Remover da lista" });
    for (const [p, label] of inactive) items.push({ label, icon: "fa-solid fa-xmark", indent: true, run: () => forgetVault(p) });
  }
  showMenu(r.left, r.bottom + 4, items);
}

export function renderNotes() {
  renderFolders();
  renderList();
  renderChrome();
}

function queueListRender() {
  if (listRenderQueued) return;
  listRenderQueued = true;
  requestAnimationFrame(() => {
    listRenderQueued = false;
    renderList();
  });
}

/**
 * Header above the note: creation date (editable; saved with the note, exported as
 * `created:`) and the last edit. Only the edit time is refreshed while typing.
 */
function renderEditorDate(note) {
  let input = editorDateEl.querySelector(".nt-created-input");
  if (!input || editorDateEl.dataset.id !== String(note.id)) {
    editorDateEl.dataset.id = note.id;
    input = document.createElement("input");
    input.type = "date";
    input.className = "nt-created-input";
    input.title = "Data de criação";
    input.addEventListener("keydown", (e) => e.stopPropagation());
    input.addEventListener("click", () => {
      try {
        input.showPicker();
      } catch {}
    });
    input.addEventListener("change", () => {
      const n = findNote(Number(editorDateEl.dataset.id));
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value);
      if (!n || !m || n.deleted_at || n.content === undefined) return renderEditorDate(n || note);
      // Keeps the time of day; only the day changes.
      const d = new Date(n.created_at || n.id);
      const base = Number.isNaN(d.getTime()) ? new Date() : d;
      n.created_at = new Date(+m[1], +m[2] - 1, +m[3], base.getHours(), base.getMinutes(), base.getSeconds()).toISOString();
      n.dirty = true;
      saveNotesSoon();
    });
    const created = document.createElement("label");
    created.className = "nt-created";
    created.append("Criada em ", input);
    const updated = document.createElement("span");
    updated.className = "nt-updated";
    editorDateEl.replaceChildren(created, document.createTextNode(" · "), updated);
  }
  const value = dateOnly(note.created_at || note.id);
  if (document.activeElement !== input) input.value = value;
  input.disabled = !!note.deleted_at || note.content === undefined;
  editorDateEl.querySelector(".nt-updated").textContent = `Editada em ${formatNoteFullDate(note.updated_at)}`;
}

function loadSelectedIntoEditor({ focus = false } = {}) {
  const note = selectedNote();
  closePopover();
  editorScrollEl.hidden = !note;
  editorEmptyEl.hidden = !!note;
  trashBannerEl.hidden = !note?.deleted_at;
  const seq = ++editorLoadSeq;
  lastTitle = note && note.content !== undefined ? titleOf(note) : null;
  if (!note) {
    propsPanel?.hide();
    linksPanel?.hide();
    return;
  }
  renderEditorDate(note);
  const open = () => {
    const updated = loadEditor(note.content, { readOnly: !!note.deleted_at, focus, key: note.id });
    if (updated !== null) {
      // Links renomeados/resolvidos ao abrir: grava sem mexer na data da nota.
      note.content = updated;
      note.links = noteLinks(updated);
      note.dirty = true;
      saveNotesSoon();
    }
    lastTitle = titleOf(note);
    renderEditorDate(note); // libera a data de criação (conteúdo carregado)
    renderPropsPanel();
    renderLinksPanel();
  };
  if (note.content !== undefined) return open();
  // HTML comes from notes.db the first time the note is opened.
  propsPanel?.hide();
  linksPanel?.hide();
  loadEditor("", { readOnly: true });
  ensureContent(note)
    .then(() => seq === editorLoadSeq && ui.selectedId === note.id && open())
    .catch((e) => toast(`Falha ao abrir a nota: ${e}`));
}

function handleEditorInput(html) {
  const note = selectedNote();
  if (!note || note.deleted_at || note.content === undefined) return;
  note.content = html;
  note.dirty = true;
  note.updated_at = Date.now();
  renderEditorDate(note);
  const links = noteLinks(html);
  const linksChanged = links.length !== (note.links?.length || 0) || links.some((l, i) => l !== note.links[i]);
  note.links = links;
  const title = titleOf(note);
  if (title !== lastTitle) {
    lastTitle = title;
    titleIndex = null;
  }
  if (linksChanged) queueLinksPanel();
  propsPanel?.place(); // o título (1º bloco) pode ter mudado de altura, inclusive ao desfazer
  if (ensureZid(note)) renderPropsPanel();
  saveNotesSoon();
  queueListRender();
}

function handleSelectionState(sel) {
  appEl.querySelectorAll('[data-cmd="check"]').forEach((b) => b.classList.toggle("active", sel?.list === "check"));
  appEl.querySelectorAll('[data-cmd="table"]').forEach((b) => b.classList.toggle("active", !!sel?.table));
  if (popoverEl.hidden) return;
  popoverEl.querySelectorAll("[data-style]").forEach((b) => b.classList.toggle("active", sel?.style === b.dataset.style && !sel?.list));
  popoverEl.querySelectorAll("[data-list]").forEach((b) => b.classList.toggle("active", sel?.list === b.dataset.list));
  popoverEl.querySelectorAll("[data-quote]").forEach((b) => b.classList.toggle("active", !!sel?.quote));
  popoverEl.querySelectorAll("[data-inline]").forEach((b) => b.classList.toggle("active", !!sel?.[b.dataset.inline]));
}

// ---------- Popover & context menu ----------

function openPopover(anchor) {
  closeMenu();
  popoverEl.hidden = false;
  popoverEl.classList.toggle("sheet", !state.desktopMode);
  if (state.desktopMode) {
    const a = anchor.getBoundingClientRect();
    const host = appEl.getBoundingClientRect();
    const left = Math.min(a.left - host.left, host.width - popoverEl.offsetWidth - 8);
    popoverEl.style.left = `${Math.max(8, left)}px`;
    popoverEl.style.top = `${a.bottom - host.top + 6}px`;
  } else {
    popoverEl.style.left = "";
    popoverEl.style.top = "";
  }
  anchor.classList.add("active");
  handleSelectionState(getSelectionState());
}

function closePopover() {
  popoverEl.hidden = true;
  appEl.querySelectorAll("[data-popover].active").forEach((b) => b.classList.remove("active"));
}

function showMenu(x, y, items) {
  closePopover();
  menuEl.innerHTML = "";
  for (const item of items) {
    if (item === "sep") {
      const sep = document.createElement("div");
      sep.className = "nt-menu-sep";
      menuEl.appendChild(sep);
      continue;
    }
    if (item.header) {
      const h = document.createElement("div");
      h.className = "nt-menu-header";
      h.textContent = item.header;
      menuEl.appendChild(h);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nt-menu-item";
    btn.classList.toggle("danger", !!item.danger);
    btn.classList.toggle("indent", !!item.indent);
    if (item.depth) btn.style.setProperty("--depth", item.depth);
    btn.disabled = !!item.disabled;
    btn.innerHTML = `<i class="${item.icon || ""}"></i>`;
    btn.append(item.label);
    btn.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menuEl.appendChild(btn);
  }
  menuEl.hidden = false;
  const host = appEl.getBoundingClientRect();
  const left = Math.min(x - host.left, host.width - menuEl.offsetWidth - 6);
  const top = Math.min(y - host.top, host.height - menuEl.offsetHeight - 6);
  menuEl.style.left = `${Math.max(6, left)}px`;
  menuEl.style.top = `${Math.max(6, top)}px`;
}

function closeMenu() {
  menuEl.hidden = true;
}

function showNoteMenu(x, y, note) {
  if (note.deleted_at) {
    showMenu(x, y, [
      { label: "Recuperar", icon: "fa-solid fa-rotate-left", run: () => restoreNote(note.id) },
      { label: "Exportar como Markdown…", icon: "fa-solid fa-file-export", run: () => exportMarkdown(note.id) },
    { label: "Exportar como PDF…", icon: "fa-regular fa-file-pdf", run: () => exportPdf(note.id) },
      "sep",
      { label: "Apagar Permanentemente", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteNote(note.id) },
    ]);
    return;
  }
  showMenu(x, y, [
    {
      label: note.pinned ? "Desafixar Nota" : "Fixar Nota",
      icon: "fa-solid fa-thumbtack",
      run: () => togglePin(note.id),
    },
    "sep",
    { header: "Mover para" },
    ...folderTreeEntries().map(({ folder: f, depth }) => ({
      label: f.name,
      icon: "fa-regular fa-folder",
      indent: true,
      depth,
      disabled: f.id === note.folder_id,
      run: () => moveNote(note.id, f.id),
    })),
    "sep",
    { label: "Exportar como Markdown…", icon: "fa-solid fa-file-export", run: () => exportMarkdown(note.id) },
    { label: "Exportar como PDF…", icon: "fa-regular fa-file-pdf", run: () => exportPdf(note.id) },
    ...(zk()
      ? [{ label: "Grafo local", icon: "fa-solid fa-circle-nodes", run: () => (selectNote(note.id, { openEditor: false }), openGraph({ local: true })) }]
      : []),
    "sep",
    { label: "Apagar", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteNote(note.id) },
  ]);
}

function showFolderMenu(x, y, entry) {
  const parent = entry.editable ? entry.folderId : 0;
  const items = [
    { label: "Nova Pasta", icon: "fa-solid fa-folder-plus", run: () => createFolder() },
    ...(entry.editable ? [{ label: "Nova Subpasta", icon: "fa-solid fa-folder-tree", run: () => createFolder(entry.folderId) }] : []),
    "sep",
    {
      label: "Importar Markdown…",
      icon: "fa-solid fa-file-import",
      run: () => {
        if (entry.scope !== "trash" && entry.scope !== "graph") ui.scope = entry.scope;
        importMarkdown();
      },
    },
    {
      label: entry.editable ? "Importar Pasta de Markdown Aqui…" : "Importar Pasta de Markdown…",
      icon: "fa-solid fa-folder-tree",
      run: () => importMarkdownFolder(parent),
    },
  ];
  // Real folder with subfolders, or "Notas" (= top level) when there are folders.
  if (entry.editable ? entry.hasChildren : entry.folderId === 0 && state.folders.length > 1) {
    items.push("sep", {
      label: entry.editable ? "Ordenar Subpastas de A a Z" : "Ordenar Pastas de A a Z",
      icon: "fa-solid fa-arrow-down-a-z",
      run: () => sortFoldersAZ(parent),
    });
  }
  if (entry.editable) {
    const folder = state.folders.find((f) => f.id === entry.folderId);
    items.push(
      "sep",
      {
        label: "Renomear Pasta",
        icon: "fa-solid fa-pen",
        run: () => {
          ui.editingFolderId = entry.folderId;
          renderNotes();
        },
      },
      ...(folder?.parent_id
        ? [{ label: "Mover para o Nível Superior", icon: "fa-solid fa-arrow-turn-up", run: () => moveFolder(entry.folderId, 0) }]
        : []),
      "sep",
      {
        label: entry.hasChildren ? "Apagar Pasta e Subpastas" : "Apagar Pasta",
        icon: "fa-regular fa-trash-can",
        danger: true,
        run: () => deleteFolder(entry.folderId),
      },
    );
  }
  showMenu(x, y, items);
}

/** Tray mode always opens on the "Todas as Notas" list. */
function openCompactHome() {
  discardIfEmpty(ui.selectedId);
  flushNotesSave();
  if (ui.scope === "graph") return renderNotes(); // volta para o grafo onde estava
  ui.scope = "all";
  ui.query = "";
  searchInputs.forEach((i) => (i.value = ""));
  ui.selectedId = null;
  ui.pane = "list";
  renderNotes();
  loadSelectedIntoEditor();
  listEl.scrollTop = 0;
}

// ---------- Event wiring ----------

const ACTIONS = {
  "new-note": createNote,
  "delete-note": () => ui.selectedId !== null && deleteNote(ui.selectedId),
  restore: () => ui.selectedId !== null && restoreNote(ui.selectedId),
  pin: () => ui.selectedId !== null && togglePin(ui.selectedId),
  "new-folder": () => createFolder(),
  "import-folder": () => importMarkdownFolder(),
  "vault-refresh": () => syncVault({ announce: true }),
  "storage-menu": showStorageMenu,
  "show-folders": () => {
    ui.pane = "folders";
    renderNotes();
  },
  "show-list": () => {
    discardIfEmpty(ui.selectedId);
    flushNotesSave();
    ui.pane = "list";
    renderNotes();
  },
  "toggle-sidebar": () => {
    ui.sidebarHidden = !ui.sidebarHidden;
    renderChrome();
  },
  desktop: () => enterDesktopMode(),
  tray: () => exitDesktopMode(),
  "close-desktop": () => exitDesktopMode({ visible: false }),
  minimize: minimizeWindow,
  maximize: toggleMaximize,
  more: showMoreMenu,
  "graph-local": () => ui.selectedId !== null && openGraph({ local: true }),
};

function moveSelection(delta) {
  const list = visibleNotes();
  if (!list.length) return;
  const idx = list.findIndex((n) => n.id === ui.selectedId);
  const next = list[Math.max(0, Math.min(list.length - 1, idx + delta))];
  if (next && next.id !== ui.selectedId) {
    selectNote(next.id, { openEditor: false });
    listEl.querySelector(`.nt-item[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

function handleGlobalKeydown(e) {
  if (state.activeMainView !== "notes") return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.altKey && !mod && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    if (navigate(e.key === "ArrowLeft" ? -1 : 1)) e.preventDefault();
    return;
  }
  if (mod && e.shiftKey && key === "g" && zk()) {
    e.preventDefault();
    return ui.scope === "graph" ? restoreLocation({ scope: graphReturnScope, query: "", id: ui.selectedId }) : openGraph();
  }

  if (e.key === "Escape") {
    if (isFindOpen()) return closeFind({ select: false });
    if (!menuEl.hidden) return closeMenu();
    if (!popoverEl.hidden) return closePopover();
    if (searchInputs.includes(document.activeElement) && ui.query) {
      document.activeElement.value = "";
      ui.query = "";
      return renderNotes();
    }
    if (!state.desktopMode && ui.pane === "editor") return ACTIONS["show-list"]();
    if (ui.scope === "graph" && !graphEl.contains(document.activeElement)) {
      ui.scope = graphReturnScope;
      if (!state.desktopMode) ui.pane = "folders";
      return renderNotes();
    }
    return;
  }
  if (mod && !e.shiftKey && key === "n") {
    e.preventDefault();
    return createNote();
  }
  if (mod && !e.altKey && key === "f") {
    e.preventDefault();
    const input = state.desktopMode ? searchInputs[0] : searchInputs[1];
    if (ui.scope === "graph") return graph?.focusSearch();
    // Ctrl+F = buscar dentro da nota aberta; Ctrl+Shift+F (ou já na busca da lista) = em todas.
    const noteOpen = !editorScrollEl.hidden && (state.desktopMode || ui.pane === "editor");
    if (!e.shiftKey && noteOpen && !searchInputs.includes(document.activeElement)) return openFind();
    if (!state.desktopMode && ui.pane !== "list") {
      ui.pane = "list";
      renderNotes();
    }
    input.focus();
    input.select();
  }
}

export function initNotes() {
  setLinkProvider({
    index: getIndex,
    titleOf: linkedTitle,
    folderOf: (id) => {
      const n = findNote(id);
      return n ? folderLabel(n.folder_id) : "";
    },
    peek: (id) => {
      const n = findNote(id);
      if (!n || n.deleted_at) return null;
      return { ...noteInfo(n), tags: zk() ? n.props?.tags || [] : [] };
    },
    open: openLinkedNote,
    create: createLinkedNote,
    currentId: () => ui.selectedId,
  });
  setVaultContext({
    linkTitle: (a) => (a.dataset.note ? linkedTitle(Number(a.dataset.note)) : null) || "",
    onConflict: onVaultConflict,
  });
  window.addEventListener("focus", () => state.activeMainView === "notes" && syncVault());
  startVaultPolling();
  initEditor({ onInput: handleEditorInput, onSelection: handleSelectionState });
  propsPanel = createPropsPanel(document.getElementById("nt-props"), {
    editor: document.getElementById("nt-editor"),
    onChange: handlePropsChange,
    tags: () => tagCounts(state.notes),
    onTagClick: openTagSearch,
  });
  linksPanel = createLinksPanel(document.getElementById("nt-backlinks"), {
    open: openLinkedNote,
    create: (title) => openLinkedNote(createLinkedNote(title)),
  });

  document.addEventListener("zettelkastenchange", () => {
    if (!zk() && ui.scope === "graph") ui.scope = graphReturnScope;
    if (zk()) {
      const note = selectedNote();
      if (note && note.content !== undefined && ensureZid(note)) handlePropsChange(note);
    }
    renderNotes();
    renderPropsPanel();
    if (ui.query.trim()) runSearch();
  });

  appEl.addEventListener("mousedown", (e) => {
    // Toolbar buttons must not take the caret away from the editor.
    if (e.target.closest("[data-cmd], [data-popover]")) e.preventDefault();
    if (!menuEl.hidden && !e.target.closest("#nt-menu")) closeMenu();
    if (!popoverEl.hidden && !e.target.closest("#nt-format-popover, [data-popover]")) closePopover();
  });

  appEl.addEventListener("click", (e) => {
    const popBtn = e.target.closest("[data-popover]");
    if (popBtn) {
      if (popoverEl.hidden) openPopover(popBtn);
      else closePopover();
      return;
    }
    const cmdBtn = e.target.closest("[data-cmd]");
    if (cmdBtn && !cmdBtn.disabled) {
      if (cmdBtn.dataset.cmd === "code") closePopover(); // the caret moves into the code editor
      runCommand(cmdBtn.dataset.cmd);
      return;
    }
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn && !actionBtn.disabled) ACTIONS[actionBtn.dataset.action]?.(actionBtn);
  });

  for (const input of searchInputs) {
    input.addEventListener("input", () => {
      ui.query = input.value;
      searchInputs.forEach((i) => i !== input && (i.value = input.value));
      runSearch();
    });
  }

  listEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if ((e.key === "Delete" || e.key === "Backspace") && ui.selectedId !== null) {
      e.preventDefault();
      deleteNote(ui.selectedId);
    } else if (e.key === "Enter") {
      e.preventDefault();
      focusEditorEnd();
    }
  });

  document.addEventListener("keydown", handleGlobalKeydown);
  listEl.addEventListener("scroll", closeMenu);

  document.addEventListener("mainviewchange", () => {
    if (state.activeMainView !== "notes") {
      closePopover();
      renderChrome(); // esconde o grafo (para a animação)
      return;
    }
    if (!state.desktopMode) openCompactHome();
    else renderChrome();
    syncVault();
  });

  document.addEventListener("windowmodechange", () => {
    closePopover();
    closeMenu();
    if (state.desktopMode) {
      ui.sidebarHidden = false;
      if (!selectedNote()) {
        const first = visibleNotes()[0];
        if (first) ui.selectedId = first.id;
      }
      renderNotes();
      loadSelectedIntoEditor();
    } else {
      openCompactHome();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (saveTimer) flushNotesSave();
  });

  registerApp("notes", {
    flush: async () => {
      discardIfEmpty(ui.selectedId);
      flushNotesSave();
      await whenSaved();
    },
    reload: async () => {
      await loadNotes();
      startVaultPolling();
    },
  });
  // Outra janela trocou o armazenamento (banco local <-> cofre) ou copiou notas para o cofre.
  document.addEventListener("notesreload", async () => {
    await loadNotes();
    startVaultPolling();
    document.dispatchEvent(new CustomEvent("notesstoragechange"));
  });

  loadSelectedIntoEditor();
}

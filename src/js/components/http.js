import { state } from "../state.js";
import {
  saveHttpDataApi,
  sendHttpRequestApi,
  cancelHttpRequestApi,
  clearHttpCookiesApi,
  openFileDialogApi,
  saveFileDialogApi,
  readTextFileApi,
  writeFileApi,
} from "../api.js";
import {
  uid,
  kv,
  clone,
  newRequest,
  newCollection,
  normalizeRequest,
  normalizeHttpData,
  buildScope,
  buildHttpRequest,
  formatMs,
  statusClass,
  headerValue,
} from "../utils/httpModel.js";
import { SNIPPETS, parseCurl, exportPostman, exportPostmanEnvironment } from "../utils/httpConvert.js";
import { runScript } from "../utils/httpScripts.js";
import { descendantIds, folderPath, flattenTree, canMoveFolder, uniqueFolderName, removeFolderTree } from "../utils/folderTree.js";
import { formatNoteListDate, formatNoteFullDate, noteGroupLabel } from "../utils/date.js";
import { initHttpEditor, loadRequest, renderResponse, refreshVariables, refreshRequestTab, focusUrl, focusName } from "./httpEditor.js";
import { el, icon, attachVarAutocomplete } from "./httpWidgets.js";
import {
  isModalOpen,
  closeModal,
  confirmDialog,
  environmentsDialog,
  collectionDialog,
  importDialog,
  codeDialog,
  runnerDialog,
} from "./httpDialogs.js";
import { enterDesktopMode, exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";

// "HTTP" tab: a Postman-like client laid out like the Notes tab
// (tray = stacked Collections → List → Request, desktop = 3 columns).

const ui = state.httpUI;

const appEl = document.getElementById("http-app");
const collectionsEl = document.getElementById("hx-collections");
const toolsEl = document.getElementById("hx-tools");
const listEl = document.getElementById("hx-list");
const listTitleEl = document.getElementById("hx-list-title");
const countEl = document.getElementById("hx-count");
const tbScopeEl = document.getElementById("hx-tb-scope");
const tbCountEl = document.getElementById("hx-tb-count");
const backLabelEl = document.getElementById("hx-back-label");
const reqEl = document.getElementById("hx-req");
const emptyEl = document.getElementById("hx-empty");
const historyBannerEl = document.getElementById("hx-history-banner");
const historyTextEl = document.getElementById("hx-history-text");
const menuEl = document.getElementById("hx-menu");
const toastEl = document.getElementById("hx-toast");
const searchInputs = [document.getElementById("hx-search-desktop"), document.getElementById("hx-search-compact")];

/** In-memory responses: "r:<requestId>" / "h:<historyId>" -> entry. */
const responses = new Map();
/** Requests being sent: response key -> Rust request id. */
const inflight = new Map();
let saveTimer = null;
let listRenderQueued = false;
let toastTimer = null;
let draggedFolder = null; // { collId, id } da pasta arrastada na lista

const data = () => state.http;

// ---------- Data helpers ----------

const findColl = (id) => data().collections.find((c) => c.id === id) || null;
const findReq = (id) => data().requests.find((r) => r.id === id) || null;
const findHistory = (id) => data().history.find((h) => h.id === id) || null;
const activeEnv = () => data().environments.find((e) => e.id === data().active_env) || null;
const inHistory = () => ui.scope === "history";
const scopeCollId = () => (ui.scope?.startsWith("c:") ? Number(ui.scope.slice(2)) : null);

function currentRequest() {
  if (ui.selectedId === null) return null;
  return inHistory() ? findHistory(ui.selectedId)?.request || null : findReq(ui.selectedId);
}

const currentKey = () => (ui.selectedId === null ? null : `${inHistory() ? "h" : "r"}:${ui.selectedId}`);

function scopeFor(req) {
  return buildScope({ globals: data().globals, collection: req ? findColl(req.collection_id) : null, environment: activeEnv() });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function matches(req, q) {
  const s = q.toLowerCase();
  return req.name.toLowerCase().includes(s) || req.url.toLowerCase().includes(s) || req.method.toLowerCase() === s;
}

function visibleRequests() {
  const q = ui.query.trim();
  const cid = scopeCollId();
  return data().requests.filter((r) => (q ? matches(r, q) : cid === null || r.collection_id === cid));
}

function visibleHistory() {
  const q = ui.query.trim();
  return q ? data().history.filter((h) => matches(h.request, q)) : data().history;
}

/** Items in on-screen order (used for keyboard navigation and "next" after deleting). */
function orderedIds() {
  if (inHistory()) return visibleHistory().map((h) => h.id);
  return [...listEl.querySelectorAll(".hx-item")].map((n) => Number(n.dataset.id));
}

function scopeLabel() {
  if (ui.query.trim()) return "Resultados";
  if (ui.scope === "all") return "Todas as Requisições";
  if (inHistory()) return "Histórico";
  return findColl(scopeCollId())?.name || "Coleção";
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (data()) saveHttpDataApi(data());
}

// ---------- Toast / clipboard / files ----------

function toast(message, action = null) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.append(el("span", {}, message));
  if (action) {
    toastEl.append(
      el("button", {
        type: "button",
        onclick: () => {
          toastEl.hidden = true;
          action.run();
        },
      }, action.label),
    );
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 6000 : 2500);
}

async function copy(text, message = "Copiado") {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Não foi possível copiar");
  }
}

const EXT_BY_TYPE = { json: "json", html: "html", xml: "xml", javascript: "js", plain: "txt", csv: "csv", png: "png", jpeg: "jpg", gif: "gif", webp: "webp", "svg+xml": "svg", pdf: "pdf", zip: "zip" };

async function saveResponse(entry) {
  const res = entry?.response;
  if (!res) return;
  const ct = (headerValue(res.headers, "content-type") || "").split(";")[0].trim();
  const sub = ct.split("/")[1] || "";
  const ext = EXT_BY_TYPE[sub] || (sub.endsWith("+json") ? "json" : res.body_base64 ? "bin" : "txt");
  const path = await saveFileDialogApi({ defaultPath: `resposta.${ext}`, title: "Salvar resposta" });
  if (!path) return;
  try {
    await writeFileApi(path, res.body_base64 ? { base64: res.body_base64 } : { text: res.body });
    toast("Resposta salva");
  } catch (e) {
    toast(`Erro ao salvar: ${e}`);
  }
}

const pickFile = () => openFileDialogApi({ title: "Escolher arquivo" });

async function readImportFile() {
  const path = await openFileDialogApi({ title: "Importar", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return null;
  try {
    return await readTextFileApi(path);
  } catch (e) {
    toast(`Erro ao ler arquivo: ${e}`);
    return null;
  }
}

async function exportJson(obj, defaultName) {
  const path = await saveFileDialogApi({ defaultPath: defaultName, filters: [{ name: "JSON", extensions: ["json"] }], title: "Exportar" });
  if (!path) return;
  try {
    await writeFileApi(path, { text: JSON.stringify(obj, null, 2) });
    toast("Exportado com sucesso");
  } catch (e) {
    toast(`Erro ao exportar: ${e}`);
  }
}

const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "export";

function exportCollection(coll) {
  const reqs = data().requests.filter((r) => r.collection_id === coll.id);
  exportJson(exportPostman(coll, reqs), `${safeFileName(coll.name)}.postman_collection.json`);
}

// ---------- Sending ----------

function scriptRequestToModel(r) {
  let headers = [];
  const h = r.header ?? r.headers;
  if (Array.isArray(h)) headers = h.map((x) => kv(String(x.key), String(x.value)));
  else if (h && typeof h === "object") headers = Object.entries(h).map(([k, v]) => kv(k, String(v)));
  const body = { mode: "none" };
  if (r.body?.mode === "raw") Object.assign(body, { mode: "raw", raw: String(r.body.raw ?? ""), lang: /^\s*[[{]/.test(r.body.raw || "") ? "json" : "text" });
  if (r.body?.mode === "urlencoded") Object.assign(body, { mode: "urlencoded", urlencoded: (r.body.urlencoded || []).map((p) => kv(p.key, String(p.value))) });
  return newRequest({ method: r.method || "GET", url: String(r.url ?? ""), headers, body, auth: { type: "none" } });
}

/**
 * Full pipeline: pre-request scripts → build → Rust → test scripts → history.
 * Always resolves with an entry: { state, response, error, tests, logs, sent, at }.
 */
async function execute(model, { key, iteration = 0, record = true, onUpdate = () => {} } = {}) {
  const collection = findColl(model.collection_id);
  const tests = [];
  const logs = [];
  const entry = { state: "loading", response: null, error: null, tests, logs, sent: null, at: Date.now() };
  const ctx = {
    request: clone(model),
    collection,
    environment: activeEnv(),
    globals: data().globals,
    locals: new Map(),
    iteration,
    sendRequest: async (r) => {
      const sub = scriptRequestToModel(r);
      const built = buildHttpRequest(sub, { collection, scope: buildScope(ctx), settings: data().settings });
      const { bodyPreview, ...payload } = built;
      return sendHttpRequestApi(payload);
    },
  };
  responses.set(key, entry);
  onUpdate(entry);
  let varsChanged = false;

  try {
    for (const code of [collection?.scripts.pre, model.scripts.pre]) {
      const r = await runScript(code, ctx, { eventName: "prerequest", logs, tests });
      varsChanged ||= r.changed;
      if (r.error) throw new Error(`Script pre-request falhou — ${r.error}`);
    }
    const built = buildHttpRequest(ctx.request, { collection, scope: buildScope(ctx), settings: data().settings });
    entry.sent = built;
    inflight.set(key, built.id);
    const { bodyPreview, ...payload } = built;
    const res = await sendHttpRequestApi(payload);
    entry.response = res;
    ctx.response = res;
    for (const code of [collection?.scripts.test, model.scripts.test]) {
      const r = await runScript(code, ctx, { eventName: "test", logs, tests });
      varsChanged ||= r.changed;
    }
  } catch (e) {
    entry.error = typeof e === "string" ? e : e?.message || String(e);
  } finally {
    inflight.delete(key);
  }
  entry.state = entry.response ? "done" : "error";

  if (varsChanged) {
    saveSoon();
    renderEnvPills();
  }
  if (record && data().settings.history_limit > 0 && entry.sent) addHistory(model, entry);
  onUpdate(entry);
  return entry;
}

function addHistory(model, entry) {
  const res = entry.response;
  const h = {
    id: uid(),
    at: entry.at,
    source_id: model.id,
    request: normalizeRequest({ ...clone(model), id: model.id }),
    status: res?.status ?? 0,
    status_text: res?.status_text ?? "",
    time_ms: res?.time_ms ?? null,
    size: res ? res.body_size + res.headers_size : null,
    error: entry.error,
  };
  data().history.unshift(h);
  data().history.length = Math.min(data().history.length, data().settings.history_limit);
  responses.set(`h:${h.id}`, entry);
  saveSoon();
  if (inHistory()) queueListRender();
  else renderSidebar();
}

async function sendCurrent() {
  const req = currentRequest();
  const key = currentKey();
  if (!req || inflight.has(key)) return;
  if (!req.url.trim()) {
    focusUrl();
    return toast("Informe a URL");
  }
  flushSave();
  if (!state.desktopMode) {
    ui.side = "response";
    renderChrome();
  }
  await execute(req, {
    key,
    onUpdate: () => {
      if (currentKey() === key) renderResponse(responses.get(key));
      queueListRender();
    },
  });
}

function cancelCurrent() {
  const id = inflight.get(currentKey());
  if (id) cancelHttpRequestApi(id);
}

// ---------- Actions ----------

function selectItem(id, { openEditor = true } = {}) {
  ui.selectedId = id;
  if (openEditor && !state.desktopMode && id !== null) {
    ui.pane = "editor";
    ui.side = responses.get(currentKey())?.response ? ui.side : "request";
  }
  renderHttp();
}

function setScope(scope) {
  ui.scope = scope;
  ui.query = "";
  ui.editingFolderId = null;
  searchInputs.forEach((i) => (i.value = ""));
  if (!state.desktopMode) ui.pane = "list";
  if (scope === "history") {
    ui.selectedId = state.desktopMode ? data().history[0]?.id ?? null : null;
  } else {
    const visible = visibleRequests();
    if (!visible.some((r) => r.id === ui.selectedId)) ui.selectedId = state.desktopMode ? visible[0]?.id ?? null : null;
  }
  renderHttp();
  listEl.scrollTop = 0;
}

function targetCollectionId() {
  return scopeCollId() ?? currentRequest()?.collection_id ?? data().collections[0].id;
}

function createRequest({ collectionId = targetCollectionId(), folderId = 0, fields = {} } = {}) {
  const req = newRequest({ collection_id: collectionId, folder_id: folderId, ...fields });
  data().requests.push(req);
  const coll = findColl(collectionId);
  if (coll) expandFolder(coll, folderId);
  if (inHistory() || (scopeCollId() !== null && scopeCollId() !== collectionId) || ui.query) {
    ui.scope = `c:${collectionId}`;
    ui.query = "";
    searchInputs.forEach((i) => (i.value = ""));
  }
  saveSoon();
  selectItem(req.id);
  if (!fields.url) requestAnimationFrame(focusUrl);
  return req;
}

function duplicateRequest(id) {
  const src = findReq(id);
  if (!src) return;
  const copyReq = normalizeRequest({ ...clone(src), id: uid(), name: `${src.name} (cópia)`, created_at: Date.now(), updated_at: Date.now() });
  data().requests.splice(data().requests.indexOf(src) + 1, 0, copyReq);
  saveSoon();
  selectItem(copyReq.id);
}

function deleteRequest(id) {
  const req = findReq(id);
  if (!req) return;
  const ids = orderedIds();
  const idx = ids.indexOf(id);
  const next = ids[idx + 1] ?? ids[idx - 1] ?? null;
  const pos = data().requests.indexOf(req);
  data().requests.splice(pos, 1);
  responses.delete(`r:${id}`);
  saveSoon();
  if (ui.selectedId === id && !inHistory()) {
    ui.selectedId = state.desktopMode ? next : null;
    if (!state.desktopMode) ui.pane = "list";
  }
  renderHttp();
  toast(`"${req.name}" apagada`, {
    label: "Desfazer",
    run: () => {
      data().requests.splice(Math.min(pos, data().requests.length), 0, req);
      saveSoon();
      selectItem(req.id, { openEditor: false });
    },
  });
}

function moveRequest(id, collectionId, folderId = 0) {
  const req = findReq(id);
  if (!req) return;
  req.collection_id = collectionId;
  req.folder_id = folderId;
  req.updated_at = Date.now();
  saveSoon();
  renderHttp();
}

function createCollection() {
  const names = new Set(data().collections.map((c) => c.name));
  let name = "Nova Coleção";
  for (let i = 2; names.has(name); i++) name = `Nova Coleção ${i}`;
  const coll = newCollection(name);
  data().collections.push(coll);
  saveSoon();
  ui.editingCollectionId = coll.id;
  ui.scope = `c:${coll.id}`;
  ui.selectedId = null;
  if (!state.desktopMode) ui.pane = "collections";
  renderHttp();
}

function renameCollection(id, name) {
  const coll = findColl(id);
  ui.editingCollectionId = null;
  if (coll && name.trim()) {
    coll.name = name.trim().slice(0, 80);
    saveSoon();
  }
  renderHttp();
}

function duplicateCollection(id) {
  const src = findColl(id);
  if (!src) return;
  const coll = { ...clone(src), id: uid(), name: `${src.name} (cópia)` };
  const folderMap = new Map();
  for (const f of coll.folders) folderMap.set(f.id, uid());
  coll.folders = coll.folders.map((f) => ({ ...f, id: folderMap.get(f.id), parent_id: folderMap.get(f.parent_id) || 0 }));
  data().collections.push(coll);
  for (const r of data().requests.filter((x) => x.collection_id === id)) {
    data().requests.push(normalizeRequest({ ...clone(r), id: uid(), collection_id: coll.id, folder_id: folderMap.get(r.folder_id) || 0 }));
  }
  saveSoon();
  setScope(`c:${coll.id}`);
}

async function deleteCollection(id) {
  const coll = findColl(id);
  if (!coll) return;
  const count = data().requests.filter((r) => r.collection_id === id).length;
  const ok = await confirmDialog({
    title: "Apagar coleção",
    message: `Apagar "${coll.name}"${count ? ` e suas ${plural(count, "requisição", "requisições")}` : ""}? Esta ação não pode ser desfeita.`,
    confirmLabel: "Apagar",
    danger: true,
  });
  if (!ok) return;
  data().collections = data().collections.filter((c) => c.id !== id);
  data().requests = data().requests.filter((r) => r.collection_id !== id);
  if (!data().collections.length) data().collections.push(newCollection("Minha Coleção"));
  saveSoon();
  if (ui.scope === `c:${id}` || currentRequest() === null) setScope(`c:${data().collections[0].id}`);
  else renderHttp();
}

/** Opens `folderId` and the folders above it (no save: the caller saves). */
function expandFolder(coll, folderId) {
  for (let f = coll.folders.find((x) => x.id === folderId); f; f = coll.folders.find((x) => x.id === f.parent_id)) {
    f.collapsed = false;
  }
}

/** New folder in the collection, inside `parentId` (0 = collection root). */
function createFolder(collectionId, parentId = 0) {
  const coll = findColl(collectionId);
  if (!coll) return;
  if (!coll.folders.some((f) => f.id === parentId)) parentId = 0;
  const folder = { id: uid(), name: uniqueFolderName(coll.folders, parentId, "Nova Pasta"), parent_id: parentId, collapsed: false };
  coll.folders.push(folder);
  expandFolder(coll, parentId);
  saveSoon();
  if (ui.scope !== `c:${collectionId}`) setScope(`c:${collectionId}`);
  ui.editingFolderId = folder.id;
  renderList();
}

function renameFolder(coll, folderId, name) {
  const folder = coll.folders.find((f) => f.id === folderId);
  ui.editingFolderId = null;
  if (folder && name.trim()) {
    folder.name = name.trim().slice(0, 80);
    saveSoon();
  }
  renderHttp();
}

/** Deletes the folder, its subfolders and every request inside them. */
async function deleteFolder(coll, folderId) {
  const folder = coll.folders.find((f) => f.id === folderId);
  if (!folder) return;
  const ids = descendantIds(coll.folders, folderId);
  const inside = data().requests.filter((r) => r.collection_id === coll.id && ids.has(r.folder_id));
  if (inside.length || ids.size > 1) {
    const subs = ids.size - 1;
    const parts = [subs && plural(subs, "subpasta", "subpastas"), inside.length && plural(inside.length, "requisição", "requisições")].filter(Boolean);
    const ok = await confirmDialog({
      title: "Apagar pasta",
      message: `Apagar a pasta "${folder.name}" e ${parts.join(" e ")}?`,
      confirmLabel: "Apagar",
      danger: true,
    });
    if (!ok) return;
  }
  removeFolderTree(coll.folders, folderId);
  data().requests = data().requests.filter((r) => !inside.includes(r));
  if (inside.some((r) => r.id === ui.selectedId)) ui.selectedId = null;
  saveSoon();
  renderHttp();
}

/** Moves a folder (with subfolders and requests) inside `parentId` of the same collection. */
function moveFolder(coll, folderId, parentId) {
  const folder = coll.folders.find((f) => f.id === folderId);
  if (!folder || (folder.parent_id || 0) === parentId || !canMoveFolder(coll.folders, folderId, parentId)) return;
  folder.parent_id = parentId;
  // Last among the new siblings.
  coll.folders.splice(coll.folders.indexOf(folder), 1);
  coll.folders.push(folder);
  expandFolder(coll, parentId);
  saveSoon();
  renderList();
}

function saveHistoryToCollection() {
  const h = findHistory(ui.selectedId);
  if (!h) return;
  const collectionId = findColl(h.request.collection_id) ? h.request.collection_id : data().collections[0].id;
  const coll = findColl(collectionId);
  const folderId = coll.folders.some((f) => f.id === h.request.folder_id) ? h.request.folder_id : 0;
  const req = normalizeRequest({ ...clone(h.request), id: uid(), collection_id: collectionId, folder_id: folderId, created_at: Date.now(), updated_at: Date.now() });
  data().requests.push(req);
  const entry = responses.get(`h:${h.id}`);
  if (entry) responses.set(`r:${req.id}`, entry);
  saveSoon();
  ui.scope = `c:${collectionId}`;
  selectItem(req.id);
  toast(`Salva em "${coll.name}"`);
}

async function clearHistory() {
  if (!data().history.length) return;
  const ok = await confirmDialog({ title: "Limpar histórico", message: "Remover todas as requisições do histórico?", confirmLabel: "Limpar", danger: true });
  if (!ok) return;
  for (const h of data().history) responses.delete(`h:${h.id}`);
  data().history = [];
  ui.selectedId = null;
  if (!state.desktopMode && ui.pane === "editor") ui.pane = "list";
  saveSoon();
  renderHttp();
}

function deleteHistoryEntry(id) {
  const ids = orderedIds();
  const idx = ids.indexOf(id);
  data().history = data().history.filter((h) => h.id !== id);
  responses.delete(`h:${id}`);
  if (ui.selectedId === id) {
    ui.selectedId = state.desktopMode ? ids[idx + 1] ?? ids[idx - 1] ?? null : null;
    if (!state.desktopMode) ui.pane = "list";
  }
  saveSoon();
  renderHttp();
}

function setActiveEnv(id) {
  data().active_env = id;
  saveSoon();
  renderEnvPills();
  refreshVariables();
}

/** Pasting a cURL into the URL bar replaces the current request (keeping its place). */
function applyCurl(text) {
  const req = currentRequest();
  if (!req || inHistory()) return;
  try {
    const parsed = parseCurl(text);
    const keep = { id: req.id, collection_id: req.collection_id, folder_id: req.folder_id, created_at: req.created_at, scripts: req.scripts };
    const name = req.name === "Nova Requisição" ? parsed.name : req.name;
    Object.assign(req, parsed, keep, { name, updated_at: Date.now() });
    saveSoon();
    renderHttp();
    toast("cURL importado");
  } catch (e) {
    toast(e.message);
  }
}

function handleImport(result) {
  if (result.kind === "curl") {
    const req = normalizeRequest({ ...result.request, collection_id: result.collectionId, folder_id: 0 });
    data().requests.push(req);
    saveSoon();
    ui.scope = `c:${req.collection_id}`;
    selectItem(req.id);
    toast("Requisição importada");
  } else if (result.kind === "postman") {
    data().collections.push(result.collection);
    data().requests.push(...result.requests);
    saveSoon();
    setScope(`c:${result.collection.id}`);
    toast(`Coleção "${result.collection.name}" importada (${plural(result.requests.length, "requisição", "requisições")})`);
  } else if (result.kind === "env") {
    data().environments.push(result.environment);
    saveSoon();
    renderEnvPills();
    toast(`Ambiente "${result.environment.name}" importado`);
    openEnvironments(result.environment.id);
  }
}

function openEnvironments(initialId = null) {
  environmentsDialog(data(), {
    initialId,
    onChange: () => {
      saveSoon();
      renderEnvPills();
      renderSidebar();
      refreshVariables();
    },
    onSelect: setActiveEnv,
    onExport: (env) => exportJson(exportPostmanEnvironment(env), `${safeFileName(env.name)}.postman_environment.json`),
  });
}

function openCollectionSettings(coll, tab = "general") {
  collectionDialog(coll, {
    tab,
    onChange: () => {
      saveSoon();
      renderSidebar();
      renderList();
      refreshRequestTab();
    },
    onRun: (c) => openRunner(c),
    onExport: exportCollection,
  });
}

let runnerKeys = new Set();

function openRunner(coll = findColl(targetCollectionId())) {
  if (!coll) return;
  // Root requests first, then each folder in tree order (as Postman's runner).
  const order = new Map([0, ...flattenTree(coll.folders).map((e) => e.folder.id)].map((id, i) => [id, i]));
  const reqs = data().requests
    .filter((r) => r.collection_id === coll.id)
    .sort((a, b) => (order.get(a.folder_id) ?? 0) - (order.get(b.folder_id) ?? 0));
  runnerDialog(coll, reqs, {
    run: (req, iteration) => {
      const key = `run:${req.id}:${uid()}`;
      runnerKeys.add(key);
      return execute(req, { key, iteration, record: false }).finally(() => {
        runnerKeys.delete(key);
        responses.delete(key);
      });
    },
    onCancelRun: () => {
      for (const key of runnerKeys) {
        const id = inflight.get(key);
        if (id) cancelHttpRequestApi(id);
      }
    },
  });
}

function openCode() {
  const req = currentRequest();
  if (!req) return;
  try {
    const built = buildHttpRequest(req, { collection: findColl(req.collection_id), scope: scopeFor(req), settings: data().settings });
    codeDialog(built, { copy });
  } catch (e) {
    toast(e.message);
  }
}

function copyAsCurl(req) {
  try {
    const built = buildHttpRequest(req, { collection: findColl(req.collection_id), scope: scopeFor(req), settings: data().settings });
    copy(SNIPPETS[0].gen(built), "cURL copiado");
  } catch (e) {
    toast(e.message);
  }
}

// ---------- Rendering ----------

function renderEnvPills() {
  const env = activeEnv();
  appEl.querySelectorAll(".hx-env-pill").forEach((pill) => {
    pill.classList.toggle("on", !!env);
    pill.querySelector(".hx-env-name").textContent = env ? env.name : "Sem ambiente";
  });
}

function sidebarRow({ scope, name, iconCls, count, editable, collId, onClick, onMenu, dropTarget }) {
  const li = el("li.nt-folder");
  li.dataset.scope = scope || "";
  li.classList.toggle("active", !!scope && ui.scope === scope && !ui.query.trim());
  li.append(icon(`${iconCls} nt-folder-icon`));

  if (collId !== undefined && ui.editingCollectionId === collId) {
    const input = el("input.nt-folder-input", { value: name, maxLength: 80 });
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (save) renameCollection(collId, input.value);
      else {
        ui.editingCollectionId = null;
        renderHttp();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    li.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  } else {
    li.append(el("span.nt-folder-name", {}, name));
  }
  li.append(el("span.nt-folder-count", {}, count ?? ""), icon("fa-solid fa-chevron-right nt-folder-chevron"));

  li.addEventListener("click", onClick || (() => setScope(scope)));
  if (editable) {
    li.addEventListener("dblclick", () => {
      ui.editingCollectionId = collId;
      renderHttp();
    });
  }
  if (onMenu) {
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      onMenu(e.clientX, e.clientY);
    });
  }
  if (dropTarget) {
    li.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-http-req")) return;
      e.preventDefault();
      li.classList.add("drop-target");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("drop-target");
      const id = Number(e.dataTransfer.getData("application/x-http-req"));
      if (id) dropTarget(id);
    });
  }
  return li;
}

function renderSidebar() {
  collectionsEl.innerHTML = "";
  toolsEl.innerHTML = "";
  collectionsEl.append(sidebarRow({ scope: "all", name: "Todas as Requisições", iconCls: "fa-regular fa-folder-open", count: data().requests.length }));
  for (const c of data().collections) {
    collectionsEl.append(
      sidebarRow({
        scope: `c:${c.id}`,
        name: c.name,
        iconCls: "fa-solid fa-box-archive",
        count: data().requests.filter((r) => r.collection_id === c.id).length,
        editable: true,
        collId: c.id,
        onMenu: (x, y) => showCollectionMenu(x, y, c),
        dropTarget: (id) => moveRequest(id, c.id, 0),
      }),
    );
  }
  toolsEl.append(
    sidebarRow({
      scope: "history",
      name: "Histórico",
      iconCls: "fa-solid fa-clock-rotate-left",
      count: data().history.length,
      onMenu: (x, y) => showMenu(x, y, [{ label: "Limpar Histórico", icon: "fa-regular fa-trash-can", danger: true, disabled: !data().history.length, run: clearHistory }]),
    }),
    sidebarRow({
      name: "Ambientes",
      iconCls: "fa-solid fa-layer-group",
      count: data().environments.length,
      onClick: () => openEnvironments(),
    }),
  );
}

function methodTag(method) {
  return el("span.hx-method-tag", { dataset: { method } }, method === "DELETE" ? "DEL" : method === "OPTIONS" ? "OPT" : method);
}

/** "Coleção / Pasta / Subpasta" of a request. */
function requestPath(req) {
  const coll = findColl(req.collection_id);
  const folder = coll && folderPath(coll.folders, req.folder_id);
  return `${coll?.name || ""}${folder ? ` / ${folder}` : ""}`;
}

function renderRequestItem(req, { showColl = false } = {}) {
  const item = el("div.nt-item.hx-item", { draggable: true });
  item.dataset.id = req.id;
  item.classList.toggle("selected", !inHistory() && req.id === ui.selectedId);
  const entry = responses.get(`r:${req.id}`);
  const statusBit =
    entry?.state === "loading"
      ? el("span.hx-spinner.small")
      : entry?.response
        ? el(`span.hx-dot-status.${statusClass(entry.response.status)}`, { title: `${entry.response.status} ${entry.response.status_text}` })
        : entry?.error
          ? el("span.hx-dot-status.err", { title: entry.error })
          : null;

  item.append(
    el("div.hx-item-line", {}, methodTag(req.method), el("span.nt-item-title.hx-item-name", {}, req.name || "Sem nome"), statusBit),
    el("div.hx-item-url", {}, req.url || "Sem URL"),
  );
  if (showColl) {
    item.append(el("div.nt-item-folder", {}, icon("fa-solid fa-box-archive"), requestPath(req)));
  }

  item.addEventListener("click", () => {
    selectItem(req.id);
    if (state.desktopMode) listEl.focus({ preventScroll: true });
  });
  item.addEventListener("dblclick", () => focusName());
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showRequestMenu(e.clientX, e.clientY, req);
  });
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-http-req", String(req.id));
    e.dataTransfer.effectAllowed = "move";
  });
  return item;
}

function renderHistoryItem(h) {
  const item = el("div.nt-item.hx-item", {});
  item.dataset.id = h.id;
  item.classList.toggle("selected", h.id === ui.selectedId);
  const status = h.status
    ? el(`span.hx-status.small.${statusClass(h.status)}`, {}, h.status)
    : el("span.hx-status.small.err", { title: h.error || "" }, "Erro");
  item.append(
    el("div.hx-item-line", {}, methodTag(h.request.method), el("span.nt-item-title.hx-item-name", {}, h.request.name)),
    el("div.hx-item-url", {}, h.request.url),
    el("div.hx-item-meta", {}, status, h.time_ms !== null ? el("span", {}, formatMs(h.time_ms)) : null, el("span.hx-flex"), el("span", {}, formatNoteListDate(h.at))),
  );
  item.addEventListener("click", () => {
    selectItem(h.id);
    if (state.desktopMode) listEl.focus({ preventScroll: true });
  });
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ui.selectedId = h.id;
    renderHttp();
    showHistoryMenu(e.clientX, e.clientY, h);
  });
  return item;
}

function folderHeader(coll, folder, count, depth = 0) {
  const head = el("div.nt-group-label.hx-folder-head", { draggable: ui.editingFolderId !== folder.id });
  if (depth) head.style.setProperty("--depth", depth);
  head.classList.toggle("collapsed", !!folder.collapsed);
  head.append(icon("fa-solid fa-chevron-down hx-folder-caret"), icon("fa-regular fa-folder"));
  if (ui.editingFolderId === folder.id) {
    const input = el("input.nt-folder-input", { value: folder.name, maxLength: 80 });
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (save) renameFolder(coll, folder.id, input.value);
      else {
        ui.editingFolderId = null;
        renderList();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    head.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  } else {
    head.append(el("span.hx-folder-name", {}, folder.name));
  }
  head.append(
    el("span.hx-folder-count", {}, count),
    el("button.hx-folder-add", {
      type: "button",
      title: "Nova requisição nesta pasta",
      onclick: (e) => {
        e.stopPropagation();
        createRequest({ collectionId: coll.id, folderId: folder.id });
      },
    }, icon("fa-solid fa-plus")),
  );
  head.addEventListener("click", () => {
    folder.collapsed = !folder.collapsed;
    saveSoon();
    renderList();
  });
  head.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    ui.editingFolderId = folder.id;
    renderList();
  });
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showFolderMenu(e.clientX, e.clientY, coll, folder);
  });
  // Folders are dragged onto another folder of the same collection (= subfolder).
  head.addEventListener("dragstart", (e) => {
    draggedFolder = { collId: coll.id, id: folder.id };
    e.dataTransfer.setData("application/x-http-folder", String(folder.id));
    e.dataTransfer.effectAllowed = "move";
  });
  head.addEventListener("dragend", () => (draggedFolder = null));
  const accepts = (e) =>
    e.dataTransfer.types.includes("application/x-http-req") ||
    (e.dataTransfer.types.includes("application/x-http-folder") &&
      draggedFolder?.collId === coll.id &&
      canMoveFolder(coll.folders, draggedFolder.id, folder.id));
  head.addEventListener("dragover", (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    head.classList.add("drop-target");
  });
  head.addEventListener("dragleave", () => head.classList.remove("drop-target"));
  head.addEventListener("drop", (e) => {
    e.preventDefault();
    head.classList.remove("drop-target");
    const id = Number(e.dataTransfer.getData("application/x-http-req"));
    const folderId = Number(e.dataTransfer.getData("application/x-http-folder"));
    if (id) moveRequest(id, coll.id, folder.id);
    else if (folderId) moveFolder(coll, folderId, folder.id);
  });
  return head;
}

function groupBox(children) {
  return el("div.nt-group", {}, children);
}

function emptyList(text, action) {
  return el("div.nt-list-empty", {}, el("div", {}, text), action ? el("button.hx-empty-btn", { type: "button", onclick: action.run }, action.label) : null);
}

function renderCollectionList(coll, reqs) {
  const ids = new Set(coll.folders.map((f) => f.id));
  const byFolder = new Map();
  for (const r of reqs) {
    const fid = ids.has(r.folder_id) ? r.folder_id : 0;
    if (!byFolder.has(fid)) byFolder.set(fid, []);
    byFolder.get(fid).push(r);
  }
  // Header counts include the subfolders (pre-order reversed = children before parents).
  const counts = new Map([...byFolder].map(([fid, list]) => [fid, list.length]));
  for (const { folder } of flattenTree(coll.folders).reverse()) {
    if (folder.parent_id) counts.set(folder.parent_id, (counts.get(folder.parent_id) || 0) + (counts.get(folder.id) || 0));
  }
  const root = byFolder.get(0) || [];
  if (root.length) listEl.append(groupBox(root.map((r) => renderRequestItem(r))));
  // Each folder: header, its requests, then its subfolders (hidden while collapsed).
  const collapsed = new Set(coll.folders.filter((f) => f.collapsed).map((f) => f.id));
  for (const { folder, depth, hasChildren } of flattenTree(coll.folders, collapsed)) {
    const inside = byFolder.get(folder.id) || [];
    listEl.append(folderHeader(coll, folder, counts.get(folder.id) || 0, depth));
    if (folder.collapsed) continue;
    const box = inside.length
      ? groupBox(inside.map((r) => renderRequestItem(r)))
      : hasChildren
        ? null
        : el("div.hx-folder-empty", {}, "Pasta vazia — arraste requisições para cá");
    if (box) {
      if (depth) box.style.setProperty("--depth", depth);
      box.classList.add("hx-folder-body");
      listEl.append(box);
    }
  }
  if (!reqs.length && !coll.folders.length) {
    listEl.append(emptyList("Nenhuma requisição", { label: "Criar requisição", run: () => createRequest({ collectionId: coll.id }) }));
  }
}

function renderList() {
  listEl.innerHTML = "";
  const q = ui.query.trim();
  let count = 0;

  if (inHistory()) {
    const items = visibleHistory();
    count = items.length;
    if (!items.length) listEl.append(emptyList(q ? "Nenhum resultado" : "Histórico vazio"));
    let label = null;
    let box = null;
    for (const h of items) {
      const l = noteGroupLabel(h.at);
      if (l !== label) {
        label = l;
        box = groupBox([]);
        listEl.append(el("div.nt-group-label", {}, l), box);
      }
      box.append(renderHistoryItem(h));
    }
  } else {
    const reqs = visibleRequests();
    count = reqs.length;
    const cid = scopeCollId();
    if (!q && cid !== null) renderCollectionList(findColl(cid), reqs);
    else {
      if (!reqs.length) listEl.append(emptyList(q ? "Nenhum resultado" : "Nenhuma requisição"));
      for (const c of data().collections) {
        const inColl = reqs.filter((r) => r.collection_id === c.id);
        if (!inColl.length) continue;
        listEl.append(el("div.nt-group-label", {}, icon("fa-solid fa-box-archive"), " ", c.name), groupBox(inColl.map((r) => renderRequestItem(r, { showColl: !!q }))));
      }
    }
  }

  const label = scopeLabel();
  const countText = inHistory() ? plural(count, "item", "itens") : plural(count, "requisição", "requisições");
  listTitleEl.textContent = label;
  tbScopeEl.textContent = label;
  tbCountEl.textContent = countText;
  countEl.textContent = countText;
  backLabelEl.textContent = label;
}

function queueListRender() {
  if (listRenderQueued) return;
  listRenderQueued = true;
  requestAnimationFrame(() => {
    listRenderQueued = false;
    renderList();
    renderChrome();
  });
}

function renderChrome() {
  appEl.dataset.pane = ui.pane;
  appEl.dataset.side = ui.side;
  appEl.classList.toggle("sidebar-hidden", ui.sidebarHidden);
  const editing = state.activeMainView === "http" && !state.desktopMode && ui.pane === "editor";
  document.body.classList.toggle("http-editing", editing);
  appEl.querySelectorAll(".hx-side-switch [data-side]").forEach((b) => b.classList.toggle("active", b.dataset.side === ui.side));
  const req = currentRequest();
  appEl.querySelectorAll('[data-action="code"], [data-action="request-menu"]').forEach((b) => (b.disabled = !req));
}

function renderEditor() {
  const req = currentRequest();
  reqEl.hidden = !req;
  emptyEl.hidden = !!req;
  if (!req) return;
  const h = inHistory() ? findHistory(ui.selectedId) : null;
  historyBannerEl.hidden = !h;
  if (h) {
    historyTextEl.textContent = `Do histórico · ${formatNoteFullDate(h.at)}`;
  }
  const crumb = findColl(req.collection_id) ? `${requestPath(req)} /` : "";
  loadRequest(req, { readOnly: !!h, crumb });
  renderResponse(responses.get(currentKey()) || null);
}

export function renderHttp() {
  if (!data()) return;
  renderSidebar();
  renderList();
  renderChrome();
  renderEditor();
  renderEnvPills();
}

// ---------- Menus ----------

function showMenu(x, y, items) {
  menuEl.innerHTML = "";
  for (const item of items) {
    if (!item) continue;
    if (item === "sep") {
      menuEl.append(el("div.nt-menu-sep"));
      continue;
    }
    if (item.header) {
      menuEl.append(el("div.nt-menu-header", {}, item.header));
      continue;
    }
    const b = el("button.nt-menu-item", { type: "button", disabled: !!item.disabled }, el("i", { class: item.icon || "" }), item.label);
    b.classList.toggle("danger", !!item.danger);
    b.classList.toggle("indent", !!item.indent);
    if (item.depth) b.style.setProperty("--depth", item.depth);
    b.classList.toggle("checked", !!item.checked);
    b.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menuEl.append(b);
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

function showMenuBelow(anchor, items) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, items);
}

function moveTargets(req) {
  const items = [{ header: "Mover para" }];
  for (const c of data().collections) {
    items.push({ label: c.name, icon: "fa-solid fa-box-archive", indent: true, disabled: req.collection_id === c.id && !req.folder_id, run: () => moveRequest(req.id, c.id, 0) });
    for (const { folder: f, depth } of flattenTree(c.folders)) {
      items.push({
        label: f.name,
        icon: "fa-regular fa-folder",
        indent: true,
        depth: depth + 1,
        disabled: req.collection_id === c.id && req.folder_id === f.id,
        run: () => moveRequest(req.id, c.id, f.id),
      });
    }
  }
  return items;
}

function showRequestMenu(x, y, req) {
  showMenu(x, y, [
    { label: "Enviar", icon: "fa-solid fa-paper-plane", run: () => (selectItem(req.id), sendCurrent()) },
    { label: "Renomear", icon: "fa-solid fa-pen", run: () => (selectItem(req.id), requestAnimationFrame(focusName)) },
    { label: "Duplicar", icon: "fa-regular fa-clone", run: () => duplicateRequest(req.id) },
    { label: "Copiar como cURL", icon: "fa-solid fa-terminal", run: () => copyAsCurl(req) },
    "sep",
    ...moveTargets(req),
    "sep",
    { label: "Apagar", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteRequest(req.id) },
  ]);
}

function showHistoryMenu(x, y, h) {
  showMenu(x, y, [
    { label: "Salvar na Coleção", icon: "fa-regular fa-floppy-disk", run: saveHistoryToCollection },
    { label: "Copiar como cURL", icon: "fa-solid fa-terminal", run: () => copyAsCurl(h.request) },
    "sep",
    { label: "Remover do Histórico", icon: "fa-solid fa-xmark", run: () => deleteHistoryEntry(h.id) },
    { label: "Limpar Histórico", icon: "fa-regular fa-trash-can", danger: true, run: clearHistory },
  ]);
}

function showCollectionMenu(x, y, c) {
  showMenu(x, y, [
    { label: "Nova Requisição", icon: "fa-solid fa-plus", run: () => createRequest({ collectionId: c.id }) },
    { label: "Nova Pasta", icon: "fa-solid fa-folder-plus", run: () => createFolder(c.id) },
    "sep",
    { label: "Configurações (auth, variáveis, scripts)", icon: "fa-solid fa-sliders", run: () => openCollectionSettings(c) },
    { label: "Executar Coleção", icon: "fa-solid fa-forward", run: () => openRunner(c) },
    { label: "Exportar (Postman v2.1)", icon: "fa-solid fa-file-export", run: () => exportCollection(c) },
    "sep",
    {
      label: "Renomear",
      icon: "fa-solid fa-pen",
      run: () => {
        ui.editingCollectionId = c.id;
        if (!state.desktopMode) ui.pane = "collections";
        renderHttp();
      },
    },
    { label: "Duplicar", icon: "fa-regular fa-clone", run: () => duplicateCollection(c.id) },
    { label: "Apagar Coleção", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteCollection(c.id) },
  ]);
}

function showFolderMenu(x, y, coll, folder) {
  showMenu(x, y, [
    { label: "Nova Requisição", icon: "fa-solid fa-plus", run: () => createRequest({ collectionId: coll.id, folderId: folder.id }) },
    { label: "Nova Subpasta", icon: "fa-solid fa-folder-tree", run: () => createFolder(coll.id, folder.id) },
    "sep",
    {
      label: "Renomear Pasta",
      icon: "fa-solid fa-pen",
      run: () => {
        ui.editingFolderId = folder.id;
        renderList();
      },
    },
    folder.parent_id && { label: "Mover para a Raiz da Coleção", icon: "fa-solid fa-arrow-turn-up", run: () => moveFolder(coll, folder.id, 0) },
    "sep",
    { label: "Apagar Pasta", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteFolder(coll, folder.id) },
  ]);
}

function showEnvMenu(anchor) {
  const active = data().active_env;
  showMenuBelow(anchor, [
    { label: "Sem ambiente", icon: active === null ? "fa-solid fa-check" : "", run: () => setActiveEnv(null) },
    ...data().environments.map((e) => ({ label: e.name, icon: e.id === active ? "fa-solid fa-check" : "", run: () => setActiveEnv(e.id) })),
    "sep",
    { label: "Gerenciar ambientes…", icon: "fa-solid fa-sliders", run: () => openEnvironments() },
  ]);
}

function showListMenu(anchor) {
  const c = findColl(scopeCollId());
  const items = inHistory()
    ? [{ label: "Limpar Histórico", icon: "fa-regular fa-trash-can", danger: true, disabled: !data().history.length, run: clearHistory }]
    : [
        c && { label: "Nova Pasta", icon: "fa-solid fa-folder-plus", run: () => createFolder(c.id) },
        c && { label: "Configurações da Coleção", icon: "fa-solid fa-sliders", run: () => openCollectionSettings(c) },
        c && { label: "Executar Coleção", icon: "fa-solid fa-forward", run: () => openRunner(c) },
        c && { label: "Exportar Coleção", icon: "fa-solid fa-file-export", run: () => exportCollection(c) },
        c && "sep",
        { label: "Importar cURL / Postman…", icon: "fa-solid fa-file-import", run: openImport },
        { label: "Ambientes…", icon: "fa-solid fa-layer-group", run: () => openEnvironments() },
      ];
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.top - 8 - Math.min(items.length * 30, 260), items);
}

function showCurrentRequestMenu(anchor) {
  const req = currentRequest();
  if (!req) return;
  const r = anchor.getBoundingClientRect();
  if (inHistory()) showHistoryMenu(r.left, r.bottom + 4, findHistory(ui.selectedId));
  else showRequestMenu(r.left - 150, r.bottom + 4, req);
}

function openImport() {
  importDialog({
    collections: data().collections,
    collectionId: targetCollectionId(),
    onImport: handleImport,
    readFile: readImportFile,
  });
}

// ---------- Event wiring ----------

const ACTIONS = {
  "new-request": () => createRequest(),
  "new-collection": createCollection,
  import: openImport,
  runner: () => openRunner(),
  code: openCode,
  "manage-envs": () => openEnvironments(),
  "env-menu": (btn) => showEnvMenu(btn),
  "list-menu": (btn) => showListMenu(btn),
  "request-menu": (btn) => showCurrentRequestMenu(btn),
  "save-history": saveHistoryToCollection,
  "show-collections": () => {
    ui.pane = "collections";
    renderHttp();
  },
  "show-list": () => {
    if (saveTimer) flushSave();
    ui.pane = "list";
    renderHttp();
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
};

function moveSelection(delta) {
  const ids = orderedIds();
  if (!ids.length) return;
  const idx = ids.indexOf(ui.selectedId);
  const next = ids[Math.max(0, Math.min(ids.length - 1, idx + delta))];
  if (next !== undefined && next !== ui.selectedId) {
    selectItem(next, { openEditor: false });
    listEl.querySelector(`.hx-item[data-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

function handleGlobalKeydown(e) {
  if (state.activeMainView !== "http" || !data()) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === "Escape") {
    if (isModalOpen()) return closeModal();
    if (!menuEl.hidden) return closeMenu();
    if (searchInputs.includes(document.activeElement) && ui.query) {
      document.activeElement.value = "";
      ui.query = "";
      return renderHttp();
    }
    if (!state.desktopMode && ui.pane === "editor") return ACTIONS["show-list"]();
    return;
  }
  if (isModalOpen()) return;
  if (mod && e.key === "Enter") {
    e.preventDefault();
    return currentKey() && inflight.has(currentKey()) ? cancelCurrent() : sendCurrent();
  }
  if (mod && !e.shiftKey && key === "n") {
    e.preventDefault();
    return createRequest();
  }
  if (mod && !e.shiftKey && key === "s") {
    e.preventDefault();
    flushSave();
    return toast("Salvo");
  }
  if (mod && !e.shiftKey && key === "l" && currentRequest()) {
    e.preventDefault();
    if (!state.desktopMode) {
      ui.pane = "editor";
      ui.side = "request";
      renderChrome();
    }
    return focusUrl();
  }
  if (mod && !e.shiftKey && key === "f") {
    e.preventDefault();
    const input = state.desktopMode ? searchInputs[0] : searchInputs[1];
    if (!state.desktopMode && ui.pane !== "list") {
      ui.pane = "list";
      renderHttp();
    }
    input.focus();
    input.select();
  }
}

function seedExamples(d) {
  const coll = d.collections[0];
  coll.name = "Exemplos";
  coll.variables = [kv("baseUrl", "https://jsonplaceholder.typicode.com")];
  const folder = { id: uid(), name: "Posts", parent_id: 0, collapsed: false };
  coll.folders.push(folder);
  d.requests.push(
    newRequest({
      collection_id: coll.id,
      folder_id: folder.id,
      name: "Listar posts",
      url: "{{baseUrl}}/posts?_limit=5",
      params: [kv("_limit", "5")],
      scripts: { pre: "", test: 'pm.test("Status 200", () => pm.response.to.have.status(200));\npm.test("Retorna 5 posts", () => {\n  pm.expect(pm.response.json()).to.have.lengthOf(5);\n});' },
    }),
    newRequest({
      collection_id: coll.id,
      folder_id: folder.id,
      name: "Buscar post",
      url: "{{baseUrl}}/posts/:id",
      path_vars: [kv("id", "1")],
      scripts: { pre: "", test: 'const post = pm.response.json();\npm.test("Tem título", () => pm.expect(post).to.have.property("title"));\npm.collectionVariables.set("ultimoPost", post.id);' },
    }),
    newRequest({
      collection_id: coll.id,
      folder_id: folder.id,
      name: "Criar post",
      method: "POST",
      url: "{{baseUrl}}/posts",
      body: { mode: "raw", lang: "json", raw: '{\n  "title": "Olá do TodoRS",\n  "body": "Criado por {{$randomFullName}}",\n  "userId": 1\n}' },
      scripts: { pre: "", test: 'pm.test("Criado (201)", () => pm.response.to.have.status(201));' },
    }),
    newRequest({ collection_id: coll.id, name: "Echo com cabeçalhos", url: "https://httpbin.org/anything", headers: [kv("X-Exemplo", "{{$guid}}")] }),
  );
}

/** Called from main.js with the raw contents of http.json (null on first run). */
export function setHttpData(raw) {
  const firstRun = !raw || typeof raw !== "object" || !Array.isArray(raw.collections);
  state.http = normalizeHttpData(raw);
  if (firstRun) {
    seedExamples(state.http);
    saveSoon();
  }
  if (!ui.scope) ui.scope = `c:${state.http.collections[0].id}`;
  renderHttp();
}

export function initHttp() {
  initHttpEditor({
    getScope: () => scopeFor(currentRequest()),
    getCollection: (req) => findColl(req.collection_id),
    onChange: (req, { list }) => {
      req.updated_at = Date.now();
      saveSoon();
      if (list) queueListRender();
    },
    onSend: sendCurrent,
    onCancel: cancelCurrent,
    onImportCurl: applyCurl,
    pickFile,
    onEditCollection: openCollectionSettings,
    saveResponse,
    copy,
    toast,
    onGlobalSettings: saveSoon,
    onClearCookies: async () => {
      await clearHttpCookiesApi();
      toast("Cookies da sessão apagados");
    },
  });
  attachVarAutocomplete(appEl, document.getElementById("hx-suggest"), () => scopeFor(currentRequest()));

  appEl.addEventListener("mousedown", (e) => {
    if (!menuEl.hidden && !e.target.closest("#hx-menu")) closeMenu();
  });

  appEl.addEventListener("click", (e) => {
    const side = e.target.closest(".hx-side-switch [data-side]");
    if (side) {
      ui.side = side.dataset.side;
      return renderChrome();
    }
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn && !actionBtn.disabled && appEl.contains(actionBtn)) {
      e.stopPropagation();
      ACTIONS[actionBtn.dataset.action]?.(actionBtn);
    }
  });

  for (const input of searchInputs) {
    input.addEventListener("input", () => {
      ui.query = input.value;
      searchInputs.forEach((i) => i !== input && (i.value = input.value));
      renderList();
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
      if (inHistory()) deleteHistoryEntry(ui.selectedId);
      else deleteRequest(ui.selectedId);
    } else if (e.key === "Enter" && currentRequest()) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) sendCurrent();
      else focusUrl();
    }
  });
  listEl.addEventListener("scroll", closeMenu);

  document.addEventListener("keydown", handleGlobalKeydown);

  document.addEventListener("mainviewchange", () => {
    closeMenu();
    if (state.activeMainView !== "http") {
      closeModal();
      renderChrome();
      return;
    }
    if (!state.desktopMode && ui.pane === "editor" && !currentRequest()) ui.pane = "list";
    renderHttp();
  });

  document.addEventListener("windowmodechange", () => {
    closeMenu();
    if (!data()) return;
    if (state.desktopMode) {
      ui.sidebarHidden = false;
      if (!currentRequest()) {
        const first = inHistory() ? data().history[0]?.id : visibleRequests()[0]?.id;
        ui.selectedId = first ?? null;
      }
    } else if (ui.pane === "editor" && !currentRequest()) {
      ui.pane = "list";
    }
    renderHttp();
  });

  window.addEventListener("beforeunload", () => {
    if (saveTimer) flushSave();
  });
}

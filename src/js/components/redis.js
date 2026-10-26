import { state } from "../state.js";
import { el, icon } from "../utils/dom.js";
import { escapeHtml } from "../utils/noteContent.js";
import { redisApi, saveFileDialogApi, writeFileApi } from "../api.js";
import {
  normalizeRedisData,
  newConnection,
  normalizeConnection,
  connConfig,
  connLabel,
  addHistory,
  uid,
  TOOLS,
  TYPES,
  REFRESH_OPTIONS,
  typeInfo,
  keyTreeRows,
  keyId,
  bulkLabel,
  argOf,
  respText,
  respInt,
  parseInfo,
  keyspace,
  parseTtl,
} from "../utils/redisModel.js";
import { fmtNum } from "../utils/rabbitModel.js";
import { createKeyTab } from "./redisKey.js";
import { createConsoleTab, forgetDocs } from "./redisConsole.js";
import { overviewView, configView, slowlogView, clientsView, monitorView, pubsubView, memoryView, clusterView } from "./redisViews.js";
import { connectionDialog, newKeyDialog, ttlDialog, promptDialog, formDialog, dangerConfirm, rdsConfirm, isRdsModalOpen, closeRdsModal } from "./redisDialogs.js";
import { enterDesktopMode, exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";
import { registerApp } from "../appLifecycle.js";
import { SOLO_APP } from "../windowContext.js";

// App "Redis": conexões e árvore de chaves (SCAN incremental, virtualizada) na barra lateral;
// abas de chave, console e ferramentas (visão geral, configuração, slowlog, clientes, Monitor,
// Pub/Sub, análise de memória, Cluster). Bandeja: resumo de cada conexão.

const appEl = document.getElementById("rds-app");
const connsEl = document.getElementById("rds-conns");
const keysEl = document.getElementById("rds-keys");
const tabsEl = document.getElementById("rds-tabs");
const tabBodyEl = document.getElementById("rds-tab-body");
const menuEl = document.getElementById("rds-menu");
const toastEl = document.getElementById("rds-toast");
const compactEl = document.getElementById("rds-compact-list");
const titleEl = document.getElementById("rds-tb-title");
const subEl = document.getElementById("rds-tb-sub");
const pillEl = document.getElementById("rds-live-pill");
const refreshLabelEl = document.getElementById("rds-refresh-label");

const ROW_H = 22;
const SCAN_ALL_LIMIT = 200_000;

let D = normalizeRedisData(null);
let loaded = false;
/** connId -> { state: idle|connecting|connected|error, info, error, pending, summary } */
const statuses = new Map();
/** `${connId}:${db}` -> estado da árvore de chaves */
const keyStates = new Map();
/** tabId -> controlador */
const controllers = new Map();
/** Monitor/assinaturas/análises em andamento: id -> { id, conn_id, label } */
const lives = new Map();
let lastRefresh = 0;

const data = () => D;
const conn = (id) => D.connections.find((c) => c.id === id) || null;
const activeConn = () => conn(D.ui.conn_id);
const status = (id) => statuses.get(id) || { state: "idle" };
const dbOf = (c) => (c ? (Number.isInteger(D.ui.dbs[c.id]) ? D.ui.dbs[c.id] : c.db) : 0);

// ---------- Persistência ----------

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    redisApi.save(D).catch((e) => toast(String(e)));
  }, 500);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  return redisApi.save(D).catch((e) => toast(String(e)));
}

// ---------- Toast / menus / clipboard ----------

let toastTimer = 0;
function toast(message, action = null) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.append(el("span", { title: message }, message));
  if (action) toastEl.append(el("button", { type: "button", onclick: () => ((toastEl.hidden = true), action.run()) }, action.label));
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 8000 : String(message).length > 80 ? 6500 : 3000);
}

async function copy(text, message = "Copiado") {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Não foi possível copiar");
  }
}

function showMenu(x, y, items) {
  menuEl.innerHTML = "";
  let lastSep = true;
  for (const item of items) {
    if (!item) continue;
    if (item === "sep") {
      if (!lastSep) menuEl.append(el("div.nt-menu-sep"));
      lastSep = true;
      continue;
    }
    lastSep = false;
    if (item.header) {
      menuEl.append(el("div.nt-menu-header", {}, item.header));
      continue;
    }
    const b = el("button.nt-menu-item", { type: "button", disabled: !!item.disabled }, el("i", { class: item.icon || "" }), item.label);
    b.classList.toggle("danger", !!item.danger);
    b.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menuEl.append(b);
  }
  if (menuEl.lastElementChild?.classList.contains("nt-menu-sep")) menuEl.lastElementChild.remove();
  menuEl.classList.toggle("over-modal", isRdsModalOpen());
  menuEl.hidden = false;
  const host = appEl.getBoundingClientRect();
  const left = Math.min(x - host.left, host.width - menuEl.offsetWidth - 6);
  const top = Math.min(y - host.top, host.height - menuEl.offsetHeight - 6);
  menuEl.style.left = `${Math.max(6, left)}px`;
  menuEl.style.top = `${Math.max(6, top)}px`;
}

function showMenuBelow(anchor, items) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, items);
}

function closeMenu() {
  menuEl.hidden = true;
}

/** Confirmação destrutiva; "ambiente sensível" exige digitar o nome. */
function danger(c, { title, message, name, confirmLabel }) {
  return dangerConfirm({ title, message, name: name || (c ? connLabel(c) : ""), confirmLabel, requireName: !!c?.protected });
}

async function saveText(fileName, text) {
  const ext = fileName.split(".").pop();
  const path = await saveFileDialogApi({ defaultPath: fileName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }], title: "Exportar" });
  if (!path) return;
  try {
    await writeFileApi(path, { text });
    toast("Arquivo salvo");
  } catch (e) {
    toast(String(e));
  }
}

// ---------- Conexões ----------

const cfg = (c) => connConfig(c);

async function ensureConnected(c) {
  const st = status(c.id);
  if (st.state === "connected") return st.info;
  if (st.pending) return st.pending;
  const pending = (async () => {
    try {
      const info = await redisApi.connect(cfg(c));
      statuses.set(c.id, { state: "connected", info });
      return info;
    } catch (e) {
      statuses.set(c.id, { state: "error", error: String(e) });
      throw e;
    } finally {
      renderAll();
    }
  })();
  statuses.set(c.id, { state: "connecting", pending });
  renderConns();
  return pending;
}

/** Executa um comando. Resposta de erro do Redis (WRONGTYPE…) vem como { t: "err" }; falha de conexão rejeita. */
async function exec(c, db, args, opts = {}) {
  await ensureConnected(c);
  return redisApi.exec(cfg(c), db, args, opts);
}

async function pipeline(c, db, cmds, opts = {}) {
  await ensureConnected(c);
  return redisApi.pipeline(cfg(c), db, cmds, opts);
}

async function disconnect(c) {
  for (const l of [...lives.values()].filter((x) => x.conn_id === c.id)) await redisApi.liveStop(l.id);
  await redisApi.disconnect(c.id);
  statuses.delete(c.id);
  forgetDocs(c.id);
  for (const k of [...keyStates.keys()]) if (k.startsWith(`${c.id}:`)) keyStates.delete(k);
  renderAll();
}

async function newConnectionDialog() {
  if (!state.desktopMode) await enterDesktopMode();
  connectionDialog(newConnection(), {
    isNew: true,
    onCopy: (url) => copy(url, "URL copiada"),
    onSave: async (c, secrets) => {
      D.connections.push(c);
      await storeSecrets(c.id, secrets);
      await saveNow();
      selectConnection(c.id);
    },
  });
}

async function storeSecrets(connId, secrets) {
  for (const [kind, value] of Object.entries(secrets || {})) {
    if (value === undefined) continue;
    await redisApi.setSecret(connId, kind, value).catch((e) => toast(String(e)));
  }
}

async function editConnection(c) {
  const saved = await redisApi.hasSecrets(c.id);
  connectionDialog(c, {
    isNew: false,
    saved,
    onCopy: (url) => copy(url, "URL copiada"),
    onSave: async (next, secrets) => {
      const i = D.connections.findIndex((x) => x.id === c.id);
      if (i < 0) return;
      D.connections[i] = next;
      await storeSecrets(c.id, secrets);
      await saveNow();
      await disconnect(next);
      renderAll();
      if (D.ui.conn_id === c.id) loadKeys(next, true);
    },
    onDelete: () => deleteConnection(c),
  });
}

async function deleteConnection(c) {
  const ok = await rdsConfirm({ title: "Excluir conexão?", message: `"${connLabel(c)}" será removida (as abas dela fecham e as senhas saem do cofre do sistema). Os dados no servidor não são tocados.`, confirmLabel: "Excluir", danger: true });
  if (!ok) return;
  await removeConnection(c);
}

async function removeConnection(c) {
  for (const t of D.ui.tabs.filter((t) => t.conn_id === c.id)) await closeTab(t.id, { force: true });
  await disconnect(c);
  await redisApi.forgetSecrets(c.id);
  D.connections = D.connections.filter((x) => x.id !== c.id);
  delete D.history[c.id];
  delete D.ui.dbs[c.id];
  if (D.ui.conn_id === c.id) D.ui.conn_id = D.connections[0]?.id || null;
  await saveNow();
  renderAll();
}

function duplicateConnection(c) {
  const copyConn = normalizeConnection({ ...structuredClone(c), id: uid(), name: `${connLabel(c)} (cópia)` });
  D.connections.push(copyConn);
  saveNow();
  renderAll();
  editConnection(copyConn);
}

function selectConnection(id) {
  D.ui.conn_id = id;
  saveSoon();
  renderAll();
  const c = conn(id);
  if (c) loadKeys(c);
}

async function selectDb(c, db) {
  D.ui.conn_id = c.id;
  D.ui.dbs[c.id] = db;
  saveSoon();
  renderAll();
  loadKeys(c);
}

function connMenu(c) {
  const st = status(c.id);
  return [
    st.state === "connected" ? { label: "Desconectar", icon: "fa-solid fa-plug-circle-xmark", run: () => disconnect(c) } : { label: "Conectar", icon: "fa-solid fa-plug", run: () => selectConnection(c.id) },
    { label: "Console", icon: "fa-solid fa-terminal", run: () => openConsole(c, dbOf(c)) },
    { label: "Nova chave…", icon: "fa-solid fa-key", run: () => newKey(c) },
    "sep",
    { label: "Editar conexão…", icon: "fa-solid fa-pen", run: () => editConnection(c) },
    { label: "Duplicar", icon: "fa-regular fa-clone", run: () => duplicateConnection(c) },
    "sep",
    { label: "Mover para cima", icon: "fa-solid fa-arrow-up", disabled: D.connections[0] === c, run: () => moveConn(c, -1) },
    { label: "Mover para baixo", icon: "fa-solid fa-arrow-down", disabled: D.connections[D.connections.length - 1] === c, run: () => moveConn(c, 1) },
    "sep",
    { label: "Esvaziar o banco (FLUSHDB)…", icon: "fa-solid fa-dumpster-fire", danger: true, run: () => flushDb(c, dbOf(c)) },
    { label: "Excluir conexão…", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteConnection(c) },
  ];
}

function moveConn(c, delta) {
  const i = D.connections.indexOf(c);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= D.connections.length) return;
  D.connections.splice(i, 1);
  D.connections.splice(j, 0, c);
  saveSoon();
  renderAll();
}

async function flushDb(c, db) {
  const ok = await danger(c, { title: `Esvaziar db${db}?`, message: `Todas as chaves de db${db} em "${connLabel(c)}" serão apagadas (FLUSHDB ASYNC). Não dá para desfazer.`, name: `db${db}`, confirmLabel: "Esvaziar" });
  if (!ok) return;
  const r = await exec(c, db, ["FLUSHDB", "ASYNC"]).catch((e) => ({ t: "err", v: String(e) }));
  toast(r.t === "err" ? r.v : `db${db} esvaziado`);
  for (const t of D.ui.tabs.filter((t) => t.conn_id === c.id && t.db === db && t.type === "key")) controllers.get(t.id)?.reload?.();
  loadKeys(c, true);
}

// ---------- Barra lateral: conexões ----------

function renderConns() {
  connsEl.innerHTML = "";
  if (!D.connections.length) {
    connsEl.append(el("div.rmq-tree-empty", {}, el("p", {}, "Nenhuma conexão."), el("button.hx-btn.primary", { type: "button", onclick: newConnectionDialog }, icon("fa-solid fa-plus"), " Nova conexão")));
    return;
  }
  for (const c of D.connections) {
    const st = status(c.id);
    const on = D.ui.conn_id === c.id;
    const row = el(
      "div.rmq-conn",
      {
        class: `rmq-conn${on ? " on" : ""}`,
        style: c.color ? `--conn:${c.color}` : "",
        title: st.error || `${c.mode} · ${c.mode === "sentinel" ? c.nodes.join(", ") : `${c.host}:${c.port}`}${c.ssh ? ` · SSH ${c.ssh.host}` : ""}`,
        onclick: () => selectConnection(c.id),
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, connMenu(c));
        },
      },
      el("span", { class: `dbx-state ${st.state}` }),
      el("span.rmq-conn-name", {}, connLabel(c)),
      c.mode !== "standalone" ? el("span.rds-mode", {}, c.mode === "cluster" ? "cluster" : "sentinel") : null,
      c.ssh ? icon("fa-solid fa-route rds-ssh-ic") : null,
      c.read_only ? icon("fa-solid fa-lock rds-ro") : null,
      c.protected ? icon("fa-solid fa-shield-halved rmq-prot") : null,
      el("button.hx-icon-btn.rmq-conn-more", { type: "button", title: "Opções", onclick: (e) => (e.stopPropagation(), showMenuBelow(e.currentTarget, connMenu(c))) }, icon("fa-solid fa-ellipsis")),
    );
    connsEl.append(row);
    if (!on) continue;
    if (st.state === "error") connsEl.append(el("div.dbx-error.rds-conn-err", {}, st.error, el("button.hx-btn.small", { type: "button", onclick: () => (statuses.delete(c.id), selectConnection(c.id)) }, "Tentar de novo")));
    const tools = el("div.rds-tools", { style: c.color ? `--conn:${c.color}` : "" });
    const cluster = st.info?.mode === "cluster";
    for (const t of TOOLS) {
      if (t.cluster && !cluster) continue;
      const active = D.ui.tabs.find((x) => x.id === D.ui.active_tab);
      tools.append(
        el(
          "button.rds-tool",
          { type: "button", class: `rds-tool${active?.conn_id === c.id && active?.type === t.id ? " on" : ""}`, title: t.label, onclick: () => (t.id === "console" ? openConsole(c, dbOf(c)) : openTool(c, t.id)) },
          icon(t.icon),
          el("span", {}, t.label),
          [...lives.values()].some((l) => l.conn_id === c.id && l.tool === t.id) ? el("i.fa-solid.fa-circle.rmq-rec-dot.pulse") : null,
        ),
      );
    }
    connsEl.append(tools);
  }
}

// ---------- Barra lateral: chaves ----------

function keyState(c, db) {
  const k = `${c.id}:${db}`;
  let ks = keyStates.get(k);
  if (!ks) {
    ks = { conn_id: c.id, db, keys: new Map(), cursor: "", done: false, loading: false, error: "", pattern: "", type: "", expanded: new Set(), selected: null, scanAll: false, total: null };
    keyStates.set(k, ks);
  }
  return ks;
}

/** Recomeça a árvore (padrão/tipo atuais) e carrega a 1ª página. */
async function loadKeys(c, reset = true) {
  if (!c) return;
  const db = dbOf(c);
  const ks = keyState(c, db);
  ks.started = true;
  if (reset) {
    ks.keys.clear();
    ks.cursor = "";
    ks.done = false;
    ks.error = "";
  }
  renderKeys();
  try {
    await ensureConnected(c);
  } catch {
    return renderKeys();
  }
  updateTotal(c, db);
  return scanMore(c, ks);
}

async function updateTotal(c, db) {
  const ks = keyState(c, db);
  try {
    const r = await exec(c, db, ["DBSIZE"]);
    ks.total = r.t === "map" ? r.v.reduce((a, [, v]) => a + respInt(v), 0) : respInt(r);
  } catch {
    ks.total = null;
  }
  renderKeysInfo();
}

async function scanMore(c, ks, { all = false } = {}) {
  if (ks.loading || ks.done) return;
  ks.loading = true;
  ks.scanAll = all;
  renderKeysInfo();
  try {
    do {
      const page = await redisApi.scan(cfg(c), ks.db, { cursor: ks.cursor, pattern: ks.pattern, type: ks.type, count: D.ui.scan_count, limit: D.ui.scan_count });
      for (const e of page.keys) ks.keys.set(keyId(e.k), e);
      ks.cursor = page.cursor || "";
      ks.done = !page.cursor;
      renderKeyRows();
      renderKeysInfo();
    } while (ks.scanAll && !ks.done && ks.keys.size < SCAN_ALL_LIMIT && keyStates.get(`${ks.conn_id}:${ks.db}`) === ks);
  } catch (e) {
    ks.error = String(e);
  } finally {
    ks.loading = false;
    ks.scanAll = false;
    renderKeysInfo();
  }
}

let keysUi = null;

function renderKeys() {
  const c = activeConn();
  keysEl.innerHTML = "";
  keysUi = null;
  if (!c) return;
  const st = status(c.id);
  const db = dbOf(c);
  const ks = keyState(c, db);
  const dbCount = st.info?.databases || 16;
  const dbSel = el("select.hx-select.small.rds-db", { title: "Banco", onchange: () => selectDb(c, Number(dbSel.value)) }, ...Array.from({ length: Math.max(1, dbCount) }, (_, n) => el("option", { value: n, selected: n === db }, `db${n}`)));
  const typeSel = el(
    "select.hx-select.small",
    { title: "Filtrar por tipo (SCAN TYPE)", onchange: () => ((ks.type = typeSel.value), loadKeys(c)) },
    el("option", { value: "" }, "Todos os tipos"),
    ...Object.entries(TYPES).map(([t, info]) => el("option", { value: t, selected: ks.type === t }, info.label)),
  );
  const search = el("input", {
    type: "search",
    value: ks.pattern,
    placeholder: "Padrão: usuario:* (Enter)",
    spellcheck: false,
    autocomplete: "off",
    onkeydown: (e) => {
      if (e.key === "Enter") {
        ks.pattern = search.value.trim();
        loadKeys(c);
      }
    },
    onsearch: () => {
      ks.pattern = search.value.trim();
      loadKeys(c);
    },
  });
  const viewBtn = el("button.hx-icon-btn", { type: "button", title: D.ui.view === "tree" ? "Ver como lista" : "Ver como árvore", onclick: () => ((D.ui.view = D.ui.view === "tree" ? "list" : "tree"), saveSoon(), renderKeys()) }, icon(D.ui.view === "tree" ? "fa-solid fa-list" : "fa-solid fa-folder-tree"));
  const head = el(
    "div.rds-keys-head",
    {},
    dbSel,
    typeSel,
    el("span.hx-flex"),
    viewBtn,
    el("button.hx-icon-btn", { type: "button", title: "Nova chave (Ctrl+N)", onclick: () => newKey(c) }, icon("fa-solid fa-plus")),
    el("button.hx-icon-btn", { type: "button", title: "Recarregar chaves", onclick: () => loadKeys(c) }, icon("fa-solid fa-rotate")),
    el("button.hx-icon-btn", { type: "button", title: "Mais", onclick: (e) => keysMenu(c, ks, e.currentTarget) }, icon("fa-solid fa-ellipsis")),
  );
  const info = el("div.rds-keys-info");
  const list = el("div.rds-key-list", { tabindex: "0" });
  const inner = el("div.rds-key-inner");
  list.append(inner);
  keysEl.append(head, el("label.db-search.rds-key-search", {}, icon("fa-solid fa-magnifying-glass"), search), info, list);
  keysUi = { c, ks, info, list, inner, rows: [] };
  list.addEventListener("scroll", () => paintRows());
  new ResizeObserver(() => paintRows()).observe(list);
  list.addEventListener("click", (e) => onKeyClick(e, false));
  list.addEventListener("dblclick", (e) => onKeyClick(e, true));
  list.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".rds-krow");
    if (!row) return;
    e.preventDefault();
    const r = keysUi.rows[Number(row.dataset.i)];
    if (r) rowMenu(r, e);
  });
  list.addEventListener("keydown", onKeysKeydown);
  renderKeyRows();
  renderKeysInfo();
}

function renderKeysInfo() {
  if (!keysUi) return;
  const { ks, info, c } = keysUi;
  const st = status(c.id);
  info.innerHTML = "";
  if (st.state === "connecting") return info.append(icon("fa-solid fa-spinner fa-spin"), " Conectando…");
  if (st.state === "error") return info.append(el("span.rds-err", {}, "Sem conexão"));
  if (ks.error) info.append(el("span.rds-err", { title: ks.error }, ks.error));
  const parts = [
    el("span", {}, `${fmtNum(ks.keys.size)}${ks.done ? "" : "+"} chave(s)${ks.total !== null && !ks.pattern && !ks.type ? ` de ${fmtNum(ks.total)}` : ""}`),
    ks.loading ? icon("fa-solid fa-spinner fa-spin") : null,
    el("span.hx-flex"),
    !ks.done && !ks.loading ? el("button.rds-link", { type: "button", onclick: () => scanMore(c, ks) }, "carregar mais") : null,
    !ks.done && !ks.loading ? el("button.rds-link", { type: "button", title: `Até ${fmtNum(SCAN_ALL_LIMIT)} chaves`, onclick: () => scanMore(c, ks, { all: true }) }, "tudo") : null,
    ks.loading && ks.scanAll ? el("button.rds-link", { type: "button", onclick: () => (ks.scanAll = false) }, "parar") : null,
  ];
  info.append(...parts.filter(Boolean));
}

function renderKeyRows() {
  if (!keysUi) return;
  const { ks } = keysUi;
  keysUi.rows = keyTreeRows([...ks.keys.values()], keysUi.c.separator, ks.expanded, { flat: D.ui.view === "list" });
  keysUi.inner.style.height = `${keysUi.rows.length * ROW_H}px`;
  paintRows();
}

function paintRows() {
  if (!keysUi) return;
  const { list, inner, rows, ks } = keysUi;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - 10);
  const last = Math.min(rows.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW_H) + 10);
  let html = "";
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const pad = 6 + r.depth * 14;
    if (r.kind === "folder") {
      html += `<div class="rds-krow folder" data-i="${i}" style="top:${i * ROW_H}px;padding-left:${pad}px"><span class="dbx-caret"><i class="fa-solid fa-chevron-${r.open ? "down" : "right"}"></i></span><i class="fa-regular fa-folder${r.open ? "-open" : ""} rds-kicon"></i><span class="rds-klabel">${escapeHtml(r.label)}</span><span class="dbx-meta">${fmtNum(r.count)}</span></div>`;
    } else {
      const t = typeInfo(r.entry.type);
      const sel = ks.selected === keyId(r.entry.k);
      html += `<div class="rds-krow key${sel ? " sel" : ""}" data-i="${i}" style="top:${i * ROW_H}px;padding-left:${pad + 12}px" title="${escapeHtml(r.full || r.label)}"><span class="rds-type sm" style="--t:${t.color}">${escapeHtml(t.short)}</span><span class="rds-klabel${r.entry.k.t === "bin" ? " bin" : ""}">${escapeHtml(r.label)}</span></div>`;
    }
  }
  inner.innerHTML = html;
}

function onKeyClick(e, dbl) {
  const row = e.target.closest(".rds-krow");
  if (!row) return;
  const r = keysUi.rows[Number(row.dataset.i)];
  if (!r) return;
  if (r.kind === "folder") {
    if (dbl && !e.target.closest(".dbx-caret")) return;
    toggleFolder(r.path);
    return;
  }
  keysUi.ks.selected = keyId(r.entry.k);
  paintRows();
  openKey(keysUi.c, keysUi.ks.db, r.entry.k, { pin: dbl });
}

function toggleFolder(path, open) {
  const ks = keysUi.ks;
  const isOpen = ks.expanded.has(path);
  if (open === undefined ? isOpen : !open) ks.expanded.delete(path);
  else ks.expanded.add(path);
  renderKeyRows();
}

function onKeysKeydown(e) {
  if (!keysUi) return;
  const { rows, ks, list } = keysUi;
  let i = rows.findIndex((r) => r.kind === "key" && keyId(r.entry.k) === ks.selected);
  if (i < 0) i = keysUi.cursor ?? -1;
  const go = (j) => {
    j = Math.max(0, Math.min(rows.length - 1, j));
    const r = rows[j];
    keysUi.cursor = j;
    if (r.kind === "key") ks.selected = keyId(r.entry.k);
    else ks.selected = null;
    keysUi.folderAt = r.kind === "folder" ? r.path : null;
    const top = j * ROW_H;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight;
    paintRows();
    list.querySelector(`.rds-krow[data-i="${j}"]`)?.classList.add("cur");
  };
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    go(i + (e.key === "ArrowDown" ? 1 : -1));
  } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && rows[i]?.kind === "folder") {
    e.preventDefault();
    toggleFolder(rows[i].path, e.key === "ArrowRight");
  } else if (e.key === "Enter" && rows[i]) {
    e.preventDefault();
    if (rows[i].kind === "folder") toggleFolder(rows[i].path);
    else openKey(keysUi.c, ks.db, rows[i].entry.k, { pin: true });
  } else if (e.key === "Delete" && rows[i]?.kind === "key") {
    e.preventDefault();
    deleteKeys(keysUi.c, ks.db, [rows[i].entry.k]);
  }
}

function rowMenu(r, e) {
  const { c, ks } = keysUi;
  if (r.kind === "folder") {
    const pattern = `${r.path}*`;
    return showMenu(e.clientX, e.clientY, [
      { label: r.open ? "Recolher" : "Expandir", icon: "fa-regular fa-folder-open", run: () => toggleFolder(r.path) },
      { label: "Filtrar por este prefixo", icon: "fa-solid fa-filter", run: () => filterKeys(c, ks.db, pattern) },
      { label: "Nova chave aqui…", icon: "fa-solid fa-plus", run: () => newKey(c, r.path) },
      { label: "Analisar memória do prefixo", icon: "fa-solid fa-chart-pie", run: () => openTool(c, "memory", { pattern }) },
      { label: "Copiar padrão", icon: "fa-regular fa-copy", run: () => copy(pattern) },
      "sep",
      { label: `Excluir chaves ${pattern}…`, icon: "fa-regular fa-trash-can", danger: true, run: () => deletePattern(c, ks.db, pattern) },
    ]);
  }
  const k = r.entry.k;
  showMenu(e.clientX, e.clientY, [
    { label: "Abrir", icon: "fa-solid fa-up-right-from-square", run: () => openKey(c, ks.db, k, { pin: true }) },
    { label: "Copiar nome", icon: "fa-regular fa-copy", run: () => copy(bulkLabel(k), "Nome copiado") },
    { label: "TTL…", icon: "fa-regular fa-clock", run: () => keyTtl(c, ks.db, k) },
    { label: "Renomear…", icon: "fa-solid fa-i-cursor", run: () => renameKey(c, ks.db, k) },
    "sep",
    { label: "Excluir…", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteKeys(c, ks.db, [k]) },
  ]);
}

function keysMenu(c, ks, anchor) {
  showMenuBelow(anchor, [
    { header: `db${ks.db}` },
    { label: "Carregar todas as chaves", icon: "fa-solid fa-angles-down", disabled: ks.done, run: () => scanMore(c, ks, { all: true }) },
    { label: "Recolher tudo", icon: "fa-solid fa-angles-up", run: () => (ks.expanded.clear(), renderKeyRows()) },
    { header: "Chaves por página (SCAN COUNT)" },
    ...[100, 500, 1000, 5000].map((n) => ({ label: fmtNum(n), icon: D.ui.scan_count === n ? "fa-solid fa-check" : "", run: () => ((D.ui.scan_count = n), saveSoon()) })),
    "sep",
    ks.pattern ? { label: `Excluir chaves ${ks.pattern}…`, icon: "fa-regular fa-trash-can", danger: true, run: () => deletePattern(c, ks.db, ks.pattern) } : null,
    { label: `Esvaziar db${ks.db} (FLUSHDB)…`, icon: "fa-solid fa-dumpster-fire", danger: true, run: () => flushDb(c, ks.db) },
  ]);
}

/** Mostra só as chaves de um padrão na árvore. */
function filterKeys(c, db, pattern) {
  D.ui.conn_id = c.id;
  D.ui.dbs[c.id] = db;
  const ks = keyState(c, db);
  ks.pattern = pattern;
  renderAll();
  loadKeys(c);
}

// ---------- Operações em chaves ----------

/** Mudança feita por uma aba (TTL, rename, exclusão…): atualiza a árvore e as outras abas. */
function keyChanged(c, db, key, change = {}) {
  const ks = keyStates.get(`${c.id}:${db}`);
  if (ks) {
    if (change.deleted) ks.keys.delete(keyId(key));
    if (change.renamedTo) {
      ks.keys.delete(keyId(key));
      ks.keys.set(keyId(change.renamedTo), { k: change.renamedTo, type: change.type });
    }
    if (change.created) ks.keys.set(keyId(key), { k: key, type: change.type });
    if (change.type && ks.keys.has(keyId(key))) ks.keys.get(keyId(key)).type = change.type;
    if (keysUi?.ks === ks) renderKeyRows();
  }
  if (change.deleted) {
    for (const t of D.ui.tabs.filter((t) => t.type === "key" && t.conn_id === c.id && t.db === db && keyId(t.key) === keyId(key))) closeTab(t.id, { force: true });
  }
  if (change.renamedTo) saveSoon();
  renderTabs();
}

async function deleteKeys(c, db, keys) {
  const names = keys.map(bulkLabel);
  const ok = await danger(c, { title: keys.length > 1 ? `Excluir ${keys.length} chaves?` : "Excluir chave?", message: names.slice(0, 20).join("\n") + (names.length > 20 ? `\n… e mais ${names.length - 20}` : ""), name: keys.length === 1 ? names[0] : `${keys.length} chaves`, confirmLabel: "Excluir" });
  if (!ok) return;
  const r = await exec(c, db, ["UNLINK", ...keys.map(argOf)]).catch((e) => ({ t: "err", v: String(e) }));
  if (r.t === "err") return toast(r.v);
  for (const k of keys) keyChanged(c, db, k, { deleted: true });
  toast(`${fmtNum(respInt(r))} chave(s) excluída(s)`);
  updateTotal(c, db);
}

/** Exclui por padrão: SCAN + UNLINK em lotes, com contagem antes e progresso. */
async function deletePattern(c, db, pattern) {
  if (!pattern || pattern === "*") {
    const ok = await danger(c, { title: "Excluir todas as chaves?", message: `Padrão "${pattern || "*"}" = o banco inteiro. Prefira FLUSHDB.`, name: `db${db}`, confirmLabel: "Continuar" });
    if (!ok) return;
  }
  toast(`Contando chaves ${pattern}…`);
  const keys = [];
  let cursor = "";
  try {
    do {
      const page = await redisApi.scan(cfg(c), db, { cursor, pattern, count: 1000, limit: 5000 });
      keys.push(...page.keys.map((e) => e.k));
      cursor = page.cursor || "";
    } while (cursor && keys.length < 1_000_000);
  } catch (e) {
    return toast(String(e));
  }
  if (!keys.length) return toast(`Nenhuma chave casa com ${pattern}`);
  const ok = await danger(c, { title: `Excluir ${fmtNum(keys.length)} chave(s)?`, message: `Todas as chaves de "${pattern}" em db${db} (${connLabel(c)}) serão excluídas com UNLINK.`, name: pattern, confirmLabel: "Excluir" });
  if (!ok) return;
  let done = 0;
  for (let i = 0; i < keys.length; i += 500) {
    const batch = keys.slice(i, i + 500);
    // Cluster: chaves de slots diferentes vão uma a uma (UNLINK com várias chaves exige o mesmo slot).
    const res = status(c.id).info?.mode === "cluster" ? await pipeline(c, db, batch.map((k) => ["UNLINK", argOf(k)])) : [await exec(c, db, ["UNLINK", ...batch.map(argOf)])];
    for (const r of res) if (r.t !== "err") done += respInt(r);
    toast(`Excluindo… ${fmtNum(done)} de ${fmtNum(keys.length)}`);
  }
  toast(`${fmtNum(done)} chave(s) excluída(s)`);
  loadKeys(c);
  for (const t of D.ui.tabs.filter((t) => t.type === "key" && t.conn_id === c.id && t.db === db)) controllers.get(t.id)?.reload?.();
}

async function keyTtl(c, db, key) {
  const r = await exec(c, db, ["PTTL", argOf(key)]);
  const s = await ttlDialog({ key: bulkLabel(key), currentMs: respInt(r) });
  if (s === null) return;
  const res = await exec(c, db, s === 0 ? ["PERSIST", argOf(key)] : ["EXPIRE", argOf(key), String(s)]);
  toast(res.t === "err" ? res.v : "TTL alterado");
  for (const t of D.ui.tabs.filter((t) => t.type === "key" && t.conn_id === c.id && t.db === db && keyId(t.key) === keyId(key))) controllers.get(t.id)?.reload?.();
}

async function renameKey(c, db, key) {
  const next = await promptDialog({ title: "Renomear chave", label: "Novo nome", value: bulkLabel(key) });
  if (!next || next === bulkLabel(key)) return;
  let r = await exec(c, db, ["RENAMENX", argOf(key), next]);
  if (r.t === "err") return toast(r.v);
  if (respInt(r) === 0) {
    if (!(await rdsConfirm({ title: "Já existe", message: `"${next}" já existe. Substituir?`, confirmLabel: "Substituir", danger: true }))) return;
    r = await exec(c, db, ["RENAME", argOf(key), next]);
    if (r.t === "err") return toast(r.v);
  }
  const type = keyStates.get(`${c.id}:${db}`)?.keys.get(keyId(key))?.type;
  const to = { t: "str", v: next };
  for (const t of D.ui.tabs.filter((t) => t.type === "key" && t.conn_id === c.id && t.db === db && keyId(t.key) === keyId(key))) {
    t.key = to;
    controllers.get(t.id)?.reload?.();
  }
  keyChanged(c, db, key, { renamedTo: to, type });
}

async function newKey(c = activeConn(), prefix = "") {
  if (!c) return newConnectionDialog();
  if (!state.desktopMode) await enterDesktopMode();
  const db = dbOf(c);
  const info = status(c.id).info;
  const v = await newKeyDialog({ prefix, hasJson: !!info?.modules?.some((m) => /json/i.test(m)) });
  if (!v) return;
  const key = v.key;
  try {
    const exists = respInt(await exec(c, db, ["EXISTS", key]));
    if (exists && !(await rdsConfirm({ title: "Chave já existe", message: `"${key}" já existe e será substituída.`, confirmLabel: "Substituir", danger: true }))) return;
    const lines = (t) => t.split(/\r?\n/).filter((x) => x !== "");
    const cmds = exists ? [["DEL", key]] : [];
    if (v.type === "string") cmds.push(["SET", key, v.value]);
    else if (v.type === "hash") cmds.push(["HSET", key, v.field, v.value]);
    else if (v.type === "list") cmds.push(["RPUSH", key, ...(lines(v.value).length ? lines(v.value) : [""])]);
    else if (v.type === "set") cmds.push(["SADD", key, ...(lines(v.value).length ? lines(v.value) : [""])]);
    else if (v.type === "zset") cmds.push(["ZADD", key, String(v.score), v.value]);
    else if (v.type === "stream") {
      const pairs = lines(v.fields).filter((l) => l.includes("=")).flatMap((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]);
      cmds.push(["XADD", key, "*", ...pairs]);
    } else if (v.type === "ReJSON-RL") cmds.push(["JSON.SET", key, "$", v.value]);
    if (v.ttl > 0) cmds.push(["EXPIRE", key, String(v.ttl)]);
    const res = await pipeline(c, db, cmds);
    const err = res.find((r) => r.t === "err");
    if (err) return toast(err.v);
    const k = { t: "str", v: key };
    keyChanged(c, db, k, { created: true, type: v.type });
    openKey(c, db, k, { pin: true });
    updateTotal(c, db);
  } catch (e) {
    toast(String(e));
  }
}

// ---------- Abas ----------

const activeTab = () => D.ui.tabs.find((t) => t.id === D.ui.active_tab) || null;

function tabTitle(t) {
  const c = conn(t.conn_id);
  const where = c ? connLabel(c) : "?";
  if (t.type === "key") return { title: bulkLabel(t.key), where: `${where}/db${t.db}`, icon: "fa-solid fa-key", color: typeInfo(keyStates.get(`${t.conn_id}:${t.db}`)?.keys.get(keyId(t.key))?.type).color };
  if (t.type === "console") return { title: "console", where: `${where}/db${t.db}`, icon: "fa-solid fa-terminal" };
  const tool = TOOLS.find((x) => x.id === t.type);
  return { title: tool?.label || t.type, where, icon: tool?.icon || "fa-solid fa-circle" };
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const t of D.ui.tabs) {
    const { title, where, icon: ic } = tabTitle(t);
    const c = conn(t.conn_id);
    const ctl = controllers.get(t.id);
    const item = el(
      "div.db-tab",
      {
        class: `db-tab${t.id === D.ui.active_tab ? " on" : ""}${ctl?.dirty ? " dirty" : ""}${ctl?.live || ctl?.running ? " running" : ""}${t.preview ? " preview" : ""}`,
        title: `${title} [${where}]`,
        style: c?.color ? `--conn:${c.color}` : "",
        onmousedown: (e) => {
          if (e.button === 1) {
            e.preventDefault();
            closeTab(t.id);
          } else if (e.button === 0 && !e.target.closest(".db-tab-x")) showTab(t.id);
        },
        ondblclick: () => {
          if (t.preview) {
            delete t.preview;
            renderTabs();
          }
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: "Fechar", icon: "fa-solid fa-xmark", run: () => closeTab(t.id) },
            { label: "Fechar as outras", icon: "fa-solid fa-xmarks-lines", run: () => closeOthers(t.id) },
            { label: "Fechar todas", icon: "fa-solid fa-ban", run: () => closeOthers(null) },
          ]);
        },
      },
      c?.color ? el("span.db-tab-color") : null,
      icon(`${ic} db-tab-icon`),
      el("span.db-tab-title", {}, title),
      el("span.db-tab-where", {}, `[${where}]`),
      el("button.db-tab-x", { type: "button", title: "Fechar (Ctrl+W)", onclick: () => closeTab(t.id) }, icon("fa-solid fa-xmark")),
    );
    tabsEl.append(item);
  }
  tabsEl.querySelector(".db-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const viewCtx = {
  conn,
  exec,
  pipeline,
  nodes: async (c) => (await ensureConnected(c), redisApi.nodes(cfg(c))),
  serverInfo: (c) => status(c?.id).info || null,
  toast,
  copy,
  showMenu,
  showMenuBelow,
  confirm: rdsConfirm,
  danger,
  prompt: promptDialog,
  form: formDialog,
  ttlDialog,
  saveText,
  openKey: (c, db, k) => openKey(c, db, k, { pin: true }),
  openTool: (c, tool, extra) => openTool(c, tool, extra),
  openConsole: (c, db, text) => openConsole(c, db, text),
  selectDb,
  filterKeys,
  deletePattern,
  keyChanged,
  onTitleChange: () => renderTabs(),
  databases: async (c) => (await ensureConnected(c)).databases || 16,
  history: (connId) => D.history[connId] || [],
  addHistory: (connId, line) => (addHistory(D, connId, line), saveSoon()),
  saveData: saveSoon,
  closeSession: (c, session) => c && redisApi.closeSession(c.id, session),
  liveStart: async (c, spec, onEvent, label) => {
    await ensureConnected(c);
    const id = await redisApi.liveStart(cfg(c), spec, onEvent);
    lives.set(id, { id, conn_id: c.id, label, tool: spec.kind === "monitor" ? "monitor" : "pubsub" });
    renderLive();
    return id;
  },
  analyzeStart: async (c, spec, onEvent) => {
    await ensureConnected(c);
    const id = await redisApi.analyzeStart(cfg(c), spec, onEvent);
    lives.set(id, { id, conn_id: c.id, label: "Análise de memória", tool: "memory" });
    renderLive();
    return id;
  },
  liveStop: (id) => redisApi.liveStop(id),
  liveEnded: (id) => {
    lives.delete(id);
    renderLive();
  },
};

const VIEWS = { overview: overviewView, config: configView, slowlog: slowlogView, clients: clientsView, monitor: monitorView, pubsub: pubsubView, memory: memoryView, cluster: clusterView };

function controllerFor(t) {
  let ctl = controllers.get(t.id);
  if (ctl) return ctl;
  if (t.type === "key") ctl = createKeyTab(viewCtx, t);
  else if (t.type === "console") ctl = createConsoleTab(viewCtx, t, t.text || "");
  else ctl = wrapView(VIEWS[t.type](viewCtx, t));
  delete t.text;
  controllers.set(t.id, ctl);
  return ctl;
}

/** Seções (rabbitViews-like): erro do refresh vira faixa no topo, com "Tentar de novo". */
function wrapView(view) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await view.refresh();
      view.root.querySelector(":scope > .rmq-error")?.remove();
    } catch (e) {
      let box = view.root.querySelector(":scope > .rmq-error");
      if (!box) {
        box = el("div.rmq-alert.rmq-error");
        view.root.prepend(box);
      }
      box.innerHTML = "";
      box.append(icon("fa-solid fa-circle-exclamation"), el("span", {}, String(e)), el("button.hx-btn", { type: "button", onclick: () => run() }, "Tentar de novo"));
    } finally {
      busy = false;
    }
  };
  let first = true;
  return {
    root: view.root,
    autoRefresh: !!view.autoRefresh,
    activate() {
      if (first) {
        first = false;
        run();
      }
    },
    refresh: run,
    get live() {
      return !!view.live;
    },
    focusFilter: view.focusFilter,
    dirty: false,
    beforeClose: async () => !view.live || rdsConfirm({ title: "Parar e fechar?", message: "Esta aba está recebendo dados ao vivo (Monitor, Pub/Sub ou análise).", confirmLabel: "Parar e fechar", danger: true }),
    dispose: () => view.dispose?.(),
  };
}

async function showTab(id) {
  const t = D.ui.tabs.find((x) => x.id === id);
  if (!t) return;
  D.ui.active_tab = id;
  saveSoon();
  renderTabs();
  renderHeader();
  renderConns();
  const c = conn(t.conn_id);
  if (c && status(c.id).state !== "connected") {
    tabBodyEl.innerHTML = "";
    tabBodyEl.append(el("div.db-placeholder", {}, icon("fa-solid fa-spinner fa-spin"), el("p", {}, `Conectando em ${connLabel(c)}…`)));
    try {
      await ensureConnected(c);
    } catch (e) {
      if (D.ui.active_tab !== id) return;
      tabBodyEl.innerHTML = "";
      tabBodyEl.append(
        el(
          "div.db-placeholder.err",
          {},
          icon("fa-solid fa-plug-circle-exclamation"),
          el("p", {}, String(e)),
          el("button.hx-btn.primary", { type: "button", onclick: () => (statuses.delete(c.id), showTab(id)) }, "Tentar de novo"),
          el("button.hx-btn", { type: "button", onclick: () => editConnection(c) }, "Editar conexão"),
        ),
      );
      return;
    }
    if (D.ui.active_tab !== id) return;
  }
  const ctl = controllerFor(t);
  tabBodyEl.innerHTML = "";
  tabBodyEl.append(ctl.root);
  ctl.activate();
  renderTabs();
}

function addTab(t) {
  const tabs = D.ui.tabs;
  const at = tabs.findIndex((x) => x.id === D.ui.active_tab);
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, t);
  showTab(t.id);
}

/** Abre a chave; sem `pin`, reaproveita a aba de pré-visualização (como no VS Code). */
async function openKey(c, db, key, { pin = false } = {}) {
  if (!state.desktopMode) await enterDesktopMode();
  const existing = D.ui.tabs.find((t) => t.type === "key" && t.conn_id === c.id && t.db === db && keyId(t.key) === keyId(key));
  if (existing) {
    if (pin && existing.preview) delete existing.preview;
    return showTab(existing.id);
  }
  const preview = !pin && D.ui.tabs.find((t) => t.type === "key" && t.preview && !controllers.get(t.id)?.dirty);
  if (preview) {
    controllers.get(preview.id)?.dispose();
    controllers.delete(preview.id);
    Object.assign(preview, { conn_id: c.id, db, key });
    return showTab(preview.id);
  }
  addTab({ id: uid(), type: "key", conn_id: c.id, db, key, ...(pin ? {} : { preview: true }) });
}

async function openConsole(c = activeConn(), db = dbOf(c), text = "") {
  if (!c) return newConnectionDialog();
  if (!state.desktopMode) await enterDesktopMode();
  if (text) {
    const existing = D.ui.tabs.find((t) => t.type === "console" && t.conn_id === c.id && t.db === db);
    if (existing) {
      await showTab(existing.id);
      controllers.get(existing.id)?.setText?.(text);
      return;
    }
  }
  addTab({ id: uid(), type: "console", conn_id: c.id, db, text });
}

async function openTool(c, tool, extra = {}) {
  if (!c) return;
  if (!state.desktopMode) await enterDesktopMode();
  const existing = D.ui.tabs.find((t) => t.type === tool && t.conn_id === c.id);
  if (existing && !extra.pattern) return showTab(existing.id);
  if (existing && extra.pattern) await closeTab(existing.id);
  addTab({ id: uid(), type: tool, conn_id: c.id, db: dbOf(c), ...extra });
}

async function closeTab(id, { force = false } = {}) {
  const tabs = D.ui.tabs;
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const ctl = controllers.get(id);
  if (ctl && !force && !(await ctl.beforeClose())) return;
  ctl?.dispose();
  controllers.delete(id);
  tabs.splice(i, 1);
  if (D.ui.active_tab === id) {
    D.ui.active_tab = tabs[Math.min(i, tabs.length - 1)]?.id || null;
    if (D.ui.active_tab) showTab(D.ui.active_tab);
    else renderEmpty();
  }
  saveSoon();
  renderTabs();
  renderHeader();
  renderConns();
}

async function closeOthers(keepId) {
  for (const t of [...D.ui.tabs]) if (t.id !== keepId) await closeTab(t.id);
}

const SHORTCUTS_HTML = [
  ["Clique / duplo clique", "abrir chave (pré-visualização / aba fixa)"],
  ["Ctrl+N", "nova chave"],
  ["Ctrl+Shift+Q", "console"],
  ["Ctrl+S", "salvar o valor editado"],
  ["F5", "atualizar"],
  ["Ctrl+W", "fechar aba"],
  ["Delete", "excluir a chave selecionada na árvore"],
]
  .map(([k, d]) => `<div><kbd>${escapeHtml(k)}</kbd><span>${escapeHtml(d)}</span></div>`)
  .join("");

function renderEmpty() {
  tabBodyEl.innerHTML = "";
  const c = activeConn();
  tabBodyEl.append(
    el(
      "div.db-placeholder",
      {},
      icon("fa-solid fa-cubes-stacked"),
      el("p", {}, c ? "Escolha uma chave na árvore ou abra o console / uma ferramenta da conexão." : "Crie uma conexão com o Redis (standalone, Cluster ou Sentinel; TLS e túnel SSH opcionais)."),
      el(
        "div.db-placeholder-actions",
        {},
        c ? el("button.hx-btn.primary", { type: "button", onclick: () => openConsole(c) }, icon("fa-solid fa-terminal"), " Console") : null,
        c ? el("button.hx-btn", { type: "button", onclick: () => openTool(c, "overview") }, icon("fa-solid fa-gauge-high"), " Visão geral") : null,
        el("button.hx-btn", { type: "button", onclick: newConnectionDialog }, icon("fa-solid fa-plus"), " Nova conexão"),
      ),
      el("div.db-shortcuts", { html: SHORTCUTS_HTML }),
    ),
  );
}

// ---------- Cabeçalho / ao vivo / bandeja ----------

function renderHeader() {
  const t = activeTab();
  const c = (t && conn(t.conn_id)) || activeConn();
  if (!c) {
    titleEl.textContent = "Redis";
    subEl.textContent = `${D.connections.length} conexão(ões)`;
    appEl.style.removeProperty("--conn");
  } else {
    const st = status(c.id);
    titleEl.textContent = connLabel(c);
    subEl.textContent = st.info ? [`Redis ${st.info.version}`, st.info.mode, st.info.role, `db${t?.conn_id === c.id ? t.db : dbOf(c)}`, c.read_only ? "somente leitura" : ""].filter(Boolean).join(" · ") : st.state === "error" ? "erro de conexão" : c.mode;
    if (c.color) appEl.style.setProperty("--conn", c.color);
    else appEl.style.removeProperty("--conn");
  }
  refreshLabelEl.textContent = D.ui.refresh_s ? `${D.ui.refresh_s}s` : "off";
}

function renderLive() {
  pillEl.hidden = !lives.size;
  pillEl.innerHTML = "";
  if (lives.size) {
    pillEl.append(el("i.fa-solid.fa-circle.rmq-rec-dot.pulse"), ` ${[...lives.values()].map((l) => l.label).join(" · ").slice(0, 60)}`);
    pillEl.title = "Clique para ver ou parar";
  }
  renderConns();
  renderTabs();
}

function renderCompact() {
  compactEl.innerHTML = "";
  if (!D.connections.length) {
    compactEl.append(el("p.db-compact-empty", {}, "Nenhuma conexão ainda."));
    return;
  }
  for (const c of D.connections) {
    const st = status(c.id);
    const s = st.summary;
    compactEl.append(
      el(
        "button.db-compact-item.rmq-compact-item",
        {
          type: "button",
          style: c.color ? `--conn:${c.color}` : "",
          onclick: async () => {
            await enterDesktopMode();
            selectConnection(c.id);
          },
        },
        el("span", { class: `dbx-state ${st.state}` }),
        icon("fa-solid fa-cubes-stacked"),
        el("span.db-compact-name", {}, connLabel(c)),
        el("span.db-compact-host", {}, st.state === "error" ? "erro de conexão" : s ? `${s.memory} · ${fmtNum(s.clients)} cliente(s) · ${fmtNum(s.ops)}/s` : c.mode === "standalone" ? `${c.host}:${c.port}` : c.mode),
      ),
    );
  }
}

/** Bandeja: INFO resumido de cada conexão a cada 15 s enquanto a aba estiver visível. */
async function refreshCompact() {
  if (state.desktopMode || state.activeMainView !== "redis" || document.hidden) return;
  await Promise.all(
    D.connections.map(async (c) => {
      try {
        const r = await exec(c, 0, ["INFO"]);
        const info = parseInfo(r.t === "map" ? respText(r.v[0]?.[1]) : respText(r));
        statuses.set(c.id, { ...status(c.id), summary: { memory: info.memory?.used_memory_human || "?", clients: Number(info.clients?.connected_clients) || 0, ops: Number(info.stats?.instantaneous_ops_per_sec) || 0, keys: Object.values(keyspace(info)).reduce((a, d) => a + d.keys, 0) } });
      } catch (e) {
        statuses.set(c.id, { state: "error", error: String(e) });
      }
    }),
  );
  renderCompact();
}

function renderAll() {
  renderConns();
  renderKeys();
  renderTabs();
  renderHeader();
  renderCompact();
  if (!activeTab() && tabBodyEl.querySelector(".db-placeholder:not(.err)")) renderEmpty();
}

function tick() {
  if (state.activeMainView !== "redis" || document.hidden || isRdsModalOpen()) return;
  if (!state.desktopMode) {
    if (Date.now() - lastRefresh > 15000) {
      lastRefresh = Date.now();
      refreshCompact();
    }
    return;
  }
  const ctl = controllers.get(D.ui.active_tab);
  if (!D.ui.refresh_s || !ctl?.autoRefresh || !tabBodyEl.contains(ctl.root)) return;
  if (Date.now() - lastRefresh >= D.ui.refresh_s * 1000) {
    lastRefresh = Date.now();
    ctl.refresh();
  }
}

// ---------- Layout ----------

function applyLayout() {
  appEl.style.setProperty("--rmq-side-w", `${D.ui.side_w}px`);
  appEl.classList.toggle("side-hidden", !D.ui.side_open);
}

function initSideSplitter() {
  appEl.querySelector('[data-split="side"]').addEventListener("mousedown", (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = D.ui.side_w;
    document.body.classList.add("db-resizing-x");
    const move = (ev) => {
      D.ui.side_w = Math.min(640, Math.max(200, w0 + ev.clientX - x0));
      applyLayout();
    };
    const up = () => {
      document.body.classList.remove("db-resizing-x");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveSoon();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

// ---------- Ações e atalhos ----------

const ACTIONS = {
  "new-connection": newConnectionDialog,
  "new-key": () => newKey(),
  console: () => openConsole(),
  refresh: () => {
    const ctl = controllers.get(D.ui.active_tab);
    if (ctl) ctl.refresh();
    else if (activeConn()) loadKeys(activeConn());
  },
  "refresh-menu": () =>
    showMenuBelow(appEl.querySelector('[data-action="refresh-menu"]'), [
      { header: "Atualização automática (visão geral, clientes, slowlog)" },
      ...REFRESH_OPTIONS.map((s) => ({ label: s ? `A cada ${s} s` : "Desligada", icon: D.ui.refresh_s === s ? "fa-solid fa-check" : "", run: () => ((D.ui.refresh_s = s), saveSoon(), renderHeader()) })),
    ]),
  "live-menu": () =>
    showMenuBelow(pillEl, [
      { header: "Ao vivo" },
      ...[...lives.values()].flatMap((l) => [
        { label: `Ver: ${l.label} (${connLabel(conn(l.conn_id))})`, icon: "fa-solid fa-eye", run: () => openTool(conn(l.conn_id), l.tool) },
        { label: `Parar: ${l.label}`, icon: "fa-solid fa-stop", danger: true, run: () => redisApi.liveStop(l.id) },
      ]),
    ]),
  "toggle-side": () => {
    D.ui.side_open = !D.ui.side_open;
    applyLayout();
    saveSoon();
  },
  desktop: () => enterDesktopMode(),
  tray: () => exitDesktopMode(),
  "close-desktop": () => exitDesktopMode({ visible: false }),
  minimize: minimizeWindow,
  maximize: toggleMaximize,
};

function onKeydown(e) {
  if (state.activeMainView !== "redis") return;
  if (e.key === "Escape") {
    if (!menuEl.hidden) return closeMenu();
    if (isRdsModalOpen()) return closeRdsModal();
  }
  if (!state.desktopMode || isRdsModalOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (e.key === "F5") {
    e.preventDefault();
    ACTIONS.refresh();
  } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "q") {
    e.preventDefault();
    openConsole();
  } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "n" && !typing) {
    e.preventDefault();
    newKey();
  } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "w" && D.ui.active_tab) {
    e.preventDefault();
    closeTab(D.ui.active_tab);
  } else if (ctrl && e.key === "Tab" && D.ui.tabs.length > 1) {
    e.preventDefault();
    const tabs = D.ui.tabs;
    const i = tabs.findIndex((t) => t.id === D.ui.active_tab);
    showTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
  } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "f" && !typing) {
    const ctl = controllers.get(D.ui.active_tab);
    if (ctl?.focusFilter) {
      e.preventDefault();
      ctl.focusFilter();
    }
  }
}

// ---------- API pública ----------

export async function loadRedis() {
  const raw = await redisApi.load();
  D = normalizeRedisData(raw);
  for (const t of D.ui.tabs) delete t.preview;
  loaded = true;
  applyLayout();
  renderAll();
  if (!activeTab()) renderEmpty();
  else if (state.activeMainView === "redis" && state.desktopMode) showTab(activeTab().id);
  if (state.activeMainView === "redis" && activeConn()) loadKeys(activeConn());
  else if (SOLO_APP === "redis" && activeConn()) loadKeys(activeConn());
}

export function initRedis() {
  appEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (b && appEl.contains(b) && ACTIONS[b.dataset.action]) ACTIONS[b.dataset.action]();
  });
  document.addEventListener("mousedown", (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", onKeydown);
  initSideSplitter();
  setInterval(tick, 1000);
  document.addEventListener("mainviewchange", (e) => {
    if (e.detail.view !== "redis" || !loaded) return;
    renderAll();
    const c = activeConn();
    if (c && !keyStates.get(`${c.id}:${dbOf(c)}`)?.started) loadKeys(c);
    if (state.desktopMode && activeTab()) {
      const ctl = controllers.get(activeTab().id);
      if (ctl && tabBodyEl.contains(ctl.root)) ctl.activate();
      else showTab(activeTab().id);
    } else if (!state.desktopMode) {
      lastRefresh = 0;
      tick();
    }
  });
  document.addEventListener("windowmodechange", () => {
    if (!loaded) return;
    renderAll();
    if (state.desktopMode && state.activeMainView === "redis" && activeTab()) showTab(activeTab().id);
  });

  registerApp("redis", {
    flush: async () => {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = 0;
      await redisApi.save(D);
    },
    // As conexões continuam no Rust; a interface é recriada a partir do redis.json.
    reload: async () => {
      for (const ctl of controllers.values()) ctl.root?.remove();
      controllers.clear();
      keyStates.clear();
      await loadRedis();
    },
    blocker: () => (lives.size ? "Há Monitor, assinatura Pub/Sub ou análise rodando no Redis. Pare antes de mover a janela." : null),
  });
}

// ---------- CLI (js/cli/redisCli.js) ----------

/** Operações do Redis usadas pela CLI `devsuite`, sobre o estado vivo desta janela. */
export const redisHost = {
  connections: () => D.connections,
  status: (id) => status(id),
  ensureConnected,
  exec,
  pipeline,
  scan: (c, db, spec) => ensureConnected(c).then(() => redisApi.scan(cfg(c), db, spec)),
  nodes: (c) => ensureConnected(c).then(() => redisApi.nodes(cfg(c))),
  liveStart: (c, spec, onEvent) => ensureConnected(c).then(() => redisApi.liveStart(cfg(c), spec, onEvent)),
  analyzeStart: (c, spec, onEvent) => ensureConnected(c).then(() => redisApi.analyzeStart(cfg(c), spec, onEvent)),
  liveStop: (id) => redisApi.liveStop(id),
  async addConnection(c, secrets) {
    D.connections.push(c);
    await storeSecrets(c.id, secrets);
    await saveNow();
    renderAll();
  },
  removeConnection,
  keyChanged: (c, db, key, change) => keyChanged(c, db, key, change),
  parseTtl,
};

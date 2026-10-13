import { state } from "../state.js";
import { el, icon } from "../utils/dom.js";
import { escapeHtml } from "../utils/noteContent.js";
import { highlightCode } from "../utils/highlight.js";
import {
  normalizeDbData,
  newConnection,
  connLabel,
  target,
  metaSession,
  newConsole,
  newTab,
  uid,
  isMongo,
  affectedText,
} from "../utils/dbModel.js";
import { dialectFor } from "../utils/sqlDialect.js";
import { saveDbDataApi, dbApi } from "../api.js";
import { createExplorer } from "./dbExplorer.js";
import { createTableTab } from "./dbTableTab.js";
import { createMongoTab } from "./dbMongoTab.js";
import { createConsoleTab, createDdlTab } from "./dbConsole.js";
import { connectionDialog, dbConfirm, isDbModalOpen, closeDbModal, sqlPreviewDialog } from "./dbDialogs.js";
import { attachWordComplete } from "./sqlComplete.js";
import { tableDesigner, ddlActionDialog, quickSchemaAction } from "./dbSchema.js";
import { renameObjectSql, dropObjectSql, truncateSql, renameColumnRefs, dropColumn } from "../utils/sqlDdl.js";
import { enterDesktopMode, exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";

// Aba "Banco": cliente de banco de dados estilo DataGrip (SQL Server / Azure SQL e MongoDB).
// Desktop: Database Explorer | abas de tabelas/consoles | log de consultas.
// Bandeja: só a lista de conexões, com atalho para o modo desktop.

const appEl = document.getElementById("db-app");
const treeEl = document.getElementById("db-tree");
const tabsEl = document.getElementById("db-tabs");
const tabBodyEl = document.getElementById("db-tab-body");
const logEl = document.getElementById("db-log");
const logListEl = document.getElementById("db-log-list");
const menuEl = document.getElementById("db-menu");
const toastEl = document.getElementById("db-toast");
const compactListEl = document.getElementById("db-compact-list");
const titleEl = document.getElementById("db-tb-title");
const subEl = document.getElementById("db-tb-sub");

const LOG_LIMIT = 500;

const data = () => state.db;
const conn = (id) => data()?.connections.find((c) => c.id === id) || null;
const dialect = () => dialectFor("mssql");

/** Estado de conexão (não persistido): idle | connecting | connected | error. */
const statuses = new Map();
const status = (connId) => statuses.get(connId) || { state: "idle" };
/** Controladores das abas abertas (criados ao ativar). */
const controllers = new Map();
/** Cache para o autocomplete: `${connId}:${db}` -> { objects, columns: Map } */
const completionCache = new Map();
let explorer = null;
let logEntries = [];

// ---------- Persistência ----------

let saveTimer = 0;
function saveDataSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDbDataApi(data()), 600);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveDbDataApi(data());
}

// ---------- Toast / menus / clipboard ----------

let toastTimer = 0;
function toast(message, action = null) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.append(el("span", { title: message }, message));
  if (action) toastEl.append(el("button", { type: "button", onclick: () => ((toastEl.hidden = true), action.run()) }, action.label));
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 8000 : message.length > 80 ? 6000 : 2800);
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
    b.classList.toggle("indent", !!item.indent);
    b.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menuEl.append(b);
  }
  if (menuEl.lastElementChild?.classList.contains("nt-menu-sep")) menuEl.lastElementChild.remove();
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

// ---------- Conexões ----------

/** Abre a sessão de metadados da conexão (pode abrir o navegador no Entra). */
async function ensureConnected(c) {
  const st = status(c.id);
  if (st.state === "connected") return st.info;
  if (st.pending) return st.pending;
  const pending = (async () => {
    statuses.set(c.id, { state: "connecting", pending: null });
    renderAll();
    if (c.auth.kind === "entra") toast("Conclua o login da Microsoft no navegador, se ele abrir…");
    try {
      const info = await dbApi.connect(target(c, metaSession(c.id, ""), ""));
      statuses.set(c.id, { state: "connected", info, title: `${info.product} ${info.version} · ${info.user}` });
      // Conectou por uma aba restaurada: reabre a árvore como estava.
      if (data().ui.expanded.includes(`c:${c.id}`)) setTimeout(() => explorer?.expandConnection(c.id), 0);
      return info;
    } catch (e) {
      statuses.set(c.id, { state: "error", error: String(e) });
      throw e;
    } finally {
      renderAll();
    }
  })();
  statuses.set(c.id, { state: "connecting", pending });
  return pending;
}

async function disconnect(c) {
  await dbApi.disconnect(`meta:${c.id}:`);
  for (const t of data().ui.tabs.filter((t) => t.conn_id === c.id)) {
    const ctl = controllers.get(t.id);
    if (ctl) {
      ctl.dispose();
      controllers.delete(t.id);
    }
  }
  statuses.delete(c.id);
  for (const k of [...completionCache.keys()]) if (k.startsWith(`${c.id}:`)) completionCache.delete(k);
  renderAll();
  if (activeTab()?.conn_id === c.id) showTab(activeTab().id);
}

function requireLogin(c) {
  statuses.set(c.id, { state: "error", error: "Login necessário" });
  renderAll();
  toast(`Sessão do Microsoft Entra expirou em "${connLabel(c)}"`, {
    label: "Entrar",
    run: () => {
      statuses.delete(c.id);
      ensureConnected(c).then(() => activeController()?.refresh()).catch((e) => toast(String(e)));
    },
  });
}

async function newConnectionDialog() {
  if (!state.desktopMode) await enterDesktopMode();
  connectionDialog(newConnection(), {
    isNew: true,
    onSave: async (c, password) => {
      data().connections.push(c);
      if (password) await dbApi.setPassword(c.id, password).catch((e) => toast(String(e)));
      saveNow();
      renderAll();
      explorer?.expandConnection(c.id);
    },
  });
}

async function editConnection(c) {
  const hasPassword = c.auth.kind === "sql" ? await dbApi.hasPassword(c.id) : false;
  connectionDialog(c, {
    isNew: false,
    hasPassword,
    onSave: async (next, password) => {
      const i = data().connections.findIndex((x) => x.id === c.id);
      if (i < 0) return;
      const authChanged = JSON.stringify(next.auth) !== JSON.stringify(c.auth) || next.host !== c.host || next.port !== c.port || next.instance !== c.instance || next.driver !== c.driver || next.uri !== c.uri || next.tls_insecure !== c.tls_insecure;
      data().connections[i] = next;
      if (password !== undefined) await dbApi.setPassword(c.id, password).catch((e) => toast(String(e)));
      if (next.auth.kind !== "entra" && c.auth.kind === "entra") await dbApi.forgetSecrets(c.id);
      saveNow();
      if (authChanged || password !== undefined || next.database !== c.database || next.encrypt !== c.encrypt || next.trust_server_certificate !== c.trust_server_certificate) {
        await disconnect(next);
        explorer?.refreshConnection(c.id);
      }
      renderAll();
    },
    onDelete: () => deleteConnection(c),
  });
}

function duplicateConnection(c) {
  const copyConn = { ...structuredClone(c), id: uid(), name: `${connLabel(c)} (cópia)` };
  data().connections.push(copyConn);
  saveNow();
  renderAll();
  editConnection(copyConn);
}

async function deleteConnection(c) {
  const ok = await dbConfirm({
    title: "Excluir conexão?",
    message: `"${connLabel(c)}" e seus consoles salvos serão removidos. A senha/token é apagada do cofre do sistema.`,
    confirmLabel: "Excluir",
    danger: true,
  });
  if (!ok) return;
  for (const t of data().ui.tabs.filter((t) => t.conn_id === c.id)) await closeTab(t.id, { force: true });
  await disconnect(c);
  await dbApi.forgetSecrets(c.id);
  data().connections = data().connections.filter((x) => x.id !== c.id);
  data().consoles = data().consoles.filter((x) => x.conn_id !== c.id);
  data().ui.expanded = data().ui.expanded.filter((k) => !k.startsWith(`c:${c.id}`));
  explorer?.forgetConnection(c.id);
  saveNow();
  renderAll();
}

async function signOut(c) {
  await disconnect(c);
  await dbApi.forgetSecrets(c.id);
  explorer?.refreshConnection(c.id);
  toast("Conta desconectada; o próximo acesso pede login de novo");
}

/** Bancos da conexão (para o seletor do console). */
async function databases(c) {
  await ensureConnected(c);
  const list = await dbApi.introspect(target(c, metaSession(c.id, ""), ""), { kind: "databases" });
  return list.map((d) => d.name);
}

/** Fonte do autocomplete: objetos do banco e colunas sob demanda (com cache). */
async function completions(c, database) {
  const db = database || status(c.id).info?.database || c.database;
  const key = `${c.id}:${db}`;
  let entry = completionCache.get(key);
  if (!entry) {
    const tgt = target(c, metaSession(c.id, db), db);
    entry = {
      columns: new Map(),
      objects: (async () => {
        if (isMongo(c)) {
          const colls = await dbApi.introspect(tgt, { kind: "collections" });
          return colls.map((o) => ({ schema: "", name: o.name, kind: o.kind }));
        }
        const schemas = await dbApi.introspect(tgt, { kind: "schemas" });
        const lists = await Promise.all(schemas.filter((s) => s.rows).map((s) => dbApi.introspect(tgt, { kind: "schema", schema: s.name }).catch(() => [])));
        return lists.flat().map((o) => ({ schema: o.schema, name: o.name, kind: o.kind }));
      })(),
      tgt,
    };
    entry.objects.catch(() => completionCache.delete(key));
    completionCache.set(key, entry);
  }
  const objects = await entry.objects;
  return {
    objects,
    columnsOf(schema, name) {
      const obj = objects.find((o) => o.name.toLowerCase() === name.toLowerCase() && (!schema || o.schema.toLowerCase() === schema.toLowerCase()));
      if (!obj) return Promise.resolve([]);
      const k = `${obj.schema}.${obj.name}`;
      if (!entry.columns.has(k)) {
        entry.columns.set(
          k,
          dbApi
            .tableInfo(entry.tgt, obj.schema, obj.name)
            .then((info) => info.columns.map((col) => ({ name: col.name, type: col.full_type })))
            .catch(() => []),
        );
      }
      return entry.columns.get(k);
    },
  };
}

// ---------- Log de consultas ----------

function log(entry) {
  logEntries.push({ at: new Date(), ...entry });
  if (logEntries.length > LOG_LIMIT) logEntries = logEntries.slice(-LOG_LIMIT);
  appendLog(logEntries[logEntries.length - 1]);
}

function appendLog(e) {
  const stamp = e.at.toLocaleTimeString("pt-BR") + "." + String(e.at.getMilliseconds()).padStart(3, "0");
  const where = `${e.conn ? connLabel(e.conn) : ""}${e.database ? `/${e.database}` : ""}`;
  // Escritas: "(N) registro(s) afetado(s)"; leituras: linhas/documentos retornados.
  const parts = [];
  if (e.affected !== null && e.affected !== undefined) parts.push(affectedText(e.affected));
  if (e.rows !== null && e.rows !== undefined) parts.push(`${Number(e.rows).toLocaleString("pt-BR")} ${e.lang === "javascript" ? "documento(s)" : "linha(s)"}`);
  const timing = `${e.ms !== undefined ? ` em ${e.ms} ms` : ""}${e.fetchMs ? ` (execução + leitura: ${e.total} ms)` : ""}`;
  const result = e.error
    ? el("div.dbl-res.err", {}, e.error)
    : parts.length
      ? el("div.dbl-res", { class: `dbl-res${e.affected !== null && e.affected !== undefined ? " affected" : ""}` }, parts.join(" · ") + timing)
      : null;
  const row = el(
    "div.dbl",
    {
      oncontextmenu: (ev) => {
        ev.preventDefault();
        showMenu(ev.clientX, ev.clientY, [
          { label: "Copiar SQL", icon: "fa-regular fa-copy", run: () => copy(e.sql, "SQL copiado") },
          e.conn ? { label: "Abrir no console", icon: "fa-solid fa-terminal", run: () => openConsole(conn(e.conn.id) || e.conn, e.database, e.sql) } : null,
        ]);
      },
      ondblclick: () =>
        sqlPreviewDialog({ title: e.lang === "javascript" ? "Comando executado" : "SQL executado", sql: e.sql, lang: e.lang || "sql", onCopy: (s) => copy(s, "Copiado"), onOpenInConsole: e.conn ? (s) => openConsole(conn(e.conn.id) || e.conn, e.database, s) : null }),
    },
    el("span.dbl-time", {}, `[${stamp}]`),
    el("span.dbl-where", {}, `${where}>`),
    el("pre.dbl-sql", { html: highlightCode(e.sql.length > 2000 ? e.sql.slice(0, 2000) + "\n…" : e.sql, e.lang || "sql") }),
    result,
  );
  logListEl.append(row);
  while (logListEl.childElementCount > LOG_LIMIT) logListEl.firstElementChild.remove();
  logListEl.scrollTop = logListEl.scrollHeight;
}

// ---------- Abas ----------

const activeTab = () => data().ui.tabs.find((t) => t.id === data().ui.active_tab) || null;
const activeController = () => controllers.get(data().ui.active_tab) || null;
const tabFlags = new Map(); // tabId -> { dirty, running }

function tabTitle(t) {
  const c = conn(t.conn_id);
  const where = c ? connLabel(c) : "?";
  if (t.type === "console") {
    const doc = data().consoles.find((x) => x.id === t.console_id);
    return { title: doc?.name || "console", where: `${where}${doc?.database ? `/${doc.database}` : ""}`, icon: "fa-solid fa-terminal" };
  }
  if (t.type === "ddl") return { title: t.name, where, icon: "fa-solid fa-code" };
  if (t.kind === "collection") return { title: t.name, where: `${where}/${t.database}`, icon: "fa-solid fa-layer-group" };
  return { title: t.name, where, icon: t.kind === "view" ? "fa-solid fa-eye" : "fa-solid fa-table" };
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const t of data().ui.tabs) {
    const { title, where, icon: ic } = tabTitle(t);
    const flags = tabFlags.get(t.id) || {};
    const c = conn(t.conn_id);
    const item = el(
      "div.db-tab",
      {
        class: `db-tab${t.id === data().ui.active_tab ? " on" : ""}${flags.dirty ? " dirty" : ""}${flags.running ? " running" : ""}`,
        title: `${title} [${where}]${t.schema ? `\n${t.schema}.${t.name}` : ""}`,
        style: c?.color ? `--conn:${c.color}` : "",
        onmousedown: (e) => {
          if (e.button === 1) {
            e.preventDefault();
            closeTab(t.id);
          } else if (e.button === 0 && !e.target.closest(".db-tab-x")) showTab(t.id);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: "Fechar", icon: "fa-solid fa-xmark", run: () => closeTab(t.id) },
            { label: "Fechar as outras", icon: "fa-solid fa-xmarks-lines", run: () => closeOthers(t.id) },
            { label: "Fechar todas", icon: "fa-solid fa-ban", run: () => closeOthers(null) },
            t.type === "console" ? "sep" : null,
            t.type === "console" ? { label: "Renomear console…", icon: "fa-solid fa-pen", run: () => renameConsole(t) } : null,
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

function renameConsole(t) {
  const doc = data().consoles.find((x) => x.id === t.console_id);
  if (!doc) return;
  const tabEl = [...tabsEl.children][data().ui.tabs.indexOf(t)];
  const titleSpan = tabEl?.querySelector(".db-tab-title");
  if (!titleSpan) return;
  const input = el("input.db-tab-rename", { value: doc.name });
  titleSpan.replaceWith(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) {
      doc.name = input.value.trim();
      saveDataSoon();
    }
    renderTabs();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    else if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true));
}

const tabCtx = {
  conn,
  dialect: () => dialect(),
  log,
  toast,
  copy,
  showMenu,
  showMenuBelow,
  saveUi: saveDataSoon,
  saveDataSoon,
  pageSize: () => data().ui.page_size,
  setPageSize: (n) => {
    data().ui.page_size = n;
    saveDataSoon();
  },
  openTable: (ref) => openTable(ref),
  openDdl: (ref) => openDdl(ref),
  openConsole: (c, database, sql) => openConsole(c, database, sql),
  databases,
  completions,
  requireLogin,
  attachColumnComplete: attachWordComplete,
  onTitleChange: (t, flags) => {
    tabFlags.set(t.id, { ...(tabFlags.get(t.id) || {}), ...flags });
    renderTabs();
  },
};

function controllerFor(t) {
  let ctl = controllers.get(t.id);
  if (ctl) return ctl;
  if (t.type === "table") ctl = isMongo(conn(t.conn_id)) ? createMongoTab(tabCtx, t) : createTableTab(tabCtx, t);
  else if (t.type === "ddl") ctl = createDdlTab(tabCtx, t);
  else {
    const doc = data().consoles.find((x) => x.id === t.console_id);
    if (!doc) return null;
    ctl = createConsoleTab(tabCtx, t, doc);
  }
  controllers.set(t.id, ctl);
  return ctl;
}

async function showTab(id) {
  const t = data().ui.tabs.find((x) => x.id === id);
  if (!t) return;
  data().ui.active_tab = id;
  saveDataSoon();
  renderTabs();
  renderHeader();
  const c = conn(t.conn_id);
  // Abre a conexão (e o login do Entra, se for o caso) antes de criar a aba.
  if (c && status(c.id).state !== "connected") {
    tabBodyEl.innerHTML = "";
    tabBodyEl.append(el("div.db-placeholder", {}, icon("fa-solid fa-spinner fa-spin"), el("p", {}, `Conectando em ${connLabel(c)}…`)));
    try {
      await ensureConnected(c);
    } catch (e) {
      if (data().ui.active_tab !== id) return;
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
    if (data().ui.active_tab !== id) return;
  }
  const ctl = controllerFor(t);
  tabBodyEl.innerHTML = "";
  if (!ctl) return;
  tabBodyEl.append(ctl.root);
  ctl.activate();
}

function addTab(t) {
  const tabs = data().ui.tabs;
  const at = tabs.findIndex((x) => x.id === data().ui.active_tab);
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, t);
  showTab(t.id);
}

function openTable({ conn: c, database, schema, name, kind = "table", where = "" }) {
  if (!c) return;
  if (!state.desktopMode) enterDesktopMode();
  const existing = data().ui.tabs.find((t) => t.type === "table" && t.conn_id === c.id && t.database === database && t.schema === schema && t.name === name);
  if (existing && !where) return showTab(existing.id);
  addTab(newTab({ type: "table", conn_id: c.id, database, schema, name, kind, where }));
}

function openDdl({ conn: c, database, schema, name, kind }) {
  if (!c) return;
  const existing = data().ui.tabs.find((t) => t.type === "ddl" && t.conn_id === c.id && t.database === database && t.schema === schema && t.name === name);
  if (existing) return showTab(existing.id);
  addTab(newTab({ type: "ddl", conn_id: c.id, database, schema, name, kind }));
}

function openConsole(c, database, sql = "") {
  if (!c) return toast("Crie uma conexão primeiro");
  const doc = newConsole(c, database);
  const n = data().consoles.filter((x) => x.conn_id === c.id).length;
  doc.name = n ? `console ${n + 1}` : "console";
  doc.sql = sql;
  data().consoles.push(doc);
  addTab(newTab({ type: "console", conn_id: c.id, database: doc.database, console_id: doc.id }));
}

async function closeTab(id, { force = false } = {}) {
  const tabs = data().ui.tabs;
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const ctl = controllers.get(id);
  if (ctl && !force && !(await ctl.beforeClose())) return;
  ctl?.dispose();
  controllers.delete(id);
  tabFlags.delete(id);
  const [t] = tabs.splice(i, 1);
  // Fechar o console descarta o rascunho; o que foi executado continua no log de consultas.
  if (t.type === "console") data().consoles = data().consoles.filter((x) => x.id !== t.console_id);
  if (data().ui.active_tab === id) {
    data().ui.active_tab = tabs[Math.min(i, tabs.length - 1)]?.id || null;
    if (data().ui.active_tab) showTab(data().ui.active_tab);
    else renderEmpty();
  }
  saveDataSoon();
  renderTabs();
  renderHeader();
}

async function closeOthers(keepId) {
  for (const t of [...data().ui.tabs]) if (t.id !== keepId) await closeTab(t.id);
}

function renderEmpty() {
  tabBodyEl.innerHTML = "";
  const hasConn = data().connections.length > 0;
  tabBodyEl.append(
    el(
      "div.db-placeholder",
      {},
      icon("fa-solid fa-database"),
      el("p", {}, hasConn ? "Abra uma tabela no Database Explorer (duplo clique) ou crie um console SQL." : "Crie uma conexão com SQL Server ou Azure SQL para começar."),
      el(
        "div.db-placeholder-actions",
        {},
        hasConn ? el("button.hx-btn.primary", { type: "button", onclick: () => newConsoleForSelection() }, icon("fa-solid fa-terminal"), " Novo console") : null,
        el("button.hx-btn", { type: "button", onclick: newConnectionDialog }, icon("fa-solid fa-plus"), " Nova conexão"),
      ),
      el("div.db-shortcuts", { html: SHORTCUTS_HTML }),
    ),
  );
}

const SHORTCUTS_HTML = [
  ["Ctrl+Enter", "executar comando / enviar alterações do grid"],
  ["Ctrl+Shift+Q", "novo console"],
  ["F2 / Enter", "editar célula · Shift+Enter: editor de valor"],
  ["Ctrl+C / Ctrl+V", "copiar/colar (compatível com Excel)"],
  ["Alt+Insert / Ctrl+D", "nova linha / duplicar linha"],
  ["Ctrl+Shift+N", "definir NULL · Ctrl+Delete: excluir linha"],
  ["Ctrl+F", "buscar no resultado · Ctrl+Espaço: autocompletar"],
]
  .map(([k, d]) => `<div><kbd>${escapeHtml(k)}</kbd><span>${escapeHtml(d)}</span></div>`)
  .join("");

/** Console na conexão selecionada no Explorer (ou na da aba atual). */
function newConsoleForSelection() {
  const node = explorer?.selectedNode();
  const fromTab = activeTab();
  const c = conn(node?.connId) || conn(fromTab?.conn_id) || data().connections[0];
  if (!c) return newConnectionDialog();
  // O banco só vem da aba ativa se ela for da mesma conexão.
  const tabDb = fromTab?.conn_id === c.id ? fromTab.database : "";
  openConsole(c, (node?.connId === c.id && node.database) || tabDb || c.database);
}

function scriptMenu(ref, x, y) {
  const make = async (kind) => {
    try {
      const info = await dbApi.tableInfo(target(ref.conn, metaSession(ref.conn.id, ref.database), ref.database), ref.schema, ref.name);
      openConsole(ref.conn, ref.database, buildScript(kind, info));
    } catch (e) {
      toast(String(e));
    }
  };
  showMenu(x, y, [
    { header: "Gerar script" },
    { label: "SELECT", indent: true, icon: "fa-solid fa-magnifying-glass", run: () => make("select") },
    { label: "INSERT", indent: true, icon: "fa-solid fa-plus", run: () => make("insert") },
    { label: "UPDATE", indent: true, icon: "fa-solid fa-pen", run: () => make("update") },
    { label: "DELETE", indent: true, icon: "fa-regular fa-trash-can", run: () => make("delete") },
  ]);
}

function buildScript(kind, info) {
  const d = dialect();
  const table = d.qualified(info.schema, info.name);
  const cols = info.columns;
  const writable = cols.filter((c) => !c.is_identity && !c.is_computed);
  const keys = cols.filter((c) => c.is_pk);
  const whereKeys = (keys.length ? keys : cols.slice(0, 1)).map((c) => `${d.quote(c.name)} = NULL /* ${c.full_type} */`).join("\n  AND ");
  if (kind === "select") return `SELECT ${cols.map((c) => d.quote(c.name)).join(",\n       ")}\nFROM ${table}\nWHERE 1 = 1;`;
  if (kind === "insert") return `INSERT INTO ${table} (${writable.map((c) => d.quote(c.name)).join(", ")})\nVALUES (${writable.map((c) => `NULL /* ${c.name} ${c.full_type} */`).join(",\n        ")});`;
  if (kind === "update") return `UPDATE ${table}\nSET ${writable.filter((c) => !c.is_pk).map((c) => `${d.quote(c.name)} = NULL /* ${c.full_type} */`).join(",\n    ")}\nWHERE ${whereKeys};`;
  return `DELETE FROM ${table}\nWHERE ${whereKeys};`;
}

// ---------- Estrutura (DDL) ----------

const KIND_LABEL = { table: "tabela", view: "view", procedure: "procedure", function: "função" };
const ITEM_LABEL = { column: "coluna", key: "chave", index: "índice", fk: "chave estrangeira" };

/** Depois de um DDL: recarrega o Explorer, o autocomplete e as abas abertas do objeto. */
async function afterDdl({ conn: c, database, schema, name, renamed = null, dropped = false, dataOnly = false }) {
  completionCache.delete(`${c.id}:${database}`);
  if (!dataOnly) {
    explorer?.refreshSchema(c.id, database, schema);
    if (renamed && renamed.schema !== schema) explorer?.refreshSchema(c.id, database, renamed.schema);
  }
  const tabs = data().ui.tabs.filter((t) => (t.type === "table" || t.type === "ddl") && t.conn_id === c.id && t.database === database && t.schema === schema && t.name === name);
  for (const t of tabs) {
    if (dropped) {
      await closeTab(t.id, { force: true });
      continue;
    }
    const ctl = controllers.get(t.id);
    if (renamed) Object.assign(t, renamed);
    else if (dataOnly || t.type === "ddl") {
      ctl?.refresh();
      continue;
    } else if (ctl?.dirty) {
      // Colunas mudaram: a aba é recriada, mas não descarta edições pendentes do grid.
      toast(`"${t.name}" tem alterações pendentes; reabra a aba para ver a nova estrutura`);
      continue;
    }
    if (ctl) {
      ctl.dispose();
      controllers.delete(t.id);
    }
    if (data().ui.active_tab === t.id) showTab(t.id);
  }
  if (tabs.length) {
    saveDataSoon();
    renderTabs();
  }
}

const schemaCtx = {
  dialect: () => dialect(),
  toast,
  log,
  copy,
  openConsole: (c, database, sql) => openConsole(c, database, sql),
  completions,
  attachColumnComplete: attachWordComplete,
  afterDdl,
};

const schemaActions = {
  modify: (ref, focus = {}) => tableDesigner(schemaCtx, { conn: ref.conn, database: ref.database, schema: ref.schema, name: ref.name, focus }),
  newTable: ({ conn: c, database, schema }) => tableDesigner(schemaCtx, { conn: c, database, schema }),

  rename(ref) {
    ddlActionDialog(schemaCtx, {
      conn: ref.conn,
      database: ref.database,
      title: `Renomear ${KIND_LABEL[ref.kind] || ref.kind} ${ref.schema}.${ref.name}`,
      message: ref.kind === "table" ? "" : "Views, procedures e funções que dependem do nome antigo não são atualizadas.",
      input: { label: "Novo nome", value: ref.name },
      build: (v) => {
        if (!v) throw new Error("Informe o nome.");
        return v === ref.name ? [] : [renameObjectSql(dialect(), ref, v)];
      },
      confirmLabel: "Renomear",
      done: (v) => afterDdl({ conn: ref.conn, database: ref.database, schema: ref.schema, name: ref.name, renamed: { schema: ref.schema, name: v } }),
    });
  },

  drop(ref) {
    const label = KIND_LABEL[ref.kind] || ref.kind;
    ddlActionDialog(schemaCtx, {
      conn: ref.conn,
      database: ref.database,
      title: `Excluir ${label} ${ref.schema}.${ref.name}?`,
      message: ref.kind === "table" ? "A tabela e todos os seus dados serão excluídos permanentemente." : `A ${label} será excluída permanentemente.`,
      build: () => [dropObjectSql(dialect(), ref)],
      confirmLabel: "Excluir",
      danger: true,
      done: () => afterDdl({ conn: ref.conn, database: ref.database, schema: ref.schema, name: ref.name, dropped: true }),
    });
  },

  truncate(ref) {
    ddlActionDialog(schemaCtx, {
      conn: ref.conn,
      database: ref.database,
      title: `Esvaziar ${ref.schema}.${ref.name}?`,
      message: "Todas as linhas serão apagadas e o IDENTITY volta ao valor inicial. Falha se outra tabela referenciar esta por chave estrangeira.",
      build: () => [truncateSql(dialect(), ref)],
      confirmLabel: "Esvaziar",
      danger: true,
      done: () => afterDdl({ conn: ref.conn, database: ref.database, schema: ref.schema, name: ref.name, dataOnly: true }),
    });
  },

  renameItem(table, kind, itemName) {
    quickSchemaAction(schemaCtx, {
      ...tableArgs(table),
      title: `Renomear ${ITEM_LABEL[kind]} ${itemName}`,
      input: { label: "Novo nome", value: itemName },
      confirmLabel: "Renomear",
      mutate(model, v) {
        if (!v) throw new Error("Informe o nome.");
        const item = findItem(model, kind, itemName);
        if (kind === "column") renameColumnRefs(model, item.name, v);
        item.name = v;
      },
    });
  },

  dropItem(table, kind, itemName) {
    quickSchemaAction(schemaCtx, {
      ...tableArgs(table),
      title: `Excluir ${ITEM_LABEL[kind]} ${itemName}?`,
      message: kind === "column" ? "Os dados da coluna são perdidos. Índices, chaves e checks que usam a coluna também são excluídos." : "",
      confirmLabel: "Excluir",
      danger: true,
      mutate(model) {
        const item = findItem(model, kind, itemName);
        if (kind === "column") dropColumn(model, item);
        else item.dropped = true;
      },
    });
  },
};

const tableArgs = (t) => ({ conn: t.conn, database: t.database, schema: t.schema, name: t.name });

function findItem(model, kind, itemName) {
  const list = kind === "column" ? model.columns : kind === "fk" ? model.fks : model.indexes;
  const item = list.find((x) => (x.orig?.name ?? x.name) === itemName);
  if (!item) throw new Error(`"${itemName}" não encontrado; atualize o Explorer (F5).`);
  return item;
}

// ---------- Cabeçalho / bandeja ----------

function renderHeader() {
  const t = activeTab();
  const c = t ? conn(t.conn_id) : null;
  if (!c) {
    titleEl.textContent = "Banco de Dados";
    subEl.textContent = `${data().connections.length} conexão(ões)`;
    appEl.style.removeProperty("--conn");
    return;
  }
  const st = status(c.id);
  titleEl.textContent = connLabel(c);
  subEl.textContent = st.info ? `${st.info.product} ${st.info.version.split(".").slice(0, 2).join(".")} · ${t.database || st.info.database}` : isMongo(c) ? "MongoDB" : c.host;
  if (c.color) appEl.style.setProperty("--conn", c.color);
  else appEl.style.removeProperty("--conn");
}

function renderCompact() {
  compactListEl.innerHTML = "";
  if (!data().connections.length) {
    compactListEl.append(el("p.db-compact-empty", {}, "Nenhuma conexão ainda."));
    return;
  }
  for (const c of data().connections) {
    const st = status(c.id);
    compactListEl.append(
      el(
        "button.db-compact-item",
        {
          type: "button",
          style: c.color ? `--conn:${c.color}` : "",
          onclick: async () => {
            await enterDesktopMode();
            explorer?.expandConnection(c.id);
          },
        },
        el("span", { class: `dbx-state ${st.state}` }),
        icon(isMongo(c) ? "fa-solid fa-leaf" : /\.database\.windows\.net$/i.test(c.host) ? "fa-brands fa-microsoft" : "fa-solid fa-server"),
        el("span.db-compact-name", {}, connLabel(c)),
        el("span.db-compact-host", {}, c.database || (isMongo(c) ? "MongoDB" : c.host)),
      ),
    );
  }
}

function renderAll() {
  explorer?.render();
  renderTabs();
  renderHeader();
  renderCompact();
  if (!activeTab() && tabBodyEl.querySelector(".db-placeholder:not(.err)")) renderEmpty();
}

// ---------- Layout ----------

function applyLayout() {
  const ui = data().ui;
  appEl.style.setProperty("--db-explorer-w", `${ui.explorer_w}px`);
  appEl.style.setProperty("--db-log-h", `${ui.log_h}px`);
  appEl.classList.toggle("explorer-hidden", !ui.explorer_open);
  appEl.classList.toggle("log-hidden", !ui.log_open);
}

function initSplitters() {
  appEl.querySelectorAll("[data-split]").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const kind = handle.dataset.split;
      const ui = data().ui;
      const startX = e.clientX;
      const startY = e.clientY;
      const w0 = ui.explorer_w;
      const h0 = ui.log_h;
      document.body.classList.add(kind === "explorer" ? "db-resizing-x" : "db-resizing-y");
      const move = (ev) => {
        if (kind === "explorer") ui.explorer_w = Math.min(640, Math.max(200, w0 + ev.clientX - startX));
        else ui.log_h = Math.min(600, Math.max(60, h0 - (ev.clientY - startY)));
        applyLayout();
      };
      const up = () => {
        document.body.classList.remove("db-resizing-x", "db-resizing-y");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        saveDataSoon();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  });
}

// ---------- Ações ----------

const ACTIONS = {
  "new-connection": newConnectionDialog,
  "new-console": newConsoleForSelection,
  "toggle-explorer": () => {
    data().ui.explorer_open = !data().ui.explorer_open;
    applyLayout();
    saveDataSoon();
  },
  "toggle-log": () => {
    data().ui.log_open = !data().ui.log_open;
    applyLayout();
    saveDataSoon();
  },
  "clear-log": () => {
    logEntries = [];
    logListEl.innerHTML = "";
  },
  "refresh-node": () => {
    const n = explorer?.selectedNode();
    if (n) explorer.refresh(n.key);
  },
  "collapse-all": () => explorer?.collapseAll(),
  desktop: () => enterDesktopMode(),
  tray: () => exitDesktopMode(),
  "close-desktop": () => exitDesktopMode({ visible: false }),
  minimize: minimizeWindow,
  maximize: toggleMaximize,
};

function onKeydown(e) {
  if (state.activeMainView !== "db") return;
  if (e.key === "Escape") {
    if (!menuEl.hidden) return closeMenu();
    if (isDbModalOpen()) return closeDbModal();
  }
  if (!state.desktopMode || isDbModalOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && e.key.toLowerCase() === "q") {
    e.preventDefault();
    newConsoleForSelection();
  } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "w" && data().ui.active_tab) {
    e.preventDefault();
    closeTab(data().ui.active_tab);
  } else if (ctrl && e.key === "Tab" && data().ui.tabs.length > 1) {
    e.preventDefault();
    const tabs = data().ui.tabs;
    const i = tabs.findIndex((t) => t.id === data().ui.active_tab);
    showTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
  }
}

// ---------- API ----------

export function setDbData(raw) {
  state.db = normalizeDbData(raw);
  applyLayout();
  explorer = createExplorer(
    {
      data,
      conn,
      status,
      ensureConnected,
      disconnect,
      openTable,
      openDdl,
      openConsole,
      editConnection,
      deleteConnection,
      duplicateConnection,
      newConnection: newConnectionDialog,
      signOut,
      scriptMenu,
      schema: schemaActions,
      dialect: () => dialect(),
      showMenu,
      copy,
      toast,
      saveUi: saveDataSoon,
    },
    { treeEl, searchEl: document.getElementById("db-tree-search") },
  );
  renderAll();
  if (!activeTab()) renderEmpty();
  else if (state.activeMainView === "db" && state.desktopMode) showTab(activeTab().id);
}

export function initDb() {
  appEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn && appEl.contains(btn) && ACTIONS[btn.dataset.action]) ACTIONS[btn.dataset.action]();
  });
  document.addEventListener("mousedown", (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", onKeydown);
  initSplitters();
  // Abas ocultas têm tamanho 0: ao voltar, a aba ativa precisa se redesenhar.
  document.addEventListener("mainviewchange", (e) => {
    if (e.detail.view !== "db" || !state.db) return;
    renderAll();
    if (state.desktopMode && activeTab()) {
      const ctl = controllers.get(activeTab().id);
      if (ctl && tabBodyEl.contains(ctl.root)) ctl.activate();
      else showTab(activeTab().id);
    }
  });
  document.addEventListener("windowmodechange", () => {
    if (!state.db) return;
    renderAll();
    if (state.desktopMode && state.activeMainView === "db" && activeTab()) showTab(activeTab().id);
  });
}

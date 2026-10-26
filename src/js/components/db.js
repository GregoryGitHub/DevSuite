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
  buildConnectionString,
  newSavedQuery,
  queriesFor,
  queryFolders,
  normalizeFolder,
} from "../utils/dbModel.js";
import { dialectFor } from "../utils/sqlDialect.js";
import { saveDbDataApi, loadDbDataApi, dbApi, readTextFileApi, openFileDialogApi } from "../api.js";
import { registerApp } from "../appLifecycle.js";
import { createExplorer } from "./dbExplorer.js";
import { createTableTab } from "./dbTableTab.js";
import { createMongoTab } from "./dbMongoTab.js";
import { createConsoleTab, createDdlTab } from "./dbConsole.js";
import { createPlanTab } from "./dbPlan.js";
import { createPerfTab, PERF_SECTIONS } from "./dbPerf.js";
import { connectionDialog, dbConfirm, isDbModalOpen, closeDbModal, sqlPreviewDialog, saveQueryDialog, dbPrompt } from "./dbDialogs.js";
import { attachWordComplete } from "./sqlComplete.js";
import { tableDesigner, ddlActionDialog, quickSchemaAction, databaseScriptDialog } from "./dbSchema.js";
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
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    saveDbDataApi(data());
  }, 600);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
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

/**
 * Copia a connection string da conexão (para usar em outro software). Com `withPassword`, usa
 * `typed` (senha digitada no diálogo) ou a do cofre do sistema.
 */
async function copyConnectionString(c, { withPassword = false, typed } = {}) {
  let password;
  if (withPassword && (isMongo(c) || c.auth.kind === "sql")) {
    try {
      password = typed || (await dbApi.getPassword(c.id)) || undefined;
    } catch (e) {
      return toast(`Não foi possível ler a senha do cofre: ${e}`);
    }
    if (!password) return copy(buildConnectionString(c), "Copiada sem senha: não há senha salva para esta conexão");
  }
  copy(buildConnectionString(c, password), password ? "Connection string copiada (com senha)" : "Connection string copiada");
}

/** Botão "Copiar connection string" do diálogo de conexão. */
function copyConnectionMenu(c, anchor, typed) {
  showMenuBelow(anchor, [
    { label: "Sem senha", icon: "fa-regular fa-clipboard", run: () => copyConnectionString(c) },
    c.auth.kind === "sql" ? { label: "Com senha", icon: "fa-solid fa-key", run: () => copyConnectionString(c, { withPassword: true, typed }) } : null,
  ]);
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
  // Menu aberto de dentro de um diálogo (ex.: copiar connection string) fica acima do overlay.
  menuEl.classList.toggle("over-modal", isDbModalOpen());
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
  // Sem showTab(): ele reconectaria na hora. A aba volta a conectar só quando o usuário pedir.
  const t = activeTab();
  if (t?.conn_id === c.id) {
    tabBodyEl.innerHTML = "";
    tabBodyEl.append(
      el(
        "div.db-placeholder",
        {},
        icon("fa-solid fa-plug-circle-xmark"),
        el("p", {}, `Desconectado de ${connLabel(c)}`),
        el("button.hx-btn.primary", { type: "button", onclick: () => showTab(t.id) }, "Conectar"),
      ),
    );
  }
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
    onCopy: copyConnectionMenu,
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
    onCopy: copyConnectionMenu,
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
        if (activeTab()?.conn_id === c.id) showTab(activeTab().id);
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
    message: `"${connLabel(c)}", seus consoles e suas consultas salvas serão removidos. A senha/token é apagada do cofre do sistema.`,
    confirmLabel: "Excluir",
    danger: true,
  });
  if (!ok) return;
  await removeConnection(c);
}

/** Remove a conexão (abas, consoles, sessões e segredos), sem perguntar. */
async function removeConnection(c) {
  for (const t of data().ui.tabs.filter((t) => t.conn_id === c.id)) await closeTab(t.id, { force: true });
  await disconnect(c);
  await dbApi.forgetSecrets(c.id);
  data().connections = data().connections.filter((x) => x.id !== c.id);
  data().consoles = data().consoles.filter((x) => x.conn_id !== c.id);
  data().queries = data().queries.filter((x) => x.conn_id !== c.id);
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
          e.conn && conn(e.conn.id) ? { label: "Salvar como consulta…", icon: "fa-regular fa-bookmark", run: () => createQuery({ conn_id: e.conn.id, database: e.database, sql: e.sql }) } : null,
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
    const q = doc?.saved_id ? savedQuery(doc.saved_id) : null;
    return {
      title: `${doc?.name || "console"}${q && q.sql !== doc.sql ? " *" : ""}`,
      where: `${where}${doc?.database ? `/${doc.database}` : ""}`,
      icon: q ? "fa-solid fa-bookmark" : "fa-solid fa-terminal",
    };
  }
  if (t.type === "plan") return { title: t.name || "Plano", where: `${where}${t.database ? `/${t.database}` : ""}`, icon: "fa-solid fa-diagram-project" };
  if (t.type === "perf") {
    const s = PERF_SECTIONS.find((x) => x.id === t.options?.section) || PERF_SECTIONS[0];
    return { title: `Desempenho: ${s.label}`, where: `${where}${t.database ? `/${t.database}` : ""}`, icon: "fa-solid fa-gauge-high" };
  }
  if (t.type === "ddl" && t.kind === "database") return { title: `DDL ${t.name}`, where, icon: "fa-solid fa-scroll" };
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
      // Console de uma consulta salva: renomear a aba renomeia a consulta.
      const q = doc.saved_id ? savedQuery(doc.saved_id) : null;
      if (q) {
        q.name = doc.name;
        q.updated_at = Date.now();
        explorer?.render();
      }
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
  connections: () => data().connections,
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
  openPlan: (p) => openPlan(p),
  openPerf: (p) => openPerf(p),
  serverInfo: (c) => (c ? status(c.id).info || null : null),
  readFile: (path) => readTextFileApi(path),
  databases,
  completions,
  requireLogin,
  attachColumnComplete: attachWordComplete,
  savedQuery: (id) => savedQuery(id),
  saveQuery: saveConsoleQuery,
  editQuery: (q) => editQuery(q),
  rememberParams,
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
  else if (t.type === "plan") ctl = createPlanTab(tabCtx, t, (x) => planXml.get(x.id));
  else if (t.type === "perf") ctl = createPerfTab(tabCtx, t);
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

function openDdl({ conn: c, database, schema, name, kind, options = null }) {
  if (!c) return;
  const existing = data().ui.tabs.find((t) => t.type === "ddl" && t.conn_id === c.id && t.database === database && t.schema === schema && t.name === name && (t.kind === "database") === (kind === "database"));
  if (existing) {
    // Script do banco pedido de novo (com outras opções): regera na mesma aba.
    if (options) {
      existing.options = options;
      saveDataSoon();
      controllers.get(existing.id)?.refresh();
    }
    return showTab(existing.id);
  }
  addTab(newTab({ type: "ddl", conn_id: c.id, database, schema, name, kind, options }));
}

// XML dos planos abertos em aba (não vai para o databases.json: pode ter vários MB).
const planXml = new Map();

/** Aba com um plano de execução (do console, do cache, do Query Store ou de um .sqlplan). */
function openPlan({ conn: c, database = "", xml = null, name = "Plano", path = "" }) {
  if (!c) return;
  const t = newTab({ type: "plan", conn_id: c.id, database, name, options: path ? { path } : null });
  if (xml) planXml.set(t.id, xml);
  addTab(t);
}

async function openPlanFile(c, database = "") {
  const path = await openFileDialogApi({ title: "Abrir plano de execução", filters: [{ name: "Plano de execução", extensions: ["sqlplan", "xml"] }] });
  if (!path) return;
  openPlan({ conn: c, database, name: String(path).split(/[\\/]/).pop(), path });
}

/** Aba Desempenho do banco (uma por conexão + banco); `section`/filtros reaproveitam a aberta. */
function openPerf({ conn: c, database = "", section = "top", ...patch }) {
  if (!c || isMongo(c)) return;
  if (!state.desktopMode) enterDesktopMode();
  const db = database || c.database || "";
  const existing = data().ui.tabs.find((t) => t.type === "perf" && t.conn_id === c.id && t.database === db);
  if (existing) {
    showTab(existing.id);
    const ctl = controllers.get(existing.id);
    if (ctl) ctl.navigate(section, patch);
    else Object.assign((existing.options ||= {}), { section, ...patch });
    return;
  }
  addTab(newTab({ type: "perf", conn_id: c.id, database: db, options: { section, ...patch } }));
}

function openConsole(c, database, sql = "", extra = null) {
  if (!c) return toast("Crie uma conexão primeiro");
  const doc = newConsole(c, database);
  const n = data().consoles.filter((x) => x.conn_id === c.id).length;
  doc.name = n ? `console ${n + 1}` : "console";
  doc.sql = sql;
  if (extra) Object.assign(doc, extra);
  data().consoles.push(doc);
  addTab(newTab({ type: "console", conn_id: c.id, database: doc.database, console_id: doc.id }));
}

// ---------- Consultas salvas ----------

const savedQuery = (id) => data().queries.find((q) => q.id === id) || null;
const sameName = (a, b) => a.trim().localeCompare(b.trim(), "pt-BR", { sensitivity: "base" }) === 0;

/** Banco "efetivo" de um console/consulta: o escolhido, o padrão da conexão ou o do login. */
function effectiveDatabase(c, database) {
  return database || c.database || status(c.id).info?.database || "";
}

function queryDialog(title, query, selfId = null) {
  return saveQueryDialog({
    title,
    query,
    connections: data().connections,
    folders: (connId, database) => queryFolders(data().queries.filter((q) => q.conn_id === connId && q.database === database)),
    databases: async (connId) => {
      const c = conn(connId);
      return c && status(c.id).state === "connected" ? databases(c) : [];
    },
    exists: (v) =>
      data().queries.some((q) => q.id !== selfId && q.conn_id === v.conn_id && q.database === v.database && q.folder === normalizeFolder(v.folder) && sameName(q.name, v.name)),
  });
}

/** Consoles abertos ligados a uma consulta (para atualizar título/estado). */
function consolesOf(queryId) {
  return data().consoles.filter((d) => d.saved_id === queryId);
}

function refreshQueryViews(queryId = null) {
  for (const t of data().ui.tabs) {
    if (t.type !== "console") continue;
    const doc = data().consoles.find((d) => d.id === t.console_id);
    if (queryId && doc?.saved_id !== queryId) continue;
    controllers.get(t.id)?.refresh();
  }
  explorer?.render();
  renderTabs();
}

/** Nova consulta salva (do log, do Explorer ou de um console). Devolve a consulta ou null. */
async function createQuery({ conn_id, database = "", sql = "", folder = "", name = "" }) {
  const c = conn(conn_id);
  if (!c) return null;
  const v = await queryDialog("Salvar consulta", { name, folder, description: "", conn_id, database: effectiveDatabase(c, database) });
  if (!v) return null;
  const q = newSavedQuery({ ...v, sql });
  data().queries.push(q);
  saveNow();
  explorer?.revealQuery(q);
  toast(`Consulta "${q.name}" salva`);
  return q;
}

/** Ctrl+S no console: atualiza a consulta ligada ou cria uma nova e liga o console a ela. */
async function saveConsoleQuery(doc, { asNew = false, text }) {
  const linked = doc.saved_id ? savedQuery(doc.saved_id) : null;
  if (linked && !asNew) {
    linked.sql = text;
    linked.updated_at = Date.now();
    saveNow();
    refreshQueryViews(linked.id);
    return toast(`"${linked.name}" salva`);
  }
  const q = await createQuery({ conn_id: doc.conn_id, database: doc.database, sql: text, folder: linked?.folder || "", name: linked ? `${linked.name} (cópia)` : "" });
  if (!q) return;
  // O console passa a ser da consulta só se ela tem o texto inteiro dele.
  if (text === doc.sql) {
    doc.saved_id = q.id;
    doc.name = q.name;
    q.params = { ...doc.params, ...q.params };
  }
  saveNow();
  refreshQueryViews();
}

async function editQuery(q) {
  const v = await queryDialog(`Consulta — ${q.name}`, { name: q.name, folder: q.folder, description: q.description, conn_id: q.conn_id, database: q.database }, q.id);
  if (!v) return;
  const moved = v.conn_id !== q.conn_id || v.database !== q.database;
  Object.assign(q, { name: v.name, folder: normalizeFolder(v.folder), description: v.description, conn_id: v.conn_id, database: v.database, updated_at: Date.now() });
  // Consoles abertos continuam na conexão deles; só o nome acompanha.
  for (const d of consolesOf(q.id)) {
    if (moved) d.saved_id = "";
    else d.name = q.name;
  }
  saveNow();
  refreshQueryViews();
  if (moved) explorer?.revealQuery(q);
}

function duplicateQuery(q) {
  const copyQ = newSavedQuery({ ...structuredClone(q), id: undefined, name: `${q.name} (cópia)` });
  data().queries.push(copyQ);
  saveNow();
  explorer?.revealQuery(copyQ);
}

function deleteQueries(list, label) {
  if (!list.length) return;
  const ids = new Set(list.map((q) => q.id));
  const before = data().queries.slice();
  const links = data().consoles.filter((d) => ids.has(d.saved_id)).map((d) => [d, d.saved_id]);
  data().queries = data().queries.filter((q) => !ids.has(q.id));
  for (const [d] of links) d.saved_id = "";
  saveNow();
  refreshQueryViews();
  toast(label, {
    label: "Desfazer",
    run: () => {
      data().queries = before;
      for (const [d, id] of links) d.saved_id = id;
      saveNow();
      refreshQueryViews();
    },
  });
}

/** Pasta das consultas (Explorer): renomear troca o prefixo de todas as consultas abaixo dela. */
async function renameQueryFolder({ connId, database, isDefault, folder }) {
  const name = folder.split("/").pop();
  const v = (await dbPrompt({ title: "Renomear pasta", label: "Nome", value: name }))?.trim();
  if (!v || v === name || v.includes("/")) return;
  const parent = folder.split("/").slice(0, -1).join("/");
  const next = normalizeFolder(parent ? `${parent}/${v}` : v);
  for (const q of queriesFor(data(), connId, database, isDefault)) {
    if (q.folder === folder) q.folder = next;
    else if (q.folder.startsWith(`${folder}/`)) q.folder = next + q.folder.slice(folder.length);
  }
  saveNow();
  explorer?.render();
}

/** Abre a consulta num console ligado a ela (reaproveita o console já aberto); `run` executa. */
function openSavedQuery(q, { run = false } = {}) {
  const c = conn(q.conn_id);
  if (!c) return;
  if (!state.desktopMode) enterDesktopMode();
  const doc = data().consoles.find((d) => d.saved_id === q.id && data().ui.tabs.some((t) => t.console_id === d.id));
  if (doc) {
    // autorun: o console executa ao ser ativado (showTab chama activate()).
    if (run) doc.autorun = true;
    return showTab(data().ui.tabs.find((x) => x.console_id === doc.id).id);
  }
  openConsole(c, q.database, q.sql, { saved_id: q.id, name: q.name, params: structuredClone(q.params), autorun: run });
}

/** Lembra os últimos valores dos parâmetros no console e na consulta ligada a ele. */
function rememberParams(doc, values) {
  const toSaved = (v) => ({ type: v.type, last: String(v.value ?? "") });
  for (const [name, v] of Object.entries(values)) doc.params[name] = toSaved(v);
  const q = doc.saved_id ? savedQuery(doc.saved_id) : null;
  if (q) for (const [name, v] of Object.entries(values)) q.params[name] = toSaved(v);
  saveDataSoon();
}

/** Arrastar no Explorer: leva a consulta para outra pasta/banco. */
function moveQuery(q, { connId, database, folder }) {
  if (q.conn_id === connId && q.database === database && q.folder === folder) return;
  if (q.conn_id !== connId) for (const d of consolesOf(q.id)) d.saved_id = "";
  Object.assign(q, { conn_id: connId, database, folder: normalizeFolder(folder), updated_at: Date.now() });
  saveNow();
  refreshQueryViews();
}

const queryActions = {
  list: (connId, database, isDefault) => queriesFor(data(), connId, database, isDefault),
  get: savedQuery,
  open: openSavedQuery,
  create: createQuery,
  edit: editQuery,
  duplicate: duplicateQuery,
  move: moveQuery,
  remove: (q) => deleteQueries([q], `Consulta "${q.name}" excluída`),
  removeFolder: ({ connId, database, isDefault, folder }) => {
    const list = queriesFor(data(), connId, database, isDefault).filter((q) => !folder || q.folder === folder || q.folder.startsWith(`${folder}/`));
    deleteQueries(list, `${list.length} consulta(s) excluída(s)`);
  },
  renameFolder: renameQueryFolder,
};

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
  planXml.delete(t.id);
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
  ["Ctrl+L / Ctrl+Shift+L", "plano estimado / executar com plano real e IO/TIME"],
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
  openDatabaseScript: ({ conn: c, database, options }) => openDdl({ conn: c, database, schema: "", name: database, kind: "database", options }),
};

const schemaActions = {
  modify: (ref, focus = {}) => tableDesigner(schemaCtx, { conn: ref.conn, database: ref.database, schema: ref.schema, name: ref.name, focus }),
  newTable: ({ conn: c, database, schema }) => tableDesigner(schemaCtx, { conn: c, database, schema }),
  databaseScript: ({ conn: c, database, schema }) => databaseScriptDialog(schemaCtx, { conn: c, database, schema }),

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
  explorer?.destroy();
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
      perf: {
        open: (c, database, section, patch = {}) => openPerf({ conn: c, database, section, ...patch }),
        openPlanFile: (c, database) => openPlanFile(c, database),
      },
      schema: schemaActions,
      queries: queryActions,
      dialect: () => dialect(),
      showMenu,
      copy,
      copyConnectionString,
      toast,
      saveUi: saveDataSoon,
      onConnectionsReordered: renderCompact,
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

  registerApp("db", {
    flush: async () => {
      if (!saveTimer) return;
      clearTimeout(saveTimer);
      saveTimer = 0;
      await saveDbDataApi(data());
    },
    reload: async () => {
      // As sessões (tab:/console:/meta:) continuam no Rust: só a interface é recriada, sem
      // dispose() (que desconectaria e perderia transações abertas).
      for (const ctl of controllers.values()) ctl.root?.remove();
      controllers.clear();
      tabFlags.clear();
      setDbData(await loadDbDataApi());
    },
    blocker: () =>
      [...tabFlags.values()].some((f) => f.running) ? "Há consultas em andamento no Banco. Espere terminar ou cancele antes de mover." : null,
  });
}

// ---------- CLI (js/cli/dbCli.js) ----------

/** Operações do Banco usadas pela CLI `devsuite`, sobre o databases.json vivo desta janela. */
export const dbHost = {
  async addConnection(c, password) {
    data().connections.push(c);
    if (password) await dbApi.setPassword(c.id, password);
    saveNow();
    renderAll();
  },
  removeConnection,
  /** Nova consulta salva (já normalizada com newSavedQuery). */
  addQuery(q) {
    data().queries.push(q);
    saveNow();
    explorer?.render();
  },
  /** Últimos valores dos parâmetros usados (como na interface). */
  rememberQueryParams(q, values) {
    for (const [name, v] of Object.entries(values)) q.params[name] = { type: v.type, last: String(v.value ?? "") };
    saveDataSoon();
  },
};

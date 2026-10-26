import { state } from "../state.js";
import { el, icon } from "../utils/dom.js";
import { rabbitApi, saveFileDialogApi, writeFileApi } from "../api.js";
import {
  SECTIONS,
  REFRESH_OPTIONS,
  apiPath,
  connConfig,
  connLabel,
  exchangeSeg,
  fmtNum,
  newConnection,
  normalizeConnection,
  normalizeSettings,
  normalizeUi,
  uid,
} from "../utils/rabbitModel.js";
import { overviewView, queuesView, exchangesView, connectionsView, channelsView, consumersView } from "./rabbitViews.js";
import { queueView, exchangeView } from "./rabbitQueue.js";
import { capturesView } from "./rabbitLog.js";
import { jsonBlock } from "./rabbitMessage.js";
import {
  connectionDialog,
  publishDialog,
  republishManyDialog,
  moveDialog,
  newQueueDialog,
  newExchangeDialog,
  bindingDialog,
  captureDialog,
  promptDialog,
  settingsDialog,
  dangerConfirm,
  rmqConfirm,
  isRmqModalOpen,
  closeRmqModal,
} from "./rabbitDialogs.js";
import { enterDesktopMode, exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";
import { registerApp } from "../appLifecycle.js";

// Aba "RabbitMQ": monitoramento das filas de um host, operações de depuração (ver, republicar,
// mover, purgar, excluir, fechar conexões) e gravação das mensagens trafegadas no rabbit.db.
// Desktop: conexões/seções | conteúdo. Bandeja: resumo das conexões.

const appEl = document.getElementById("rmq-app");
const treeEl = document.getElementById("rmq-tree");
const mainEl = document.getElementById("rmq-main");
const menuEl = document.getElementById("rmq-menu");
const toastEl = document.getElementById("rmq-toast");
const compactEl = document.getElementById("rmq-compact-list");
const titleEl = document.getElementById("rmq-tb-title");
const subEl = document.getElementById("rmq-tb-sub");
const pillEl = document.getElementById("rmq-rec-pill");
const refreshLabelEl = document.getElementById("rmq-refresh-label");

const R = { connections: [], ui: normalizeUi(), settings: normalizeSettings(), loaded: false };
/** connId -> { state: idle|connecting|connected|error, error, overview, vhosts, pending } */
const statuses = new Map();
/** connId -> { section -> número } (contadores da barra lateral) */
const counts = new Map();
/** Gravações ativas: id -> { id, conn_id, vhost, mode, source, queues, count } */
const live = new Map();
const captureListeners = new Set();
const remembered = {};

let view = null; // { root, refresh, dispose, focusFilter? }
let viewKey = "";
let refreshing = false;
let lastRefresh = 0;
let detail = null; // { type: "queue" | "exchange", vhost, name }

const conn = () => R.connections.find((c) => c.id === R.ui.conn_id) || null;
const status = (id) => statuses.get(id) || { state: "idle" };

// ---------- Persistência ----------

let uiTimer = 0;
function saveUi() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    uiTimer = 0;
    rabbitApi.saveMeta("ui", R.ui).catch(() => {});
  }, 500);
}

function saveConnections() {
  return rabbitApi.saveConnections(R.connections).catch((e) => toast(String(e)));
}

// ---------- Toast / menus / clipboard ----------

let toastTimer = 0;
function toast(message, action = null) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.append(el("span", { title: message }, message));
  if (action) toastEl.append(el("button", { type: "button", onclick: () => ((toastEl.hidden = true), action.run()) }, action.label));
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 8000 : message.length > 80 ? 6500 : 3000);
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
    b.classList.toggle("on", !!item.on);
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

// ---------- API ----------

function api(method, path, body = null, c = conn()) {
  if (!c) return Promise.reject("Nenhuma conexão selecionada.");
  return rabbitApi.http(connConfig(c), method, path, body);
}

const get = (path, c) => api("GET", path, null, c);

async function ensureConnected(c) {
  const st = status(c.id);
  if (st.state === "connected") return st;
  if (st.pending) return st.pending;
  const pending = (async () => {
    try {
      const [overview, vhosts] = await Promise.all([get("/overview", c), get("/vhosts?columns=name,tracing", c).catch(() => [])]);
      const next = { state: "connected", overview, vhosts: vhosts.map((v) => v.name).sort(), tracing: vhosts.filter((v) => v.tracing).map((v) => v.name) };
      statuses.set(c.id, next);
      return next;
    } catch (e) {
      statuses.set(c.id, { state: "error", error: String(e) });
      throw e;
    } finally {
      renderTree();
      renderCompact();
      renderHeader();
    }
  })();
  statuses.set(c.id, { state: "connecting", pending });
  renderTree();
  return pending;
}

function vhostOf(c) {
  const v = R.ui.vhosts[c?.id];
  return v === undefined ? c?.vhost || "/" : v;
}

// ---------- Conexões ----------

async function newConnectionDialog() {
  if (!state.desktopMode) await enterDesktopMode();
  connectionDialog(newConnection(), {
    isNew: true,
    onSave: async (c, password) => {
      R.connections.push(c);
      if (password !== undefined) await rabbitApi.setPassword(c.id, password).catch((e) => toast(String(e)));
      await saveConnections();
      selectConnection(c.id, "overview");
    },
  });
}

async function editConnection(c) {
  const hasPassword = await rabbitApi.hasPassword(c.id);
  connectionDialog(c, {
    isNew: false,
    hasPassword,
    onSave: async (next, password) => {
      const i = R.connections.findIndex((x) => x.id === c.id);
      if (i < 0) return;
      R.connections[i] = next;
      if (password !== undefined) await rabbitApi.setPassword(c.id, password).catch((e) => toast(String(e)));
      await saveConnections();
      statuses.delete(c.id);
      renderAll();
      if (R.ui.conn_id === c.id) showCurrent(true);
    },
    onDelete: () => deleteConnection(c),
  });
}

async function deleteConnection(c) {
  const ok = await rmqConfirm({ title: "Excluir conexão?", message: `"${connLabel(c)}" será removida e a senha apagada do cofre do sistema. As mensagens gravadas continuam no rabbit.db.`, confirmLabel: "Excluir", danger: true });
  if (!ok) return;
  await removeConnection(c);
}

/** Remove a conexão (para as gravações dela e apaga a senha), sem perguntar. */
async function removeConnection(c) {
  for (const cap of [...live.values()].filter((x) => x.conn_id === c.id)) await rabbitApi.captureStop(cap.id).catch(() => {});
  await rabbitApi.forgetPassword(c.id);
  R.connections = R.connections.filter((x) => x.id !== c.id);
  statuses.delete(c.id);
  if (R.ui.conn_id === c.id) R.ui.conn_id = R.connections[0]?.id || null;
  await saveConnections();
  saveUi();
  renderAll();
  showCurrent(true);
}

function duplicateConnection(c) {
  const copyConn = normalizeConnection({ ...structuredClone(c), id: uid(), name: `${connLabel(c)} (cópia)` });
  R.connections.push(copyConn);
  saveConnections();
  renderAll();
  editConnection(copyConn);
}

function selectConnection(id, section = null) {
  R.ui.conn_id = id;
  if (section) R.ui.section = section;
  if (!R.ui.expanded.includes(id)) R.ui.expanded.push(id);
  detail = null;
  saveUi();
  renderAll();
  showCurrent(true);
}

// ---------- Barra lateral ----------

function renderTree() {
  treeEl.innerHTML = "";
  if (!R.connections.length) {
    treeEl.append(el("div.rmq-tree-empty", {}, el("p", {}, "Nenhuma conexão."), el("button.hx-btn.primary", { type: "button", onclick: newConnectionDialog }, icon("fa-solid fa-plus"), " Nova conexão")));
    return;
  }
  for (const c of R.connections) {
    const st = status(c.id);
    const open = R.ui.expanded.includes(c.id);
    const selectedConn = R.ui.conn_id === c.id;
    const row = el(
      "div.rmq-conn",
      {
        class: `rmq-conn${selectedConn ? " on" : ""}`,
        style: c.color ? `--conn:${c.color}` : "",
        title: st.error || c.mgmt_url,
        onclick: (e) => {
          if (e.target.closest(".rmq-caret")) {
            toggleExpanded(c.id);
            return;
          }
          selectConnection(c.id);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, connMenu(c));
        },
      },
      el("span.rmq-caret", {}, icon(`fa-solid fa-chevron-${open ? "down" : "right"}`)),
      el("span", { class: `dbx-state ${st.state}` }),
      el("span.rmq-conn-name", {}, connLabel(c)),
      c.protected ? icon("fa-solid fa-shield-halved rmq-prot") : null,
      el("button.hx-icon-btn.rmq-conn-more", { type: "button", title: "Opções", onclick: (e) => (e.stopPropagation(), showMenuBelow(e.currentTarget, connMenu(c))) }, icon("fa-solid fa-ellipsis")),
    );
    treeEl.append(row);
    if (!open) continue;
    const box = el("div.rmq-conn-body", { style: c.color ? `--conn:${c.color}` : "" });
    if (st.state === "connected" && st.vhosts?.length) {
      const sel = el(
        "select.hx-select.small.rmq-vh-select",
        {
          title: "Vhost",
          onchange: () => {
            R.ui.vhosts[c.id] = sel.value;
            saveUi();
            if (R.ui.conn_id !== c.id) R.ui.conn_id = c.id;
            detail = null;
            renderAll();
            showCurrent(true);
          },
        },
        el("option", { value: "" }, "Todos os vhosts"),
        ...st.vhosts.map((v) => el("option", { value: v }, `vhost ${v}`)),
      );
      sel.value = vhostOf(c);
      box.append(sel);
    }
    const n = counts.get(c.id) || {};
    for (const s of SECTIONS) {
      const active = selectedConn && R.ui.section === s.id && !detail;
      const liveCount = s.id === "captures" ? [...live.values()].filter((x) => x.conn_id === c.id).length : 0;
      box.append(
        el(
          "button.rmq-sec",
          { type: "button", class: `rmq-sec${active ? " on" : ""}${selectedConn && R.ui.section === s.id && detail ? " parent" : ""}`, onclick: () => openSection(s.id, {}, c.id) },
          icon(s.icon),
          el("span", {}, s.label),
          liveCount ? el("span.rmq-sec-live", { title: "Gravando" }, el("i.fa-solid.fa-circle.rmq-rec-dot.pulse"), String(liveCount)) : n[s.id] !== undefined ? el("span.rmq-sec-n", {}, fmtNum(n[s.id])) : null,
        ),
      );
      if (s.id === R.ui.section && selectedConn && detail) {
        box.append(el("div.rmq-sec.on.child", {}, icon(detail.type === "queue" ? "fa-solid fa-inbox" : "fa-solid fa-shuffle"), el("span", { title: detail.name }, detail.name || "(AMQP default)")));
      }
    }
    treeEl.append(box);
  }
}

function toggleExpanded(id) {
  const i = R.ui.expanded.indexOf(id);
  if (i >= 0) R.ui.expanded.splice(i, 1);
  else R.ui.expanded.push(id);
  saveUi();
  renderTree();
}

function connMenu(c) {
  return [
    { label: "Editar conexão…", icon: "fa-solid fa-pen", run: () => editConnection(c) },
    { label: "Duplicar", icon: "fa-regular fa-clone", run: () => duplicateConnection(c) },
    { label: "Reconectar", icon: "fa-solid fa-rotate", run: () => (statuses.delete(c.id), selectConnection(c.id)) },
    { label: "Abrir management no navegador", icon: "fa-solid fa-arrow-up-right-from-square", run: () => rabbitApi.openMgmt(connConfig(c)).catch((e) => toast(String(e))) },
    "sep",
    { label: "Preferências (busca e gravação)…", icon: "fa-solid fa-sliders", run: () => settingsDialog(ctx) },
    "sep",
    { label: "Excluir conexão…", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteConnection(c) },
  ];
}

// ---------- Cabeçalho / bandeja ----------

function renderHeader() {
  const c = conn();
  if (!c) {
    titleEl.textContent = "RabbitMQ";
    subEl.textContent = `${R.connections.length} conexão(ões)`;
    appEl.style.removeProperty("--conn");
  } else {
    const st = status(c.id);
    titleEl.textContent = connLabel(c);
    const ov = st.overview;
    const vh = vhostOf(c);
    subEl.textContent = ov ? `RabbitMQ ${ov.rabbitmq_version} · ${vh ? `vhost ${vh}` : "todos os vhosts"}` : st.state === "error" ? "erro de conexão" : c.mgmt_url;
    if (c.color) appEl.style.setProperty("--conn", c.color);
    else appEl.style.removeProperty("--conn");
  }
  refreshLabelEl.textContent = R.ui.refresh_s ? `${R.ui.refresh_s}s` : "off";
  const n = live.size;
  pillEl.hidden = !n;
  pillEl.innerHTML = "";
  if (n) {
    const total = [...live.values()].reduce((s, x) => s + (x.count || 0), 0);
    pillEl.append(el("i.fa-solid.fa-circle.rmq-rec-dot.pulse"), ` Gravando ${n} · ${fmtNum(total)} msg`);
    pillEl.title = [...live.values()].map((x) => `${x.name || x.source}: ${fmtNum(x.count)}`).join("\n");
  }
}

function renderCompact() {
  compactEl.innerHTML = "";
  if (!R.connections.length) {
    compactEl.append(el("p.db-compact-empty", {}, "Nenhuma conexão ainda."));
    return;
  }
  for (const c of R.connections) {
    const st = status(c.id);
    const qt = st.overview?.queue_totals;
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
        icon("fa-solid fa-envelopes-bulk"),
        el("span.db-compact-name", {}, connLabel(c)),
        el(
          "span.db-compact-host",
          {},
          st.state === "error" ? "erro de conexão" : qt ? `${fmtNum(qt.messages_ready)} prontas · ${fmtNum(qt.messages_unacknowledged)} sem ack` : "",
        ),
      ),
    );
  }
}

/** No modo bandeja: resumo (overview) de cada conexão a cada 15 s enquanto a aba estiver visível. */
async function refreshCompact() {
  if (state.desktopMode || state.activeMainView !== "rabbit" || document.hidden) return;
  await Promise.all(
    R.connections.map(async (c) => {
      try {
        const overview = await get("/overview", c);
        statuses.set(c.id, { ...status(c.id), state: "connected", overview, pending: null });
      } catch (e) {
        statuses.set(c.id, { state: "error", error: String(e) });
      }
    }),
  );
  renderCompact();
}

function renderAll() {
  renderTree();
  renderHeader();
  renderCompact();
}

// ---------- Conteúdo ----------

const VIEWS = {
  overview: overviewView,
  queues: queuesView,
  exchanges: exchangesView,
  connections: connectionsView,
  channels: channelsView,
  consumers: consumersView,
  captures: capturesView,
};

function openSection(id, opts = {}, connId = R.ui.conn_id) {
  if (connId && connId !== R.ui.conn_id) R.ui.conn_id = connId;
  R.ui.section = id;
  detail = null;
  if (opts.text !== undefined) {
    const ls = listState(id, {});
    ls.text = opts.text;
  }
  saveUi();
  renderAll();
  showCurrent(true, opts);
}

function openQueue(vhost, name) {
  if (!state.desktopMode) enterDesktopMode();
  R.ui.section = "queues";
  detail = { type: "queue", vhost, name };
  renderTree();
  showCurrent(true);
}

function openExchange(vhost, name) {
  R.ui.section = "exchanges";
  detail = { type: "exchange", vhost, name };
  renderTree();
  showCurrent(true);
}

function placeholder(content) {
  mainEl.innerHTML = "";
  mainEl.append(content);
}

/** Recria a seção atual (force) ou só a atualiza. */
async function showCurrent(force = false, opts = {}) {
  const c = conn();
  if (!c) {
    disposeView();
    placeholder(
      el(
        "div.db-placeholder",
        {},
        icon("fa-solid fa-envelopes-bulk"),
        el("p", {}, R.connections.length ? "Escolha uma conexão na barra lateral." : "Crie uma conexão com o RabbitMQ (URL do plugin de management, ex.: http://localhost:15672)."),
        el("div.db-placeholder-actions", {}, el("button.hx-btn.primary", { type: "button", onclick: newConnectionDialog }, icon("fa-solid fa-plus"), " Nova conexão")),
        el("div.db-shortcuts", { html: SHORTCUTS_HTML }),
      ),
    );
    return;
  }
  const key = `${c.id}|${vhostOf(c)}|${R.ui.section}|${detail ? `${detail.type}:${detail.vhost}:${detail.name}` : ""}`;
  if (!force && view && key === viewKey && mainEl.contains(view.root)) return refreshView();
  if (status(c.id).state !== "connected") {
    disposeView();
    placeholder(el("div.db-placeholder", {}, icon("fa-solid fa-spinner fa-spin"), el("p", {}, `Conectando em ${connLabel(c)}…`)));
    try {
      await ensureConnected(c);
    } catch (e) {
      if (conn()?.id !== c.id) return;
      placeholder(
        el(
          "div.db-placeholder.err",
          {},
          icon("fa-solid fa-plug-circle-exclamation"),
          el("p", {}, String(e)),
          el("button.hx-btn.primary", { type: "button", onclick: () => (statuses.delete(c.id), showCurrent(true)) }, "Tentar de novo"),
          el("button.hx-btn", { type: "button", onclick: () => editConnection(c) }, "Editar conexão"),
        ),
      );
      return;
    }
    if (conn()?.id !== c.id) return;
  }
  disposeView();
  viewKey = key;
  view = detail ? (detail.type === "queue" ? queueView(ctx, detail) : exchangeView(ctx, detail)) : VIEWS[R.ui.section](ctx, opts);
  placeholder(view.root);
  renderHeader();
  refreshView();
}

function disposeView() {
  view?.dispose?.();
  view = null;
  viewKey = "";
}

async function refreshView() {
  if (!view || refreshing) return;
  refreshing = true;
  lastRefresh = Date.now();
  const v = view;
  try {
    await v.refresh();
    v.root.querySelector(":scope > .rmq-error")?.remove();
  } catch (e) {
    if (v !== view) return;
    let box = v.root.querySelector(":scope > .rmq-error");
    if (!box) {
      box = el("div.rmq-alert.rmq-error");
      v.root.prepend(box);
    }
    box.innerHTML = "";
    box.append(icon("fa-solid fa-circle-exclamation"), el("span", {}, String(e)), el("button.hx-btn", { type: "button", onclick: () => refreshView() }, "Tentar de novo"));
    if (/conectar|Tempo esgotado|401/.test(String(e))) {
      const c = conn();
      if (c) statuses.set(c.id, { state: "error", error: String(e) });
      renderTree();
    }
  } finally {
    refreshing = false;
  }
}

let soonTimer = 0;
function refreshSoon() {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => refreshView(), 400);
}

function tick() {
  if (state.activeMainView !== "rabbit" || document.hidden || isRmqModalOpen()) return;
  if (!state.desktopMode) {
    if (Date.now() - lastRefresh > 15000) {
      lastRefresh = Date.now();
      refreshCompact();
    }
    return;
  }
  // Gravações e a seção de mensagens têm atualização própria (eventos / ação do usuário).
  if (!R.ui.refresh_s || !view || R.ui.section === "captures") return;
  if (Date.now() - lastRefresh >= R.ui.refresh_s * 1000) refreshView();
}

function listState(section, defaults) {
  R.ui.lists[section] = { ...defaults, ...(R.ui.lists[section] || {}) };
  return R.ui.lists[section];
}

// ---------- Redimensionamento ----------

function applyLayout() {
  appEl.style.setProperty("--rmq-side-w", `${R.ui.side_w}px`);
  appEl.style.setProperty("--rmq-detail-h", `${R.ui.detail_h}px`);
  appEl.classList.toggle("side-hidden", !R.ui.side_open);
}

function initSideSplitter() {
  appEl.querySelector('[data-split="side"]').addEventListener("mousedown", (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = R.ui.side_w;
    document.body.classList.add("db-resizing-x");
    const move = (ev) => {
      R.ui.side_w = Math.min(420, Math.max(180, w0 + ev.clientX - x0));
      applyLayout();
    };
    const up = () => {
      document.body.classList.remove("db-resizing-x");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveUi();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/** Separador horizontal (lista em cima, detalhe embaixo) dentro de `.rmq-split.v`. */
function attachSplit(split) {
  const handle = split.querySelector(".rmq-split-h");
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = R.ui.detail_h;
    document.body.classList.add("db-resizing-y");
    const move = (ev) => {
      R.ui.detail_h = Math.min(Math.max(120, split.clientHeight - 80), Math.max(120, h0 - (ev.clientY - y0)));
      applyLayout();
    };
    const up = () => {
      document.body.classList.remove("db-resizing-y");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveUi();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

// ---------- Operações ----------

const needsName = () => !!conn()?.protected;

const ops = {
  async purge({ vhost, name, messages }) {
    const ok = await dangerConfirm({
      title: "Purgar fila?",
      message: `Todas as mensagens prontas${messages ? ` (${fmtNum(messages)})` : ""} de "${name}" serão apagadas. Mensagens sem ack (com consumidores) não são afetadas. Não dá para desfazer.`,
      name,
      confirmLabel: "Purgar",
      requireName: needsName(),
    });
    if (!ok) return false;
    try {
      await api("DELETE", `${apiPath("queues", vhost, name)}/contents`);
      toast(`Fila "${name}" purgada`);
      return true;
    } catch (e) {
      toast(String(e));
      return false;
    }
  },
  async purgeMany(list) {
    const total = list.reduce((n, q) => n + (q.messages_ready || 0), 0);
    const ok = await dangerConfirm({ title: `Purgar ${list.length} filas?`, message: `${fmtNum(total)} mensagem(ns) prontas serão apagadas de: ${list.map((q) => q.name).join(", ")}.`, name: `${list.length} filas`, confirmLabel: "Purgar todas", requireName: needsName() });
    if (!ok) return;
    const errors = [];
    for (const q of list) await api("DELETE", `${apiPath("queues", q.vhost, q.name)}/contents`).catch((e) => errors.push(`${q.name}: ${e}`));
    toast(errors.length ? `Falhas: ${errors.join(" · ")}` : `${list.length} filas purgadas`);
  },
  async deleteQueue({ vhost, name, messages = 0, consumers = 0 }) {
    const ok = await dangerConfirm({
      title: "Excluir fila?",
      message: `"${name}" será excluída${messages ? ` com ${fmtNum(messages)} mensagem(ns)` : ""}${consumers ? ` e ${consumers} consumidor(es) serão desconectados` : ""}.`,
      name,
      confirmLabel: "Excluir",
      requireName: needsName(),
    });
    if (!ok) return false;
    try {
      await api("DELETE", apiPath("queues", vhost, name));
      toast(`Fila "${name}" excluída`);
      return true;
    } catch (e) {
      toast(String(e));
      return false;
    }
  },
  async deleteMany(list) {
    const ok = await dangerConfirm({ title: `Excluir ${list.length} filas?`, message: list.map((q) => q.name).join(", "), name: `${list.length} filas`, confirmLabel: "Excluir todas", requireName: needsName() });
    if (!ok) return;
    const errors = [];
    for (const q of list) await api("DELETE", apiPath("queues", q.vhost, q.name)).catch((e) => errors.push(`${q.name}: ${e}`));
    toast(errors.length ? `Falhas: ${errors.join(" · ")}` : `${list.length} filas excluídas`);
  },
  async deleteExchange({ vhost, name }) {
    const ok = await dangerConfirm({ title: "Excluir exchange?", message: `"${name}" e as ligações dela serão removidas.`, name, confirmLabel: "Excluir", requireName: needsName() });
    if (!ok) return false;
    try {
      await api("DELETE", apiPath("exchanges", vhost, exchangeSeg(name)));
      toast(`Exchange "${name}" excluída`);
      return true;
    } catch (e) {
      toast(String(e));
      return false;
    }
  },
  async closeConnections(list) {
    const names = list.map((c) => c.name).filter(Boolean);
    if (!names.length) return;
    const ok = await dangerConfirm({
      title: names.length > 1 ? `Fechar ${names.length} conexões?` : "Fechar conexão?",
      message: `${names.join("\n")}\n\nO cliente recebe "CONNECTION_FORCED" e normalmente reconecta; mensagens sem ack voltam para a fila.`,
      name: names.length === 1 ? names[0] : `${names.length} conexões`,
      confirmLabel: "Fechar",
      requireName: needsName(),
    });
    if (!ok) return;
    const errors = [];
    for (const n of names) {
      await rabbitApi
        .http(connConfig(conn()), "DELETE", apiPath("connections", n), null)
        .catch((e) => errors.push(String(e)));
    }
    toast(errors.length ? errors.join(" · ") : names.length > 1 ? `${names.length} conexões fechadas` : "Conexão fechada");
  },
  async setTracing(vhost, on) {
    const v = await get(apiPath("vhosts", vhost));
    const body = { tracing: on };
    if (v.description) body.description = v.description;
    if (Array.isArray(v.tags)) body.tags = v.tags.join(",");
    if (v.default_queue_type && v.default_queue_type !== "undefined") body.default_queue_type = v.default_queue_type;
    await api("PUT", apiPath("vhosts", vhost), body);
    toast(`Tracing ${on ? "ligado" : "desligado"} em ${vhost}`);
  },
};

function queueMenu(list, x, y, after) {
  const q = list[0];
  if (list.length > 1) {
    return showMenu(x, y, [
      { header: `${list.length} filas` },
      { label: "Gravar mensagens…", icon: "fa-solid fa-circle-dot", run: () => captureDialog(ctx, { vhost: q.vhost, queues: list.map((x) => x.name) }) },
      { label: "Copiar nomes", icon: "fa-regular fa-copy", run: () => copy(list.map((x) => x.name).join("\n")) },
      "sep",
      { label: "Purgar…", icon: "fa-solid fa-broom", danger: true, run: () => ops.purgeMany(list).then(after) },
      { label: "Excluir…", icon: "fa-regular fa-trash-can", danger: true, run: () => ops.deleteMany(list).then(after) },
    ]);
  }
  showMenu(x, y, [
    { label: "Abrir", icon: "fa-solid fa-up-right-from-square", run: () => openQueue(q.vhost, q.name) },
    { label: "Publicar mensagem…", icon: "fa-solid fa-paper-plane", run: () => publishDialog(ctx, { vhost: q.vhost, exchange: "", routing_key: q.name }) },
    { label: "Mover / copiar mensagens…", icon: "fa-solid fa-right-left", disabled: !q.messages_ready, run: () => moveDialog(ctx, { vhost: q.vhost, queue: q.name, count: q.messages_ready }).then((r) => r && after()) },
    { label: "Gravar mensagens…", icon: "fa-solid fa-circle-dot", run: () => captureDialog(ctx, { vhost: q.vhost, queues: [q.name] }) },
    { label: "Nova ligação…", icon: "fa-solid fa-link", run: () => bindingDialog(ctx, { vhost: q.vhost, queue: q.name }) },
    "sep",
    { label: "Copiar nome", icon: "fa-regular fa-copy", run: () => copy(q.name) },
    "sep",
    { label: "Purgar…", icon: "fa-solid fa-broom", danger: true, disabled: !q.messages_ready, run: () => ops.purge({ vhost: q.vhost, name: q.name, messages: q.messages_ready }).then(after) },
    { label: "Excluir…", icon: "fa-regular fa-trash-can", danger: true, run: () => ops.deleteQueue({ vhost: q.vhost, name: q.name, messages: q.messages, consumers: q.consumers }).then(after) },
  ]);
}

// ---------- Gravações ----------

function captureQueues(info) {
  if (info.mode === "exchange" || !info.source || info.source.startsWith("vhost ")) return [];
  return info.source.split(", ");
}

function onCaptureEvent(ev) {
  const cap = live.get(ev.capture_id);
  if (ev.kind === "progress" && cap) cap.count = ev.count;
  else if (ev.kind === "warning") toast(ev.message);
  else if (ev.kind === "stopped") {
    live.delete(ev.capture_id);
    const name = cap?.name || "Gravação";
    toast(ev.error ? `${name} parou: ${ev.error}` : `${name} encerrada · ${fmtNum(ev.count)} mensagem(ns)`, { label: "Ver", run: () => openSection("captures", { captureId: ev.capture_id }) });
    renderTree();
  }
  renderHeader();
  for (const fn of captureListeners) fn(ev);
}

async function startCapture(spec, c = conn()) {
  const info = await rabbitApi.captureStart(connConfig(c), spec, onCaptureEvent);
  live.set(info.id, { ...info, queues: captureQueues(info), count: 0 });
  renderTree();
  renderHeader();
  for (const fn of captureListeners) fn({ kind: "started", capture_id: info.id });
  toast(`Gravando: ${info.name}`, { label: "Ver", run: () => openSection("captures", { captureId: info.id }) });
  return info;
}

async function stopCapture(id) {
  await rabbitApi.captureStop(id).catch((e) => toast(String(e)));
}

/** Gravações que continuaram rodando no Rust (interface recarregada): reconecta os eventos. */
async function reattachCaptures() {
  try {
    const list = await rabbitApi.captures(null);
    for (const c of list.filter((x) => x.active)) {
      if (await rabbitApi.captureAttach(c.id, onCaptureEvent)) live.set(c.id, { ...c, queues: captureQueues(c) });
    }
  } catch {
    /* fora do Tauri */
  }
  renderTree();
  renderHeader();
}

// ---------- Utilidades para as seções ----------

async function saveJson(fileName, text) {
  const path = await saveFileDialogApi({ defaultPath: fileName, filters: [{ name: "JSON", extensions: ["json"] }], title: "Exportar" });
  if (!path) return;
  try {
    await writeFileApi(path, { text });
    toast("Arquivo salvo");
  } catch (e) {
    toast(String(e));
  }
}

async function exportDefinitions() {
  const c = conn();
  const vh = vhostOf(c);
  try {
    const defs = await get(vh ? apiPath("definitions", vh) : "/definitions");
    saveJson(`rabbitmq-${connLabel(c).replace(/[^\w.-]+/g, "_")}${vh ? `-${vh.replace(/[^\w.-]+/g, "_") || "root"}` : ""}.json`, JSON.stringify(defs, null, 2));
  } catch (e) {
    toast(String(e));
  }
}

const ctx = {
  conn,
  connConfig: () => connConfig(conn()),
  vhost: () => vhostOf(conn()),
  vhostList: () => status(conn()?.id).vhosts || [],
  api: (method, path, body) => api(method, path, body),
  get: (path) => get(path),
  toast,
  copy,
  showMenu,
  showMenuBelow,
  confirm: rmqConfirm,
  confirmDanger: ({ title, message, name, confirmLabel }) => dangerConfirm({ title, message, name, confirmLabel, requireName: needsName() }),
  listState,
  saveUi,
  settings: () => R.settings,
  saveSettings: (s) => {
    R.settings = normalizeSettings(s);
    rabbitApi.saveMeta("settings", R.settings).catch((e) => toast(String(e)));
  },
  detailTab: (kind) => R.ui.lists[`tab:${kind}`],
  setDetailTab: (kind, tab) => ((R.ui.lists[`tab:${kind}`] = tab), saveUi()),
  setCount: (section, n) => {
    const c = conn();
    if (!c) return;
    const m = counts.get(c.id) || {};
    if (m[section] === n) return;
    m[section] = n;
    counts.set(c.id, m);
    renderTree();
  },
  openSection,
  openQueue,
  openExchange,
  queueMenu,
  ops,
  setTracing: (vh, on) => ops.setTracing(vh, on),
  isCapturing: (vhost, queue) => [...live.values()].some((x) => x.conn_id === conn()?.id && x.vhost === vhost && x.queues.includes(queue)),
  liveCapture: (id) => live.get(id) || null,
  onCaptureEvent: (fn) => (captureListeners.add(fn), () => captureListeners.delete(fn)),
  startCapture,
  stopCapture,
  saveMessages: (records) => rabbitApi.saveMessages(records, R.settings.max_body_kb),
  saveJson,
  exportDefinitions,
  jsonBlock,
  attachSplit,
  refreshSoon,
  remember: (k, v) => (remembered[k] = v),
  dialogs: {
    publish: (preset) => publishDialog(ctx, preset),
    republishMany: (msgs) => republishManyDialog(ctx, msgs),
    move: (opts) => moveDialog(ctx, opts),
    newQueue: (preset) => newQueueDialog(ctx, preset),
    newExchange: (preset) => newExchangeDialog(ctx, preset),
    binding: (opts) => bindingDialog(ctx, opts),
    capture: (preset) => captureDialog(ctx, preset),
    prompt: (opts) => promptDialog(opts),
  },
};

const SHORTCUTS_HTML = [
  ["F5", "atualizar"],
  ["Ctrl+F", "filtrar a lista"],
  ["Ctrl+Shift+P", "publicar mensagem"],
  ["Alt+←", "voltar da fila/exchange para a lista"],
  ["Duplo clique", "abrir fila / exchange"],
  ["Botão direito", "purgar, mover, gravar, excluir…"],
]
  .map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`)
  .join("");

// ---------- Ações da barra / atalhos ----------

const ACTIONS = {
  "new-connection": newConnectionDialog,
  refresh: () => (conn() && status(conn().id).state !== "connected" ? (statuses.delete(conn().id), showCurrent(true)) : refreshView()),
  "refresh-menu": () =>
    showMenuBelow(appEl.querySelector('[data-action="refresh-menu"]'), [
      { header: "Atualização automática" },
      ...REFRESH_OPTIONS.map((s) => ({ label: s ? `A cada ${s} s` : "Desligada", icon: R.ui.refresh_s === s ? "fa-solid fa-check" : "", run: () => ((R.ui.refresh_s = s), saveUi(), renderHeader()) })),
    ]),
  publish: () => conn() && publishDialog(ctx, remembered.publish || {}),
  "new-capture": () => conn() && captureDialog(ctx, {}),
  "go-captures": () => openSection("captures"),
  "toggle-side": () => {
    R.ui.side_open = !R.ui.side_open;
    applyLayout();
    saveUi();
  },
  desktop: () => enterDesktopMode(),
  tray: () => exitDesktopMode(),
  "close-desktop": () => exitDesktopMode({ visible: false }),
  minimize: minimizeWindow,
  maximize: toggleMaximize,
};

function onKeydown(e) {
  if (state.activeMainView !== "rabbit") return;
  if (e.key === "Escape") {
    if (!menuEl.hidden) return closeMenu();
    if (isRmqModalOpen()) return closeRmqModal();
  }
  if (!state.desktopMode || isRmqModalOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (e.key === "F5") {
    e.preventDefault();
    ACTIONS.refresh();
  } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    ACTIONS.publish();
  } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "f" && view?.focusFilter) {
    e.preventDefault();
    view.focusFilter();
  } else if (e.altKey && e.key === "ArrowLeft" && detail && !typing) {
    e.preventDefault();
    openSection(R.ui.section);
  }
}

// ---------- API pública ----------

export async function loadRabbit() {
  try {
    const d = await rabbitApi.load();
    R.connections = (d.connections || []).map(normalizeConnection);
    R.ui = normalizeUi(d.ui);
    R.settings = normalizeSettings(d.settings);
  } catch (e) {
    console.error("rabbit load failed", e);
  }
  if (R.ui.conn_id && !R.connections.some((c) => c.id === R.ui.conn_id)) R.ui.conn_id = R.connections[0]?.id || null;
  if (!R.ui.conn_id) R.ui.conn_id = R.connections[0]?.id || null;
  R.loaded = true;
  applyLayout();
  renderAll();
  reattachCaptures();
  if (state.activeMainView === "rabbit" && state.desktopMode) showCurrent(true);
}

export function initRabbit() {
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
    if (e.detail.view !== "rabbit" || !R.loaded) return;
    renderAll();
    if (state.desktopMode) showCurrent(!view || !mainEl.contains(view.root));
    else {
      lastRefresh = 0;
      tick();
    }
  });
  document.addEventListener("windowmodechange", () => {
    if (!R.loaded) return;
    renderAll();
    if (state.desktopMode && state.activeMainView === "rabbit") showCurrent(true);
  });

  registerApp("rabbit", {
    flush: async () => {
      if (!uiTimer) return;
      clearTimeout(uiTimer);
      uiTimer = 0;
      await rabbitApi.saveMeta("ui", R.ui).catch(() => {});
    },
    // As gravações ativas continuam no Rust; loadRabbit reconecta os eventos nesta janela.
    reload: () => loadRabbit(),
  });
}

// ---------- CLI (js/cli/rabbitCli.js) ----------

/** Operações do RabbitMQ usadas pela CLI `devsuite`, sobre o estado vivo desta janela. */
export const rabbitHost = {
  connections: () => R.connections,
  settings: () => R.settings,
  startCapture: (c, spec) => startCapture(spec, c),
  async addConnection(c, password) {
    R.connections.push(c);
    if (password !== undefined) await rabbitApi.setPassword(c.id, password);
    await saveConnections();
    renderAll();
  },
  removeConnection,
  refreshSoon,
};

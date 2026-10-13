import { el, icon } from "../utils/dom.js";
import { rabbitApi } from "../api.js";
import { CAPTURE_MODES, EVENT_LABELS, exchangeLabel, exportMessages, fmtBytes, fmtNum, fmtTime, normalizeMessage } from "../utils/rabbitModel.js";
import { createTable, esc } from "./rabbitViews.js";
import { messageDetail } from "./rabbitMessage.js";

// Gravações: lista das capturas (tap/firehose/exchange) e das mensagens salvas no rabbit.db,
// com busca pelo conteúdo (FTS), filtros por routing key/fila/exchange/caminho JSON/período,
// acompanhamento ao vivo, republicação e exportação.

const PAGE = 200;

const toLocalInput = (ms) => {
  if (!ms) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 19);
};
const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);

export function capturesView(ctx, opts = {}) {
  const st = ctx.listState("captures", { selected: "all", text: "", routing_key: "", exchange: "", queue: "", event: "", json_path: "", json_op: "eq", json_value: "", from: null, to: null, live: true });
  if (opts.savedOnly) st.selected = "saved";
  if (opts.captureId) st.selected = String(opts.captureId);
  let disposed = false;
  let captures = [];
  let rows = [];
  let total = null;
  let loadingMore = false;
  let selectedId = null;
  let liveTimer = 0;

  // ----- Lista de gravações -----
  const capList = el("div.rmq-cap-items");
  const storeInfo = el("div.rmq-cap-store");
  const side = el(
    "div.rmq-cap-side",
    {},
    el("div.db-pane-head", {}, el("span", {}, "Gravações"), el("span.hx-flex"), el("button.hx-icon-btn", { type: "button", title: "Nova gravação", onclick: () => ctx.dialogs.capture({}) }, icon("fa-solid fa-plus"))),
    capList,
    storeInfo,
  );

  function capItem(key, { title, sub, iconCls, active = false, count = null, menu = null, cls = "" }) {
    const b = el(
      "button.rmq-cap-item",
      {
        type: "button",
        class: `rmq-cap-item${st.selected === key ? " on" : ""}${active ? " live" : ""}${cls ? ` ${cls}` : ""}`,
        onclick: () => select(key),
        oncontextmenu: menu
          ? (e) => {
              e.preventDefault();
              ctx.showMenu(e.clientX, e.clientY, menu());
            }
          : null,
      },
      el("span.rmq-cap-icon", {}, active ? el("i.rmq-rec-dot.pulse.fa-solid.fa-circle") : icon(iconCls)),
      el("span.rmq-cap-text", {}, el("span.rmq-cap-title", {}, title), sub ? el("span.rmq-cap-sub", {}, sub) : null),
      count !== null ? el("span.rmq-cap-count", {}, fmtNum(count)) : null,
    );
    return b;
  }

  function renderCaptures() {
    capList.innerHTML = "";
    capList.append(
      capItem("all", { title: "Todas as mensagens", sub: "desta conexão", iconCls: "fa-solid fa-layer-group" }),
      capItem("saved", { title: "Salvas das filas", sub: "mensagens espiadas/consumidas", iconCls: "fa-solid fa-floppy-disk" }),
    );
    if (captures.length) capList.append(el("div.rmq-cap-sep", {}, "Gravações"));
    for (const c of captures) {
      const mode = CAPTURE_MODES[c.mode] || { short: c.mode, icon: "fa-solid fa-circle-dot" };
      const live = ctx.liveCapture(c.id);
      const count = live ? Math.max(live.count, c.count) : c.count;
      capList.append(
        capItem(String(c.id), {
          title: c.name || c.source,
          sub: `${mode.short} · ${c.vhost} · ${fmtTime(c.started_at, { millis: false })}${c.stopped_at ? ` → ${fmtTime(c.stopped_at, { millis: false, date: false })}` : ""}${c.error && !c.active ? " · ⚠" : ""}`,
          iconCls: mode.icon,
          active: c.active,
          count,
          cls: c.error && !c.active ? "err" : "",
          menu: () => [
            c.active ? { label: "Parar gravação", icon: "fa-solid fa-stop", run: () => ctx.stopCapture(c.id) } : null,
            { label: "Renomear…", icon: "fa-solid fa-pen", run: () => rename(c) },
            { label: "Gravar de novo (mesma origem)", icon: "fa-solid fa-rotate-right", disabled: c.active, run: () => ctx.dialogs.capture({ vhost: c.vhost, mode: c.mode, queues: c.mode !== "exchange" && c.source && !c.source.startsWith("vhost ") ? c.source.split(", ") : [], exchange: c.mode === "exchange" ? c.source.replace(/ \[.*\]$/, "") : "" }) },
            { label: "Exportar mensagens (JSON)", icon: "fa-solid fa-file-export", run: () => exportFilter({ ...baseFilter(), capture_id: c.id }, `${c.name || "gravacao"}.json`) },
            c.error ? { label: "Ver erro", icon: "fa-solid fa-circle-exclamation", run: () => ctx.toast(c.error) } : null,
            "sep",
            { label: "Excluir gravação e mensagens…", icon: "fa-regular fa-trash-can", danger: true, run: () => removeCapture(c) },
          ],
        }),
      );
    }
  }

  function refreshStoreInfo() {
    rabbitApi
      .stats()
      .then((s) => !disposed && (storeInfo.textContent = `rabbit.db: ${fmtNum(s.messages)} mensagens · ${fmtBytes(s.bytes)}`))
      .catch(() => {});
  }

  async function loadCaptures() {
    captures = await rabbitApi.captures(ctx.conn().id);
    if (disposed) return;
    if (st.selected !== "all" && st.selected !== "saved" && !captures.some((c) => String(c.id) === st.selected)) st.selected = "all";
    renderCaptures();
    paintLiveFlag();
    refreshStoreInfo();
  }

  async function rename(c) {
    const name = await ctx.dialogs.prompt({ title: "Renomear gravação", label: "Nome", value: c.name });
    if (name === null) return;
    await rabbitApi.captureRename(c.id, name);
    loadCaptures();
  }

  async function removeCapture(c) {
    const ok = await ctx.confirm({ title: "Excluir gravação?", message: `"${c.name}" e ${fmtNum(c.count)} mensagem(ns) gravada(s) serão apagadas do rabbit.db.`, confirmLabel: "Excluir", danger: true });
    if (!ok) return;
    await rabbitApi.captureDelete(c.id);
    if (st.selected === String(c.id)) st.selected = "all";
    await loadCaptures();
    search();
  }

  function select(key) {
    st.selected = key;
    ctx.saveUi();
    renderCaptures();
    paintLiveFlag();
    search();
  }

  // ----- Filtros -----
  const input = (key, placeholder, cls = "", type = "search") =>
    el(`input.hx-input${cls ? `.${cls}` : ""}`, {
      type,
      value: type === "datetime-local" ? toLocalInput(st[key]) : st[key] || "",
      placeholder,
      spellcheck: false,
      step: type === "datetime-local" ? 1 : undefined,
      onchange: (e) => {
        st[key] = type === "datetime-local" ? fromLocalInput(e.target.value) : e.target.value;
        ctx.saveUi();
        search();
      },
      onkeydown: (e) => {
        if (e.key === "Enter") {
          st[key] = type === "datetime-local" ? fromLocalInput(e.target.value) : e.target.value;
          search();
        }
      },
    });
  const textIn = input("text", "Buscar no corpo, headers e routing key", "rmq-f-text");
  textIn.addEventListener("input", () => {
    st.text = textIn.value;
    clearTimeout(textIn._t);
    textIn._t = setTimeout(search, 300);
  });
  const eventSel = el(
    "select.hx-select.small",
    { onchange: () => ((st.event = eventSel.value), ctx.saveUi(), search()) },
    el("option", { value: "" }, "Todos os eventos"),
    el("option", { value: "publish" }, "Publicadas"),
    el("option", { value: "deliver" }, "Entregues (firehose)"),
    el("option", { value: "peek" }, "Salvas das filas"),
  );
  eventSel.value = st.event || "";
  const opSel = el(
    "select.hx-select.small.rmq-f-op",
    { onchange: () => ((st.json_op = opSel.value), ctx.saveUi(), st.json_path && search()) },
    ...[
      ["eq", "="],
      ["ne", "≠"],
      ["contains", "contém"],
      ["gt", ">"],
      ["lt", "<"],
      ["exists", "existe"],
    ].map(([v, l]) => el("option", { value: v }, l)),
  );
  opSel.value = st.json_op || "eq";
  const liveBtn = el("button.rmq-chip", { type: "button", title: "Acompanhar novas mensagens das gravações ativas", onclick: () => ((st.live = !st.live), ctx.saveUi(), paintLiveFlag()) }, el("i.fa-solid.fa-circle.rmq-rec-dot"), " Ao vivo");
  const filters = el(
    "div.rmq-filters",
    {},
    el("label.db-search.rmq-filter.grow", {}, icon("fa-solid fa-magnifying-glass"), textIn),
    input("routing_key", "Routing key (aceita *)", "rmq-f-sm"),
    input("queue", "Fila", "rmq-f-sm"),
    input("exchange", "Exchange", "rmq-f-sm"),
    eventSel,
    el("span.rmq-f-group", { title: "Filtro por campo do corpo JSON, ex.: pedido.id = 42 ou $.itens[0].sku" }, input("json_path", "Campo JSON (pedido.id)", "rmq-f-sm"), opSel, input("json_value", "valor", "rmq-f-xs")),
    el("span.rmq-f-group", { title: "Período" }, input("from", "", "rmq-f-date", "datetime-local"), el("span.rmq-sub", {}, "até"), input("to", "", "rmq-f-date", "datetime-local")),
    el("button.hx-btn", { type: "button", title: "Limpar filtros", onclick: clearFilters }, icon("fa-solid fa-filter-circle-xmark")),
    liveBtn,
  );

  function clearFilters() {
    Object.assign(st, { text: "", routing_key: "", exchange: "", queue: "", event: "", json_path: "", json_value: "", from: null, to: null });
    ctx.saveUi();
    filters.querySelectorAll("input").forEach((i) => (i.value = ""));
    eventSel.value = "";
    search();
  }

  function baseFilter() {
    const f = {
      conn_id: ctx.conn().id,
      text: st.text || "",
      routing_key: st.routing_key || "",
      exchange: st.exchange || "",
      queue: st.queue || "",
      event: st.event || "",
      json_path: st.json_path || "",
      json_op: st.json_op || "eq",
      json_value: st.json_value || "",
      from: st.from || null,
      to: st.to || null,
    };
    if (st.selected === "saved") f.event = "peek";
    else if (st.selected !== "all") f.capture_id = Number(st.selected);
    return f;
  }

  // ----- Resultado -----
  const countEl = el("span.rmq-count");
  const bulk = el("div.rmq-bulk", { hidden: true });
  const moreBtn = el("button.hx-btn.rmq-more", { type: "button", hidden: true, onclick: () => loadMore() }, "Carregar mais");
  const table = createTable({
    state: {},
    rowKey: (r) => r.id,
    emptyText: "Nenhuma mensagem. Inicie uma gravação ou salve mensagens a partir de uma fila.",
    rowClass: (r) => (r.fresh ? "fresh" : ""),
    columns: [
      { key: "at", label: "Hora", html: (r) => `<span class="rmq-sub">${esc(fmtTime(r.at))}</span>` },
      { key: "event", label: "Evento", html: (r) => `<span class="rmq-ev ev-${esc(r.event)}">${esc(EVENT_LABELS[r.event] || r.event)}</span>${r.redelivered ? ' <span class="rmq-feat warn" title="Reentregue">R</span>' : ""}` },
      { key: "ex", label: "Exchange", html: (r) => esc(exchangeLabel(r.exchange)) },
      { key: "rk", label: "Routing key", html: (r) => `<code>${esc(r.routing_key)}</code>` },
      { key: "queues", label: "Filas", html: (r) => `<span class="rmq-sub">${esc(r.queues.split(" ").join(", "))}</span>` },
      { key: "preview", label: "Corpo", html: (r) => `<span class="rmq-preview">${r.binary ? "(binário)" : esc(r.preview)}</span>` },
      { key: "size", label: "Tamanho", align: "right", html: (r) => `${fmtBytes(r.size)}${r.truncated ? ' <span class="rmq-feat warn" title="Truncado no limite configurado">T</span>' : ""}` },
      { key: "id", label: "message_id", html: (r) => `<span class="rmq-sub">${esc(r.message_id || r.correlation_id)}</span>` },
    ],
    onSelect: (list) => {
      selectedId = list.length === 1 ? list[0].id : null;
      paintBulk(list);
      paintDetail();
    },
    onMenu: (list, e) => ctx.showMenu(e.clientX, e.clientY, rowMenu(list)),
  });
  const detailEl = el("div.rmq-msg-pane");
  const tableBox = el("div.rmq-table-box", {}, table.root, moreBtn);
  const split = el("div.rmq-split.v", {}, tableBox, el("div.rmq-split-h", { title: "Arraste para redimensionar" }), detailEl);
  ctx.attachSplit(split);
  const main = el(
    "div.rmq-cap-main",
    {},
    el(
      "div.rmq-head",
      {},
      el("h2", {}, icon("fa-solid fa-circle-dot"), el("span", {}, "Mensagens"), countEl),
      bulk,
      el("span.hx-flex"),
      el("button.hx-btn.rmq-tool", { type: "button", title: "Exportar o resultado do filtro (JSON)", onclick: () => exportFilter(baseFilter(), "mensagens.json") }, icon("fa-solid fa-file-export"), " Exportar"),
      el("button.hx-btn.rmq-tool", { type: "button", title: "Apagar do rabbit.db as mensagens do resultado do filtro", onclick: deleteFiltered }, icon("fa-regular fa-trash-can")),
      el("button.hx-btn.primary.rmq-tool", { type: "button", onclick: () => ctx.dialogs.capture({}) }, icon("fa-solid fa-circle-dot"), " Gravar"),
    ),
    filters,
    split,
  );
  const root = el("div.rmq-view.rmq-captures", {}, side, main);

  function paintBulk(list) {
    bulk.innerHTML = "";
    bulk.hidden = list.length < 2;
    if (list.length < 2) return;
    bulk.append(
      el("span.rmq-bulk-n", {}, `${list.length} selecionadas`),
      el("button.hx-btn.rmq-tool", { type: "button", onclick: () => republish(list) }, icon("fa-solid fa-paper-plane"), " Republicar"),
      el("button.hx-btn.rmq-tool", { type: "button", onclick: () => exportIds(list.map((r) => r.id)) }, icon("fa-solid fa-file-export")),
      el("button.hx-btn.rmq-tool", { type: "button", onclick: () => deleteRows(list) }, icon("fa-regular fa-trash-can")),
    );
  }

  function rowMenu(list) {
    return [
      list.length === 1 ? { label: "Republicar…", icon: "fa-solid fa-paper-plane", run: () => republish(list) } : { label: `Republicar ${list.length}…`, icon: "fa-solid fa-paper-plane", run: () => republish(list) },
      list.length === 1 ? { label: "Copiar corpo", icon: "fa-regular fa-copy", run: async () => ctx.copy((await rabbitApi.message(list[0].id)).payload, "Corpo copiado") } : null,
      { label: "Copiar como JSON", icon: "fa-solid fa-code", run: async () => ctx.copy(exportMessages(await full(list.map((r) => r.id))), "Copiado") },
      { label: "Exportar…", icon: "fa-solid fa-file-export", run: () => exportIds(list.map((r) => r.id)) },
      list.length === 1 && list[0].routing_key ? { label: "Filtrar por esta routing key", icon: "fa-solid fa-filter", run: () => setFilter("routing_key", list[0].routing_key) } : null,
      list.length === 1 && list[0].message_id ? { label: "Buscar este message_id", icon: "fa-solid fa-magnifying-glass", run: () => setFilter("text", list[0].message_id) } : null,
      list.length === 1 && list[0].correlation_id ? { label: "Buscar este correlation_id", icon: "fa-solid fa-magnifying-glass", run: () => setFilter("text", list[0].correlation_id) } : null,
      "sep",
      { label: list.length > 1 ? `Excluir ${list.length} do log` : "Excluir do log", icon: "fa-regular fa-trash-can", danger: true, run: () => deleteRows(list) },
    ];
  }

  function setFilter(key, value) {
    st[key] = value;
    const target = { text: textIn }[key] || [...filters.querySelectorAll("input")].find((i) => i.placeholder.toLowerCase().startsWith(key === "routing_key" ? "routing" : key));
    if (target) target.value = value;
    ctx.saveUi();
    search();
  }

  const full = async (ids) => (await rabbitApi.messages(ids)).map(toMessage);

  function toMessage(m) {
    return normalizeMessage(m, { id: m.id, event: m.event, at: m.at, queues: m.queues, client: m.client, truncated: m.truncated, size: m.size, vhost: m.vhost });
  }

  async function paintDetail() {
    detailEl.innerHTML = "";
    if (!selectedId) {
      detailEl.append(el("div.rmq-empty", {}, rows.length ? "Selecione uma mensagem." : ""));
      return;
    }
    const id = selectedId;
    const m = await rabbitApi.message(id).catch(() => null);
    if (disposed || selectedId !== id) return;
    if (!m) {
      detailEl.append(el("div.rmq-empty", {}, "Mensagem não encontrada (apagada?)."));
      return;
    }
    const msg = toMessage(m);
    detailEl.append(
      messageDetail(msg, {
        copy: ctx.copy,
        extra: [["vhost", m.vhost]],
        actions: [
          el("button.hx-btn", { type: "button", onclick: () => ctx.dialogs.publish({ vhost: m.vhost, message: msg }) }, icon("fa-solid fa-paper-plane"), " Republicar"),
          el("button.hx-btn", { type: "button", title: "Excluir do log", onclick: () => deleteRows([{ id }]) }, icon("fa-regular fa-trash-can")),
        ],
      }),
    );
  }

  async function republish(list) {
    const msgs = await full(list.map((r) => r.id));
    if (msgs.length === 1) return ctx.dialogs.publish({ vhost: msgs[0].vhost, message: msgs[0] });
    ctx.dialogs.republishMany(msgs);
  }

  async function exportIds(ids) {
    ctx.saveJson("mensagens.json", exportMessages(await full(ids)));
  }

  async function exportFilter(filter, fileName) {
    const page = await rabbitApi.query({ ...filter, ascending: true, limit: 100000 });
    if (!page.rows.length) return ctx.toast("Nada para exportar");
    ctx.saveJson(fileName, exportMessages(await full(page.rows.map((r) => r.id))));
  }

  async function deleteRows(list) {
    const ok = await ctx.confirm({ title: "Excluir do log?", message: `${list.length} mensagem(ns) serão apagadas do rabbit.db (não afeta o RabbitMQ).`, confirmLabel: "Excluir", danger: true });
    if (!ok) return;
    await rabbitApi.deleteMessages(list.map((r) => r.id));
    search();
    renderCaptures();
  }

  async function deleteFiltered() {
    if (!total) return ctx.toast("Nada para apagar");
    const ok = await ctx.confirm({ title: "Apagar o resultado do filtro?", message: `${fmtNum(total)} mensagem(ns) que casam com o filtro atual serão apagadas do rabbit.db (não afeta o RabbitMQ).`, confirmLabel: "Apagar", danger: true });
    if (!ok) return;
    const n = await rabbitApi.deleteMatching(baseFilter());
    ctx.toast(`${fmtNum(n)} mensagem(ns) apagada(s)`);
    search();
    loadCaptures();
  }

  let searchSeq = 0;
  async function search() {
    const seq = ++searchSeq;
    try {
      const page = await rabbitApi.query({ ...baseFilter(), limit: PAGE });
      if (disposed || seq !== searchSeq) return;
      rows = page.rows;
      total = page.total;
      table.setRows(rows);
      paintCount();
      if (!rows.some((r) => r.id === selectedId)) {
        selectedId = null;
        paintDetail();
      }
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  function paintCount() {
    countEl.textContent = total === null ? "" : rows.length < total ? `${fmtNum(rows.length)} de ${fmtNum(total)}` : fmtNum(total);
    moreBtn.hidden = total === null || rows.length >= total;
  }

  async function loadMore() {
    if (loadingMore || !rows.length) return;
    loadingMore = true;
    try {
      const page = await rabbitApi.query({ ...baseFilter(), limit: PAGE, before_id: rows[rows.length - 1].id });
      rows = rows.concat(page.rows);
      table.setRows(rows);
      paintCount();
    } finally {
      loadingMore = false;
    }
  }

  /** Novas mensagens das gravações ativas (só busca as com id maior que a mais nova mostrada). */
  async function pullNew() {
    const maxId = rows.length ? rows[0].id : 0;
    const page = await rabbitApi.query({ ...baseFilter(), ascending: true, before_id: maxId, limit: 500 });
    if (disposed || !page.rows.length) return;
    const fresh = page.rows.reverse();
    for (const r of fresh) r.fresh = true;
    for (const r of rows) r.fresh = false;
    rows = fresh.concat(rows);
    if (total !== null) total += fresh.length;
    table.setRows(rows);
    paintCount();
  }

  function liveRelevant() {
    if (!st.live) return false;
    if (st.selected === "all") return captures.some((c) => c.active);
    if (st.selected === "saved") return false;
    return !!captures.find((c) => String(c.id) === st.selected)?.active;
  }

  function paintLiveFlag() {
    liveBtn.classList.toggle("on", !!st.live);
    liveBtn.classList.toggle("rec", liveRelevant());
  }

  const unsubscribe = ctx.onCaptureEvent((ev) => {
    if (disposed) return;
    if (ev.kind === "stopped" || ev.kind === "started") {
      loadCaptures();
      return;
    }
    if (ev.kind !== "progress") return;
    // Contador da lista sem recarregar tudo.
    const item = captures.find((c) => c.id === ev.capture_id);
    if (item) {
      item.count = ev.count;
      renderCaptures();
    }
    if (liveRelevant() && !liveTimer) {
      liveTimer = setTimeout(() => {
        liveTimer = 0;
        pullNew().catch(() => {});
      }, 500);
    }
  });

  loadCaptures().then(search);

  return {
    root,
    refresh: () => loadCaptures(),
    focusFilter: () => textIn.focus(),
    dispose: () => {
      disposed = true;
      clearTimeout(liveTimer);
      unsubscribe();
    },
  };
}

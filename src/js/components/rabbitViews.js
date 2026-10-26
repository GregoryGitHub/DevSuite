import { el, icon } from "../utils/dom.js";
import { escapeHtml } from "../utils/noteContent.js";
import {
  apiPath,
  exchangeLabel,
  exchangeSeg,
  fmtBytes,
  fmtDuration,
  fmtNum,
  fmtRate,
  fmtTime,
  isDeadLetterQueue,
  isTransientQueue,
  nameMatcher,
  parseApiDate,
  queueFeatures,
  rate,
  sortBy,
} from "../utils/rabbitModel.js";

// Seções da aba RabbitMQ: visão geral e listas (filas, exchanges, conexões, canais, consumidores).
// Cada seção é criada com o `ctx` do orquestrador (rabbit.js) e expõe { root, refresh(), dispose() }.

const esc = (v) => escapeHtml(v === null || v === undefined ? "" : String(v));

// ---------- Tabela genérica (ordenável, seleção estilo explorador de arquivos) ----------

const MAX_ROWS = 2000;

/**
 * columns: [{ key, label, html(row) => string, sort(row) => valor, align: "right", width, title }]
 * state: objeto persistido { sort, dir } (mutado ao ordenar); onState() salva.
 */
export function createTable({ columns, rowKey, state = {}, onState, onOpen, onMenu, onSelect, emptyText = "Nada para mostrar.", rowClass }) {
  const root = el("div.rmq-table-wrap");
  const table = el("table.rmq-table");
  const thead = el("thead");
  const tbody = el("tbody");
  const note = el("div.rmq-table-note", { hidden: true });
  table.append(thead, tbody);
  root.append(table, note);

  let rows = [];
  let shown = [];
  const selected = new Set();
  let anchor = null;

  function renderHead() {
    thead.innerHTML = "";
    const tr = el("tr");
    for (const c of columns) {
      const on = state.sort === c.key;
      const th = el(
        "th",
        {
          class: `${c.align === "right" ? "r" : ""}${c.sort ? " sortable" : ""}${on ? " on" : ""}`,
          style: c.width ? `width:${c.width}` : "",
          title: c.title || "",
          onclick: () => {
            if (!c.sort) return;
            if (state.sort === c.key) state.dir = state.dir === "asc" ? "desc" : "asc";
            else {
              state.sort = c.key;
              state.dir = c.align === "right" ? "desc" : "asc";
            }
            onState?.();
            renderHead();
            renderBody();
          },
        },
        c.label,
        on ? icon(`fa-solid fa-caret-${state.dir === "desc" ? "down" : "up"} rmq-sort`) : null,
      );
      tr.append(th);
    }
    thead.append(tr);
  }

  function renderBody() {
    const col = columns.find((c) => c.key === state.sort && c.sort);
    shown = col ? sortBy(rows, col.sort, state.dir) : rows;
    const visible = shown.slice(0, MAX_ROWS);
    if (!visible.length) {
      tbody.innerHTML = `<tr class="empty"><td colspan="${columns.length}">${esc(emptyText)}</td></tr>`;
    } else {
      tbody.innerHTML = visible
        .map((r, i) => {
          const k = rowKey(r);
          const cls = [selected.has(k) ? "sel" : "", rowClass?.(r) || ""].filter(Boolean).join(" ");
          return `<tr data-i="${i}"${cls ? ` class="${cls}"` : ""}>${columns.map((c) => `<td${c.align === "right" ? ' class="r"' : ""}>${c.html(r)}</td>`).join("")}</tr>`;
        })
        .join("");
    }
    note.hidden = shown.length <= MAX_ROWS;
    note.textContent = `Mostrando ${fmtNum(MAX_ROWS)} de ${fmtNum(shown.length)}. Refine o filtro para ver as demais.`;
  }

  const rowAt = (tr) => (tr ? shown[Number(tr.dataset.i)] : null);

  function selectRow(r, e) {
    const k = rowKey(r);
    if (e?.shiftKey && anchor !== null) {
      const keys = shown.map(rowKey);
      const a = keys.indexOf(anchor);
      const b = keys.indexOf(k);
      if (a >= 0 && b >= 0) {
        if (!(e.ctrlKey || e.metaKey)) selected.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(keys[i]);
      }
    } else if (e?.ctrlKey || e?.metaKey) {
      if (selected.has(k)) selected.delete(k);
      else selected.add(k);
      anchor = k;
    } else {
      selected.clear();
      selected.add(k);
      anchor = k;
    }
    renderBody();
    onSelect?.(selectedRows());
  }

  function selectedRows() {
    return rows.filter((r) => selected.has(rowKey(r)));
  }

  tbody.addEventListener("mousedown", (e) => {
    const r = rowAt(e.target.closest("tr[data-i]"));
    if (!r || e.target.closest("a, button, input")) return;
    if (e.button === 2 && selected.has(rowKey(r))) return;
    if (e.button === 0 || e.button === 2) selectRow(r, e.button === 0 ? e : null);
  });
  tbody.addEventListener("dblclick", (e) => {
    const r = rowAt(e.target.closest("tr[data-i]"));
    if (r && !e.target.closest("a, button, input")) onOpen?.(r);
  });
  tbody.addEventListener("contextmenu", (e) => {
    const r = rowAt(e.target.closest("tr[data-i]"));
    if (!r || !onMenu) return;
    e.preventDefault();
    onMenu(selectedRows().length > 1 && selected.has(rowKey(r)) ? selectedRows() : [r], e);
  });
  tbody.addEventListener("click", (e) => {
    const a = e.target.closest("[data-open]");
    const r = rowAt(e.target.closest("tr[data-i]"));
    if (a && r) {
      e.preventDefault();
      onOpen?.(r);
    }
  });

  renderHead();
  renderBody();

  return {
    root,
    setRows(next) {
      rows = next || [];
      // Mantém só a seleção que ainda existe.
      const keys = new Set(rows.map(rowKey));
      for (const k of [...selected]) if (!keys.has(k)) selected.delete(k);
      renderBody();
    },
    rows: () => rows,
    shownRows: () => shown,
    selectedRows,
    selectAll() {
      for (const r of shown) selected.add(rowKey(r));
      renderBody();
      onSelect?.(selectedRows());
    },
    clearSelection() {
      selected.clear();
      renderBody();
      onSelect?.([]);
    },
  };
}

// ---------- Peças comuns ----------

function viewShell({ title, iconCls, count, tools = [], filter }) {
  const countEl = el("span.rmq-count", {}, count ?? "");
  const head = el("div.rmq-head", {}, el("h2", {}, icon(iconCls), el("span", {}, title), countEl), filter || null, el("span.hx-flex"), ...tools);
  const body = el("div.rmq-scroll");
  const foot = el("div.rmq-foot");
  const root = el("div.rmq-view", {}, head, body, foot);
  return { root, head, body, foot, countEl };
}

function filterInput(state, placeholder, onChange) {
  const input = el("input", {
    type: "search",
    value: state.text || "",
    placeholder,
    spellcheck: false,
    autocomplete: "off",
    title: "Contém o texto; * como curinga; /regex/ para expressão regular",
    oninput: () => {
      state.text = input.value;
      onChange();
    },
  });
  return { box: el("label.db-search.rmq-filter", {}, icon("fa-solid fa-magnifying-glass"), input), input };
}

function toggleBtn(label, on, onchange, title = "") {
  const b = el("button.rmq-chip", { type: "button", title, onclick: () => (b.classList.toggle("on"), onchange(b.classList.contains("on"))) }, label);
  b.classList.toggle("on", !!on);
  return b;
}

const toolBtn = (iconCls, title, onclick, label = "") => el("button.hx-btn.rmq-tool", { type: "button", title, onclick }, icon(iconCls), label ? ` ${label}` : "");

function updatedText(at, extra = "") {
  return `${extra}${extra ? " · " : ""}atualizado ${fmtTime(at, { millis: false, date: false })}`;
}

function errorBox(e, retry) {
  return el("div.db-placeholder.err", {}, icon("fa-solid fa-plug-circle-exclamation"), el("p", {}, String(e)), retry ? el("button.hx-btn.primary", { type: "button", onclick: retry }, "Tentar de novo") : null);
}

const vhostCell = (ctx, vh) => (ctx.vhost() ? "" : `<span class="rmq-vh">${esc(vh)}</span>`);

/** Badges de atributos (D, TTL, DLX...). */
export function featureHtml(list) {
  return list.map((f) => `<span class="rmq-feat${f.cls ? ` ${esc(f.cls)}` : ""}" title="${esc(f.t)}">${esc(f.k)}</span>`).join("");
}

function numCell(n, cls = "") {
  return n ? `<span class="${cls}">${fmtNum(n)}</span>` : `<span class="rmq-zero">${fmtNum(n ?? 0)}</span>`;
}

function rateCell(r) {
  return r ? fmtRate(r) : `<span class="rmq-zero">${r === null ? "" : "0/s"}</span>`;
}

/** Fila em um único fetch: colunas limitadas para servidores com muitas filas. */
const QUEUE_COLUMNS = [
  "name", "vhost", "type", "state", "durable", "auto_delete", "exclusive", "arguments", "policy", "effective_policy_definition",
  "messages", "messages_ready", "messages_unacknowledged", "consumers", "consumer_utilisation", "consumer_capacity", "memory", "idle_since",
  "message_stats.publish_details.rate", "message_stats.deliver_get_details.rate", "message_stats.ack_details.rate", "message_stats.redeliver_details.rate",
].join(",");

export function fetchQueues(ctx) {
  const vh = ctx.vhost();
  return ctx.get(`${vh ? apiPath("queues", vh) : "/queues"}?columns=${QUEUE_COLUMNS}`);
}

// ---------- Visão geral ----------

const SPARK_W = 260;
const SPARK_H = 48;

/** Taxas a partir das amostras cumulativas da API (samples: [{sample, timestamp}], mais novo primeiro). */
function ratesFromSamples(samples = []) {
  const s = [...samples].reverse();
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i].timestamp - s[i - 1].timestamp) / 1000;
    out.push(dt > 0 ? Math.max(0, (s[i].sample - s[i - 1].sample) / dt) : 0);
  }
  return out;
}

function sparkline(series) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const paths = series
    .filter((s) => s.values.length > 1)
    .map((s) => {
      const n = s.values.length;
      const pts = s.values.map((v, i) => `${((i / (n - 1)) * SPARK_W).toFixed(1)},${(SPARK_H - 2 - (v / max) * (SPARK_H - 6)).toFixed(1)}`);
      return `<polyline class="rmq-spark-line ${s.cls}" points="${pts.join(" ")}" />`;
    })
    .join("");
  return `<svg class="rmq-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
}

export function chartCard(title, series, fmt) {
  const legend = series
    .map((s) => `<span class="rmq-legend ${s.cls}"><i></i>${esc(s.label)} <b>${fmt(s.values[s.values.length - 1] ?? 0)}</b></span>`)
    .join("");
  return el("div.rmq-card.rmq-chart", { html: `<div class="rmq-card-title">${esc(title)}</div>${sparkline(series)}<div class="rmq-legends">${legend}</div>` });
}

export function tile(label, value, { sub = "", cls = "", onclick, title = "" } = {}) {
  return el(
    onclick ? "button.rmq-tile" : "div.rmq-tile",
    { class: `rmq-tile ${cls}`, type: onclick ? "button" : undefined, onclick, title },
    el("span.rmq-tile-label", {}, label),
    el("strong", {}, value),
    sub ? el("span.rmq-tile-sub", {}, sub) : null,
  );
}

export function overviewView(ctx) {
  const v = viewShell({ title: "Visão geral", iconCls: "fa-solid fa-gauge-high", tools: [toolBtn("fa-solid fa-file-export", "Exportar definições (filas, exchanges, ligações, policies) do vhost em JSON", () => ctx.exportDefinitions(), "Definições")] });
  let disposed = false;

  async function refresh() {
    const ages = "lengths_age=600&lengths_incr=10&msg_rates_age=600&msg_rates_incr=10";
    const [ov, nodes, queues, vhosts] = await Promise.all([
      ctx.get(`/overview?${ages}`),
      ctx.get("/nodes?columns=name,type,running,mem_used,mem_limit,mem_alarm,disk_free,disk_free_limit,disk_free_alarm,fd_used,fd_total,sockets_used,sockets_total,proc_used,proc_total,uptime,partitions").catch(() => []),
      fetchQueues(ctx).catch(() => []),
      ctx.get("/vhosts?columns=name,tracing,messages,messages_ready,messages_unacknowledged").catch(() => []),
    ]);
    if (disposed) return;
    render(ov, nodes, queues, vhosts);
  }

  function render(ov, nodes, queues, vhosts) {
    const qt = ov.queue_totals || {};
    const ms = ov.message_stats || {};
    const ot = ov.object_totals || {};
    v.body.innerHTML = "";

    const alarms = nodes.filter((n) => n.mem_alarm || n.disk_free_alarm || n.running === false);
    if (alarms.length) {
      v.body.append(
        el(
          "div.rmq-alert",
          {},
          icon("fa-solid fa-triangle-exclamation"),
          el(
            "span",
            {},
            alarms
              .map((n) => `${n.name}: ${n.running === false ? "parado" : [n.mem_alarm ? "alarme de memória" : "", n.disk_free_alarm ? "alarme de disco" : ""].filter(Boolean).join(" e ")}`)
              .join(" · ") + " — publicações estão bloqueadas enquanto houver alarme.",
          ),
        ),
      );
    }
    const tracing = vhosts.filter((x) => x.tracing);
    if (tracing.length) {
      v.body.append(
        el(
          "div.rmq-alert.info",
          {},
          icon("fa-solid fa-fire"),
          el("span", {}, `Tracing (firehose) ligado em: ${tracing.map((x) => x.name).join(", ")}. Isso tem custo de desempenho no servidor.`),
          ...tracing.map((x) =>
            el("button.hx-btn", { type: "button", onclick: () => ctx.setTracing(x.name, false).then(refresh) }, `Desligar em ${x.name}`),
          ),
        ),
      );
    }

    const go = (s) => () => ctx.openSection(s);
    v.body.append(
      el(
        "div.rmq-tiles",
        {},
        tile("Prontas", fmtNum(qt.messages_ready), { cls: "accent", onclick: go("queues"), title: "Mensagens aguardando consumidor (todas as filas)" }),
        tile("Não confirmadas", fmtNum(qt.messages_unacknowledged), { cls: qt.messages_unacknowledged ? "warn" : "", onclick: go("queues"), title: "Entregues a consumidores e ainda sem ack" }),
        tile("Total", fmtNum(qt.messages), { onclick: go("queues") }),
        tile("Publicação", fmtRate(ms.publish_details?.rate ?? 0)),
        tile("Entrega", fmtRate((ms.deliver_get_details?.rate ?? 0))),
        tile("Ack", fmtRate(ms.ack_details?.rate ?? 0)),
        tile("Reentregas", fmtRate(ms.redeliver_details?.rate ?? 0), { cls: ms.redeliver_details?.rate ? "warn" : "", title: "Mensagens reentregues (nack/requeue ou consumidor caiu)" }),
        tile("Conexões", fmtNum(ot.connections), { onclick: go("connections") }),
        tile("Canais", fmtNum(ot.channels), { onclick: go("channels") }),
        tile("Filas", fmtNum(ot.queues), { onclick: go("queues") }),
        tile("Consumidores", fmtNum(ot.consumers), { onclick: go("consumers") }),
        tile("Exchanges", fmtNum(ot.exchanges), { onclick: go("exchanges") }),
      ),
    );

    const lenSeries = (k) => (qt[`${k}_details`]?.samples || []).map((s) => s.sample).reverse();
    v.body.append(
      el(
        "div.rmq-charts",
        {},
        chartCard(
          "Mensagens em fila (10 min)",
          [
            { label: "Prontas", cls: "s1", values: lenSeries("messages_ready") },
            { label: "Não conf.", cls: "s2", values: lenSeries("messages_unacknowledged") },
          ],
          fmtNum,
        ),
        chartCard(
          "Taxas (10 min)",
          [
            { label: "Publicação", cls: "s1", values: ratesFromSamples(ms.publish_details?.samples) },
            { label: "Entrega", cls: "s3", values: ratesFromSamples(ms.deliver_get_details?.samples) },
            { label: "Ack", cls: "s2", values: ratesFromSamples(ms.ack_details?.samples) },
          ],
          fmtRate,
        ),
      ),
    );

    // Atenção: o que costuma explicar um bug em ambiente de desenvolvimento.
    const noConsumer = queues.filter((q) => q.messages > 0 && !q.consumers && !isDeadLetterQueue(q));
    const dlqs = queues.filter((q) => q.messages > 0 && isDeadLetterQueue(q));
    const unacked = queues.filter((q) => q.messages_unacknowledged > 0);
    const watch = el("div.rmq-watch");
    const watchList = (title, iconCls, list, cls, describe) => {
      if (!list.length) return null;
      return el(
        "div.rmq-card",
        {},
        el("div.rmq-card-title", {}, icon(iconCls), ` ${title} `, el("span.rmq-count", {}, list.length)),
        ...sortBy(list, (q) => q.messages, "desc")
          .slice(0, 8)
          .map((q) =>
            el(
              "button.rmq-watch-item",
              { type: "button", class: `rmq-watch-item ${cls}`, onclick: () => ctx.openQueue(q.vhost, q.name), title: `${q.vhost} · ${q.name}` },
              el("span.rmq-watch-name", {}, q.name),
              el("span.rmq-watch-val", {}, describe(q)),
            ),
          ),
      );
    };
    const cards = [
      watchList("DLQs com mensagens", "fa-solid fa-skull-crossbones", dlqs, "bad", (q) => `${fmtNum(q.messages)} msg`),
      watchList("Com mensagens e sem consumidor", "fa-solid fa-user-slash", noConsumer, "warn", (q) => `${fmtNum(q.messages)} msg`),
      watchList("Mensagens sem ack", "fa-solid fa-hourglass-half", unacked, "", (q) => `${fmtNum(q.messages_unacknowledged)} · ${q.consumers} cons.`),
    ].filter(Boolean);
    if (cards.length) {
      watch.append(...cards);
      v.body.append(watch);
    }

    if (nodes.length) {
      const bar = (used, limit, alarm) => {
        const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
        return `<div class="rmq-bar${alarm ? " bad" : pct > 80 ? " warn" : ""}" title="${esc(fmtNum(used))} / ${esc(fmtNum(limit))}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
      };
      const t = createTable({
        columns: [
          { key: "name", label: "Nó", html: (n) => `<span class="rmq-state ${n.running === false ? "bad" : "ok"}"></span>${esc(n.name)}` },
          { key: "mem", label: "Memória", html: (n) => `${bar(n.mem_used, n.mem_limit, n.mem_alarm)}<span class="rmq-sub">${fmtBytes(n.mem_used)} / ${fmtBytes(n.mem_limit)}</span>` },
          { key: "disk", label: "Disco livre", html: (n) => `<span class="${n.disk_free_alarm ? "rmq-bad" : ""}">${fmtBytes(n.disk_free)}</span><span class="rmq-sub"> limite ${fmtBytes(n.disk_free_limit)}</span>` },
          { key: "fd", label: "Descritores", html: (n) => `${bar(n.fd_used, n.fd_total)}<span class="rmq-sub">${fmtNum(n.fd_used)} / ${fmtNum(n.fd_total)}</span>` },
          { key: "proc", label: "Processos Erlang", html: (n) => `${bar(n.proc_used, n.proc_total)}<span class="rmq-sub">${fmtNum(n.proc_used)} / ${fmtNum(n.proc_total)}</span>` },
          { key: "up", label: "Uptime", align: "right", html: (n) => fmtDuration(n.uptime) },
        ],
        rowKey: (n) => n.name,
      });
      t.setRows(nodes);
      v.body.append(el("div.rmq-card.rmq-card-table", {}, el("div.rmq-card-title", {}, icon("fa-solid fa-server"), " Nós"), t.root));
    }

    const listeners = (ov.listeners || []).map((l) => `${l.protocol}:${l.port}`).join(" · ");
    v.foot.textContent = updatedText(Date.now(), [`RabbitMQ ${ov.rabbitmq_version || "?"}`, `Erlang ${ov.erlang_version || "?"}`, ov.cluster_name, listeners].filter(Boolean).join(" · "));
  }

  return {
    root: v.root,
    refresh,
    dispose: () => (disposed = true),
  };
}

// ---------- Filas ----------

export function queuesView(ctx) {
  const st = ctx.listState("queues", { sort: "name", dir: "asc", text: "", hideEmpty: false, hideTransient: true });
  const f = filterInput(st, "Filtrar filas (texto, *, /regex/)", () => (applyFilter(), ctx.saveUi()));
  const actions = el("div.rmq-bulk", { hidden: true });
  const v = viewShell({
    title: "Filas",
    iconCls: "fa-solid fa-inbox",
    filter: f.box,
    tools: [
      toggleBtn("Com mensagens", st.hideEmpty, (on) => ((st.hideEmpty = on), applyFilter(), ctx.saveUi()), "Ocultar filas vazias"),
      toggleBtn("Ocultar temporárias", st.hideTransient, (on) => ((st.hideTransient = on), applyFilter(), ctx.saveUi()), "Ocultar filas exclusivas e amq.gen-*"),
      actions,
      toolBtn("fa-solid fa-plus", "Nova fila", () => ctx.dialogs.newQueue(), "Fila"),
    ],
  });
  let all = [];
  let disposed = false;

  const table = createTable({
    state: st,
    onState: ctx.saveUi,
    rowKey: (q) => `${q.vhost}\u0000${q.name}`,
    emptyText: "Nenhuma fila.",
    rowClass: (q) => [q.messages > 0 && isDeadLetterQueue(q) ? "dlq" : "", q.state && q.state !== "running" ? "bad" : ""].join(" "),
    columns: [
      {
        key: "name",
        label: "Nome",
        sort: (q) => q.name.toLowerCase(),
        html: (q) => `${vhostCell(ctx, q.vhost)}<a href="#" data-open class="rmq-link">${esc(q.name)}</a>${ctx.isCapturing(q.vhost, q.name) ? '<i class="fa-solid fa-circle rmq-rec-dot" title="Gravando"></i>' : ""}`,
      },
      { key: "feat", label: "Atributos", html: (q) => featureHtml(queueFeatures(q)) },
      {
        key: "state",
        label: "Estado",
        sort: (q) => q.state || "",
        html: (q) => `<span class="rmq-state ${q.state === "running" ? "ok" : q.state ? "bad" : ""}"></span>${esc(q.state === "running" ? (q.idle_since ? "ociosa" : "ativa") : q.state || "?")}`,
      },
      { key: "ready", label: "Prontas", align: "right", sort: (q) => q.messages_ready ?? 0, html: (q) => numCell(q.messages_ready, "rmq-ready") },
      { key: "unacked", label: "Sem ack", align: "right", sort: (q) => q.messages_unacknowledged ?? 0, html: (q) => numCell(q.messages_unacknowledged, "rmq-unacked") },
      { key: "total", label: "Total", align: "right", sort: (q) => q.messages ?? 0, html: (q) => numCell(q.messages) },
      { key: "consumers", label: "Cons.", align: "right", title: "Consumidores", sort: (q) => q.consumers ?? 0, html: (q) => (q.consumers ? fmtNum(q.consumers) : q.messages ? '<span class="rmq-warn" title="Mensagens sem consumidor">0</span>' : '<span class="rmq-zero">0</span>') },
      { key: "in", label: "Entrada", align: "right", sort: (q) => rate(q, "publish") ?? 0, html: (q) => rateCell(rate(q, "publish")) },
      { key: "out", label: "Saída", align: "right", sort: (q) => rate(q, "deliver_get") ?? 0, html: (q) => rateCell(rate(q, "deliver_get")) },
      { key: "ack", label: "Ack", align: "right", sort: (q) => rate(q, "ack") ?? 0, html: (q) => rateCell(rate(q, "ack")) },
    ],
    onOpen: (q) => ctx.openQueue(q.vhost, q.name),
    onMenu: (list, e) => ctx.queueMenu(list, e.clientX, e.clientY, refresh),
    onSelect: (list) => renderBulk(list),
  });
  v.body.append(table.root);

  function renderBulk(list) {
    actions.innerHTML = "";
    actions.hidden = list.length < 2;
    if (list.length < 2) return;
    actions.append(
      el("span.rmq-bulk-n", {}, `${list.length} selecionadas`),
      toolBtn("fa-solid fa-circle-dot", "Gravar as mensagens dessas filas", () => ctx.dialogs.capture({ vhost: list[0].vhost, queues: list.map((q) => q.name) })),
      toolBtn("fa-solid fa-broom", "Purgar as filas selecionadas", () => ctx.ops.purgeMany(list).then(refresh)),
      toolBtn("fa-regular fa-trash-can", "Excluir as filas selecionadas", () => ctx.ops.deleteMany(list).then(refresh)),
    );
  }

  function applyFilter() {
    const match = nameMatcher(st.text);
    const rows = all.filter((q) => match(q.name) && (!st.hideEmpty || q.messages > 0) && (!st.hideTransient || !isTransientQueue(q)));
    table.setRows(rows);
    v.countEl.textContent = rows.length === all.length ? fmtNum(all.length) : `${fmtNum(rows.length)} de ${fmtNum(all.length)}`;
    const sum = (k) => rows.reduce((n, q) => n + (q[k] || 0), 0);
    v.foot.textContent = updatedText(Date.now(), `${fmtNum(sum("messages_ready"))} prontas · ${fmtNum(sum("messages_unacknowledged"))} sem ack · ${fmtNum(sum("consumers"))} consumidores`);
  }

  async function refresh() {
    const list = await fetchQueues(ctx);
    if (disposed) return;
    all = list;
    ctx.setCount("queues", list.length);
    applyFilter();
  }

  return {
    root: v.root,
    refresh,
    focusFilter: () => f.input.focus(),
    selectAll: () => table.selectAll(),
    dispose: () => (disposed = true),
  };
}

// ---------- Exchanges ----------

export function exchangesView(ctx) {
  const st = ctx.listState("exchanges", { sort: "name", dir: "asc", text: "", hideSystem: true });
  const f = filterInput(st, "Filtrar exchanges", () => (applyFilter(), ctx.saveUi()));
  const v = viewShell({
    title: "Exchanges",
    iconCls: "fa-solid fa-shuffle",
    filter: f.box,
    tools: [
      toggleBtn("Ocultar amq.*", st.hideSystem, (on) => ((st.hideSystem = on), applyFilter(), ctx.saveUi()), "Ocultar as exchanges internas do RabbitMQ"),
      toolBtn("fa-solid fa-plus", "Nova exchange", () => ctx.dialogs.newExchange(), "Exchange"),
    ],
  });
  let all = [];
  let disposed = false;
  const table = createTable({
    state: st,
    onState: ctx.saveUi,
    rowKey: (x) => `${x.vhost}\u0000${x.name}`,
    columns: [
      { key: "name", label: "Nome", sort: (x) => x.name.toLowerCase(), html: (x) => `${vhostCell(ctx, x.vhost)}<a href="#" data-open class="rmq-link">${esc(exchangeLabel(x.name))}</a>` },
      { key: "type", label: "Tipo", sort: (x) => x.type, html: (x) => `<span class="rmq-type t-${esc(x.type)}">${esc(x.type)}</span>` },
      {
        key: "feat",
        label: "Atributos",
        html: (x) =>
          featureHtml(
            [
              x.durable && { k: "D", t: "Durável" },
              x.auto_delete && { k: "AD", t: "Auto-delete" },
              x.internal && { k: "I", t: "Interna (não aceita publicação de clientes)" },
              x.arguments?.["alternate-exchange"] && { k: "AE", t: `Alternate exchange: ${x.arguments["alternate-exchange"]}` },
              x.policy && { k: "Pol", t: `Policy: ${x.policy}`, cls: "policy" },
            ].filter(Boolean),
          ),
      },
      { key: "in", label: "Entrada", align: "right", sort: (x) => x.message_stats?.publish_in_details?.rate ?? 0, html: (x) => rateCell(x.message_stats?.publish_in_details?.rate ?? null) },
      { key: "out", label: "Saída", align: "right", sort: (x) => x.message_stats?.publish_out_details?.rate ?? 0, html: (x) => rateCell(x.message_stats?.publish_out_details?.rate ?? null) },
    ],
    onOpen: (x) => ctx.openExchange(x.vhost, x.name),
    onMenu: ([x], e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        { label: "Abrir", icon: "fa-solid fa-up-right-from-square", run: () => ctx.openExchange(x.vhost, x.name) },
        { label: "Publicar mensagem…", icon: "fa-solid fa-paper-plane", run: () => ctx.dialogs.publish({ vhost: x.vhost, exchange: x.name }) },
        { label: "Gravar mensagens…", icon: "fa-solid fa-circle-dot", disabled: x.name === "", run: () => ctx.dialogs.capture({ vhost: x.vhost, mode: "exchange", exchange: x.name, routing_key: x.type === "topic" ? "#" : "" }) },
        "sep",
        { label: "Copiar nome", icon: "fa-regular fa-copy", run: () => ctx.copy(x.name) },
        "sep",
        { label: "Excluir…", icon: "fa-regular fa-trash-can", danger: true, disabled: x.name === "" || x.name.startsWith("amq."), run: () => ctx.ops.deleteExchange(x).then(refresh) },
      ]),
  });
  v.body.append(table.root);

  function applyFilter() {
    const match = nameMatcher(st.text);
    const rows = all.filter((x) => match(x.name) && (!st.hideSystem || !(x.name.startsWith("amq.") || x.internal)));
    table.setRows(rows);
    v.countEl.textContent = rows.length === all.length ? fmtNum(all.length) : `${fmtNum(rows.length)} de ${fmtNum(all.length)}`;
    v.foot.textContent = updatedText(Date.now());
  }

  async function refresh() {
    const vh = ctx.vhost();
    const list = await ctx.get(vh ? apiPath("exchanges", vh) : "/exchanges");
    if (disposed) return;
    all = list;
    ctx.setCount("exchanges", list.length);
    applyFilter();
  }

  return { root: v.root, refresh, focusFilter: () => f.input.focus(), dispose: () => (disposed = true) };
}

// ---------- Conexões ----------

export const clientName = (c) => c.client_properties?.connection_name || c.user_provided_name || "";

function clientDesc(c) {
  const p = c.client_properties || {};
  return [p.product, p.version, p.platform].filter(Boolean).join(" ");
}

export function connectionsView(ctx) {
  const st = ctx.listState("connections", { sort: "name", dir: "asc", text: "" });
  const f = filterInput(st, "Filtrar por nome, cliente, usuário, IP", () => (applyFilter(), ctx.saveUi()));
  const v = viewShell({ title: "Conexões", iconCls: "fa-solid fa-plug", filter: f.box });
  let all = [];
  let disposed = false;
  const detail = el("div.rmq-side-detail", { hidden: true });
  const table = createTable({
    state: st,
    onState: ctx.saveUi,
    rowKey: (c) => c.name,
    emptyText: "Nenhum cliente conectado.",
    columns: [
      {
        key: "name",
        label: "Cliente",
        sort: (c) => (clientName(c) || c.name).toLowerCase(),
        html: (c) => `${clientName(c) ? `<strong>${esc(clientName(c))}</strong><span class="rmq-sub">${esc(c.name)}</span>` : esc(c.name)}`,
      },
      { key: "product", label: "Biblioteca", sort: clientDesc, html: (c) => `<span class="rmq-sub">${esc(clientDesc(c))}</span>` },
      { key: "user", label: "Usuário", sort: (c) => c.user, html: (c) => `${esc(c.user)}${ctx.vhost() ? "" : `<span class="rmq-vh">${esc(c.vhost)}</span>`}` },
      { key: "peer", label: "Origem", sort: (c) => `${c.peer_host}:${c.peer_port}`, html: (c) => `${esc(c.peer_host)}:${esc(c.peer_port)}${c.ssl ? ' <i class="fa-solid fa-lock rmq-sub" title="TLS"></i>' : ""}` },
      { key: "state", label: "Estado", sort: (c) => c.state, html: (c) => `<span class="rmq-state ${c.state === "running" ? "ok" : c.state === "blocked" || c.state === "blocking" ? "bad" : "warn"}"></span>${esc(c.state)}` },
      { key: "channels", label: "Canais", align: "right", sort: (c) => c.channels ?? 0, html: (c) => fmtNum(c.channels) },
      { key: "recv", label: "Recebe", align: "right", sort: (c) => c.recv_oct_details?.rate ?? 0, html: (c) => `${fmtBytes(c.recv_oct_details?.rate ?? 0)}/s` },
      { key: "send", label: "Envia", align: "right", sort: (c) => c.send_oct_details?.rate ?? 0, html: (c) => `${fmtBytes(c.send_oct_details?.rate ?? 0)}/s` },
      { key: "since", label: "Desde", align: "right", sort: (c) => c.connected_at ?? 0, html: (c) => `<span class="rmq-sub">${fmtTime(c.connected_at, { millis: false })}</span>` },
    ],
    onOpen: (c) => showDetail(c),
    onSelect: (list) => (list.length === 1 ? showDetail(list[0]) : (detail.hidden = true)),
    onMenu: (list, e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        list.length === 1 ? { label: "Detalhes", icon: "fa-solid fa-circle-info", run: () => showDetail(list[0]) } : null,
        list.length === 1 ? { label: "Ver canais", icon: "fa-solid fa-diagram-project", run: () => ctx.openSection("channels", { text: list[0].name }) } : null,
        list.length === 1 ? { label: "Copiar nome", icon: "fa-regular fa-copy", run: () => ctx.copy(list[0].name) } : null,
        "sep",
        { label: list.length > 1 ? `Fechar ${list.length} conexões…` : "Fechar conexão…", icon: "fa-solid fa-plug-circle-xmark", danger: true, run: () => ctx.ops.closeConnections(list).then(refresh) },
      ]),
  });
  const split = el("div.rmq-split", {}, table.root, detail);
  v.body.append(split);

  function showDetail(c) {
    detail.hidden = false;
    detail.innerHTML = "";
    const p = c.client_properties || {};
    const caps = p.capabilities ? Object.entries(p.capabilities).filter(([, on]) => on).map(([k]) => k) : [];
    const rows = [
      ["Nome", c.name],
      ["connection_name", clientName(c) || "—"],
      ["Biblioteca", clientDesc(c) || "—"],
      ["Usuário / vhost", `${c.user} @ ${c.vhost}`],
      ["Protocolo", `${c.protocol || ""}${c.ssl ? ` · TLS ${c.ssl_protocol || ""}` : ""}`],
      ["Origem", `${c.peer_host}:${c.peer_port}`],
      ["Servidor", `${c.host}:${c.port} (${c.node})`],
      ["Heartbeat", c.timeout ? `${c.timeout}s` : "desligado"],
      ["frame_max / channel_max", `${fmtNum(c.frame_max)} / ${fmtNum(c.channel_max)}`],
      ["Conectado em", fmtTime(c.connected_at, { millis: false })],
      ["Recebido / enviado", `${fmtBytes(c.recv_oct)} / ${fmtBytes(c.send_oct)}`],
      ["Capacidades", caps.join(", ") || "—"],
    ];
    detail.append(
      el("div.rmq-side-head", {}, el("strong", {}, clientName(c) || c.name), el("button.hx-icon-btn", { type: "button", title: "Fechar", onclick: () => (detail.hidden = true) }, icon("fa-solid fa-xmark"))),
      el("dl.rmq-dl", {}, ...rows.flatMap(([k, val]) => [el("dt", {}, k), el("dd", {}, String(val ?? "—"))])),
      el("div.rmq-side-actions", {}, el("button.hx-btn", { type: "button", onclick: () => ctx.openSection("channels", { text: c.name }) }, icon("fa-solid fa-diagram-project"), " Canais"), el("button.hx-btn.danger", { type: "button", onclick: () => ctx.ops.closeConnections([c]).then(refresh) }, icon("fa-solid fa-plug-circle-xmark"), " Fechar")),
      el("div.rmq-card-title", {}, "client_properties"),
      ctx.jsonBlock(p),
    );
  }

  function applyFilter() {
    const match = nameMatcher(st.text);
    const rows = all.filter((c) => [c.name, clientName(c), clientDesc(c), c.user, c.peer_host, c.vhost].some((s) => s && match(String(s))));
    table.setRows(rows);
    v.countEl.textContent = rows.length === all.length ? fmtNum(all.length) : `${fmtNum(rows.length)} de ${fmtNum(all.length)}`;
    v.foot.textContent = updatedText(Date.now(), `${fmtNum(rows.reduce((n, c) => n + (c.channels || 0), 0))} canais`);
  }

  async function refresh() {
    const vh = ctx.vhost();
    const list = await ctx.get(vh ? apiPath("vhosts", vh, "connections") : "/connections");
    if (disposed) return;
    all = list;
    ctx.setCount("connections", list.length);
    applyFilter();
  }

  return { root: v.root, refresh, focusFilter: () => f.input.focus(), dispose: () => (disposed = true) };
}

// ---------- Canais ----------

export function channelsView(ctx) {
  const st = ctx.listState("channels", { sort: "name", dir: "asc", text: "" });
  const f = filterInput(st, "Filtrar canais (nome, conexão, usuário)", () => (applyFilter(), ctx.saveUi()));
  const v = viewShell({ title: "Canais", iconCls: "fa-solid fa-diagram-project", filter: f.box });
  let all = [];
  let disposed = false;
  const table = createTable({
    state: st,
    onState: ctx.saveUi,
    rowKey: (c) => c.name,
    emptyText: "Nenhum canal aberto.",
    columns: [
      { key: "name", label: "Canal", sort: (c) => c.name, html: (c) => `${esc(c.connection_details?.name ? clientLabel(c) : c.name)}<span class="rmq-sub">${esc(c.name)}</span>` },
      { key: "user", label: "Usuário", sort: (c) => c.user, html: (c) => esc(c.user) },
      {
        key: "mode",
        label: "Modo",
        html: (c) => featureHtml([c.confirm && { k: "C", t: "Publisher confirms" }, c.transactional && { k: "T", t: "Transacional" }].filter(Boolean)),
      },
      { key: "prefetch", label: "Prefetch", align: "right", sort: (c) => c.prefetch_count ?? 0, html: (c) => (c.prefetch_count ? fmtNum(c.prefetch_count) : '<span class="rmq-warn" title="Sem limite (prefetch 0): o consumidor pode receber tudo de uma vez">∞</span>') },
      { key: "unacked", label: "Sem ack", align: "right", sort: (c) => c.messages_unacknowledged ?? 0, html: (c) => numCell(c.messages_unacknowledged, "rmq-unacked") },
      { key: "unconfirmed", label: "Não confirmadas", align: "right", sort: (c) => c.messages_unconfirmed ?? 0, html: (c) => numCell(c.messages_unconfirmed) },
      { key: "consumers", label: "Cons.", align: "right", sort: (c) => c.consumer_count ?? 0, html: (c) => fmtNum(c.consumer_count) },
      { key: "pub", label: "Publicação", align: "right", sort: (c) => rate(c, "publish") ?? 0, html: (c) => rateCell(rate(c, "publish")) },
      { key: "del", label: "Entrega", align: "right", sort: (c) => rate(c, "deliver_get") ?? 0, html: (c) => rateCell(rate(c, "deliver_get")) },
      { key: "ack", label: "Ack", align: "right", sort: (c) => rate(c, "ack") ?? 0, html: (c) => rateCell(rate(c, "ack")) },
      { key: "state", label: "Estado", sort: (c) => c.state, html: (c) => `<span class="rmq-state ${c.state === "running" ? "ok" : "warn"}"></span>${esc(c.state)}` },
    ],
    onMenu: ([c], e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        { label: "Ver consumidores", icon: "fa-solid fa-user-gear", run: () => ctx.openSection("consumers", { text: c.name }) },
        { label: "Copiar nome", icon: "fa-regular fa-copy", run: () => ctx.copy(c.name) },
        "sep",
        { label: "Fechar a conexão deste canal…", icon: "fa-solid fa-plug-circle-xmark", danger: true, run: () => ctx.ops.closeConnections([{ name: c.connection_details?.name, vhost: c.vhost }]).then(refresh) },
      ]),
  });
  v.body.append(table.root);

  function applyFilter() {
    const match = nameMatcher(st.text);
    const rows = all.filter((c) => [c.name, c.user, c.connection_details?.name, clientLabel(c)].some((s) => s && match(String(s))));
    table.setRows(rows);
    v.countEl.textContent = rows.length === all.length ? fmtNum(all.length) : `${fmtNum(rows.length)} de ${fmtNum(all.length)}`;
    v.foot.textContent = updatedText(Date.now(), `${fmtNum(rows.reduce((n, c) => n + (c.messages_unacknowledged || 0), 0))} sem ack`);
  }

  async function refresh() {
    const vh = ctx.vhost();
    const list = await ctx.get(vh ? apiPath("vhosts", vh, "channels") : "/channels");
    if (disposed) return;
    all = list;
    applyFilter();
  }

  return { root: v.root, refresh, focusFilter: () => f.input.focus(), dispose: () => (disposed = true) };
}

const clientLabel = (c) => c.connection_details?.peer_host ? `${c.connection_details.peer_host}:${c.connection_details.peer_port}` : c.connection_details?.name || "";

// ---------- Consumidores ----------

export function consumersView(ctx) {
  const st = ctx.listState("consumers", { sort: "queue", dir: "asc", text: "" });
  const f = filterInput(st, "Filtrar por fila, tag, conexão", () => (applyFilter(), ctx.saveUi()));
  const v = viewShell({ title: "Consumidores", iconCls: "fa-solid fa-user-gear", filter: f.box });
  let all = [];
  let disposed = false;
  const table = createTable({
    state: st,
    onState: ctx.saveUi,
    rowKey: (c) => `${c.channel_details?.name}\u0000${c.consumer_tag}`,
    emptyText: "Nenhum consumidor.",
    columns: [
      { key: "queue", label: "Fila", sort: (c) => c.queue?.name, html: (c) => `${vhostCell(ctx, c.queue?.vhost)}<a href="#" data-open class="rmq-link">${esc(c.queue?.name)}</a>` },
      { key: "tag", label: "Consumer tag", sort: (c) => c.consumer_tag, html: (c) => `<code>${esc(c.consumer_tag)}</code>` },
      { key: "conn", label: "Conexão", sort: (c) => c.channel_details?.connection_name, html: (c) => `${esc(c.channel_details?.peer_host || "")}${c.channel_details?.peer_port ? `:${esc(c.channel_details.peer_port)}` : ""}<span class="rmq-sub">${esc(c.channel_details?.name || "")}</span>` },
      { key: "user", label: "Usuário", sort: (c) => c.channel_details?.user, html: (c) => esc(c.channel_details?.user || "") },
      { key: "ack", label: "Ack", html: (c) => (c.ack_required ? "manual" : '<span class="rmq-warn" title="auto-ack: a mensagem sai da fila na entrega, mesmo se o consumidor falhar">auto</span>') },
      { key: "prefetch", label: "Prefetch", align: "right", sort: (c) => c.prefetch_count ?? 0, html: (c) => (c.prefetch_count ? fmtNum(c.prefetch_count) : "∞") },
      { key: "active", label: "Ativo", html: (c) => (c.active === false ? `<span class="rmq-warn">${esc(c.activity_status || "inativo")}</span>` : esc(c.activity_status || "sim")) },
      { key: "excl", label: "Exclusivo", html: (c) => (c.exclusive ? "sim" : "") },
    ],
    onOpen: (c) => ctx.openQueue(c.queue.vhost, c.queue.name),
    onMenu: ([c], e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        { label: "Abrir fila", icon: "fa-solid fa-inbox", run: () => ctx.openQueue(c.queue.vhost, c.queue.name) },
        { label: "Copiar consumer tag", icon: "fa-regular fa-copy", run: () => ctx.copy(c.consumer_tag) },
        "sep",
        { label: "Fechar a conexão do consumidor…", icon: "fa-solid fa-plug-circle-xmark", danger: true, run: () => ctx.ops.closeConnections([{ name: c.channel_details?.connection_name, vhost: c.queue?.vhost }]).then(refresh) },
      ]),
  });
  v.body.append(table.root);

  function applyFilter() {
    const match = nameMatcher(st.text);
    const rows = all.filter((c) => [c.queue?.name, c.consumer_tag, c.channel_details?.name, c.channel_details?.peer_host, c.channel_details?.user].some((s) => s && match(String(s))));
    table.setRows(rows);
    v.countEl.textContent = rows.length === all.length ? fmtNum(all.length) : `${fmtNum(rows.length)} de ${fmtNum(all.length)}`;
    v.foot.textContent = updatedText(Date.now());
  }

  async function refresh() {
    const vh = ctx.vhost();
    const list = await ctx.get(vh ? apiPath("consumers", vh) : "/consumers");
    if (disposed) return;
    all = list;
    applyFilter();
  }

  return { root: v.root, refresh, focusFilter: () => f.input.focus(), dispose: () => (disposed = true) };
}

export { errorBox, viewShell, toolBtn, filterInput, toggleBtn, updatedText, numCell, rateCell, esc, parseApiDate, exchangeSeg };

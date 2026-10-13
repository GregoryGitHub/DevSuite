import { el, icon } from "../utils/dom.js";
import {
  apiPath,
  deathInfo,
  exchangeLabel,
  exchangeSeg,
  fmtBytes,
  fmtNum,
  fmtRate,
  fmtTime,
  messageToRecord,
  exportMessages,
  normalizeMessage,
  payloadText,
  queueFeatures,
  rate,
  isDeadLetterQueue,
} from "../utils/rabbitModel.js";
import { createTable, featureHtml, esc } from "./rabbitViews.js";
import { messageDetail, jsonBlock } from "./rabbitMessage.js";

// Detalhe de uma fila (mensagens, consumidores, ligações, detalhes) e de uma exchange.

function tabsBar(tabs, active, onPick) {
  const bar = el("nav.hx-tabs.rmq-tabs");
  const btns = {};
  for (const t of tabs) {
    btns[t.id] = el("button.hx-tab", { type: "button", onclick: () => onPick(t.id) }, t.label, el("span.hx-tab-badge", { hidden: true }));
    bar.append(btns[t.id]);
  }
  const set = (id) => Object.entries(btns).forEach(([k, b]) => b.classList.toggle("active", k === id));
  set(active);
  return {
    bar,
    set,
    badge(id, n) {
      const b = btns[id]?.querySelector(".hx-tab-badge");
      if (!b) return;
      b.hidden = !n;
      b.textContent = n ? fmtNum(n) : "";
    },
  };
}

function stat(label, value, cls = "") {
  return el("div.rmq-stat", { class: `rmq-stat ${cls}` }, el("span", {}, label), el("strong", {}, value));
}

// ---------- Fila ----------

export function queueView(ctx, { vhost, name }) {
  let q = null;
  let disposed = false;
  let tab = ctx.detailTab("queue") || "messages";
  const qPath = apiPath("queues", vhost, name);

  const titleEl = el("h2", {}, icon("fa-solid fa-inbox"), el("span.rmq-qname", { title: name }, name));
  const featEl = el("span.rmq-feats");
  const stateEl = el("span.rmq-qstate");
  const stats = el("div.rmq-stats");
  const actions = el(
    "div.rmq-detail-actions",
    {},
    el("button.hx-btn", { type: "button", title: "Publicar mensagem nesta fila", onclick: () => ctx.dialogs.publish({ vhost, exchange: "", routing_key: name }) }, icon("fa-solid fa-paper-plane"), " Publicar"),
    el("button.hx-btn", { type: "button", title: "Mover ou copiar mensagens para outra fila/exchange (transação AMQP)", onclick: () => ctx.dialogs.move({ vhost, queue: name, count: q?.messages_ready, dead: isDeadLetterQueue({ name }) }).then((r) => r && refresh()) }, icon("fa-solid fa-right-left"), " Mover"),
    el("button.hx-btn", { type: "button", title: "Gravar as mensagens que chegam nesta fila", onclick: () => ctx.dialogs.capture({ vhost, queues: [name] }) }, icon("fa-solid fa-circle-dot"), " Gravar"),
    el("button.hx-btn", { type: "button", title: "Apagar todas as mensagens prontas", onclick: () => ctx.ops.purge({ vhost, name, messages: q?.messages_ready }).then(refresh) }, icon("fa-solid fa-broom"), " Purgar"),
    el("button.hx-btn.danger", { type: "button", title: "Excluir a fila", onclick: () => ctx.ops.deleteQueue({ vhost, name, messages: q?.messages, consumers: q?.consumers }).then((ok) => ok && ctx.openSection("queues")) }, icon("fa-regular fa-trash-can")),
  );
  const head = el(
    "div.rmq-detail-head",
    {},
    el(
      "div.rmq-detail-title",
      {},
      el("button.hx-icon-btn", { type: "button", title: "Voltar para Filas (Alt+←)", onclick: () => ctx.openSection("queues") }, icon("fa-solid fa-arrow-left")),
      titleEl,
      el("button.hx-icon-btn", { type: "button", title: "Copiar nome", onclick: () => ctx.copy(name) }, icon("fa-regular fa-copy")),
      featEl,
      stateEl,
      el("span.rmq-vh", {}, vhost),
    ),
    actions,
  );
  const tabs = tabsBar(
    [
      { id: "messages", label: "Mensagens" },
      { id: "consumers", label: "Consumidores" },
      { id: "bindings", label: "Ligações" },
      { id: "details", label: "Detalhes" },
    ],
    tab,
    (id) => {
      tab = id;
      ctx.setDetailTab("queue", id);
      tabs.set(id);
      showTab();
    },
  );
  const body = el("div.rmq-detail-body");
  const root = el("div.rmq-view.rmq-detail", {}, head, stats, tabs.bar, body);

  // ----- Mensagens (espiar/consumir via API; não atualiza sozinho) -----
  const settings = ctx.settings();
  let messages = [];
  let selectedIdx = -1;
  const countInput = el("input.hx-input.hx-num.rmq-count-input", { type: "number", min: 1, max: 5000, value: settings.peek_count, title: "Quantidade de mensagens" });
  const modeSel = el(
    "select.hx-select.small",
    { title: "Espiar devolve as mensagens à fila; consumir remove" },
    el("option", { value: "ack_requeue_true" }, "Espiar (devolve à fila)"),
    el("option", { value: "ack_requeue_false" }, "Consumir (remove da fila)"),
    el("option", { value: "reject_requeue_false" }, "Rejeitar (vai para a DLX)"),
  );
  const filterIn = el("input", { type: "search", placeholder: "Filtrar mensagens carregadas (corpo, headers, routing key)", spellcheck: false, oninput: () => paintMessages() });
  const msgInfo = el("span.rmq-sub");
  const msgTable = createTable({
    state: {},
    rowKey: (m) => m.idx,
    emptyText: "Clique em \"Buscar\" para ver as mensagens da fila.",
    columns: [
      { key: "idx", label: "#", align: "right", html: (m) => String(m.idx + 1) },
      { key: "rk", label: "Routing key", html: (m) => esc(m.routing_key) || '<span class="rmq-zero">—</span>' },
      { key: "ex", label: "Exchange", html: (m) => esc(exchangeLabel(m.exchange)) },
      { key: "preview", label: "Corpo", html: (m) => `<span class="rmq-preview">${esc(previewOf(m))}</span>` },
      { key: "size", label: "Tamanho", align: "right", html: (m) => fmtBytes(m.size) },
      { key: "id", label: "message_id", html: (m) => `<span class="rmq-sub">${esc(m.properties.message_id || m.properties.correlation_id || "")}</span>` },
      {
        key: "flags",
        label: "",
        html: (m) => {
          const d = deathInfo(m.properties);
          return `${m.redelivered ? '<span class="rmq-feat warn" title="Reentregue">R</span>' : ""}${d ? `<span class="rmq-feat dlx" title="x-death: ${esc(d.reason)} em ${esc(d.queue)} (${d.count}x)">☠ ${d.count}</span>` : ""}`;
        },
      },
    ],
    onSelect: (list) => {
      selectedIdx = list.length === 1 ? list[0].idx : -1;
      paintDetail();
    },
    onMenu: (list, e) => ctx.showMenu(e.clientX, e.clientY, messageMenuItems(list)),
  });
  const detailEl = el("div.rmq-msg-pane");
  const msgSplit = el("div.rmq-split.v", {}, msgTable.root, el("div.rmq-split-h", { title: "Arraste para redimensionar" }), detailEl);
  ctx.attachSplit(msgSplit);
  const fetchBtn = el("button.hx-btn.primary", { type: "button", onclick: () => fetchMessages() }, icon("fa-solid fa-download"), " Buscar");
  const msgPane = el(
    "div.rmq-msgs",
    {},
    el(
      "div.rmq-msgs-bar",
      {},
      countInput,
      modeSel,
      fetchBtn,
      el("label.db-search.rmq-filter", {}, icon("fa-solid fa-filter"), filterIn),
      msgInfo,
      el("span.hx-flex"),
      el("button.hx-btn", { type: "button", title: "Guardar as mensagens carregadas no histórico local (Gravações)", onclick: () => saveToLog(shownMessages()) }, icon("fa-solid fa-floppy-disk"), " Salvar no log"),
      el("button.hx-btn", { type: "button", title: "Exportar as mensagens carregadas em JSON", onclick: () => ctx.saveJson(`${name}-mensagens.json`, exportMessages(shownMessages())) }, icon("fa-solid fa-file-export")),
    ),
    msgSplit,
  );

  function previewOf(m) {
    const { text, binary } = payloadText(m);
    return binary ? "(binário)" : text.slice(0, 200).replace(/\s+/g, " ");
  }

  function shownMessages() {
    const f = filterIn.value.trim().toLowerCase();
    if (!f) return messages;
    return messages.filter((m) => `${m.routing_key}\n${payloadText(m).text}\n${JSON.stringify(m.properties)}`.toLowerCase().includes(f));
  }

  function paintMessages() {
    const list = shownMessages();
    msgTable.setRows(list);
    if (messages.length) msgInfo.textContent = list.length === messages.length ? `${fmtNum(messages.length)} carregada(s)` : `${fmtNum(list.length)} de ${fmtNum(messages.length)}`;
    paintDetail();
  }

  function messageMenuItems(list) {
    const m = list[0];
    const d = list.length === 1 ? deathInfo(m.properties) : null;
    return [
      list.length === 1 ? { label: "Publicar cópia…", icon: "fa-solid fa-paper-plane", run: () => ctx.dialogs.publish({ vhost, message: m }) } : null,
      d ? { label: "Publicar cópia na origem (x-death)…", icon: "fa-solid fa-rotate-left", run: () => ctx.dialogs.publish({ vhost, message: m, exchange: d.exchange, routing_key: d.routing_key, dropDeath: true }) } : null,
      list.length === 1 ? { label: "Copiar corpo", icon: "fa-regular fa-copy", run: () => ctx.copy(payloadText(m).text, "Corpo copiado") } : null,
      { label: list.length > 1 ? `Copiar ${list.length} como JSON` : "Copiar como JSON", icon: "fa-solid fa-code", run: () => ctx.copy(exportMessages(list), "Copiado") },
      { label: list.length > 1 ? `Salvar ${list.length} no log` : "Salvar no log", icon: "fa-solid fa-floppy-disk", run: () => saveToLog(list) },
    ];
  }

  function paintDetail() {
    detailEl.innerHTML = "";
    const m = messages.find((x) => x.idx === selectedIdx);
    if (!m) {
      detailEl.append(el("div.rmq-empty", {}, messages.length ? "Selecione uma mensagem." : ""));
      return;
    }
    const d = deathInfo(m.properties);
    detailEl.append(
      messageDetail(m, {
        copy: ctx.copy,
        extra: m.message_count !== null ? [["Restavam na fila", fmtNum(m.message_count)]] : [],
        actions: [
          el("button.hx-btn", { type: "button", title: "Abrir o diálogo de publicação com esta mensagem (edite antes de enviar)", onclick: () => ctx.dialogs.publish({ vhost, message: m }) }, icon("fa-solid fa-paper-plane"), " Publicar cópia"),
          d ? el("button.hx-btn", { type: "button", title: `Publicar em ${exchangeLabel(d.exchange)} [${d.routing_key}] sem os headers x-death`, onclick: () => ctx.dialogs.publish({ vhost, message: m, exchange: d.exchange, routing_key: d.routing_key, dropDeath: true }) }, icon("fa-solid fa-rotate-left"), " Para a origem") : null,
          el("button.hx-btn", { type: "button", title: "Guardar no histórico local", onclick: () => saveToLog([m]) }, icon("fa-solid fa-floppy-disk")),
        ].filter(Boolean),
      }),
    );
  }

  async function saveToLog(list) {
    if (!list.length) return ctx.toast("Nada para salvar");
    const n = await ctx.saveMessages(list.map((m) => messageToRecord(m, { connId: ctx.conn().id, vhost, queue: name })));
    ctx.toast(`${fmtNum(n)} mensagem(ns) salva(s) no log`, { label: "Ver", run: () => ctx.openSection("captures", { savedOnly: true }) });
  }

  async function fetchMessages() {
    const count = Math.max(1, Math.min(5000, Number(countInput.value) || settings.peek_count));
    const ackmode = modeSel.value;
    if (ackmode !== "ack_requeue_true") {
      const ok = await ctx.confirmDanger({
        title: ackmode === "ack_requeue_false" ? "Consumir mensagens?" : "Rejeitar mensagens?",
        message:
          ackmode === "ack_requeue_false"
            ? `As primeiras ${count} mensagem(ns) de "${name}" serão REMOVIDAS da fila (elas ficam visíveis aqui e você pode salvá-las no log).`
            : `As primeiras ${count} mensagem(ns) de "${name}" serão rejeitadas sem requeue: vão para a dead-letter exchange da fila (ou são descartadas se não houver).`,
        name,
        confirmLabel: ackmode === "ack_requeue_false" ? "Consumir" : "Rejeitar",
      });
      if (!ok) return;
    }
    fetchBtn.disabled = true;
    msgInfo.textContent = "Buscando…";
    try {
      const list = await ctx.api("POST", `${qPath}/get`, { count, ackmode, encoding: "auto", truncate: settings.peek_truncate_kb * 1024 });
      messages = list.map((m, idx) => normalizeMessage(m, { idx, truncated: m.payload_bytes > settings.peek_truncate_kb * 1024 }));
      selectedIdx = messages.length ? 0 : -1;
      if (ackmode !== "ack_requeue_true" && messages.length) {
        // Guarda automaticamente o que foi removido: não dá para "desconsumir".
        await saveToLog(messages);
      }
      paintMessages();
      if (!messages.length) msgInfo.textContent = "A fila está vazia (ou todas as mensagens estão com consumidores, sem ack).";
      refresh().catch(() => {});
    } catch (e) {
      msgInfo.textContent = "";
      ctx.toast(String(e));
    } finally {
      fetchBtn.disabled = false;
    }
  }

  // ----- Consumidores -----
  const consTable = createTable({
    state: {},
    rowKey: (c) => `${c.channel_details?.name}\u0000${c.consumer_tag}`,
    emptyText: "Nenhum consumidor nesta fila.",
    columns: [
      { key: "tag", label: "Consumer tag", html: (c) => `<code>${esc(c.consumer_tag)}</code>` },
      { key: "conn", label: "Conexão", html: (c) => `${esc(c.channel_details?.connection_name || "")}<span class="rmq-sub">${esc(c.channel_details?.peer_host || "")}:${esc(c.channel_details?.peer_port || "")}</span>` },
      { key: "user", label: "Usuário", html: (c) => esc(c.channel_details?.user || "") },
      { key: "ack", label: "Ack", html: (c) => (c.ack_required ? "manual" : '<span class="rmq-warn">auto</span>') },
      { key: "prefetch", label: "Prefetch", align: "right", html: (c) => (c.prefetch_count ? fmtNum(c.prefetch_count) : "∞") },
      { key: "active", label: "Ativo", html: (c) => (c.active === false ? `<span class="rmq-warn">${esc(c.activity_status || "inativo")}</span>` : esc(c.activity_status || "sim")) },
    ],
    onMenu: ([c], e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        { label: "Copiar consumer tag", icon: "fa-regular fa-copy", run: () => ctx.copy(c.consumer_tag) },
        { label: "Fechar a conexão deste consumidor…", icon: "fa-solid fa-plug-circle-xmark", danger: true, run: () => ctx.ops.closeConnections([{ name: c.channel_details?.connection_name, vhost }]).then(refresh) },
      ]),
  });

  // ----- Ligações -----
  let bindings = [];
  const bindTable = createTable({
    state: {},
    rowKey: (b) => `${b.source}\u0000${b.properties_key}`,
    emptyText: "Sem ligações.",
    columns: [
      { key: "src", label: "Exchange", html: (b) => (b.source === "" ? '<span class="rmq-sub">(AMQP default)</span>' : `<a href="#" data-open class="rmq-link">${esc(b.source)}</a>`) },
      { key: "rk", label: "Routing key", html: (b) => `<code>${esc(b.routing_key)}</code>` },
      { key: "args", label: "Argumentos", html: (b) => (b.arguments && Object.keys(b.arguments).length ? `<code>${esc(JSON.stringify(b.arguments))}</code>` : "") },
    ],
    onOpen: (b) => b.source !== "" && ctx.openExchange(vhost, b.source),
    onMenu: ([b], e) =>
      ctx.showMenu(e.clientX, e.clientY, [
        b.source !== "" ? { label: "Abrir exchange", icon: "fa-solid fa-shuffle", run: () => ctx.openExchange(vhost, b.source) } : null,
        b.source !== "" ? { label: "Publicar por esta ligação…", icon: "fa-solid fa-paper-plane", run: () => ctx.dialogs.publish({ vhost, exchange: b.source, routing_key: b.routing_key }) } : null,
        "sep",
        { label: "Remover ligação", icon: "fa-solid fa-link-slash", danger: true, disabled: b.source === "", run: () => unbind(b) },
      ]),
  });
  const bindPane = el(
    "div.rmq-pane",
    {},
    el("div.rmq-msgs-bar", {}, el("button.hx-btn", { type: "button", onclick: () => ctx.dialogs.binding({ vhost, queue: name }).then((ok) => ok && loadBindings()) }, icon("fa-solid fa-link"), " Nova ligação")),
    bindTable.root,
  );

  async function loadBindings() {
    bindings = await ctx.get(`${qPath}/bindings`);
    if (disposed) return;
    bindTable.setRows(bindings);
    tabs.badge("bindings", bindings.length);
  }

  async function unbind(b) {
    const ok = await ctx.confirmDanger({ title: "Remover ligação?", message: `${b.source} → ${name} [${b.routing_key}]`, confirmLabel: "Remover" });
    if (!ok) return;
    try {
      await ctx.api("DELETE", `${apiPath("bindings", vhost, "e", exchangeSeg(b.source), "q", name)}/${encodeURIComponent(b.properties_key)}`);
      ctx.toast("Ligação removida");
      loadBindings();
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  // ----- Detalhes -----
  const detailsPane = el("div.rmq-pane.rmq-details");

  function paintDetails() {
    detailsPane.innerHTML = "";
    if (!q) return;
    const rows = [
      ["Tipo", q.type || "classic"],
      ["Nó", q.node || "—"],
      q.leader ? ["Líder", q.leader] : null,
      q.members ? ["Membros", q.members.join(", ")] : null,
      ["Durável / auto-delete", `${q.durable ? "sim" : "não"} / ${q.auto_delete ? "sim" : "não"}`],
      q.exclusive ? ["Exclusiva de", q.owner_pid_details?.name || "sim"] : null,
      ["Policy", q.policy || "—"],
      ["Memória", fmtBytes(q.memory)],
      ["Bytes das mensagens", `${fmtBytes(q.message_bytes)} (prontas ${fmtBytes(q.message_bytes_ready)}, sem ack ${fmtBytes(q.message_bytes_unacknowledged)})`],
      q.head_message_timestamp ? ["Mensagem mais antiga", fmtTime(q.head_message_timestamp * 1000, { millis: false })] : null,
      q.idle_since ? ["Ociosa desde", q.idle_since] : null,
      q.consumer_capacity !== undefined || q.consumer_utilisation !== undefined ? ["Uso dos consumidores", `${Math.round(((q.consumer_capacity ?? q.consumer_utilisation) || 0) * 100)}%`] : null,
      q.single_active_consumer_tag ? ["Consumidor ativo (SAC)", q.single_active_consumer_tag] : null,
      ["Reentregas", fmtRate(rate(q, "redeliver") ?? 0)],
      ["get sem mensagem", fmtRate(rate(q, "get_empty") ?? 0)],
    ].filter(Boolean);
    detailsPane.append(
      el("dl.rmq-dl.wide", {}, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, String(v))])),
      el("div.rmq-card-title", {}, "Argumentos"),
      jsonBlock(q.arguments || {}),
      q.effective_policy_definition && Object.keys(q.effective_policy_definition).length ? el("div.rmq-card-title", {}, "Policy efetiva") : null,
      q.effective_policy_definition && Object.keys(q.effective_policy_definition).length ? jsonBlock(q.effective_policy_definition) : null,
    );
  }

  function showTab() {
    body.innerHTML = "";
    if (tab === "messages") {
      body.append(msgPane);
      paintMessages();
    } else if (tab === "consumers") {
      body.append(el("div.rmq-pane", {}, consTable.root));
    } else if (tab === "bindings") {
      body.append(bindPane);
      loadBindings().catch((e) => ctx.toast(String(e)));
    } else {
      body.append(detailsPane);
      paintDetails();
    }
  }

  function paintHead() {
    featEl.innerHTML = featureHtml(queueFeatures(q));
    stateEl.innerHTML = `<span class="rmq-state ${q.state === "running" ? "ok" : "bad"}"></span>${esc(q.state || "")}`;
    stats.innerHTML = "";
    stats.append(
      stat("Prontas", fmtNum(q.messages_ready), q.messages_ready ? "accent" : ""),
      stat("Sem ack", fmtNum(q.messages_unacknowledged), q.messages_unacknowledged ? "warn" : ""),
      stat("Total", fmtNum(q.messages)),
      stat("Consumidores", fmtNum(q.consumers), !q.consumers && q.messages ? "warn" : ""),
      stat("Entrada", fmtRate(rate(q, "publish") ?? 0)),
      stat("Saída", fmtRate(rate(q, "deliver_get") ?? 0)),
      stat("Ack", fmtRate(rate(q, "ack") ?? 0)),
      stat("Tamanho", fmtBytes(q.message_bytes)),
    );
    tabs.badge("consumers", q.consumers);
    consTable.setRows(q.consumer_details || []);
  }

  async function refresh() {
    try {
      q = await ctx.get(qPath);
    } catch (e) {
      if (String(e).includes("404")) {
        stats.innerHTML = "";
        stats.append(el("div.rmq-alert", {}, icon("fa-solid fa-circle-exclamation"), el("span", {}, `A fila "${name}" não existe mais.`)));
        return;
      }
      throw e;
    }
    if (disposed) return;
    paintHead();
    if (tab === "details") paintDetails();
    if (tab === "bindings") loadBindings().catch(() => {});
  }

  showTab();
  return {
    root,
    refresh,
    dispose: () => (disposed = true),
    title: name,
  };
}

// ---------- Exchange ----------

export function exchangeView(ctx, { vhost, name }) {
  let x = null;
  let disposed = false;
  const xPath = apiPath("exchanges", vhost, exchangeSeg(name));
  const featEl = el("span.rmq-feats");
  const stats = el("div.rmq-stats");
  const head = el(
    "div.rmq-detail-head",
    {},
    el(
      "div.rmq-detail-title",
      {},
      el("button.hx-icon-btn", { type: "button", title: "Voltar para Exchanges", onclick: () => ctx.openSection("exchanges") }, icon("fa-solid fa-arrow-left")),
      el("h2", {}, icon("fa-solid fa-shuffle"), el("span.rmq-qname", {}, exchangeLabel(name))),
      el("button.hx-icon-btn", { type: "button", title: "Copiar nome", onclick: () => ctx.copy(name) }, icon("fa-regular fa-copy")),
      featEl,
      el("span.rmq-vh", {}, vhost),
    ),
    el(
      "div.rmq-detail-actions",
      {},
      el("button.hx-btn", { type: "button", onclick: () => ctx.dialogs.publish({ vhost, exchange: name }) }, icon("fa-solid fa-paper-plane"), " Publicar"),
      name !== ""
        ? el("button.hx-btn", { type: "button", title: "Gravar o que é publicado nesta exchange", onclick: () => ctx.dialogs.capture({ vhost, mode: "exchange", exchange: name, routing_key: x?.type === "topic" ? "#" : "" }) }, icon("fa-solid fa-circle-dot"), " Gravar")
        : null,
      name !== "" ? el("button.hx-btn", { type: "button", onclick: () => ctx.dialogs.binding({ vhost, exchange: name }).then((ok) => ok && refresh()) }, icon("fa-solid fa-link"), " Nova ligação") : null,
      name !== "" && !name.startsWith("amq.") ? el("button.hx-btn.danger", { type: "button", onclick: () => ctx.ops.deleteExchange({ vhost, name }).then((ok) => ok && ctx.openSection("exchanges")) }, icon("fa-regular fa-trash-can")) : null,
    ),
  );
  const mkTable = (dir) =>
    createTable({
      state: {},
      rowKey: (b) => `${b.source}\u0000${b.destination}\u0000${b.destination_type}\u0000${b.properties_key}`,
      emptyText: dir === "out" ? (name === "" ? "A exchange padrão entrega direto na fila com o nome da routing key." : "Nenhuma fila/exchange ligada.") : "Nenhuma exchange ligada a esta.",
      columns: [
        {
          key: "dest",
          label: dir === "out" ? "Destino" : "Origem",
          html: (b) => {
            const target = dir === "out" ? b.destination : b.source;
            const type = dir === "out" ? b.destination_type : "exchange";
            return `<i class="fa-solid ${type === "queue" ? "fa-inbox" : "fa-shuffle"} rmq-sub"></i> <a href="#" data-open class="rmq-link">${esc(target)}</a>`;
          },
        },
        { key: "rk", label: "Routing key", html: (b) => `<code>${esc(b.routing_key)}</code>` },
        { key: "args", label: "Argumentos", html: (b) => (b.arguments && Object.keys(b.arguments).length ? `<code>${esc(JSON.stringify(b.arguments))}</code>` : "") },
      ],
      onOpen: (b) => {
        if (dir === "in") return ctx.openExchange(vhost, b.source);
        if (b.destination_type === "queue") ctx.openQueue(vhost, b.destination);
        else ctx.openExchange(vhost, b.destination);
      },
      onMenu: ([b], e) =>
        ctx.showMenu(e.clientX, e.clientY, [
          { label: "Publicar por esta ligação…", icon: "fa-solid fa-paper-plane", run: () => ctx.dialogs.publish({ vhost, exchange: b.source, routing_key: b.routing_key }) },
          "sep",
          {
            label: "Remover ligação",
            icon: "fa-solid fa-link-slash",
            danger: true,
            run: async () => {
              const ok = await ctx.confirmDanger({ title: "Remover ligação?", message: `${b.source} → ${b.destination} [${b.routing_key}]`, confirmLabel: "Remover" });
              if (!ok) return;
              const t = b.destination_type === "queue" ? "q" : "e";
              await ctx.api("DELETE", `${apiPath("bindings", vhost, "e", b.source, t, b.destination)}/${encodeURIComponent(b.properties_key)}`).catch((err) => ctx.toast(String(err)));
              refresh();
            },
          },
        ]),
    });
  const outTable = mkTable("out");
  const inTable = mkTable("in");
  const details = el("div.rmq-pane.rmq-details");
  const body = el(
    "div.rmq-detail-body.scroll",
    {},
    el("div.rmq-card-title", {}, icon("fa-solid fa-arrow-right-from-bracket"), " Ligações de saída"),
    outTable.root,
    el("div.rmq-card-title", {}, icon("fa-solid fa-arrow-right-to-bracket"), " Ligações de entrada (exchange → exchange)"),
    inTable.root,
    details,
  );
  const root = el("div.rmq-view.rmq-detail", {}, head, stats, body);

  async function refresh() {
    const [xx, out, inc] = await Promise.all([
      ctx.get(xPath),
      name === "" ? Promise.resolve([]) : ctx.get(`${xPath}/bindings/source`),
      name === "" ? Promise.resolve([]) : ctx.get(`${xPath}/bindings/destination`),
    ]);
    if (disposed) return;
    x = xx;
    featEl.innerHTML = `<span class="rmq-type t-${esc(x.type)}">${esc(x.type)}</span>${featureHtml(
      [x.durable && { k: "D", t: "Durável" }, x.auto_delete && { k: "AD", t: "Auto-delete" }, x.internal && { k: "I", t: "Interna" }, x.arguments?.["alternate-exchange"] && { k: "AE", t: `Alternate exchange: ${x.arguments["alternate-exchange"]}` }].filter(Boolean),
    )}`;
    stats.innerHTML = "";
    stats.append(
      stat("Entrada", fmtRate(x.message_stats?.publish_in_details?.rate ?? 0)),
      stat("Saída", fmtRate(x.message_stats?.publish_out_details?.rate ?? 0)),
      stat("Ligações", fmtNum(out.length)),
    );
    outTable.setRows(out);
    inTable.setRows(inc);
    details.innerHTML = "";
    if (x.arguments && Object.keys(x.arguments).length) details.append(el("div.rmq-card-title", {}, "Argumentos"), jsonBlock(x.arguments));
  }

  return { root, refresh, dispose: () => (disposed = true), title: exchangeLabel(name) };
}


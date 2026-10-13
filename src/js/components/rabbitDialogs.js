import { el, icon } from "../utils/dom.js";
import { createModalHost, btn } from "./modal.js";
import { codeEditor } from "./codeEditor.js";
import {
  CAPTURE_MODES,
  CONN_COLORS,
  apiPath,
  connConfig,
  connLabel,
  exchangeLabel,
  exchangeSeg,
  expandTemplate,
  fmtNum,
  nameMatcher,
  normalizeConnection,
  parseHeadersText,
  payloadText,
  prettyBody,
  publishBody,
  queueArguments,
  republishProps,
  uuid,
  isTransientQueue,
} from "../utils/rabbitModel.js";
import { rabbitApi } from "../api.js";

// Modais da aba RabbitMQ.

const modal = createModalHost(document.getElementById("rmq-modal"));

export const isRmqModalOpen = modal.isOpen;
export const closeRmqModal = modal.close;
export const rmqConfirm = modal.confirm;

function field(label, control, hint = "") {
  return el("label.hx-field", {}, el("span.hx-field-label", {}, label), control, hint ? el("span.hx-field-hint", {}, hint) : null);
}

function input(value, { type = "text", placeholder = "", oninput, className = "", list, min, max } = {}) {
  return el(`input.hx-input${className ? `.${className}` : ""}`, { type, value: value ?? "", placeholder, spellcheck: false, autocomplete: "off", oninput, list, min, max });
}

function selectEl(options, value, onchange) {
  const s = el("select.hx-select", { onchange: () => onchange(s.value) });
  for (const [v, label] of options) s.append(el("option", { value: v, selected: v === value }, label));
  return s;
}

function check(label, checked, onchange, hint = "") {
  const box = el("input", { type: "checkbox", checked, onchange: () => onchange(box.checked) });
  return el("label.db-check", { title: hint }, box, el("span", {}, label));
}

function statusBox() {
  const box = el("div.db-test", { hidden: true });
  box.show = (ok, text) => {
    box.hidden = false;
    box.className = `db-test ${ok === null ? "busy" : ok ? "ok" : "bad"}`;
    box.innerHTML = "";
    box.append(icon(ok === null ? "fa-solid fa-spinner fa-spin" : ok ? "fa-solid fa-circle-check" : "fa-solid fa-circle-exclamation"), el("span", {}, text));
  };
  return box;
}

let listSeq = 0;
function datalist(values) {
  const id = `rmq-dl-${++listSeq}`;
  const dl = el("datalist", { id });
  const set = (vals) => {
    dl.innerHTML = "";
    for (const v of vals) dl.append(el("option", { value: v }));
  };
  set(values || []);
  dl.set = set;
  return dl;
}

/** Nomes de filas/exchanges do vhost para autocompletar (falhas viram lista vazia). */
async function names(ctx, kind, vhost) {
  try {
    const list = await ctx.get(`${apiPath(kind, vhost)}?columns=name${kind === "exchanges" ? ",type" : ",exclusive"}`);
    return list.filter((x) => !(kind === "queues" && isTransientQueue(x))).map((x) => x.name);
  } catch {
    return [];
  }
}

function vhostSelect(ctx, value, onchange) {
  const list = ctx.vhostList();
  const opts = (list.length ? list : [value || "/"]).map((v) => [v, v]);
  return selectEl(opts, value || ctx.vhost() || ctx.conn().vhost || "/", onchange);
}

// ---------- Confirmações ----------

/** Confirmação de ação destrutiva; em conexões "sensíveis" exige digitar o nome. */
export function dangerConfirm({ title, message, name = "", confirmLabel = "Confirmar", requireName = false }) {
  if (!requireName || !name) return modal.confirm({ title, message, confirmLabel, danger: true });
  return new Promise((resolve) => {
    let answered = false;
    const typed = input("", { placeholder: name });
    const ok = btn(confirmLabel, () => {
      if (typed.value !== name) return typed.classList.add("bad");
      answered = true;
      resolve(true);
      modal.close();
    }, "hx-btn.danger");
    ok.disabled = true;
    typed.addEventListener("input", () => (ok.disabled = typed.value !== name));
    typed.addEventListener("keydown", (e) => e.key === "Enter" && !ok.disabled && ok.click());
    modal.open({
      title,
      body: el("div", {}, el("p.hx-modal-text", {}, message), field(el("span", {}, "Ambiente sensível: digite ", el("code", {}, name), " para confirmar"), typed)),
      footer: [btn("Cancelar", () => modal.close()), ok],
      onClose: () => !answered && resolve(false),
    });
    typed.focus();
  });
}

export function promptDialog({ title, label, value = "", placeholder = "" }) {
  return new Promise((resolve) => {
    let answered = false;
    const inp = input(value, { placeholder });
    const done = (v) => {
      answered = true;
      resolve(v);
      modal.close();
    };
    inp.addEventListener("keydown", (e) => e.key === "Enter" && done(inp.value.trim()));
    modal.open({ title, body: field(label, inp), footer: [btn("Cancelar", () => modal.close()), btn("OK", () => done(inp.value.trim()), "hx-btn.primary")], onClose: () => !answered && resolve(null) });
    inp.focus();
    inp.select();
  });
}

// ---------- Conexão ----------

/** onSave(conn, password) — password undefined = não mudou. */
export function connectionDialog(initial, { isNew, hasPassword = false, onSave, onDelete }) {
  const c = normalizeConnection(structuredClone(initial));
  let password;
  const status = statusBox();

  const colorRow = el("div.db-colors");
  function paintColors() {
    colorRow.innerHTML = "";
    for (const color of CONN_COLORS) {
      colorRow.append(
        el("button.db-color", {
          type: "button",
          title: color ? "Cor da conexão" : "Sem cor",
          style: color ? `--c:${color}` : "",
          class: `db-color${color === c.color ? " on" : ""}${color ? "" : " none"}`,
          onclick: () => ((c.color = color), paintColors()),
        }),
      );
    }
  }
  paintColors();

  const urlInput = input(c.mgmt_url, { placeholder: "http://localhost:15672", oninput: (e) => (c.mgmt_url = e.target.value.trim()) });
  const pwInput = input("", { type: "password", placeholder: hasPassword ? "•••••••• (salva no cofre do sistema)" : "senha", oninput: (e) => (password = e.target.value) });

  async function test() {
    if (!c.mgmt_url) return status.show(false, "Informe a URL do management.");
    status.show(null, "Conectando…");
    testBtn.disabled = true;
    try {
      const r = await rabbitApi.test(connConfig(c), password ?? null, c.vhost);
      const ov = r.overview;
      const base = `Management OK: RabbitMQ ${ov.rabbitmq_version} · ${ov.cluster_name || ""} · usuário ${ov.user || c.user}`;
      if (r.amqp_error) status.show(false, `${base}. AMQP falhou (a gravação e o "mover" precisam dele): ${r.amqp_error}`);
      else status.show(true, `${base} · AMQP OK.`);
    } catch (e) {
      status.show(false, String(e));
    } finally {
      testBtn.disabled = false;
    }
  }
  const testBtn = btn([icon("fa-solid fa-plug-circle-check"), " Testar conexão"], test);

  const body = el(
    "div.db-conn-form",
    {},
    el("div.db-row2", {}, field("Nome", input(c.name, { placeholder: "ex.: RabbitMQ local", oninput: (e) => (c.name = e.target.value) })), field("Cor", colorRow)),
    field("URL do management", urlInput, "Plugin rabbitmq_management (porta 15672; HTTPS normalmente 15671). Ex.: http://localhost:15672"),
    el("div.db-row2", {}, field("Usuário", input(c.user, { oninput: (e) => (c.user = e.target.value) })), field("Senha", pwInput)),
    field("Vhost padrão", input(c.vhost, { placeholder: "/", oninput: (e) => (c.vhost = e.target.value || "/") }), "As listas podem mostrar todos os vhosts ou um só (seletor na barra lateral)."),
    el(
      "details.db-advanced",
      { open: !!(c.amqp_host || c.amqp_port || c.amqp_tls) },
      el("summary", {}, "AMQP (gravação e mover mensagens)"),
      el(
        "div.db-row2",
        {},
        field("Host AMQP", input(c.amqp_host, { placeholder: "mesmo host da URL", oninput: (e) => (c.amqp_host = e.target.value.trim()) })),
        field("Porta", input(c.amqp_port ?? "", { type: "number", placeholder: "5672 (TLS: 5671)", className: "hx-num", oninput: (e) => (c.amqp_port = e.target.value ? Number(e.target.value) : null) })),
      ),
      check("AMQP com TLS (amqps)", c.amqp_tls, (v) => (c.amqp_tls = v)),
    ),
    el(
      "details.db-advanced",
      {},
      el("summary", {}, "Avançado"),
      check("Aceitar certificado HTTPS inválido/autoassinado no management", c.tls_insecure, (v) => (c.tls_insecure = v)),
      field("Tempo limite (s)", input(c.timeout_s, { type: "number", className: "hx-num", oninput: (e) => (c.timeout_s = Number(e.target.value) || 20) })),
    ),
    check("Ambiente sensível: exigir digitar o nome para purgar, excluir, consumir ou fechar conexões", c.protected, (v) => (c.protected = v)),
    el("div.db-test-row", {}, testBtn),
    status,
  );

  const save = btn(isNew ? "Criar" : "Salvar", async () => {
    if (!c.mgmt_url) return status.show(false, "Informe a URL do management.");
    modal.close();
    await onSave(c, password);
  }, "hx-btn.primary");
  modal.open({
    title: isNew ? "Nova conexão RabbitMQ" : `Conexão: ${connLabel(c)}`,
    iconCls: "fa-solid fa-envelopes-bulk",
    body,
    className: "db-conn-modal",
    footer: [onDelete ? btn([icon("fa-regular fa-trash-can"), " Excluir"], () => (modal.close(), onDelete()), "hx-btn.danger") : null, el("span.hx-flex"), btn("Cancelar", () => modal.close()), save].filter(Boolean),
  });
  urlInput.focus();
}

// ---------- Publicar ----------

/**
 * preset: { vhost, exchange, routing_key, message (normalizada), dropDeath }
 */
export function publishDialog(ctx, preset = {}) {
  const msg = preset.message || null;
  let vhost = preset.vhost || msg?.vhost || ctx.vhost() || ctx.conn().vhost || "/";
  const props = republishProps(msg?.properties || {}, { dropDeath: !!preset.dropDeath });
  const headers = props.headers || {};
  delete props.headers;
  const { text: msgText, binary } = msg ? payloadText(msg) : { text: "", binary: false };
  const initialPayload = msg ? (binary ? msg.payload : prettyBody(msgText, props.content_type).text) : "{\n  \n}";
  let encoding = binary ? "base64" : "string";

  const exList = datalist([]);
  const qList = datalist([]);
  const exInput = input(exchangeLabel(preset.exchange ?? msg?.exchange ?? ""), { placeholder: "(AMQP default)", list: exList.id });
  const rkInput = input(preset.routing_key ?? msg?.routing_key ?? "", { placeholder: "routing key (na exchange padrão: nome da fila)", list: qList.id });
  const loadNames = () => {
    names(ctx, "exchanges", vhost).then((n) => exList.set(n.map(exchangeLabel)));
    names(ctx, "queues", vhost).then((n) => qList.set(n));
  };
  loadNames();
  const vh = vhostSelect(ctx, vhost, (v) => ((vhost = v), loadNames()));

  const p = { ...props };
  const pInput = (key, placeholder, extra = {}) => input(p[key] ?? "", { placeholder, oninput: (e) => (p[key] = e.target.value), ...extra });
  const ctList = datalist(["application/json", "text/plain", "application/xml", "application/octet-stream", "application/x-protobuf"]);
  const msgIdInput = pInput("message_id", "message_id");
  const persistent = check("Persistente (delivery_mode 2)", (p.delivery_mode ?? 2) === 2, (v) => (p.delivery_mode = v ? 2 : 1));
  p.delivery_mode = p.delivery_mode ?? 2;
  const stampNow = check("timestamp = agora", false, (v) => (stampNow.on = v));

  const headersEd = codeEditor({ value: Object.keys(headers).length ? JSON.stringify(headers, null, 2) : "", lang: "json", placeholder: '{ "tenant": "acme" }', minLines: 3, maxLines: 10 });
  const payloadEd = codeEditor({ value: initialPayload, lang: binary ? "text" : prettyBody(initialPayload, props.content_type).lang === "json" ? "json" : "text", minLines: 8, maxLines: 22 });
  const encSel = selectEl(
    [
      ["string", "Texto (UTF-8)"],
      ["base64", "Base64 (binário)"],
    ],
    encoding,
    (v) => (encoding = v),
  );
  const formatBtn = btn([icon("fa-solid fa-wand-magic-sparkles"), " Formatar JSON"], () => {
    try {
      payloadEd.setValue(JSON.stringify(JSON.parse(payloadEd.value), null, 2));
      payloadEd.setLang("json");
    } catch (e) {
      status.show(false, `JSON inválido: ${e.message}`);
    }
  });
  const repeatInput = input(1, { type: "number", className: "hx-num", min: 1, max: 100000 });
  const status = statusBox();

  async function publish(keepOpen) {
    let hdrs;
    try {
      hdrs = parseHeadersText(headersEd.value);
    } catch (e) {
      return status.show(false, e.message);
    }
    const exchange = exInput.value.trim() === "(AMQP default)" ? "" : exInput.value.trim();
    const count = Math.max(1, Math.min(100000, Number(repeatInput.value) || 1));
    const properties = { ...p };
    for (const k of Object.keys(properties)) if (properties[k] === "") delete properties[k];
    if (properties.priority !== undefined) properties.priority = Number(properties.priority);
    if (Object.keys(hdrs).length) properties.headers = hdrs;
    const path = `${apiPath("exchanges", vhost, exchangeSeg(exchange))}/publish`;
    status.show(null, count > 1 ? `Publicando 0 de ${count}…` : "Publicando…");
    let routed = 0;
    let unrouted = 0;
    try {
      for (let n = 1; n <= count; n++) {
        const now = Date.now();
        const props_n = { ...properties };
        if (stampNow.on) props_n.timestamp = Math.floor(now / 1000);
        if (props_n.message_id) props_n.message_id = expandTemplate(props_n.message_id, n, now);
        if (props_n.correlation_id) props_n.correlation_id = expandTemplate(props_n.correlation_id, n, now);
        const payload = encoding === "string" ? expandTemplate(payloadEd.value, n, now) : payloadEd.value.replace(/\s+/g, "");
        const r = await ctx.api("POST", path, publishBody({ routing_key: expandTemplate(rkInput.value, n, now), properties: props_n, payload, payload_encoding: encoding }));
        if (r?.routed) routed++;
        else unrouted++;
        if (count > 1 && n % 25 === 0) status.show(null, `Publicando ${n} de ${count}…`);
      }
    } catch (e) {
      return status.show(false, `${String(e)}${routed + unrouted ? ` (${routed + unrouted} publicada(s) antes do erro)` : ""}`);
    }
    const where = `${exchangeLabel(exchange)}${rkInput.value ? ` [${rkInput.value}]` : ""}`;
    const text = unrouted
      ? `${fmtNum(routed + unrouted)} publicada(s) em ${where}; ${fmtNum(unrouted)} SEM ROTA (nenhuma fila recebeu — confira a routing key/ligações).`
      : `${fmtNum(routed)} mensagem(ns) publicada(s) em ${where}.`;
    ctx.remember("publish", { vhost, exchange, routing_key: rkInput.value });
    if (keepOpen || unrouted) status.show(!unrouted, text);
    else {
      modal.close();
      ctx.toast(text);
    }
    ctx.refreshSoon();
  }

  const body = el(
    "div.rmq-publish",
    {},
    exList,
    qList,
    ctList,
    el("div.rmq-row3", {}, field("Vhost", vh), field("Exchange", exInput), field("Routing key", rkInput)),
    el(
      "details.db-advanced",
      { open: Object.keys(props).some((k) => !["delivery_mode", "content_type"].includes(k)) },
      el("summary", {}, "Propriedades"),
      el(
        "div.rmq-props",
        {},
        field("content_type", pInput("content_type", "application/json", { list: ctList.id })),
        field(el("span", {}, "message_id ", el("button.rmq-mini", { type: "button", title: "Gerar UUID", onclick: () => ((msgIdInput.value = p.message_id = uuid())) }, "uuid")), msgIdInput),
        field("correlation_id", pInput("correlation_id", "")),
        field("reply_to", pInput("reply_to", "")),
        field("expiration (ms)", pInput("expiration", "ex.: 60000")),
        field("priority", pInput("priority", "0-255", { type: "number" })),
        field("type", pInput("type", "")),
        field("app_id", pInput("app_id", "")),
        field("content_encoding", pInput("content_encoding", "")),
      ),
      el("div.rmq-checks", {}, persistent, stampNow),
    ),
    field("Headers (JSON)", headersEd.root),
    el("div.rmq-payload-head", {}, el("span.hx-field-label", {}, "Corpo"), el("span.hx-flex"), formatBtn, encSel),
    payloadEd.root,
    el(
      "div.rmq-repeat",
      {},
      field("Repetir", repeatInput),
      el("span.hx-field-hint", {}, "Variáveis no corpo, routing key, message_id e correlation_id: {{n}} (sequência), {{uuid}}, {{now}}, {{timestamp}}."),
    ),
    status,
  );
  modal.open({
    title: msg ? "Publicar cópia da mensagem" : "Publicar mensagem",
    iconCls: "fa-solid fa-paper-plane",
    body,
    wide: true,
    footer: [el("span.hx-flex"), btn("Cancelar", () => modal.close()), btn("Publicar e continuar", () => publish(true)), btn([icon("fa-solid fa-paper-plane"), " Publicar"], () => publish(false), "hx-btn.primary")],
  });
  body.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      publish(false);
    }
  });
  (rkInput.value ? payloadEd.input : rkInput).focus();
}

/** Republicar várias mensagens gravadas: na exchange/routing key originais ou num destino único. */
export function republishManyDialog(ctx, msgs) {
  let target = "original";
  let vhost = msgs[0]?.vhost || ctx.vhost() || "/";
  const exInput = input("", { placeholder: "(AMQP default)" });
  const rkInput = input("", { placeholder: "routing key / nome da fila" });
  const custom = el("div.rmq-row2", { hidden: true }, field("Exchange", exInput), field("Routing key", rkInput));
  const dropDeath = check("Remover headers x-death", true, (v) => (dropDeath.on = v));
  dropDeath.on = true;
  const status = statusBox();
  const radios = el(
    "div.rmq-radios",
    {},
    ...[
      ["original", "Exchange e routing key originais de cada mensagem"],
      ["custom", "Outro destino"],
    ].map(([v, label]) =>
      el("label.db-check", {}, el("input", { type: "radio", name: "rmq-rp", checked: v === target, onchange: () => ((target = v), (custom.hidden = v !== "custom")) }), el("span", {}, label)),
    ),
  );
  async function run() {
    let ok = 0;
    let unrouted = 0;
    status.show(null, "Publicando…");
    try {
      for (const m of msgs) {
        const ex = target === "custom" ? (exInput.value.trim() === "(AMQP default)" ? "" : exInput.value.trim()) : m.exchange;
        const rk = target === "custom" ? rkInput.value : m.routing_key;
        const props = republishProps(m.properties, { dropDeath: dropDeath.on });
        const r = await ctx.api("POST", `${apiPath("exchanges", vhost, exchangeSeg(ex))}/publish`, publishBody({ routing_key: rk, properties: props, payload: m.payload, payload_encoding: m.payload_encoding }));
        if (r?.routed) ok++;
        else unrouted++;
      }
    } catch (e) {
      return status.show(false, `${String(e)} (${ok + unrouted} publicada(s) antes do erro)`);
    }
    modal.close();
    ctx.toast(unrouted ? `${ok} publicada(s); ${unrouted} sem rota` : `${ok} mensagem(ns) republicada(s)`);
    ctx.refreshSoon();
  }
  modal.open({
    title: `Republicar ${msgs.length} mensagens`,
    iconCls: "fa-solid fa-paper-plane",
    body: el("div", {}, field("Vhost", vhostSelect(ctx, vhost, (v) => (vhost = v))), radios, custom, dropDeath, status),
    footer: [btn("Cancelar", () => modal.close()), btn("Republicar", run, "hx-btn.primary")],
  });
}

// ---------- Mover / copiar ----------

/** Resolve com o resultado (ou null se cancelado). */
export async function moveDialog(ctx, { vhost, queue, count = 0, dead = false }) {
  // Em ambiente sensível a confirmação vem antes (o host mostra um modal por vez).
  if (ctx.conn().protected) {
    const ok = await dangerConfirm({ title: "Mover/copiar mensagens?", message: `Mensagens podem sair de "${queue}".`, name: queue, confirmLabel: "Continuar", requireName: true });
    if (!ok) return null;
  }
  return new Promise((resolve) => {
    let target = dead ? "origin" : "queue";
    let done = false;
    const qList = datalist([]);
    names(ctx, "queues", vhost).then((n) => qList.set(n.filter((x) => x !== queue)));
    const exList = datalist([]);
    names(ctx, "exchanges", vhost).then((n) => exList.set(n.filter(Boolean)));
    const toQueue = input("", { placeholder: "fila de destino", list: qList.id });
    const exInput = input("", { placeholder: "exchange", list: exList.id });
    const rkInput = input("", { placeholder: "routing key" });
    const countInput = input("", { type: "number", className: "hx-num", placeholder: `todas (${fmtNum(count || 0)})`, min: 1 });
    let copy = false;
    const status = statusBox();
    const qBox = field("Fila", toQueue);
    const exBox = el("div.rmq-row2", {}, field("Exchange", exInput), field("Routing key", rkInput));
    const originHint = el("p.hx-field-hint", {}, "Cada mensagem volta para a exchange/routing key de onde morreu (header x-death). Mensagens sem x-death ficam na fila.");
    const sync = () => {
      qBox.hidden = target !== "queue";
      exBox.hidden = target !== "exchange";
      originHint.hidden = target !== "origin";
    };
    const radios = el(
      "div.rmq-radios",
      {},
      ...[
        ["queue", "Outra fila"],
        ["exchange", "Exchange + routing key"],
        ["origin", "Origem (x-death) — reprocessar DLQ"],
      ].map(([v, label]) => el("label.db-check", {}, el("input", { type: "radio", name: "rmq-mv", checked: v === target, onchange: () => ((target = v), sync()) }), el("span", {}, label))),
    );
    sync();
    async function run() {
      const spec = {
        vhost,
        from_queue: queue,
        target,
        to_queue: toQueue.value.trim(),
        exchange: exInput.value.trim(),
        routing_key: rkInput.value,
        count: countInput.value ? Number(countInput.value) : null,
        copy,
      };
      if (target === "queue" && !spec.to_queue) return status.show(false, "Informe a fila de destino.");
      if (target === "exchange" && !spec.exchange) return status.show(false, "Informe a exchange.");
      status.show(null, copy ? "Copiando…" : "Movendo…");
      try {
        const r = await rabbitApi.move(ctx.connConfig(), spec);
        done = true;
        const parts = [`${fmtNum(r.moved)} ${copy ? "copiada(s)" : "movida(s)"}`];
        if (r.skipped) parts.push(`${fmtNum(r.skipped)} sem x-death ficaram na fila`);
        if (r.returned) parts.push(`${fmtNum(r.returned)} sem rota no destino ${copy ? "não foram copiadas" : "voltaram para a fila"}`);
        modal.close();
        ctx.toast(parts.join(" · "));
        resolve(r);
      } catch (e) {
        status.show(false, String(e));
      }
    }
    modal.open({
      title: `Mover mensagens de "${queue}"`,
      iconCls: "fa-solid fa-right-left",
      body: el(
        "div",
        {},
        qList,
        exList,
        radios,
        qBox,
        exBox,
        originHint,
        el("div.rmq-row2", {}, field("Quantidade", countInput, "Vazio = todas as que estão na fila agora."), el("div", {}, check("Copiar (mantém as mensagens na origem)", false, (v) => (copy = v)))),
        el("p.hx-field-hint", {}, "Usa uma transação AMQP: cada lote é publicado e confirmado junto; se a conexão cair, nada se perde. Destinos sem rota devolvem as mensagens à origem."),
        status,
      ),
      footer: [btn("Cancelar", () => modal.close()), btn([icon("fa-solid fa-right-left"), " Executar"], run, "hx-btn.primary")],
      onClose: () => !done && resolve(null),
    });
  });
}

// ---------- Nova fila / exchange / ligação ----------

export function newQueueDialog(ctx, preset = {}) {
  let vhost = preset.vhost || ctx.vhost() || ctx.conn().vhost || "/";
  const f = { type: "classic", durable: true, auto_delete: false, ttl: "", expires: "", max_length: "", max_length_bytes: "", overflow: "", dlx: "", dlk: "", max_priority: "", single_active: false, delivery_limit: "" };
  const nameIn = input("", { placeholder: "nome da fila" });
  const exList = datalist([]);
  names(ctx, "exchanges", vhost).then((n) => exList.set(n.filter(Boolean)));
  const bindEx = input("", { placeholder: "opcional: ligar a uma exchange", list: exList.id });
  const bindRk = input("", { placeholder: "routing key" });
  const extra = codeEditor({ value: "", lang: "json", placeholder: '{ "x-argumento": "valor" }', minLines: 2, maxLines: 6 });
  const num = (key, placeholder) => input("", { type: "number", className: "hx-num", placeholder, oninput: (e) => (f[key] = e.target.value) });
  const txt = (key, placeholder, list) => input("", { placeholder, list, oninput: (e) => (f[key] = e.target.value) });
  const status = statusBox();
  async function create() {
    const name = nameIn.value.trim();
    if (!name) return status.show(false, "Informe o nome.");
    let extraArgs = {};
    try {
      extraArgs = parseHeadersText(extra.value);
    } catch (e) {
      return status.show(false, e.message.replace("Headers", "Argumentos"));
    }
    const args = queueArguments({ ...f, extra: extraArgs });
    try {
      await ctx.api("PUT", apiPath("queues", vhost, name), { durable: f.type === "classic" ? f.durable : true, auto_delete: f.type === "classic" ? f.auto_delete : false, arguments: args });
      if (bindEx.value.trim()) await ctx.api("POST", apiPath("bindings", vhost, "e", bindEx.value.trim(), "q", name), { routing_key: bindRk.value, arguments: {} });
    } catch (e) {
      return status.show(false, String(e));
    }
    modal.close();
    ctx.toast(`Fila "${name}" criada`);
    ctx.openQueue(vhost, name);
  }
  modal.open({
    title: "Nova fila",
    iconCls: "fa-solid fa-inbox",
    wide: true,
    body: el(
      "div",
      {},
      exList,
      el("div.rmq-row3", {}, field("Vhost", vhostSelect(ctx, vhost, (v) => (vhost = v))), field("Nome", nameIn), field("Tipo", selectEl([["classic", "Classic"], ["quorum", "Quorum"], ["stream", "Stream"]], f.type, (v) => (f.type = v)))),
      el("div.rmq-checks", {}, check("Durável", true, (v) => (f.durable = v)), check("Auto-delete", false, (v) => (f.auto_delete = v)), check("Single active consumer", false, (v) => (f.single_active = v))),
      el(
        "div.rmq-props",
        {},
        field("TTL das mensagens (ms)", num("ttl", "x-message-ttl")),
        field("Expira sem uso (ms)", num("expires", "x-expires")),
        field("Máx. mensagens", num("max_length", "x-max-length")),
        field("Máx. bytes", num("max_length_bytes", "x-max-length-bytes")),
        field("Ao lotar", selectEl([["", "padrão (drop-head)"], ["drop-head", "drop-head"], ["reject-publish", "reject-publish"], ["reject-publish-dlx", "reject-publish-dlx"]], "", (v) => (f.overflow = v))),
        field("Dead letter exchange", txt("dlx", "x-dead-letter-exchange", exList.id)),
        field("Dead letter routing key", txt("dlk", "x-dead-letter-routing-key")),
        field("Prioridade máx.", num("max_priority", "x-max-priority")),
        field("Limite de entregas (quorum)", num("delivery_limit", "x-delivery-limit")),
      ),
      el("div.rmq-row2", {}, field("Ligar à exchange", bindEx), field("Routing key", bindRk)),
      field("Outros argumentos (JSON)", extra.root),
      status,
    ),
    footer: [btn("Cancelar", () => modal.close()), btn("Criar fila", create, "hx-btn.primary")],
  });
  nameIn.focus();
}

export function newExchangeDialog(ctx, preset = {}) {
  let vhost = preset.vhost || ctx.vhost() || ctx.conn().vhost || "/";
  const x = { type: "topic", durable: true, auto_delete: false, internal: false, ae: "" };
  const nameIn = input("", { placeholder: "nome da exchange" });
  const status = statusBox();
  async function create() {
    const name = nameIn.value.trim();
    if (!name) return status.show(false, "Informe o nome.");
    try {
      await ctx.api("PUT", apiPath("exchanges", vhost, name), { type: x.type, durable: x.durable, auto_delete: x.auto_delete, internal: x.internal, arguments: x.ae ? { "alternate-exchange": x.ae } : {} });
    } catch (e) {
      return status.show(false, String(e));
    }
    modal.close();
    ctx.toast(`Exchange "${name}" criada`);
    ctx.openExchange(vhost, name);
  }
  modal.open({
    title: "Nova exchange",
    iconCls: "fa-solid fa-shuffle",
    body: el(
      "div",
      {},
      el("div.rmq-row3", {}, field("Vhost", vhostSelect(ctx, vhost, (v) => (vhost = v))), field("Nome", nameIn), field("Tipo", selectEl(["direct", "topic", "fanout", "headers", "x-delayed-message", "x-consistent-hash"].map((t) => [t, t]), x.type, (v) => (x.type = v)))),
      el("div.rmq-checks", {}, check("Durável", true, (v) => (x.durable = v)), check("Auto-delete", false, (v) => (x.auto_delete = v)), check("Interna", false, (v) => (x.internal = v))),
      field("Alternate exchange", input("", { placeholder: "recebe o que não tiver rota (opcional)", oninput: (e) => (x.ae = e.target.value.trim()) })),
      status,
    ),
    footer: [btn("Cancelar", () => modal.close()), btn("Criar exchange", create, "hx-btn.primary")],
  });
  nameIn.focus();
}

/** Liga exchange → fila (ou exchange → exchange). Resolve true se criou. */
export function bindingDialog(ctx, { vhost, queue = "", exchange = "" }) {
  return new Promise((resolve) => {
    let created = false;
    let destType = "q";
    const exList = datalist([]);
    const qList = datalist([]);
    names(ctx, "exchanges", vhost).then((n) => exList.set(n.filter(Boolean)));
    names(ctx, "queues", vhost).then((n) => qList.set(n));
    const exIn = input(exchange, { placeholder: "exchange de origem", list: exList.id });
    const destIn = input(queue, { placeholder: "fila de destino", list: qList.id });
    const rkIn = input("", { placeholder: "routing key (topic: * e #)" });
    const args = codeEditor({ value: "", lang: "json", placeholder: '{ "x-match": "all", "tipo": "pedido" }  (exchanges headers)', minLines: 2, maxLines: 6 });
    const status = statusBox();
    const destSel = selectEl([["q", "Fila"], ["e", "Exchange"]], "q", (v) => {
      destType = v;
      destIn.placeholder = v === "q" ? "fila de destino" : "exchange de destino";
      destIn.setAttribute("list", v === "q" ? qList.id : exList.id);
    });
    async function create() {
      const src = exIn.value.trim();
      const dest = destIn.value.trim();
      if (!src || !dest) return status.show(false, "Informe a exchange e o destino.");
      let a = {};
      try {
        a = parseHeadersText(args.value);
      } catch (e) {
        return status.show(false, e.message.replace("Headers", "Argumentos"));
      }
      try {
        await ctx.api("POST", apiPath("bindings", vhost, "e", src, destType, dest), { routing_key: rkIn.value, arguments: a });
      } catch (e) {
        return status.show(false, String(e));
      }
      created = true;
      modal.close();
      ctx.toast("Ligação criada");
      resolve(true);
    }
    modal.open({
      title: "Nova ligação",
      iconCls: "fa-solid fa-link",
      body: el("div", {}, exList, qList, field("Exchange de origem", exIn), el("div.rmq-row2", {}, field("Tipo do destino", destSel), field("Destino", destIn)), field("Routing key", rkIn), field("Argumentos (JSON)", args.root), status),
      footer: [btn("Cancelar", () => modal.close()), btn("Criar", create, "hx-btn.primary")],
      onClose: () => !created && resolve(false),
    });
    (exchange ? rkIn : exIn).focus();
  });
}

// ---------- Gravação ----------

/** preset: { vhost, mode, queues, exchange, routing_key } */
export function captureDialog(ctx, preset = {}) {
  const spec = {
    vhost: preset.vhost || ctx.vhost() || ctx.conn().vhost || "/",
    mode: preset.mode || (preset.exchange ? "exchange" : "tap"),
    queues: [...(preset.queues || [])],
    exchange: preset.exchange || "",
    routing_key: preset.routing_key ?? "#",
    events: [],
    name: "",
  };
  const settings = ctx.settings();
  let allQueues = [];
  const status = statusBox();
  const qFilter = input("", { placeholder: "Filtrar filas", oninput: () => paintQueues() });
  const qBox = el("div.rmq-qpick");
  const qSel = el("span.rmq-sub");
  const exList = datalist([]);
  const exIn = input(spec.exchange, { placeholder: "exchange", list: exList.id, oninput: (e) => (spec.exchange = e.target.value.trim()) });
  const rkIn = input(spec.routing_key, { placeholder: "# (topic: tudo)", oninput: (e) => (spec.routing_key = e.target.value) });
  const nameIn = input("", { placeholder: "opcional (padrão: filas/exchange)", oninput: (e) => (spec.name = e.target.value) });
  const help = el("p.rmq-mode-help");
  const evBox = el(
    "div.rmq-checks",
    {},
    check("Publicações", true, (v) => setEvent("publish", v)),
    check("Entregas a consumidores", true, (v) => setEvent("deliver", v)),
  );
  const evState = { publish: true, deliver: true };
  function setEvent(k, v) {
    evState[k] = v;
    spec.events = evState.publish && evState.deliver ? [] : Object.keys(evState).filter((x) => evState[x]);
  }
  const queuePart = el("div", {}, el("div.rmq-qpick-head", {}, el("label.db-search.rmq-filter.grow", {}, icon("fa-solid fa-magnifying-glass"), qFilter), qSel), qBox);
  const exPart = el("div.rmq-row2", {}, exList, field("Exchange", exIn), field("Routing key", rkIn));

  async function loadQueues() {
    qBox.innerHTML = "";
    qBox.append(el("div.rmq-empty", {}, "Carregando filas…"));
    try {
      const list = await ctx.get(`${apiPath("queues", spec.vhost)}?columns=name,messages,exclusive,consumers`);
      allQueues = list.filter((q) => !isTransientQueue(q));
    } catch (e) {
      allQueues = [];
      status.show(false, String(e));
    }
    paintQueues();
    names(ctx, "exchanges", spec.vhost).then((n) => exList.set(n.filter((x) => x && !x.startsWith("amq.rabbitmq"))));
  }

  function paintQueues() {
    const match = nameMatcher(qFilter.value);
    qBox.innerHTML = "";
    const shown = allQueues.filter((q) => match(q.name) || spec.queues.includes(q.name));
    if (!shown.length) qBox.append(el("div.rmq-empty", {}, "Nenhuma fila."));
    for (const q of shown.slice(0, 500)) {
      const box = el("input", {
        type: "checkbox",
        checked: spec.queues.includes(q.name),
        onchange: () => {
          if (box.checked) spec.queues.push(q.name);
          else spec.queues = spec.queues.filter((x) => x !== q.name);
          qSel.textContent = spec.queues.length ? `${spec.queues.length} selecionada(s)` : "";
        },
      });
      qBox.append(el("label.rmq-qpick-item", {}, box, el("span", {}, q.name), el("span.rmq-sub", {}, `${fmtNum(q.messages)} msg · ${q.consumers ?? 0} cons.`)));
    }
    qSel.textContent = spec.queues.length ? `${spec.queues.length} selecionada(s)` : "";
  }

  const HELP = {
    tap: "Cria uma fila temporária com as mesmas ligações das filas escolhidas: recebe uma cópia de cada mensagem publicada para elas, sem consumir nada das filas reais. Não vê publicações diretas na fila (exchange padrão).",
    firehose: "Liga o tracing do vhost (rabbitmqctl trace_on) e grava cada publicação e cada entrega a consumidores, inclusive publicações diretas na fila. Tem custo de desempenho no servidor: use em ambiente de desenvolvimento. O tracing é desligado ao parar a gravação. Sem filas marcadas = vhost inteiro.",
    exchange: "Fila temporária ligada à exchange com a routing key informada (topic: # para tudo; fanout: qualquer valor; direct: a chave exata).",
  };
  const modeSwitch = el("div.db-driver-switch");
  function paintMode() {
    modeSwitch.innerHTML = "";
    for (const [k, m] of Object.entries(CAPTURE_MODES)) {
      modeSwitch.append(el("button", { type: "button", class: `db-driver${spec.mode === k ? " on" : ""}`, onclick: () => ((spec.mode = k), paintMode()) }, icon(m.icon), m.short));
    }
    help.textContent = HELP[spec.mode];
    help.classList.toggle("warn", spec.mode === "firehose");
    queuePart.hidden = spec.mode === "exchange";
    exPart.hidden = spec.mode !== "exchange";
    evBox.hidden = spec.mode !== "firehose";
  }
  paintMode();

  async function start() {
    if (spec.mode === "tap" && !spec.queues.length) return status.show(false, "Marque ao menos uma fila.");
    if (spec.mode === "exchange" && !spec.exchange) return status.show(false, "Informe a exchange.");
    if (spec.mode === "firehose" && evState.publish === false && evState.deliver === false) return status.show(false, "Escolha publicações e/ou entregas.");
    status.show(null, "Iniciando…");
    try {
      await ctx.startCapture({ ...spec, max_body_kb: settings.max_body_kb, max_messages: settings.max_messages });
      modal.close();
    } catch (e) {
      status.show(false, String(e));
    }
  }

  modal.open({
    title: "Gravar mensagens",
    iconCls: "fa-solid fa-circle-dot",
    wide: true,
    body: el(
      "div.rmq-capture-form",
      {},
      el("div.rmq-row2", {}, field("Vhost", vhostSelect(ctx, spec.vhost, (v) => ((spec.vhost = v), (spec.queues = []), loadQueues()))), field("Nome da gravação", nameIn)),
      modeSwitch,
      help,
      queuePart,
      exPart,
      evBox,
      el("p.hx-field-hint", {}, `As mensagens vão para o rabbit.db (corpo até ${fmtNum(settings.max_body_kb)} KB; mantém as ${fmtNum(settings.max_messages)} mais recentes). A gravação continua em segundo plano enquanto o app estiver aberto.`),
      status,
    ),
    footer: [btn("Cancelar", () => modal.close()), btn([icon("fa-solid fa-circle-dot"), " Iniciar gravação"], start, "hx-btn.primary")],
  });
  loadQueues();
}

// ---------- Preferências ----------

export function settingsDialog(ctx) {
  const s = { ...ctx.settings() };
  const num = (key, hint) => input(s[key], { type: "number", className: "hx-num", oninput: (e) => (s[key] = Number(e.target.value) || s[key]) });
  modal.open({
    title: "Preferências do RabbitMQ",
    iconCls: "fa-solid fa-sliders",
    body: el(
      "div",
      {},
      el("div.rmq-row2", {}, field("Mensagens por busca (padrão)", num("peek_count")), field("Truncar corpo ao espiar (KB)", num("peek_truncate_kb"))),
      el("div.rmq-row2", {}, field("Corpo máximo gravado (KB)", num("max_body_kb")), field("Máximo de mensagens no rabbit.db", num("max_messages"), "As mais antigas são apagadas.")),
    ),
    footer: [btn("Cancelar", () => modal.close()), btn("Salvar", () => (ctx.saveSettings(s), modal.close()), "hx-btn.primary")],
  });
}

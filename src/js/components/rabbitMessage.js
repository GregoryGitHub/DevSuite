import { el, icon } from "../utils/dom.js";
import { highlightCode } from "../utils/highlight.js";
import { deathInfo, deathReasonLabel, exchangeLabel, fmtBytes, fmtTime, hexDump, payloadText, prettyBody, EVENT_LABELS } from "../utils/rabbitModel.js";

// Detalhe de uma mensagem (visualização da fila e histórico gravado): propriedades,
// headers, x-death e corpo formatado (JSON/XML com realce, binário em hex).

const HIGHLIGHT_LIMIT = 300_000;

export function jsonBlock(value, { cls = "" } = {}) {
  const text = JSON.stringify(value ?? null, null, 2);
  return el(`pre.rmq-code${cls ? `.${cls}` : ""}`, { html: text.length > HIGHLIGHT_LIMIT ? escapeText(text) : highlightCode(text, "json") });
}

function escapeText(t) {
  return t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

const PROP_LABELS = [
  ["content_type", "content_type"],
  ["content_encoding", "content_encoding"],
  ["delivery_mode", "delivery_mode"],
  ["priority", "priority"],
  ["message_id", "message_id"],
  ["correlation_id", "correlation_id"],
  ["reply_to", "reply_to"],
  ["expiration", "expiration"],
  ["timestamp", "timestamp"],
  ["type", "type"],
  ["user_id", "user_id"],
  ["app_id", "app_id"],
  ["cluster_id", "cluster_id"],
];

function propValue(k, v) {
  if (k === "delivery_mode") return v === 2 ? "2 (persistente)" : v === 1 ? "1 (transiente)" : String(v);
  if (k === "timestamp" && typeof v === "number") return `${v} (${fmtTime(v < 1e12 ? v * 1000 : v, { millis: false })})`;
  if (k === "expiration") return `${v} ms`;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * msg: { exchange, routing_key, redelivered, properties, payload, payload_encoding, size, truncated?, event?, at?, queues?, client? }
 * opts: { actions: Node[], copy(text, label), extra: [[label, value]] }
 */
export function messageDetail(msg, { actions = [], copy, extra = [] } = {}) {
  const props = msg.properties || {};
  const { text, binary } = payloadText(msg);
  const pretty = binary ? null : prettyBody(text, props.content_type);
  let mode = binary ? "hex" : pretty.json ? "pretty" : "raw";

  const bodyEl = el("pre.rmq-code.rmq-body");
  const modeBtns = el("div.rmq-seg");
  const modes = binary ? [["hex", "Hex"], ["raw", "Base64"]] : pretty.json ? [["pretty", "Formatado"], ["raw", "Bruto"]] : [["raw", "Texto"]];
  function paintBody() {
    const t = mode === "hex" ? hexDump(msg.payload) : mode === "pretty" ? pretty.text : binary ? msg.payload : text;
    const lang = mode === "pretty" ? "json" : mode === "raw" && !binary ? pretty.lang : "text";
    bodyEl.innerHTML = t.length > HIGHLIGHT_LIMIT || lang === "text" ? escapeText(t) : highlightCode(t, lang);
    modeBtns.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  }
  for (const [m, label] of modes) modeBtns.append(el("button", { type: "button", dataset: { mode: m }, onclick: () => ((mode = m), paintBody()) }, label));
  paintBody();

  const death = deathInfo(props);
  const headers = props.headers && Object.keys(props.headers).length ? props.headers : null;
  const propRows = PROP_LABELS.filter(([k]) => props[k] !== undefined && props[k] !== null && props[k] !== "");

  const meta = [
    ["Exchange", exchangeLabel(msg.exchange ?? "")],
    ["Routing key", msg.routing_key || "—"],
    msg.queues && (Array.isArray(msg.queues) ? msg.queues.length : msg.queues) ? ["Filas", Array.isArray(msg.queues) ? msg.queues.join(", ") : msg.queues] : null,
    msg.event ? ["Evento", EVENT_LABELS[msg.event] || msg.event] : null,
    msg.at ? ["Quando", fmtTime(msg.at)] : null,
    msg.client ? ["Cliente", msg.client] : null,
    ...extra,
  ].filter(Boolean);

  const badges = [
    msg.redelivered ? el("span.rmq-badge.warn", { title: "Já foi entregue antes (requeue, nack ou espiada)" }, "reentregue") : null,
    msg.size !== null && msg.size !== undefined ? el("span.rmq-badge", {}, fmtBytes(msg.size)) : null,
    props.content_type ? el("span.rmq-badge", {}, props.content_type) : null,
    binary ? el("span.rmq-badge", {}, "binário") : null,
    msg.truncated ? el("span.rmq-badge.warn", { title: "Corpo maior que o limite configurado: só o início foi guardado/mostrado" }, "truncado") : null,
  ];

  const copyBody = () => copy?.(mode === "pretty" ? pretty.text : binary ? msg.payload : text, "Corpo copiado");

  return el(
    "div.rmq-msg",
    {},
    el("div.rmq-msg-head", {}, el("div.rmq-msg-title", {}, el("strong", {}, msg.routing_key || "(sem routing key)"), ...badges), el("div.rmq-msg-actions", {}, ...actions)),
    death
      ? el(
          "div.rmq-alert.dead",
          {},
          icon("fa-solid fa-skull-crossbones"),
          el(
            "span",
            {},
            `Dead-lettered de "${death.queue}": ${deathReasonLabel(death.reason)}${death.count > 1 ? ` (${death.count}x)` : ""}. Origem: ${exchangeLabel(death.exchange)}${death.routing_key ? ` [${death.routing_key}]` : ""}${death.time ? ` · ${fmtTime(death.time, { millis: false })}` : ""}.`,
          ),
        )
      : null,
    el("dl.rmq-dl", {}, ...meta.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, String(v))])),
    propRows.length ? el("details.rmq-sect", { open: true }, el("summary", {}, "Propriedades"), el("dl.rmq-dl", {}, ...propRows.flatMap(([k, label]) => [el("dt", {}, label), el("dd", {}, propValue(k, props[k]))]))) : null,
    headers ? el("details.rmq-sect", { open: true }, el("summary", {}, `Headers (${Object.keys(headers).length})`, el("button.hx-icon-btn", { type: "button", title: "Copiar headers", onclick: (e) => (e.preventDefault(), copy?.(JSON.stringify(headers, null, 2), "Headers copiados")) }, icon("fa-regular fa-copy"))), jsonBlock(headers)) : null,
    el(
      "div.rmq-sect.body",
      {},
      el("div.rmq-sect-head", {}, el("span", {}, "Corpo"), modeBtns, el("span.hx-flex"), el("button.hx-icon-btn", { type: "button", title: "Copiar corpo", onclick: copyBody }, icon("fa-regular fa-copy"))),
      bodyEl,
    ),
  );
}

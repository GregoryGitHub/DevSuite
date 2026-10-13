// RabbitMQ: modelo das conexões/estado da interface e utilitários puros (sem DOM).
// Persistência em rabbit.db (Rust): conexões sem senha, `ui` e `settings` como JSON.

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const CONN_COLORS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ec4899"];

export const SECTIONS = [
  { id: "overview", label: "Visão geral", icon: "fa-solid fa-gauge-high" },
  { id: "queues", label: "Filas", icon: "fa-solid fa-inbox" },
  { id: "exchanges", label: "Exchanges", icon: "fa-solid fa-shuffle" },
  { id: "connections", label: "Conexões", icon: "fa-solid fa-plug" },
  { id: "channels", label: "Canais", icon: "fa-solid fa-diagram-project" },
  { id: "consumers", label: "Consumidores", icon: "fa-solid fa-user-gear" },
  { id: "captures", label: "Gravações", icon: "fa-solid fa-circle-dot" },
];

export function newConnection() {
  return normalizeConnection({ id: uid() });
}

export function normalizeConnection(c = {}) {
  return {
    id: c.id || uid(),
    name: c.name || "",
    color: CONN_COLORS.includes(c.color) ? c.color : "",
    mgmt_url: c.mgmt_url ?? "http://localhost:15672",
    user: c.user ?? "guest",
    vhost: c.vhost || "/",
    amqp_host: c.amqp_host || "",
    amqp_port: Number(c.amqp_port) > 0 ? Number(c.amqp_port) : null,
    amqp_tls: !!c.amqp_tls,
    tls_insecure: !!c.tls_insecure,
    timeout_s: Number(c.timeout_s) > 0 ? Number(c.timeout_s) : 20,
    /** Ambiente sensível: purgar/excluir/fechar exigem digitar o nome. */
    protected: !!c.protected,
  };
}

/** Só o que o Rust precisa (RmqConn). */
export function connConfig(c) {
  const { id, mgmt_url, user, amqp_host, amqp_port, amqp_tls, tls_insecure, timeout_s } = c;
  return { id, mgmt_url, user, amqp_host, amqp_port, amqp_tls, tls_insecure, timeout_s };
}

export function connLabel(c) {
  if (!c) return "?";
  if (c.name) return c.name;
  try {
    const u = new URL(c.mgmt_url.includes("://") ? c.mgmt_url : `http://${c.mgmt_url}`);
    return u.host;
  } catch {
    return c.mgmt_url || "RabbitMQ";
  }
}

export const REFRESH_OPTIONS = [0, 2, 5, 10, 30, 60];

export function normalizeUi(ui = {}) {
  ui = ui && typeof ui === "object" ? ui : {};
  return {
    conn_id: ui.conn_id || null,
    section: SECTIONS.some((s) => s.id === ui.section) ? ui.section : "overview",
    /** conn_id -> vhost escolhido ("" = todos) */
    vhosts: ui.vhosts && typeof ui.vhosts === "object" ? ui.vhosts : {},
    refresh_s: REFRESH_OPTIONS.includes(ui.refresh_s) ? ui.refresh_s : 5,
    side_w: clamp(Number(ui.side_w) || 240, 180, 420),
    side_open: ui.side_open !== false,
    expanded: Array.isArray(ui.expanded) ? ui.expanded : [],
    /** Filtros/ordenação por seção: { queues: { text, sort, dir, hideEmpty } } */
    lists: ui.lists && typeof ui.lists === "object" ? ui.lists : {},
    detail_h: clamp(Number(ui.detail_h) || 300, 120, 900),
  };
}

export function normalizeSettings(s = {}) {
  s = s && typeof s === "object" ? s : {};
  return {
    peek_count: clamp(Number(s.peek_count) || 50, 1, 5000),
    peek_truncate_kb: clamp(Number(s.peek_truncate_kb) || 256, 1, 16384),
    max_body_kb: clamp(Number(s.max_body_kb) || 512, 1, 16384),
    max_messages: clamp(Number(s.max_messages) || 200000, 1000, 10_000_000),
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ---------- Caminhos da API ----------

/** apiPath("queues", "/", "pedidos") → "/queues/%2F/pedidos" */
export function apiPath(...segments) {
  return "/" + segments.map((s) => encodeURIComponent(String(s))).join("/");
}

/** Exchange padrão: "" na AMQP, "amq.default" nos caminhos da API. */
export const exchangeSeg = (name) => (name === "" ? "amq.default" : name);
export const exchangeLabel = (name) => (name === "" ? "(AMQP default)" : name);

// ---------- Formatação ----------

const nf = new Intl.NumberFormat("pt-BR");
const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

export const fmtNum = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : nf.format(n));

export function fmtRate(r) {
  if (r === null || r === undefined) return "";
  if (r === 0) return "0/s";
  return `${r < 10 ? nf1.format(r) : nf.format(Math.round(r))}/s`;
}

export function fmtBytes(b) {
  if (b === null || b === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(b);
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? nf1.format(v) : nf.format(v)} ${units[i]}`;
}

export function fmtDuration(ms) {
  if (!ms && ms !== 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}min`;
  if (m) return `${m}min ${s % 60}s`;
  return `${s}s`;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** 06/10 14:03:22.123 (ms = true) */
export function fmtTime(ms, { millis = true, date = true } = {}) {
  if (!ms) return "—";
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${millis ? `.${pad(d.getMilliseconds(), 3)}` : ""}`;
  return date ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}` : time;
}

/** Datas da API ("2026-10-06 14:03:22" ou epoch ms). */
export function parseApiDate(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;
  const t = Date.parse(String(v).replace(" ", "T"));
  return Number.isNaN(t) ? 0 : t;
}

export const rate = (obj, key) => obj?.message_stats?.[`${key}_details`]?.rate ?? null;

// ---------- Filas / exchanges ----------

/** Atributos curtos de uma fila (badges ao lado do nome). */
export function queueFeatures(q) {
  const a = q.arguments || {};
  const eff = { ...(q.effective_policy_definition || {}) };
  const f = [];
  const type = q.type || a["x-queue-type"] || "classic";
  if (type !== "classic") f.push({ k: type === "quorum" ? "Q" : type === "stream" ? "S" : type, t: `Fila ${type}`, cls: type });
  if (q.durable) f.push({ k: "D", t: "Durável" });
  if (q.auto_delete) f.push({ k: "AD", t: "Auto-delete" });
  if (q.exclusive) f.push({ k: "Excl", t: "Exclusiva (da conexão que a criou)" });
  const ttl = a["x-message-ttl"] ?? eff["message-ttl"];
  if (ttl !== undefined) f.push({ k: "TTL", t: `TTL das mensagens: ${fmtDuration(ttl)} (${ttl} ms)` });
  const exp = a["x-expires"] ?? eff.expires;
  if (exp !== undefined) f.push({ k: "Exp", t: `Fila expira após ${fmtDuration(exp)} sem uso` });
  const dlx = a["x-dead-letter-exchange"] ?? eff["dead-letter-exchange"];
  if (dlx !== undefined) {
    const dlk = a["x-dead-letter-routing-key"] ?? eff["dead-letter-routing-key"];
    f.push({ k: "DLX", t: `Dead letter → ${exchangeLabel(dlx)}${dlk ? ` [${dlk}]` : ""}`, cls: "dlx" });
  }
  const maxLen = a["x-max-length"] ?? eff["max-length"];
  const maxBytes = a["x-max-length-bytes"] ?? eff["max-length-bytes"];
  if (maxLen !== undefined || maxBytes !== undefined) {
    const parts = [maxLen !== undefined ? `${fmtNum(maxLen)} msgs` : "", maxBytes !== undefined ? fmtBytes(maxBytes) : ""].filter(Boolean);
    f.push({ k: "Lim", t: `Limite: ${parts.join(" / ")} (${a["x-overflow"] ?? eff.overflow ?? "drop-head"})` });
  }
  if (a["x-max-priority"] !== undefined) f.push({ k: "Pri", t: `Prioridade máx.: ${a["x-max-priority"]}` });
  if (a["x-single-active-consumer"]) f.push({ k: "SAC", t: "Single active consumer" });
  if ((a["x-queue-mode"] ?? eff["queue-mode"]) === "lazy") f.push({ k: "Lazy", t: "Lazy" });
  if (q.policy) f.push({ k: "Pol", t: `Policy: ${q.policy}`, cls: "policy" });
  return f;
}

/** Filas "de sistema"/temporárias (amq.gen-*, exclusivas, reply-to). */
export const isTransientQueue = (q) => q.exclusive || /^amq\.gen-/.test(q.name);

/** Prováveis DLQs: o nome ou o fato de alguma fila apontar para ela. */
export function isDeadLetterQueue(q) {
  return /(^|[._-])(dlq|dead|deadletter|dead-letter|error|errors|parking|poison)([._-]|$)/i.test(q.name);
}

/**
 * Filtro de nome: texto (contém, sem maiúsculas), curingas `*`, ou `/regex/`.
 * Devolve uma função (name) => boolean; regex inválida = nada casa.
 */
export function nameMatcher(filter) {
  const f = String(filter || "").trim();
  if (!f) return () => true;
  const re = /^\/(.+)\/([imsu]*)$/.exec(f);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i");
      return (n) => rx.test(n);
    } catch {
      return () => false;
    }
  }
  if (f.includes("*")) {
    const rx = new RegExp("^" + f.split("*").map(escapeRegex).join(".*") + "$", "i");
    return (n) => rx.test(n);
  }
  const low = f.toLowerCase();
  return (n) => String(n).toLowerCase().includes(low);
}

function escapeRegex(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Ordena cópia de `rows` por `get(row)` (números antes de texto; nulos por último). */
export function sortBy(rows, get, dir = "asc") {
  const m = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === y) return 0;
    if (x === null || x === undefined || x === "") return 1;
    if (y === null || y === undefined || y === "") return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * m;
    return String(x).localeCompare(String(y), "pt-BR", { numeric: true, sensitivity: "base" }) * m;
  });
}

// ---------- Mensagens ----------

/** Mensagem do /get da API (ou do rabbit.db) no formato comum da interface. */
export function normalizeMessage(m, extra = {}) {
  return {
    exchange: m.exchange ?? "",
    routing_key: m.routing_key ?? "",
    redelivered: !!m.redelivered,
    properties: m.properties && typeof m.properties === "object" && !Array.isArray(m.properties) ? m.properties : {},
    payload: m.payload ?? "",
    payload_encoding: m.payload_encoding === "base64" ? "base64" : "string",
    size: m.payload_bytes ?? m.size ?? null,
    message_count: m.message_count ?? null,
    ...extra,
  };
}

/** Texto do corpo (base64 decodificado quando for UTF-8 válido). */
export function payloadText(msg) {
  if (msg.payload_encoding !== "base64") return { text: msg.payload, binary: false };
  try {
    const bytes = Uint8Array.from(atob(msg.payload), (c) => c.charCodeAt(0));
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), binary: false };
  } catch {
    return { text: msg.payload, binary: true };
  }
}

/** Hex dump curto para corpos binários. */
export function hexDump(base64, max = 4096) {
  let bytes;
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).slice(0, max);
  } catch {
    return "";
  }
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = [...bytes.slice(i, i + 16)];
    const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

/** Linguagem para realce + texto formatado (JSON indentado quando possível). */
export function prettyBody(text, contentType = "") {
  const t = String(text ?? "");
  const trimmed = t.trim();
  const ct = String(contentType).toLowerCase();
  if (/json/.test(ct) || /^[[{]/.test(trimmed)) {
    try {
      return { lang: "json", text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true };
    } catch {
      /* não é JSON válido: segue como texto */
    }
  }
  if (/xml|html/.test(ct) || /^<[?!a-zA-Z]/.test(trimmed)) return { lang: /html/.test(ct) ? "html" : "xml", text: t, json: false };
  return { lang: "text", text: t, json: false };
}

/** x-death mais recente: de onde a mensagem veio e por que morreu. */
export function deathInfo(props) {
  const d = props?.headers?.["x-death"];
  if (!Array.isArray(d) || !d.length) return null;
  const first = d[0] || {};
  return {
    exchange: first.exchange ?? "",
    routing_key: Array.isArray(first["routing-keys"]) ? first["routing-keys"][0] ?? "" : "",
    queue: first.queue ?? "",
    reason: first.reason ?? "",
    count: d.reduce((n, x) => n + (Number(x.count) || 0), 0),
    time: first.time ? (typeof first.time === "number" ? first.time * 1000 : parseApiDate(first.time)) : 0,
  };
}

const DEATH_REASONS = {
  rejected: "rejeitada (nack/reject sem requeue)",
  expired: "expirou (TTL)",
  maxlen: "fila cheia (max-length)",
  delivery_limit: "limite de entregas (quorum)",
};
export const deathReasonLabel = (r) => DEATH_REASONS[r] || r;

/** Propriedades limpas para publicar de novo (sem vazios; x-death opcionalmente removido). */
export function republishProps(props = {}, { dropDeath = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "headers") {
      const h = { ...v };
      if (dropDeath) for (const x of Object.keys(h)) if (/^x-(death|first-death|last-death)/.test(x)) delete h[x];
      if (Object.keys(h).length) out.headers = h;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Corpo do POST /exchanges/{vh}/{ex}/publish. */
export function publishBody({ routing_key = "", properties = {}, payload = "", payload_encoding = "string" }) {
  return { routing_key, properties: republishProps(properties), payload, payload_encoding };
}

/** Uma mensagem do /get pronta para `rmq_messages_save`. */
export function messageToRecord(m, { connId, vhost, queue, event = "peek" }) {
  return {
    conn_id: connId,
    vhost,
    at: Date.now(),
    event,
    exchange: m.exchange,
    routing_key: m.routing_key,
    queues: queue ? [queue] : [],
    properties: m.properties,
    payload_text: m.payload,
    payload_encoding: m.payload_encoding,
    size: m.size ?? 0,
    redelivered: m.redelivered,
  };
}

/** Exporta mensagens (detalhe completo) como JSON legível e reimportável. */
export function exportMessages(list) {
  return JSON.stringify(
    list.map((m) => ({
      at: m.at ? new Date(m.at).toISOString() : undefined,
      event: m.event,
      exchange: m.exchange,
      routing_key: m.routing_key,
      queues: typeof m.queues === "string" ? m.queues.split(" ").filter(Boolean) : m.queues,
      redelivered: m.redelivered,
      properties: m.properties,
      payload_encoding: m.payload_encoding,
      payload: m.payload_encoding === "string" && prettyBody(m.payload).json ? JSON.parse(m.payload) : m.payload,
    })),
    null,
    2,
  );
}

/** Texto do editor de headers (JSON) → objeto; lança erro legível. */
export function parseHeadersText(text) {
  const t = String(text || "").trim();
  if (!t) return {};
  let v;
  try {
    v = JSON.parse(t);
  } catch (e) {
    throw new Error(`Headers: JSON inválido (${e.message})`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Headers: use um objeto JSON, ex.: { \"tenant\": \"acme\" }");
  return v;
}

/** Argumentos da nova fila a partir dos campos do diálogo (vazios são ignorados). */
export function queueArguments(f) {
  const a = {};
  const num = (v) => (v === "" || v === null || v === undefined ? undefined : Number(v));
  if (f.type && f.type !== "classic") a["x-queue-type"] = f.type;
  const set = (k, v) => v !== undefined && v !== "" && !Number.isNaN(v) && (a[k] = v);
  set("x-message-ttl", num(f.ttl));
  set("x-expires", num(f.expires));
  set("x-max-length", num(f.max_length));
  set("x-max-length-bytes", num(f.max_length_bytes));
  if (f.overflow) a["x-overflow"] = f.overflow;
  if (f.dlx !== undefined && f.dlx !== null && f.dlx !== "") a["x-dead-letter-exchange"] = f.dlx === "(default)" ? "" : f.dlx;
  if (f.dlk) a["x-dead-letter-routing-key"] = f.dlk;
  set("x-max-priority", num(f.max_priority));
  if (f.single_active) a["x-single-active-consumer"] = true;
  set("x-delivery-limit", num(f.delivery_limit));
  return { ...a, ...(f.extra || {}) };
}

export const CAPTURE_MODES = {
  tap: { label: "Tap (cópia pelas ligações)", short: "Tap", icon: "fa-solid fa-faucet-drip" },
  firehose: { label: "Firehose (tracing do vhost)", short: "Firehose", icon: "fa-solid fa-fire" },
  exchange: { label: "Exchange + routing key", short: "Exchange", icon: "fa-solid fa-shuffle" },
};

export const EVENT_LABELS = { publish: "publicada", deliver: "entregue", peek: "salva da fila" };

/** UUID v4 (crypto quando disponível). */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ ((Math.random() * 16) >> (c / 4))).toString(16));
}

/** Variáveis da publicação repetida: {{n}} (1, 2, ...), {{uuid}}, {{now}} (ISO), {{timestamp}} (ms). */
export function expandTemplate(text, n, now = Date.now()) {
  if (!text || !text.includes("{{")) return text;
  return text.replace(/\{\{\s*(n|i|uuid|now|timestamp)\s*\}\}/g, (_, k) => {
    if (k === "n" || k === "i") return String(n);
    if (k === "uuid") return uuid();
    if (k === "now") return new Date(now).toISOString();
    return String(now);
  });
}

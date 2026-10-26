// CLI: `devsuite rabbit ...` (ver src-tauri/cli/commands.json). Gestão pela API de management
// (`rmq_http`), mover/copiar e gravações pelo AMQP no Rust, como na interface. Operações que
// alteram filas exigem --write; numa conexão "ambiente sensível", também --confirm <nome>.

import { rabbitApi } from "../api.js";
import { rabbitHost as host } from "../components/rabbit.js";
import {
  connConfig, connLabel, newConnection, apiPath, exchangeSeg, isDeadLetterQueue, isTransientQueue, nameMatcher, normalizeMessage,
  payloadText, messageToRecord, publishBody, expandTemplate, deathInfo, rate,
} from "../utils/rabbitModel.js";
import { CliError, pick, list, splitPair, requireFlag, iso, fold, sinceMs } from "./cliUtils.js";

const QUEUE_COLUMNS = [
  "name", "vhost", "type", "state", "durable", "auto_delete", "exclusive", "arguments", "policy",
  "messages", "messages_ready", "messages_unacknowledged", "consumers", "consumer_utilisation", "idle_since",
  "message_stats.publish_details.rate", "message_stats.deliver_get_details.rate", "message_stats.ack_details.rate",
].join(",");

function findConn(wanted) {
  return pick(host.connections(), wanted, { what: "conexão", name: connLabel });
}

const api = (c, method, path, body = null) => rabbitApi.http(connConfig(c), method, path, body);
const vhostOf = (c, p) => (p.vhost !== undefined ? String(p.vhost) : c.vhost || "/");

/** Operações destrutivas: --write e, em ambiente sensível, --confirm com o nome da conexão. */
function guard(c, p, what) {
  requireFlag(p, "write", `${what} exige --write`);
  if (c.protected && fold(p.confirm) !== fold(connLabel(c))) {
    throw new CliError("needs_confirm", `${connLabel(c)} é um ambiente sensível: ${what} exige --confirm "${connLabel(c)}"`);
  }
}

function queueRow(q) {
  return {
    name: q.name,
    vhost: q.vhost,
    type: q.type || "classic",
    state: q.state || "",
    messages: q.messages ?? 0,
    ready: q.messages_ready ?? 0,
    unacked: q.messages_unacknowledged ?? 0,
    consumers: q.consumers ?? 0,
    publish_rate: rate(q, "publish"),
    deliver_rate: rate(q, "deliver_get"),
    ack_rate: rate(q, "ack"),
    dlq: isDeadLetterQueue(q) || undefined,
    dlx: q.arguments?.["x-dead-letter-exchange"] ?? undefined,
  };
}

async function queuesOf(c, vhost) {
  return api(c, "GET", `${apiPath("queues", vhost)}?columns=${QUEUE_COLUMNS}`);
}

function messageView(m) {
  const { text, binary } = payloadText(m);
  const out = {
    exchange: m.exchange,
    routing_key: m.routing_key,
    redelivered: m.redelivered,
    properties: m.properties,
    body: binary ? undefined : text,
    body_base64: binary ? m.payload : undefined,
    size: m.size,
  };
  const death = deathInfo(m.properties);
  if (death) out.death = { ...death, time: death.time ? iso(death.time) : null };
  return out;
}

// ---------- Conexões ----------

async function conns() {
  return Promise.all(
    host.connections().map(async (c) => ({
      id: c.id,
      name: connLabel(c),
      mgmt_url: c.mgmt_url,
      user: c.user,
      vhost: c.vhost,
      amqp: c.amqp_host ? `${c.amqp_host}:${c.amqp_port || 5672}` : null,
      protected: c.protected,
      has_password: await rabbitApi.hasPassword(c.id),
    })),
  );
}

async function connAdd(p) {
  if (host.connections().some((c) => fold(connLabel(c)) === fold(p.name))) throw new CliError("failed", `Já existe a conexão ${p.name}`);
  const c = newConnection();
  Object.assign(c, {
    name: String(p.name).trim(),
    mgmt_url: p.url || c.mgmt_url,
    user: p.user ?? c.user,
    vhost: p.vhost || "/",
    amqp_host: p.amqp_host || "",
    amqp_port: p.amqp_port || null,
    protected: !!p.protected,
  });
  const password = p.password !== undefined ? String(p.password).replace(/\r?\n$/, "") : undefined;
  if (p.test) {
    const r = await rabbitApi.test(connConfig(c), password ?? null, c.vhost);
    if (r.amqp_error) c.test_warning = r.amqp_error;
  }
  await host.addConnection(c, password);
  return { id: c.id, name: connLabel(c), saved: true, warning: c.test_warning };
}

async function connRemove(p) {
  requireFlag(p, "yes", "Remover uma conexão exige --yes");
  const c = findConn(p.conn);
  await host.removeConnection(c);
  return { id: c.id, name: connLabel(c), removed: true };
}

// ---------- Leitura ----------

async function overview(p) {
  const c = findConn(p.conn);
  const vhost = vhostOf(c, p);
  const ages = "lengths_age=600&lengths_incr=10&msg_rates_age=600&msg_rates_incr=10";
  const [ov, nodes, queues] = await Promise.all([
    api(c, "GET", `/overview?${ages}`),
    api(c, "GET", "/nodes?columns=name,running,mem_used,mem_limit,mem_alarm,disk_free,disk_free_limit,disk_free_alarm,fd_used,fd_total,uptime").catch(() => []),
    queuesOf(c, vhost).catch(() => []),
  ]);
  const qt = ov.queue_totals || {};
  const ms = ov.message_stats || {};
  const r = (k) => ms[`${k}_details`]?.rate ?? null;
  const alarms = nodes
    .filter((n) => n.mem_alarm || n.disk_free_alarm || n.running === false)
    .map((n) => `${n.name}: ${n.running === false ? "parado" : [n.mem_alarm ? "memória" : "", n.disk_free_alarm ? "disco" : ""].filter(Boolean).join(" e ")}`);
  const visible = queues.filter((q) => !isTransientQueue(q));
  return {
    conn: connLabel(c),
    cluster: ov.cluster_name,
    rabbitmq: ov.rabbitmq_version,
    vhost,
    totals: { messages: qt.messages ?? 0, ready: qt.messages_ready ?? 0, unacked: qt.messages_unacknowledged ?? 0, ...ov.object_totals },
    rates: { publish: r("publish"), deliver: r("deliver_get"), ack: r("ack"), redeliver: r("redeliver") },
    alarms,
    dlqs_with_messages: visible.filter((q) => isDeadLetterQueue(q) && q.messages > 0).map(queueRow),
    queues_without_consumers: visible.filter((q) => !q.consumers && q.messages > 0 && !isDeadLetterQueue(q)).map(queueRow),
    nodes: nodes.map((n) => ({
      name: n.name,
      running: n.running,
      mem: n.mem_limit ? `${Math.round((n.mem_used / n.mem_limit) * 100)}%` : null,
      disk_free_mb: n.disk_free != null ? Math.round(n.disk_free / 1048576) : null,
      fd: n.fd_total ? `${n.fd_used}/${n.fd_total}` : null,
      uptime_h: n.uptime ? Math.round(n.uptime / 3600000) : null,
    })),
  };
}

async function queues(p) {
  const c = findConn(p.conn);
  const match = p.filter ? nameMatcher(p.filter) : () => true;
  return (await queuesOf(c, vhostOf(c, p)))
    .filter((q) => match(q.name))
    .filter((q) => !p.non_empty || q.messages > 0)
    .filter((q) => !p.no_consumers || !q.consumers)
    .filter((q) => !p.dlq || isDeadLetterQueue(q))
    .map(queueRow);
}

async function queue(p) {
  const c = findConn(p.conn);
  const vhost = vhostOf(c, p);
  const path = apiPath("queues", vhost, p.queue);
  const [q, bindings] = await Promise.all([api(c, "GET", path), api(c, "GET", `${path}/bindings`).catch(() => [])]);
  return {
    ...queueRow(q),
    durable: q.durable,
    auto_delete: q.auto_delete,
    exclusive: q.exclusive,
    arguments: q.arguments,
    policy: q.policy || null,
    memory: q.memory,
    idle_since: q.idle_since || null,
    consumer_details: (q.consumer_details || []).map((x) => ({ tag: x.consumer_tag, prefetch: x.prefetch_count, ack_required: x.ack_required, channel: x.channel_details?.name })),
    bindings: bindings.map((b) => ({ source: b.source || "(default)", routing_key: b.routing_key, arguments: Object.keys(b.arguments || {}).length ? b.arguments : undefined })),
  };
}

async function exchanges(p) {
  const c = findConn(p.conn);
  const match = p.filter ? nameMatcher(p.filter) : () => true;
  const list = await api(c, "GET", apiPath("exchanges", vhostOf(c, p)));
  return list
    .filter((x) => match(x.name || "amq.default"))
    .map((x) => ({ name: x.name || "(default)", type: x.type, durable: x.durable, internal: x.internal, publish_in: x.message_stats?.publish_in_details?.rate ?? null, publish_out: x.message_stats?.publish_out_details?.rate ?? null }));
}

async function bindings(p) {
  const c = findConn(p.conn);
  const f = p.filter ? fold(p.filter) : "";
  const list = await api(c, "GET", apiPath("bindings", vhostOf(c, p)));
  return list
    .map((b) => ({ source: b.source || "(default)", destination: b.destination, type: b.destination_type, routing_key: b.routing_key }))
    .filter((b) => !f || [b.source, b.destination, b.routing_key].some((x) => fold(x).includes(f)));
}

async function connections(p) {
  const c = findConn(p.conn);
  const f = p.filter ? fold(p.filter) : "";
  const list = await api(c, "GET", "/connections");
  return list
    .map((x) => ({ name: x.name, client: x.client_properties?.connection_name || x.user_provided_name || "", user: x.user, vhost: x.vhost, state: x.state, channels: x.channels, recv_rate: x.recv_oct_details?.rate ?? null, send_rate: x.send_oct_details?.rate ?? null, connected_at: x.connected_at ? iso(x.connected_at) : null }))
    .filter((x) => !f || fold(`${x.name} ${x.client} ${x.user}`).includes(f));
}

async function channels(p) {
  const c = findConn(p.conn);
  const f = p.filter ? fold(p.filter) : "";
  const list = await api(c, "GET", "/channels");
  return list
    .map((x) => ({ name: x.name, connection: x.connection_details?.name, user: x.user, vhost: x.vhost, consumers: x.consumer_count, prefetch: x.prefetch_count, unacked: x.messages_unacknowledged, state: x.state }))
    .filter((x) => !f || fold(`${x.name} ${x.connection}`).includes(f));
}

async function consumers(p) {
  const c = findConn(p.conn);
  const f = p.filter ? fold(p.filter) : "";
  const list = await api(c, "GET", apiPath("consumers", vhostOf(c, p)));
  return list
    .map((x) => ({ queue: x.queue?.name, tag: x.consumer_tag, channel: x.channel_details?.name, prefetch: x.prefetch_count, ack_required: x.ack_required, active: x.active }))
    .filter((x) => !f || fold(`${x.queue} ${x.tag}`).includes(f));
}

// ---------- Mensagens ----------

async function getMessages(c, vhost, queueName, count, ackmode) {
  const truncate = host.settings().peek_truncate_kb * 1024;
  const raw = await api(c, "POST", `${apiPath("queues", vhost, queueName)}/get`, { count, ackmode, encoding: "auto", truncate });
  return raw.map((m) => normalizeMessage(m));
}

async function saveToLog(c, vhost, queueName, messages) {
  if (!messages.length) return 0;
  return rabbitApi.saveMessages(messages.map((m) => messageToRecord(m, { connId: c.id, vhost, queue: queueName })), host.settings().max_body_kb);
}

async function peek(p) {
  const c = findConn(p.conn);
  const vhost = vhostOf(c, p);
  const messages = await getMessages(c, vhost, p.queue, Math.max(1, p.count || 10), "ack_requeue_true");
  const saved = p.save ? await saveToLog(c, vhost, p.queue, messages) : 0;
  host.refreshSoon();
  return { queue: p.queue, count: messages.length, saved: saved || undefined, note: "espiar devolve as mensagens à fila marcadas como redelivered", messages: messages.map(messageView) };
}

async function consume(p) {
  const c = findConn(p.conn);
  guard(c, p, "Consumir mensagens");
  const vhost = vhostOf(c, p);
  const messages = await getMessages(c, vhost, p.queue, Math.max(1, p.count || 1), "ack_requeue_false");
  // Não dá para "desconsumir": o que saiu da fila fica guardado no log.
  const saved = await saveToLog(c, vhost, p.queue, messages);
  host.refreshSoon();
  return { queue: p.queue, consumed: messages.length, saved_to_log: saved, messages: messages.map(messageView) };
}

function parseProps(entries) {
  const props = {};
  for (const [k, v] of list(entries).map((e) => splitPair(e))) {
    props[k] = ["priority", "delivery_mode"].includes(k) ? Number(v) : v;
  }
  return props;
}

async function publish(p) {
  const c = findConn(p.conn);
  guard(c, p, "Publicar");
  const vhost = vhostOf(c, p);
  let exchange = p.exchange ?? "";
  let routingKey = p.routing_key ?? "";
  if (p.queue !== undefined) {
    exchange = "";
    routingKey = p.queue;
  }
  const properties = parseProps(p.property);
  const headers = Object.fromEntries(list(p.header).map((h) => splitPair(h, ["=", ":"])));
  if (Object.keys(headers).length) properties.headers = headers;
  if (!properties.content_type && /^\s*[[{]/.test(p.body)) properties.content_type = "application/json";
  const count = Math.max(1, Math.min(100000, p.repeat || 1));
  const path = `${apiPath("exchanges", vhost, exchangeSeg(exchange))}/publish`;
  let routed = 0;
  let unrouted = 0;
  for (let n = 1; n <= count; n++) {
    const now = Date.now();
    const props = { ...properties };
    if (props.message_id) props.message_id = expandTemplate(props.message_id, n, now);
    if (props.correlation_id) props.correlation_id = expandTemplate(props.correlation_id, n, now);
    const r = await api(c, "POST", path, publishBody({ routing_key: expandTemplate(routingKey, n, now), properties: props, payload: expandTemplate(String(p.body), n, now) }));
    if (r?.routed) routed++;
    else unrouted++;
  }
  host.refreshSoon();
  return { exchange: exchange || "(default)", routing_key: routingKey, published: routed + unrouted, routed, unrouted, warning: unrouted ? "mensagens sem rota: nenhuma fila recebeu (confira a routing key/ligações)" : undefined };
}

async function move(p) {
  const c = findConn(p.conn);
  guard(c, p, p.copy ? "Copiar mensagens" : "Mover mensagens");
  const target = p.origin ? "origin" : p.to_exchange !== undefined ? "exchange" : p.to_queue !== undefined ? "queue" : null;
  if (!target) throw new CliError("usage", "Informe --to-queue, --to-exchange ou --origin");
  const spec = {
    vhost: vhostOf(c, p),
    from_queue: p.queue,
    target,
    to_queue: p.to_queue || "",
    exchange: p.to_exchange || "",
    routing_key: p.routing_key || "",
    count: p.count || null,
    copy: !!p.copy,
  };
  const r = await rabbitApi.move(connConfig(c), spec);
  host.refreshSoon();
  return { ...r, action: p.copy ? "copy" : "move", from: p.queue };
}

async function purge(p) {
  const c = findConn(p.conn);
  guard(c, p, "Purgar a fila");
  const vhost = vhostOf(c, p);
  const before = await api(c, "GET", apiPath("queues", vhost, p.queue)).catch(() => null);
  await api(c, "DELETE", `${apiPath("queues", vhost, p.queue)}/contents`);
  host.refreshSoon();
  return { queue: p.queue, purged: before?.messages_ready ?? null };
}

async function deleteQueue(p) {
  const c = findConn(p.conn);
  guard(c, p, "Excluir a fila");
  await api(c, "DELETE", apiPath("queues", vhostOf(c, p), p.queue));
  host.refreshSoon();
  return { queue: p.queue, deleted: true };
}

async function deleteExchange(p) {
  const c = findConn(p.conn);
  guard(c, p, "Excluir a exchange");
  if (!p.exchange || p.exchange.startsWith("amq.")) throw new CliError("usage", "Exchanges padrão (amq.*) não podem ser excluídas");
  await api(c, "DELETE", apiPath("exchanges", vhostOf(c, p), p.exchange));
  host.refreshSoon();
  return { exchange: p.exchange, deleted: true };
}

async function declareQueue(p) {
  const c = findConn(p.conn);
  guard(c, p, "Criar fila");
  const vhost = vhostOf(c, p);
  const args = {};
  for (const [k, v] of list(p.arg).map((a) => splitPair(a))) args[k] = /^-?\d+$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
  if (p.type && p.type !== "classic") args["x-queue-type"] = p.type;
  await api(c, "PUT", apiPath("queues", vhost, p.queue), { durable: true, auto_delete: false, arguments: args });
  for (const b of list(p.bind)) {
    const i = b.indexOf(":");
    const exchange = i < 0 ? b : b.slice(0, i);
    const routing_key = i < 0 ? p.queue : b.slice(i + 1);
    await api(c, "POST", apiPath("bindings", vhost, "e", exchange, "q", p.queue), { routing_key, arguments: {} });
  }
  host.refreshSoon();
  return { queue: p.queue, vhost, arguments: args, bindings: list(p.bind) };
}

async function closeConnection(p) {
  const c = findConn(p.conn);
  guard(c, p, "Fechar a conexão");
  await api(c, "DELETE", apiPath("connections", p.name));
  return { connection: p.name, closed: true };
}

async function watch(p, ctx) {
  const c = findConn(p.conn);
  const vhost = vhostOf(c, p);
  const interval = Math.max(1, p.interval || 5) * 1000;
  const cycles = p.cycles || 0;
  const wanted = list(p.queue);
  let n = 0;
  let last = null;
  while (!ctx.cancelled && (!cycles || n < cycles)) {
    const all = await queuesOf(c, vhost);
    const rows = (wanted.length ? all.filter((q) => wanted.includes(q.name)) : all.filter((q) => !isTransientQueue(q) && (q.messages > 0 || !q.consumers))).map(queueRow);
    const at = new Date().toISOString();
    const total = rows.reduce((s, q) => s + q.messages, 0);
    last = { at, total, queues: rows };
    const line = `${at.slice(11, 19)}  total=${total}  ` + rows.map((q) => `${q.name}=${q.messages}${q.consumers ? "" : "(sem consumidor)"}`).join("  ");
    const alive = await ctx.event({ ...last, line });
    if (alive === false) break;
    n++;
    if (cycles && n >= cycles) break;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, interval);
      ctx.onCancel.push(() => (clearTimeout(t), resolve()));
    });
  }
  return { cycles: n, last };
}

// ---------- Gravações e log ----------

function captureView(x) {
  return { id: x.id, name: x.name, conn: connLabel(host.connections().find((c) => c.id === x.conn_id)), mode: x.mode, source: x.source, vhost: x.vhost, active: !!x.active, count: x.count, started: x.started_at ? iso(x.started_at) : undefined, stopped: x.stopped_at ? iso(x.stopped_at) : undefined };
}

async function captures(p) {
  const c = p.conn ? findConn(p.conn) : null;
  return (await rabbitApi.captures(c?.id ?? null)).map(captureView);
}

async function captureStart(p) {
  const c = findConn(p.conn);
  const mode = p.mode ? fold(p.mode) : "tap";
  if (!["tap", "firehose", "exchange"].includes(mode)) throw new CliError("usage", "--mode deve ser tap, firehose ou exchange");
  if (mode === "firehose") requireFlag(p, "write", "O firehose liga o tracing do vhost (afeta o servidor): exige --write");
  if (mode === "exchange" && !p.exchange) throw new CliError("usage", "O modo exchange exige --exchange");
  if (mode !== "exchange" && mode === "tap" && !list(p.queue).length) throw new CliError("usage", "O modo tap exige --queue");
  const spec = {
    vhost: vhostOf(c, p),
    mode,
    queues: list(p.queue),
    exchange: p.exchange || "",
    routing_key: p.routing_key || "#",
    events: [],
    name: p.name || "",
    max_body_kb: host.settings().max_body_kb,
    max_messages: p.max_messages || host.settings().max_messages,
  };
  const info = await host.startCapture(c, spec);
  return captureView({ ...info, active: true });
}

async function captureStop(p) {
  const ok = await rabbitApi.captureStop(Number(p.id));
  if (!ok) throw new CliError("not_found", `Gravação ativa não encontrada: ${p.id}`);
  return { id: Number(p.id), stopped: true };
}

async function captureDelete(p) {
  requireFlag(p, "yes", "Excluir uma gravação exige --yes");
  const n = await rabbitApi.captureDelete(Number(p.id));
  return { id: Number(p.id), deleted: true, messages: n };
}

async function messages(p) {
  const c = p.conn ? findConn(p.conn) : null;
  const filter = {
    conn_id: c?.id ?? null,
    capture_id: p.capture ?? null,
    text: p.search || "",
    routing_key: p.routing_key || "",
    queue: p.queue || "",
    exchange: p.exchange || "",
    json_path: p.json_path || "",
    json_op: p.json_path ? (p.json_value !== undefined ? "eq" : "exists") : "",
    json_value: p.json_value ?? "",
    from: p.since ? sinceMs(p.since) : null,
    limit: Math.min(1000, p.limit || 50),
  };
  const page = await rabbitApi.query(filter);
  if (p.full) {
    const full = await rabbitApi.messages(page.rows.map((r) => r.id));
    return { total: page.total, messages: full };
  }
  return {
    total: page.total,
    messages: page.rows.map((r) => ({ id: r.id, at: iso(r.at), event: r.event, exchange: r.exchange, routing_key: r.routing_key, queues: r.queues, size: r.size, preview: r.preview, message_id: r.message_id || undefined, correlation_id: r.correlation_id || undefined })),
  };
}

async function message(p) {
  const m = await rabbitApi.message(Number(p.id));
  if (!m) throw new CliError("not_found", `Mensagem não encontrada: ${p.id}`);
  return m;
}

async function rawApi(p) {
  const c = findConn(p.conn);
  const method = String(p.method || "GET").toUpperCase();
  if (method !== "GET") guard(c, p, `${method} na API`);
  let body = null;
  if (p.body !== undefined) {
    try {
      body = JSON.parse(p.body);
    } catch {
      throw new CliError("usage", "--body deve ser JSON");
    }
  }
  const path = String(p.path).replace(/^\/api(?=\/)/, "");
  return api(c, method, path.startsWith("/") ? path : `/${path}`, body);
}

export const rabbitCli = {
  conns,
  conn_add: connAdd,
  conn_remove: connRemove,
  overview,
  queues,
  queue,
  exchanges,
  bindings,
  connections,
  channels,
  consumers,
  peek,
  consume,
  publish,
  move,
  purge,
  delete_queue: deleteQueue,
  delete_exchange: deleteExchange,
  declare_queue: declareQueue,
  close_connection: closeConnection,
  watch,
  captures,
  capture_start: captureStart,
  capture_stop: captureStop,
  capture_delete: captureDelete,
  messages,
  message,
  api: rawApi,
};

// Testes dos utilitários da aba RabbitMQ (sem framework): node tests/rabbit.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const m = await import(base + "rabbitModel.js");

// --- conexões / estado
const c = m.normalizeConnection({ id: "x", amqp_port: "5673", color: "#nope", timeout_s: 0 });
assert.equal(c.mgmt_url, "http://localhost:15672");
assert.equal(c.amqp_port, 5673);
assert.equal(c.color, "");
assert.equal(c.timeout_s, 20);
assert.deepEqual(Object.keys(m.connConfig(c)).sort(), ["amqp_host", "amqp_port", "amqp_tls", "id", "mgmt_url", "timeout_s", "tls_insecure", "user"]);
assert.equal(m.connLabel({ name: "", mgmt_url: "https://mq.local:15671/x" }), "mq.local:15671");
assert.equal(m.connLabel({ name: "Dev", mgmt_url: "" }), "Dev");
const ui = m.normalizeUi({ section: "nope", refresh_s: 7, side_w: 9999 });
assert.equal(ui.section, "overview");
assert.equal(ui.refresh_s, 5);
assert.equal(ui.side_w, 420);
assert.equal(m.normalizeSettings({ max_messages: 5 }).max_messages, 1000);

// --- caminhos
assert.equal(m.apiPath("queues", "/", "pedidos v2"), "/queues/%2F/pedidos%20v2");
assert.equal(m.apiPath("exchanges", "/", m.exchangeSeg("")), "/exchanges/%2F/amq.default");
assert.equal(m.exchangeLabel(""), "(AMQP default)");

// --- formatação
assert.equal(m.fmtBytes(1536), "1,5 KB");
assert.equal(m.fmtRate(0), "0/s");
assert.equal(m.fmtRate(2.25), "2,3/s");
assert.equal(m.fmtRate(1234.4), "1.234/s");
assert.equal(m.fmtDuration(90_000), "1min 30s");
assert.equal(m.fmtDuration(26 * 3600 * 1000), "1d 2h");
assert.equal(m.parseApiDate("2026-10-06 14:03:22") > 0, true);

// --- filtros / ordenação
assert.ok(m.nameMatcher("PED")("fila.pedidos"));
assert.ok(m.nameMatcher("*.dlq")("pedidos.dlq"));
assert.ok(!m.nameMatcher("*.dlq")("pedidos.dlq.x"));
assert.ok(m.nameMatcher("/^ped.*s$/")("pedidos"));
assert.ok(!m.nameMatcher("/[/")("x"));
assert.deepEqual(
  m.sortBy([{ n: 2 }, { n: null }, { n: 10 }], (x) => x.n, "desc").map((x) => x.n),
  [10, 2, null],
);
assert.deepEqual(
  m.sortBy([{ s: "q10" }, { s: "q2" }], (x) => x.s).map((x) => x.s),
  ["q2", "q10"],
);
assert.ok(m.isDeadLetterQueue({ name: "pedidos.dlq" }));
assert.ok(m.isDeadLetterQueue({ name: "pedidos-error" }));
assert.ok(!m.isDeadLetterQueue({ name: "pedidos" }));
assert.ok(m.isTransientQueue({ name: "amq.gen-abc" }));

// --- atributos de fila
const feats = m.queueFeatures({ durable: true, type: "quorum", arguments: { "x-dead-letter-exchange": "dlx", "x-message-ttl": 60000, "x-max-length": 10 }, policy: "p1" });
assert.deepEqual(feats.map((f) => f.k), ["Q", "D", "TTL", "DLX", "Lim", "Pol"]);
assert.match(feats.find((f) => f.k === "DLX").t, /dlx/);
assert.deepEqual(
  m.queueArguments({ type: "quorum", ttl: "1000", max_length: "", dlx: "(default)", dlk: "q.retry", single_active: true, extra: { "x-foo": 1 } }),
  { "x-queue-type": "quorum", "x-message-ttl": 1000, "x-dead-letter-exchange": "", "x-dead-letter-routing-key": "q.retry", "x-single-active-consumer": true, "x-foo": 1 },
);

// --- mensagens
const api = { payload_bytes: 12, redelivered: true, exchange: "ex", routing_key: "a.b", message_count: 3, properties: { content_type: "application/json", headers: { "x-death": [{ count: 2, exchange: "orders", queue: "q", reason: "rejected", "routing-keys": ["order.created"], time: 1700000000 }, { count: 1, exchange: "x" }] } }, payload: '{"a":1}', payload_encoding: "string" };
const msg = m.normalizeMessage(api, { idx: 0 });
assert.equal(msg.size, 12);
assert.equal(msg.idx, 0);
const d = m.deathInfo(msg.properties);
assert.deepEqual([d.exchange, d.routing_key, d.queue, d.reason, d.count, d.time], ["orders", "order.created", "q", "rejected", 3, 1700000000000]);
assert.equal(m.deathInfo({}), null);
assert.match(m.deathReasonLabel("expired"), /TTL/);
assert.deepEqual(m.prettyBody('{"a":1}'), { lang: "json", text: '{\n  "a": 1\n}', json: true });
assert.equal(m.prettyBody("<x/>").lang, "xml");
assert.equal(m.prettyBody("{quebrado").lang, "text");
const bin = { payload: btoa(String.fromCharCode(0xff, 0x00, 0x41)), payload_encoding: "base64" };
assert.equal(m.payloadText(bin).binary, true);
assert.match(m.hexDump(bin.payload), /^000000 {2}ff 00 41 .* \.\.A$/);
assert.deepEqual(m.payloadText({ payload: Buffer.from("olá").toString("base64"), payload_encoding: "base64" }), { text: "olá", binary: false });
const rp = m.republishProps({ ...msg.properties, message_id: "", priority: null, headers: { ...msg.properties.headers, keep: 1, "x-first-death-queue": "q" } }, { dropDeath: true });
assert.deepEqual(rp, { content_type: "application/json", headers: { keep: 1 } });
assert.deepEqual(m.publishBody({ routing_key: "k", properties: { a: "", b: 1 }, payload: "p" }), { routing_key: "k", properties: { b: 1 }, payload: "p", payload_encoding: "string" });
const rec = m.messageToRecord(msg, { connId: "c1", vhost: "/", queue: "q" });
assert.deepEqual([rec.conn_id, rec.event, rec.queues[0], rec.payload_text, rec.size], ["c1", "peek", "q", '{"a":1}', 12]);
const exported = JSON.parse(m.exportMessages([{ ...msg, queues: "q1 q2", at: 0 }]));
assert.deepEqual(exported[0].payload, { a: 1 });
assert.deepEqual(exported[0].queues, ["q1", "q2"]);
assert.deepEqual(m.parseHeadersText(' { "a": 1 } '), { a: 1 });
assert.deepEqual(m.parseHeadersText(""), {});
assert.throws(() => m.parseHeadersText("[1]"), /objeto/);
assert.throws(() => m.parseHeadersText("{x"), /JSON inválido/);

// --- publicação repetida
assert.equal(m.expandTemplate('{"n": {{n}}, "t": "{{ now }}"}', 7, Date.UTC(2026, 9, 6)), '{"n": 7, "t": "2026-10-06T00:00:00.000Z"}');
assert.match(m.expandTemplate("{{uuid}}", 1), /^[0-9a-f-]{36}$/);
assert.equal(m.expandTemplate("sem variáveis", 1), "sem variáveis");
assert.equal(m.expandTemplate("{{outra}}", 1), "{{outra}}");

console.log("rabbit.test.mjs: ok");

// Testes dos utilitários do app Redis (sem framework): node tests/redis.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const m = await import(base + "redisModel.js");

// --- linha de comando (redis-cli)
assert.deepEqual(m.parseCommandLine('SET "a b" \'c d\' e').args, ["SET", "a b", "c d", "e"]);
assert.deepEqual(m.parseCommandLine('SET k "linha\\nnova \\"x\\""').args, ["SET", "k", 'linha\nnova "x"']);
assert.deepEqual(m.parseCommandLine("SET k 'it\\'s'").args, ["SET", "k", "it's"]);
assert.deepEqual(m.parseCommandLine('SET k "\\xff\\x00"').args, ["SET", "k", { b64: "/wA=" }]);
assert.deepEqual(m.parseCommandLine('GET "olá"').args, ["GET", "olá"]);
assert.deepEqual(m.parseCommandLine('SET k ""').args, ["SET", "k", ""]);
assert.ok(m.parseCommandLine('GET "aberto').error);
assert.deepEqual(m.commandLines("GET a\n\n# comentário\n  // outro\nSET b 1\n"), ["GET a", "SET b 1"]);
assert.equal(m.commandText(["SET", "a b", "x", { b64: "/wA=" }]), 'SET "a b" x "\\xff\\x00"');

// --- formatação estilo redis-cli
assert.equal(m.formatResp({ t: "nil" }), "(nil)");
assert.equal(m.formatResp({ t: "int", v: 3 }), "(integer) 3");
assert.equal(m.formatResp({ t: "status", v: "OK" }), "OK");
assert.equal(m.formatResp({ t: "str", v: 'a"b' }), '"a\\"b"');
assert.equal(m.formatResp({ t: "bin", v: "/wA=" }), '"\\xff\\x00"');
assert.equal(m.formatResp({ t: "arr", v: [] }), "(empty array)");
assert.equal(
  m.formatResp({ t: "arr", v: [{ t: "str", v: "a" }, { t: "arr", v: [{ t: "int", v: 1 }, { t: "nil" }] }] }),
  '1) "a"\n2) 1) (integer) 1\n   2) (nil)',
);
assert.equal(m.formatResp({ t: "map", v: [[{ t: "str", v: "k" }, { t: "int", v: 1 }]] }), '1# "k" => (integer) 1');
assert.equal(m.formatResp({ t: "err", v: "WRONGTYPE x" }), "(error) WRONGTYPE x");
assert.deepEqual(m.respToJs({ t: "map", v: [[{ t: "str", v: "a" }, { t: "arr", v: [{ t: "int", v: 1 }] }]] }), { a: [1] });
assert.deepEqual(m.respObject({ t: "arr", v: [{ t: "str", v: "x" }, { t: "int", v: 2 }] }), { x: 2 });

// --- chaves/valores binários
assert.equal(m.bulkLabel({ t: "bin", v: "/wA=" }), "\\xff\\x00");
assert.deepEqual(m.argOf({ t: "bin", v: "/wA=" }), { b64: "/wA=" });
assert.equal(m.argOf({ t: "str", v: "k" }), "k");
assert.deepEqual(m.bulkOf(new Uint8Array([0xff])), { t: "bin", v: "/w==" });
assert.deepEqual(m.bulkOf(new Uint8Array([0x61])), { t: "str", v: "a" });
assert.equal(m.detectFormat({ t: "str", v: '{"a":1}' }).kind, "json");
assert.equal(m.detectFormat({ t: "str", v: "texto" }).kind, "text");
assert.equal(m.detectFormat({ t: "bin", v: "/wA=" }).kind, "binary");
assert.match(m.hexDumpBytes(new Uint8Array([0x41, 0x00])), /^00000000  41 00 +A\.$/);

// --- comandos perigosos
assert.equal(m.classifyCommand(["flushall"]).level, "danger");
assert.equal(m.classifyCommand(["CONFIG", "set", "x", "y"]).level, "danger");
assert.equal(m.classifyCommand(["CONFIG", "GET", "*"]).level, null);
assert.equal(m.classifyCommand(["KEYS", "*"]).level, "warn");
assert.equal(m.classifyCommand(["GET", "k"]).level, null);

// --- INFO / CLIENT LIST / SLOWLOG / MONITOR
const info = m.parseInfo("# Server\r\nredis_version:7.2.4\r\n\r\n# Keyspace\r\ndb0:keys=10,expires=2,avg_ttl=0\r\ndb3:keys=1,expires=0,avg_ttl=0\r\n");
assert.equal(info.server.redis_version, "7.2.4");
assert.deepEqual(m.keyspace(info), { 0: { keys: 10, expires: 2, avg_ttl: 0 }, 3: { keys: 1, expires: 0, avg_ttl: 0 } });
const clients = m.parseClientList("id=3 addr=127.0.0.1:5000 name= age=10 db=0 cmd=client|list\nid=4 addr=x:1 name=api age=2 db=1 cmd=get\n");
assert.equal(clients.length, 2);
assert.equal(clients[1].name, "api");
assert.equal(clients[0].id, 3);
const slow = m.parseSlowlog({ t: "arr", v: [{ t: "arr", v: [{ t: "int", v: 7 }, { t: "int", v: 1700000000 }, { t: "int", v: 15000 }, { t: "arr", v: [{ t: "str", v: "KEYS" }, { t: "str", v: "*" }] }, { t: "str", v: "1.2.3.4:5" }, { t: "str", v: "app" }] }] });
assert.deepEqual(slow[0], { id: 7, at: 1700000000000, us: 15000, args: ["KEYS", "*"], client: "1.2.3.4:5", name: "app" });
const mon = m.parseMonitorLine('1700000000.123456 [2 127.0.0.1:5000] "SET" "a b" "x\\"y"');
assert.equal(mon.db, 2);
assert.equal(mon.at, 1700000000123);
assert.deepEqual(mon.args, ["SET", "a b", 'x\\"y']);

// --- árvore de chaves
const keys = ["user:1:name", "user:1:age", "user:2:name", "config", "user:10:name"].map((v) => ({ k: { t: "str", v }, type: "string" }));
let rows = m.keyTreeRows(keys, ":", new Set());
assert.deepEqual(rows.map((r) => [r.kind, r.label, r.count ?? null]), [["folder", "user", 4], ["key", "config", null]]);
rows = m.keyTreeRows(keys, ":", new Set(["user:", "user:1:"]));
assert.deepEqual(rows.map((r) => `${r.depth}${r.kind[0]}${r.label}`), ["0fuser", "1f1", "2kage", "2kname", "1f2", "1f10", "0kconfig"]);
assert.equal(m.keyTreeRows(keys, ":", new Set(), { flat: true }).length, 5);

// --- conexões / URL
const p = m.parseRedisUrl("rediss://app:s%40nha@cache.example.com:6380/2");
assert.deepEqual(p, { patch: { mode: "standalone", tls: true, host: "cache.example.com", port: 6380, username: "app", db: 2 }, password: "s@nha" });
assert.deepEqual(m.parseRedisUrl("localhost:7000").patch, { mode: "standalone", host: "localhost", port: 7000 });
const cli = m.parseRedisUrl("redis-cli -h 10.0.0.1 -p 6390 -a 'x y' --tls -n 1");
assert.deepEqual(cli, { patch: { mode: "standalone", host: "10.0.0.1", port: 6390, tls: true, db: 1 }, password: "x y" });
const conn = m.newConnection({ host: "h", port: 6380, username: "u", tls: true });
assert.equal(m.buildRedisUrl(conn, "p w"), "rediss://u:p%20w@h:6380");
assert.equal(m.buildRedisUrl(conn), "rediss://u@h:6380");
assert.deepEqual(Object.keys(m.connConfig(conn)).sort(), ["ca_path", "host", "id", "master_name", "mode", "nodes", "port", "read_only", "sentinel_username", "ssh", "timeout_s", "tls", "tls_insecure", "username"].sort());
const data = m.normalizeRedisData({ connections: [conn], ui: { tabs: [{ id: "t", type: "key", conn_id: conn.id, key: { t: "str", v: "a" } }, { id: "x", type: "key", conn_id: "outra" }] }, history: { [conn.id]: ["GET a"], outra: ["x"] } });
assert.equal(data.ui.tabs.length, 1);
assert.deepEqual(Object.keys(data.history), [conn.id]);
m.addHistory(data, conn.id, "GET a");
assert.equal(data.history[conn.id].length, 1);

// --- TTL
assert.equal(m.fmtTtl(-1), "sem expiração");
assert.equal(m.fmtTtl(90_000), "1min 30s");
assert.equal(m.fmtTtl(90_061_000), "1d 1h 1min");
assert.equal(m.parseTtl("1h30m"), 5400);
assert.equal(m.parseTtl("120"), 120);
assert.equal(m.parseTtl("abc"), null);
assert.equal(m.streamIdTime("1700000000000-3"), 1700000000000);

console.log("redis: ok");

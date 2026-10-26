// CLI: `devsuite redis ...` (ver src-tauri/cli/commands.json). Conexões do redis.json vivo
// (sem senhas: o Rust lê do cofre), comandos pela mesma ponte da interface (`redis_exec`/
// `redis_pipeline`/`redis_scan`, sessão própria `cli`). Leitura é livre; comandos com a flag
// `write` do COMMAND INFO exigem --write; excluir exige --yes; "ambiente sensível", --confirm.

import { redisApi } from "../api.js";
import { redisHost as host } from "../components/redis.js";
import {
  newConnection,
  connConfig,
  connLabel,
  parseRedisUrl,
  parseCommandLine,
  commandLines,
  commandText,
  classifyCommand,
  respToJs,
  respText,
  respInt,
  respPairs,
  bulkLabel,
  parseInfo,
  keyspace,
  parseClientList,
  parseSlowlog,
  parseMonitorLine,
  typeInfo,
  fmtTtl,
} from "../utils/redisModel.js";
import { CliError, pick, list, requireFlag, fold, iso } from "./cliUtils.js";

const SESSION = { session: "cli" };

function findConn(wanted) {
  return pick(host.connections(), wanted, { what: "conexão", name: connLabel });
}

const dbOf = (c, p) => (p.db !== undefined && p.db !== null && p.db !== "" ? Number(p.db) : c.db);

async function connected(c) {
  try {
    return await host.ensureConnected(c);
  } catch (e) {
    throw new CliError("failed", `${connLabel(c)}: ${e}`);
  }
}

const run = async (c, db, args, opts = {}) => {
  const r = await host.exec(c, db, args, { ...SESSION, ...opts });
  return r;
};

const check = (r) => {
  if (r?.t === "err") throw new CliError("failed", r.v);
  return r;
};

/** Ambiente sensível: --confirm com o nome da conexão. */
function confirmProtected(c, p, what) {
  if (c.protected && fold(p.confirm) !== fold(connLabel(c))) {
    throw new CliError("needs_confirm", `${connLabel(c)} é um ambiente sensível: ${what} exige --confirm "${connLabel(c)}"`);
  }
}

const writeFlags = new Map(); // `${connId}:${cmd}` -> bool
const CONTAINERS = new Set(["CONFIG", "CLIENT", "SLOWLOG", "LATENCY", "DEBUG", "CLUSTER", "ACL", "FUNCTION", "SCRIPT", "MODULE", "MEMORY", "OBJECT", "XINFO", "XGROUP", "COMMAND", "PUBSUB"]);

/** O comando altera dados/servidor? (flag `write` do COMMAND INFO, com cache; perigosos sempre contam). */
async function isWrite(c, args) {
  if (classifyCommand(args).level === "danger") return true;
  const name = String(typeof args[0] === "string" ? args[0] : "").toLowerCase();
  const sub = CONTAINERS.has(name.toUpperCase()) && typeof args[1] === "string" ? `${name}|${args[1].toLowerCase()}` : null;
  const key = `${c.id}:${sub || name}`;
  if (writeFlags.has(key)) return writeFlags.get(key);
  let write = false;
  try {
    const r = await run(c, 0, ["COMMAND", "INFO", sub || name]);
    const info = r.v?.[0];
    const flags = info?.t === "arr" ? (info.v[2]?.v || []).map(respText) : [];
    write = flags.some((f) => f.toLowerCase() === "write");
  } catch {
    write = true;
  }
  writeFlags.set(key, write);
  return write;
}

// ---------- Conexões ----------

async function conns() {
  return Promise.all(
    host.connections().map(async (c) => ({
      id: c.id,
      name: connLabel(c),
      mode: c.mode,
      address: c.mode === "sentinel" ? `${c.master_name} @ ${c.nodes.join(", ")}` : c.mode === "cluster" && c.nodes.length ? c.nodes.join(", ") : `${c.host}:${c.port}`,
      db: c.db,
      tls: c.tls,
      ssh: c.ssh ? `${c.ssh.user}@${c.ssh.host}:${c.ssh.port}` : null,
      read_only: c.read_only,
      protected: c.protected,
      secrets: await redisApi.hasSecrets(c.id),
      connected: host.status(c.id).state === "connected",
    })),
  );
}

async function connAdd(p) {
  if (host.connections().some((c) => fold(connLabel(c)) === fold(p.name))) throw new CliError("failed", `Já existe a conexão ${p.name}`);
  const c = newConnection({ name: String(p.name).trim() });
  let password;
  if (p.url) {
    const parsed = parseRedisUrl(p.url);
    if (!parsed) throw new CliError("usage", `URL não reconhecida: ${p.url}`);
    Object.assign(c, parsed.patch);
    password = parsed.password;
  }
  if (p.host) c.host = String(p.host);
  if (p.port) c.port = Number(p.port);
  if (p.mode) {
    if (!["standalone", "cluster", "sentinel"].includes(p.mode)) throw new CliError("usage", "--mode: standalone, cluster ou sentinel");
    c.mode = p.mode;
  }
  if (list(p.node).length) c.nodes = list(p.node).map(String);
  if (p.master) c.master_name = String(p.master);
  if (p.user) c.username = String(p.user);
  if (p.tls) c.tls = true;
  if (p.read_only) c.read_only = true;
  if (p.protected) c.protected = true;
  if (p.password !== undefined) password = String(p.password).replace(/\r?\n$/, "");
  const secrets = password !== undefined ? { password } : {};
  if (p.test) {
    try {
      await redisApi.test(connConfig(c), secrets);
    } catch (e) {
      throw new CliError("failed", `Teste falhou: ${e}`);
    }
  }
  await host.addConnection(c, secrets);
  return { id: c.id, name: connLabel(c), saved: true };
}

async function connRemove(p) {
  requireFlag(p, "yes", "Remover uma conexão exige --yes");
  const c = findConn(p.conn);
  await host.removeConnection(c);
  return { id: c.id, name: connLabel(c), removed: true };
}

// ---------- Leitura ----------

async function info(p) {
  const c = findConn(p.conn);
  const server = await connected(c);
  const r = check(await run(c, 0, ["INFO", p.section || "everything"], { node: p.node || null }));
  const text = r.t === "map" ? respText(r.v[0]?.[1]) : respText(r);
  const parsed = parseInfo(text);
  if (p.section) return { conn: connLabel(c), section: p.section, info: parsed };
  const m = parsed.memory || {};
  const st = parsed.stats || {};
  const hits = Number(st.keyspace_hits) || 0;
  const misses = Number(st.keyspace_misses) || 0;
  return {
    conn: connLabel(c),
    version: server.version,
    mode: server.mode,
    role: server.role,
    address: server.address || undefined,
    modules: server.modules,
    uptime_s: Number(parsed.server?.uptime_in_seconds) || 0,
    memory: { used: m.used_memory_human, peak: m.used_memory_peak_human, max: m.maxmemory_human, policy: m.maxmemory_policy, fragmentation: Number(m.mem_fragmentation_ratio) || null },
    clients: { connected: Number(parsed.clients?.connected_clients) || 0, blocked: Number(parsed.clients?.blocked_clients) || 0 },
    ops_per_sec: Number(st.instantaneous_ops_per_sec) || 0,
    hit_rate: hits + misses ? Math.round((hits / (hits + misses)) * 1000) / 10 : null,
    evicted_keys: Number(st.evicted_keys) || 0,
    expired_keys: Number(st.expired_keys) || 0,
    keyspace: keyspace(parsed),
    persistence: { rdb_last_bgsave: parsed.persistence?.rdb_last_bgsave_status, aof: parsed.persistence?.aof_enabled === "1" },
  };
}

async function keys(p) {
  const c = findConn(p.conn);
  await connected(c);
  const db = dbOf(c, p);
  const limit = Math.max(1, p.limit || 1000);
  const out = [];
  let cursor = "";
  do {
    const page = await host.scan(c, db, { cursor, pattern: p.pattern || "", type: p.type || "", count: 1000, limit: Math.min(1000, limit - out.length) });
    out.push(...page.keys);
    cursor = page.cursor || "";
  } while (cursor && out.length < limit);
  return {
    conn: connLabel(c),
    db,
    pattern: p.pattern || "*",
    count: out.length,
    complete: !cursor,
    keys: out.slice(0, limit).map((e) => ({ key: bulkLabel(e.k), type: typeInfo(e.type).label.toLowerCase(), binary: e.k.t === "bin" || undefined })),
  };
}

/** Valor tipado de uma chave (coleções até --limit itens). */
async function get(p) {
  const c = findConn(p.conn);
  await connected(c);
  const db = dbOf(c, p);
  const k = String(p.key);
  const n = Math.max(1, p.limit || 100);
  const [type, pttl, mem] = await host.pipeline(c, db, [["TYPE", k], ["PTTL", k], ["MEMORY", "USAGE", k]], SESSION);
  const t = respText(type);
  if (t === "none") throw new CliError("not_found", `Chave não encontrada: ${k}`);
  const base = { conn: connLabel(c), db, key: k, type: t, ttl_ms: respInt(pttl), ttl: fmtTtl(respInt(pttl)), memory_bytes: mem?.t === "int" ? mem.v : null };
  const js = (r) => respToJs(check(r));
  if (t === "string") {
    const len = respInt(await run(c, db, ["STRLEN", k]));
    const r = check(await run(c, db, len > 1_000_000 && !p.all ? ["GETRANGE", k, "0", "999999"] : ["GET", k]));
    let value = respToJs(r);
    if (p.parse) {
      try {
        value = JSON.parse(value);
      } catch {
        /* não é JSON */
      }
    }
    return { ...base, size: len, truncated: len > 1_000_000 && !p.all, value };
  }
  if (t === "hash") {
    const size = respInt(await run(c, db, ["HLEN", k]));
    const fields = {};
    let cursor = "0";
    do {
      const r = check(await run(c, db, ["HSCAN", k, cursor, "COUNT", "500", ...(p.match ? ["MATCH", p.match] : [])]));
      cursor = respText(r.v[0]);
      const items = r.v[1].v;
      for (let i = 0; i + 1 < items.length && Object.keys(fields).length < n; i += 2) fields[bulkLabel(items[i])] = bulkLabel(items[i + 1]);
    } while (cursor !== "0" && Object.keys(fields).length < n);
    return { ...base, size, truncated: Object.keys(fields).length < size && !p.match, value: fields };
  }
  if (t === "list") return { ...base, size: respInt(await run(c, db, ["LLEN", k])), value: js(await run(c, db, ["LRANGE", k, String(p.start || 0), String((p.start || 0) + n - 1)])) };
  if (t === "set") {
    const r = check(await run(c, db, ["SSCAN", k, "0", "COUNT", String(n), ...(p.match ? ["MATCH", p.match] : [])]));
    return { ...base, size: respInt(await run(c, db, ["SCARD", k])), value: r.v[1].v.map(bulkLabel).slice(0, n) };
  }
  if (t === "zset") {
    const r = check(await run(c, db, ["ZRANGE", k, "0", String(n - 1), ...(p.rev ? ["REV"] : []), "WITHSCORES"]));
    const items = r.v;
    const pairs = items.length && items[0]?.t === "arr" ? items.map((x) => [x.v[0], x.v[1]]) : respPairs(r);
    return { ...base, size: respInt(await run(c, db, ["ZCARD", k])), value: pairs.map(([m, s]) => ({ member: bulkLabel(m), score: Number(respText(s)) })) };
  }
  if (t === "stream") {
    const r = check(await run(c, db, ["XREVRANGE", k, "+", "-", "COUNT", String(n)]));
    const groups = await run(c, db, ["XINFO", "GROUPS", k]);
    return {
      ...base,
      size: respInt(await run(c, db, ["XLEN", k])),
      value: r.v.map((e) => ({ id: respText(e.v[0]), ...Object.fromEntries(respPairs(e.v[1]).map(([f, v]) => [bulkLabel(f), bulkLabel(v)])) })),
      groups: groups.t === "err" ? [] : groups.v.map((g) => Object.fromEntries(respPairs(g).map(([a, b]) => [respText(a), respToJs(b)]))),
    };
  }
  if (t === "ReJSON-RL") return { ...base, value: JSON.parse(respText(check(await run(c, db, ["JSON.GET", k])))) };
  return { ...base, value: null, note: `Tipo ${t} (módulo): use devsuite redis exec` };
}

async function ttl(p) {
  const c = findConn(p.conn);
  await connected(c);
  const db = dbOf(c, p);
  const k = String(p.key);
  if (p.set !== undefined || p.persist) {
    requireFlag(p, "write", "Alterar o TTL exige --write");
    if (c.read_only) throw new CliError("read_only", `A conexão ${connLabel(c)} é somente leitura`);
    const seconds = p.persist ? 0 : host.parseTtl(String(p.set));
    if (seconds === null) throw new CliError("usage", `TTL inválido: ${p.set} (ex.: 3600, 30min, 1h30m, 7d)`);
    const r = check(await run(c, db, seconds ? ["EXPIRE", k, String(seconds)] : ["PERSIST", k]));
    if (!respInt(r) && seconds) throw new CliError("not_found", `Chave não encontrada: ${k}`);
  }
  const ms = respInt(check(await run(c, db, ["PTTL", k])));
  if (ms === -2) throw new CliError("not_found", `Chave não encontrada: ${k}`);
  return { conn: connLabel(c), db, key: k, ttl_ms: ms, ttl: fmtTtl(ms) };
}

// ---------- Escrita ----------

async function set(p) {
  requireFlag(p, "write", "Gravar exige --write");
  const c = findConn(p.conn);
  await connected(c);
  if (c.read_only) throw new CliError("read_only", `A conexão ${connLabel(c)} é somente leitura`);
  const db = dbOf(c, p);
  const args = ["SET", String(p.key), String(p.value)];
  if (p.ttl) {
    const s = host.parseTtl(String(p.ttl));
    if (s === null) throw new CliError("usage", `TTL inválido: ${p.ttl}`);
    args.push("EX", String(s));
  } else if (!p.reset_ttl) args.push("KEEPTTL");
  if (p.nx) args.push("NX");
  const r = check(await run(c, db, args));
  host.keyChanged(c, db, { t: "str", v: String(p.key) }, { created: true, type: "string" });
  return { conn: connLabel(c), db, key: p.key, ok: r.t !== "nil", result: respToJs(r) };
}

async function del(p) {
  requireFlag(p, "write", "Excluir exige --write");
  requireFlag(p, "yes", "Excluir exige --yes");
  const c = findConn(p.conn);
  await connected(c);
  confirmProtected(c, p, "excluir");
  if (c.read_only) throw new CliError("read_only", `A conexão ${connLabel(c)} é somente leitura`);
  const db = dbOf(c, p);
  let targets = list(p.key).map(String);
  if (p.pattern) {
    const found = await keys({ conn: c.id, db, pattern: p.pattern, limit: p.limit || 100000 });
    targets = targets.concat(found.keys.filter((x) => !x.binary).map((x) => x.key));
  }
  if (!targets.length) return { conn: connLabel(c), db, deleted: 0 };
  let deleted = 0;
  const cluster = host.status(c.id).info?.mode === "cluster";
  for (let i = 0; i < targets.length; i += 500) {
    const batch = targets.slice(i, i + 500);
    const res = cluster ? await host.pipeline(c, db, batch.map((k) => ["UNLINK", k]), SESSION) : [await run(c, db, ["UNLINK", ...batch])];
    for (const r of res) deleted += r.t === "int" ? r.v : 0;
  }
  for (const k of targets) host.keyChanged(c, db, { t: "str", v: k }, { deleted: true });
  return { conn: connLabel(c), db, requested: targets.length, deleted };
}

/** Comandos crus (redis-cli; várias linhas = vários comandos). Escrita exige --write. */
async function exec(p) {
  const c = findConn(p.conn);
  await connected(c);
  let db = dbOf(c, p);
  const lines = commandLines(p.command);
  if (!lines.length) throw new CliError("usage", "Nada para executar");
  const parsed = lines.map((line) => {
    const { args, error } = parseCommandLine(line);
    if (error) throw new CliError("usage", `${error}: ${line}`);
    return { line, args };
  });
  for (const { args } of parsed) {
    if (/^(use|select)$/i.test(String(args[0]))) continue;
    if (await isWrite(c, args)) {
      if (c.read_only) throw new CliError("read_only", `A conexão ${connLabel(c)} é somente leitura; comando recusado: ${commandText(args).slice(0, 120)}`);
      requireFlag(p, "write", `Comando de escrita exige --write: ${commandText(args).slice(0, 120)}`);
      if (classifyCommand(args).level === "danger") confirmProtected(c, p, String(args[0]).toUpperCase());
    }
  }
  const results = [];
  for (const { line, args } of parsed) {
    if (/^(use|select)$/i.test(String(args[0])) && args.length === 2) {
      db = Number(args[1]);
      results.push({ command: line, result: `db${db}` });
      continue;
    }
    const t0 = Date.now();
    const r = await run(c, db, args, { node: p.node || null });
    results.push({ command: line, db, ms: Date.now() - t0, error: r.t === "err" ? r.v : undefined, result: r.t === "err" ? undefined : p.raw ? respText(r) : respToJs(r) });
  }
  return { conn: connLabel(c), results };
}

async function publish(p) {
  requireFlag(p, "write", "Publicar exige --write");
  const c = findConn(p.conn);
  await connected(c);
  const r = check(await run(c, 0, ["PUBLISH", String(p.channel), String(p.message)]));
  return { conn: connLabel(c), channel: p.channel, receivers: respInt(r) };
}

// ---------- Depuração ----------

async function slowlog(p) {
  const c = findConn(p.conn);
  await connected(c);
  const r = check(await run(c, 0, ["SLOWLOG", "GET", String(p.count || 50)], { node: p.node || null }));
  return parseSlowlog(r).map((e) => ({ id: e.id, at: iso(e.at), ms: e.us / 1000, command: e.args.join(" ").slice(0, 500), client: e.client, name: e.name || undefined }));
}

async function clients(p) {
  const c = findConn(p.conn);
  await connected(c);
  const r = check(await run(c, 0, ["CLIENT", "LIST"], { node: p.node || null }));
  return parseClientList(respText(r)).map((x) => ({ id: x.id, addr: x.addr, name: x.name || undefined, lib: x["lib-name"] ? `${x["lib-name"]} ${x["lib-ver"] || ""}`.trim() : undefined, db: x.db, age_s: x.age, idle_s: x.idle, cmd: x.cmd, flags: x.flags }));
}

/** Análise de memória (SCAN + MEMORY USAGE); progresso como eventos, resultado final no fim. */
async function memory(p, ctx) {
  const c = findConn(p.conn);
  await connected(c);
  const spec = { db: dbOf(c, p), pattern: p.pattern || "", separator: p.separator ?? c.separator, depth: p.depth || 3, limit: p.limit || 0, count: 500, pause_ms: p.pause || 0, top: p.top || 30 };
  let id = null;
  const final = await new Promise((resolve, reject) => {
    host
      .analyzeStart(c, spec, (s) => {
        if (s.done) return resolve(s);
        ctx.event({ line: `${s.scanned} chave(s) · ${Math.round(s.total.bytes / 1024)} KB`, scanned: s.scanned, bytes: s.total.bytes });
      })
      .then((x) => {
        id = x;
        ctx.onCancel.push(() => host.liveStop(id));
      })
      .catch(reject);
  });
  return {
    conn: connLabel(c),
    db: spec.db,
    scanned: final.scanned,
    total_bytes: final.total.bytes,
    error: final.error || undefined,
    memory_unavailable: final.memory_unavailable || undefined,
    by_type: final.by_type,
    ttl: final.ttl,
    prefixes: final.prefixes.slice(0, p.prefixes || 30),
    top: final.top.map((t) => ({ key: bulkLabel(t.key), type: t.type, bytes: t.bytes, ttl: fmtTtl(t.ttl) })),
  };
}

/** MONITOR / SUBSCRIBE por --seconds (ou até Ctrl+C): uma linha por comando/mensagem. */
async function live(c, spec, p, ctx, toLines) {
  const seconds = p.seconds === undefined ? 10 : Number(p.seconds);
  let count = 0;
  let id = null;
  await new Promise((resolve, reject) => {
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      if (id !== null) host.liveStop(id);
      else resolve();
    };
    host
      .liveStart(c, spec, async (ev) => {
        if (ev.type === "stopped") {
          clearTimeout(timer);
          return ev.error && !ctx.cancelled ? reject(new CliError("failed", ev.error)) : resolve();
        }
        for (const item of toLines(ev)) {
          count++;
          if ((await ctx.event(item)) === false) stop();
        }
      })
      .then((x) => {
        id = x;
        ctx.onCancel.push(stop);
        if (seconds > 0) timer = setTimeout(stop, seconds * 1000);
      })
      .catch(reject);
  });
  return { conn: connLabel(c), events: count };
}

async function monitor(p, ctx) {
  const c = findConn(p.conn);
  await connected(c);
  const filter = p.filter ? String(p.filter).toLowerCase() : "";
  return live(c, { kind: "monitor", node: p.node || "", db: 0 }, p, ctx, (ev) =>
    (ev.lines || [])
      .filter((l) => !filter || l.toLowerCase().includes(filter))
      .map((l) => {
        const m = parseMonitorLine(l);
        return { at: iso(m.at), db: m.db, client: m.client, args: m.args, line: l };
      }),
  );
}

async function subscribe(p, ctx) {
  const c = findConn(p.conn);
  await connected(c);
  const channels = list(p.channel).map(String);
  const patterns = list(p.pattern).map(String);
  if (!channels.length && !patterns.length) throw new CliError("usage", "Informe --channel e/ou --pattern");
  return live(c, { kind: "subscribe", channels, patterns, node: "", db: 0 }, p, ctx, (ev) =>
    (ev.items || []).map((m) => ({ at: iso(m.at), channel: m.channel, pattern: m.pattern || undefined, message: bulkLabel(m.payload), line: `${m.channel}: ${bulkLabel(m.payload)}` })),
  );
}

async function nodes(p) {
  const c = findConn(p.conn);
  await connected(c);
  return host.nodes(c);
}

export const redisCli = {
  conns,
  conn_add: connAdd,
  conn_remove: connRemove,
  info,
  keys,
  get,
  ttl,
  set,
  del,
  exec,
  publish,
  slowlog,
  clients,
  memory,
  monitor,
  subscribe,
  nodes,
};


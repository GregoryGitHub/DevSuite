// Redis: modelo do redis.json (conexões sem segredos, interface, histórico do console) e
// utilitários puros (sem DOM): valores RESP ↔ texto, linha de comando estilo redis-cli,
// árvore de chaves, INFO/CLIENT LIST/SLOWLOG/MONITOR e comandos perigosos.
//
// Valores vindos do Rust: { t, v } com t = nil | int | str | bin (Base64) | status | err |
// arr | map ([[k, v]]) | set | dbl | bool | big | push. Chaves/valores binários vão de volta
// como { b64 }; os demais, como texto.

export const REDIS_VERSION = 1;
const HISTORY_LIMIT = 300;

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export const CONN_COLORS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7", "#ec4899"];
export const MODES = [
  ["standalone", "Standalone"],
  ["cluster", "Cluster"],
  ["sentinel", "Sentinel"],
];
export const REFRESH_OPTIONS = [0, 2, 5, 10, 30, 60];

/** Ferramentas de cada conexão (barra lateral). */
export const TOOLS = [
  { id: "overview", label: "Visão geral", icon: "fa-solid fa-gauge-high" },
  { id: "console", label: "Console", icon: "fa-solid fa-terminal" },
  { id: "monitor", label: "Monitor", icon: "fa-solid fa-wave-square" },
  { id: "pubsub", label: "Pub/Sub", icon: "fa-solid fa-tower-broadcast" },
  { id: "slowlog", label: "Slowlog e latência", icon: "fa-solid fa-hourglass-half" },
  { id: "clients", label: "Clientes", icon: "fa-solid fa-plug" },
  { id: "memory", label: "Análise de memória", icon: "fa-solid fa-chart-pie" },
  { id: "config", label: "Configuração", icon: "fa-solid fa-sliders" },
  { id: "cluster", label: "Nós do Cluster", icon: "fa-solid fa-circle-nodes", cluster: true },
];

export const TYPES = {
  string: { label: "STRING", short: "STR", color: "#3b82f6", size: "STRLEN" },
  hash: { label: "HASH", short: "HASH", color: "#a855f7", size: "HLEN" },
  list: { label: "LIST", short: "LIST", color: "#22c55e", size: "LLEN" },
  set: { label: "SET", short: "SET", color: "#f97316", size: "SCARD" },
  zset: { label: "ZSET", short: "ZSET", color: "#ec4899", size: "ZCARD" },
  stream: { label: "STREAM", short: "STRM", color: "#06b6d4", size: "XLEN" },
  "ReJSON-RL": { label: "JSON", short: "JSON", color: "#eab308", size: null },
  "TSDB-TYPE": { label: "TIMESERIES", short: "TS", color: "#14b8a6", size: null },
  "MBbloom--": { label: "BLOOM", short: "BF", color: "#64748b", size: null },
};
export const typeInfo = (t) => TYPES[t] || { label: String(t || "?").toUpperCase(), short: String(t || "?").slice(0, 4).toUpperCase(), color: "#94a3b8", size: null };

// ---------- redis.json ----------

export function newConnection(patch = {}) {
  return normalizeConnection({ id: uid(), ...patch });
}

function normalizeSsh(s) {
  if (!s || typeof s !== "object" || !String(s.host || "").trim()) return null;
  return {
    host: String(s.host || ""),
    port: Number(s.port) > 0 ? Number(s.port) : 22,
    user: String(s.user || ""),
    auth: s.auth === "key" ? "key" : "password",
    key_path: String(s.key_path || ""),
  };
}

export function normalizeConnection(c = {}) {
  return {
    id: c.id || uid(),
    name: String(c.name || ""),
    color: CONN_COLORS.includes(c.color) ? c.color : "",
    mode: ["standalone", "cluster", "sentinel"].includes(c.mode) ? c.mode : "standalone",
    host: String(c.host ?? "localhost"),
    port: Number(c.port) > 0 ? Number(c.port) : 6379,
    /** Cluster: nós iniciais; Sentinel: sentinels ("host:porta"). */
    nodes: Array.isArray(c.nodes) ? c.nodes.map(String).filter((n) => n.trim()) : [],
    master_name: String(c.master_name || ""),
    username: String(c.username || ""),
    sentinel_username: String(c.sentinel_username || ""),
    tls: !!c.tls,
    tls_insecure: !!c.tls_insecure,
    ca_path: String(c.ca_path || ""),
    timeout_s: Number(c.timeout_s) > 0 ? Number(c.timeout_s) : 10,
    read_only: !!c.read_only,
    /** Ambiente sensível: FLUSH*, excluir por padrão, CLIENT KILL… exigem digitar o nome. */
    protected: !!c.protected,
    db: Number.isInteger(c.db) && c.db >= 0 ? c.db : 0,
    /** Separador da árvore de chaves. */
    separator: typeof c.separator === "string" ? c.separator : ":",
    ssh: normalizeSsh(c.ssh),
  };
}

/** Só o que o Rust usa (RedisConn). */
export function connConfig(c) {
  const { id, mode, host, port, nodes, master_name, username, sentinel_username, tls, tls_insecure, ca_path, timeout_s, read_only, ssh } = c;
  return { id, mode, host: host.trim(), port, nodes, master_name: master_name.trim(), username, sentinel_username, tls, tls_insecure, ca_path, timeout_s, read_only, ssh };
}

export function connLabel(c) {
  if (!c) return "?";
  if (c.name.trim()) return c.name.trim();
  if (c.mode === "sentinel") return c.master_name || "sentinel";
  if (c.mode === "cluster" && !c.host && c.nodes[0]) return c.nodes[0];
  return `${c.host || "localhost"}:${c.port}`;
}

function normalizeTab(t) {
  if (!t || !t.id || !t.conn_id) return null;
  if (!["key", "console", ...TOOLS.map((x) => x.id)].includes(t.type)) return null;
  return {
    id: String(t.id),
    type: t.type,
    conn_id: String(t.conn_id),
    db: Number.isInteger(t.db) ? t.db : 0,
    /** Aba de chave: { t: "str" | "bin", v } */
    key: t.key && (t.key.t === "str" || t.key.t === "bin") ? { t: t.key.t, v: String(t.key.v) } : null,
  };
}

export function normalizeRedisData(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const ui = d.ui && typeof d.ui === "object" ? d.ui : {};
  const connections = (Array.isArray(d.connections) ? d.connections : []).map(normalizeConnection);
  const ids = new Set(connections.map((c) => c.id));
  const tabs = (Array.isArray(ui.tabs) ? ui.tabs : []).map(normalizeTab).filter((t) => t && ids.has(t.conn_id));
  const history = {};
  for (const [k, list] of Object.entries(d.history && typeof d.history === "object" ? d.history : {})) {
    if (ids.has(k) && Array.isArray(list)) history[k] = list.map(String).slice(-HISTORY_LIMIT);
  }
  return {
    version: REDIS_VERSION,
    connections,
    history,
    ui: {
      conn_id: ids.has(ui.conn_id) ? ui.conn_id : connections[0]?.id || null,
      /** conn_id → banco escolhido na árvore. */
      dbs: ui.dbs && typeof ui.dbs === "object" ? { ...ui.dbs } : {},
      tabs,
      active_tab: tabs.some((t) => t.id === ui.active_tab) ? ui.active_tab : tabs[0]?.id || null,
      side_w: clamp(Number(ui.side_w) || 300, 200, 640),
      side_open: ui.side_open !== false,
      refresh_s: REFRESH_OPTIONS.includes(ui.refresh_s) ? ui.refresh_s : 5,
      view: ui.view === "list" ? "list" : "tree",
      scan_count: [100, 500, 1000, 5000].includes(ui.scan_count) ? ui.scan_count : 1000,
      expanded: Array.isArray(ui.expanded) ? ui.expanded.map(String).slice(0, 2000) : [],
      lists: ui.lists && typeof ui.lists === "object" ? ui.lists : {},
    },
  };
}

export function addHistory(data, connId, line) {
  const list = (data.history[connId] ||= []);
  if (list[list.length - 1] !== line) list.push(line);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * redis://[usuário[:senha]@]host[:porta][/db] (rediss:// = TLS), "host:porta" ou argumentos do
 * redis-cli (-h, -p, -a, --user, -n, --tls). Devolve { patch, password } ou null.
 */
export function parseRedisUrl(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const m = /^(rediss?|valkeys?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/:?]+|\[[^\]]+\])(?::(\d+))?(?:\/(\d+))?(?:\?.*)?$/i.exec(s);
  if (m) {
    const patch = { mode: "standalone", tls: /s$/i.test(m[1]), host: m[4].replace(/^\[|\]$/g, ""), port: m[5] ? Number(m[5]) : 6379 };
    if (m[2]) patch.username = decodeURIComponent(m[2]);
    if (m[6]) patch.db = Number(m[6]);
    return { patch, password: m[3] !== undefined ? decodeURIComponent(m[3]) : undefined };
  }
  if (/(^|\s)-(h|p|a|n)\s|--(tls|user|pass)\b/.test(s)) {
    const args = parseCommandLine(s).args.map((a) => (typeof a === "string" ? a : ""));
    const patch = { mode: "standalone" };
    let password;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const next = () => args[++i] ?? "";
      if (a === "-h") patch.host = next();
      else if (a === "-p") patch.port = Number(next()) || 6379;
      else if (a === "-a" || a === "--pass") password = next();
      else if (a === "--user") patch.username = next();
      else if (a === "-n") patch.db = Number(next()) || 0;
      else if (a === "--tls") patch.tls = true;
      else if (a === "-u") return parseRedisUrl(next());
    }
    return patch.host || patch.port ? { patch, password } : null;
  }
  const hp = /^([^\s:]+):(\d+)$/.exec(s);
  if (hp) return { patch: { mode: "standalone", host: hp[1], port: Number(hp[2]) }, password: undefined };
  return null;
}

/** URL para outro software (com a senha só se informada). */
export function buildRedisUrl(c, password) {
  const auth = c.username || password ? `${encodeURIComponent(c.username || "")}${password ? `:${encodeURIComponent(password)}` : ""}@` : "";
  const host = c.mode === "cluster" && !c.host && c.nodes[0] ? c.nodes[0] : `${c.host}:${c.port}`;
  return `${c.tls ? "rediss" : "redis"}://${auth}${host}${c.db ? `/${c.db}` : ""}`;
}

// ---------- Bytes, chaves e valores ----------

const enc = new TextEncoder();

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bytes → texto se for UTF-8 válido; senão `null`. */
export function utf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Bulk ({ t: str|bin, v }) → bytes. */
export function bulkBytes(r) {
  if (!r) return new Uint8Array();
  return r.t === "bin" ? b64ToBytes(r.v) : enc.encode(String(r.v ?? ""));
}

/** Argumento para o Rust: texto ou { b64 }. */
export function argOf(r) {
  if (r && typeof r === "object") return r.t === "bin" ? { b64: r.v } : String(r.v ?? "");
  return String(r ?? "");
}

/** Texto/bytes → bulk ({ t, v }). */
export function bulkOf(value) {
  if (value instanceof Uint8Array) {
    const t = utf8(value);
    return t === null ? { t: "bin", v: bytesToB64(value) } : { t: "str", v: t };
  }
  return { t: "str", v: String(value ?? "") };
}

export const keyId = (k) => `${k.t}:${k.v}`;

/** Bytes fora do ASCII imprimível como \xHH (como o redis-cli). */
export function escapeBytes(bytes) {
  let out = "";
  for (const b of bytes) {
    if (b === 0x5c) out += "\\\\";
    else if (b === 0x22) out += '\\"';
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x09) out += "\\t";
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** Nome exibido de uma chave/valor (binário com \xHH). */
export function bulkLabel(r) {
  if (!r) return "";
  return r.t === "bin" ? escapeBytes(b64ToBytes(r.v)) : String(r.v ?? "");
}

/** Texto de um valor RESP qualquer (para ler INFO, contagens etc.). */
export function respText(r) {
  if (!r) return "";
  switch (r.t) {
    case "nil":
      return "";
    case "bin":
      return bulkLabel(r);
    case "arr":
    case "set":
    case "push":
      return r.v.map(respText).join("\n");
    case "map":
      return r.v.map(([k, v]) => `${respText(k)}: ${respText(v)}`).join("\n");
    default:
      return String(r.v);
  }
}

export const respInt = (r) => (r?.t === "int" ? r.v : Number(respText(r)) || 0);

/** RESP → valor JS (mapas viram objetos; binário vira "\xHH"). */
export function respToJs(r) {
  if (!r) return null;
  switch (r.t) {
    case "nil":
      return null;
    case "int":
    case "dbl":
    case "bool":
      return r.v;
    case "bin":
      return bulkLabel(r);
    case "arr":
    case "set":
    case "push":
      return r.v.map(respToJs);
    case "map": {
      const o = {};
      for (const [k, v] of r.v) o[respText(k)] = respToJs(v);
      return o;
    }
    case "err":
      return { error: r.v };
    default:
      return r.v;
  }
}

/** Pares [campo, valor] de uma resposta HGETALL/CONFIG GET/XINFO (lista plana ou mapa). */
export function respPairs(r) {
  if (!r) return [];
  if (r.t === "map") return r.v;
  const out = [];
  const list = r.v || [];
  for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]);
  return out;
}

/** Objeto { campo: valor JS } de pares RESP (XINFO, MEMORY STATS…). */
export function respObject(r) {
  const o = {};
  for (const [k, v] of respPairs(r)) o[respText(k)] = respToJs(v);
  return o;
}

function quoteBulk(r) {
  const bytes = bulkBytes(r);
  return `"${escapeBytes(bytes)}"`;
}

/** Saída no estilo do redis-cli. */
export function formatResp(r, indent = 0) {
  if (!r) return "(nil)";
  const pad = " ".repeat(indent);
  switch (r.t) {
    case "nil":
      return "(nil)";
    case "int":
      return `(integer) ${r.v}`;
    case "str":
    case "bin":
      return quoteBulk(r);
    case "status":
      return String(r.v);
    case "err":
      return `(error) ${r.v}`;
    case "dbl":
      return `(double) ${r.v}`;
    case "bool":
      return r.v ? "(true)" : "(false)";
    case "big":
      return `(big number) ${r.v}`;
    case "arr":
    case "set":
    case "push": {
      if (!r.v.length) return r.t === "set" ? "(empty set)" : "(empty array)";
      const mark = r.t === "set" ? "~" : ")";
      const w = String(r.v.length).length;
      return r.v
        .map((item, i) => {
          const label = `${String(i + 1).padStart(w)}${mark} `;
          const body = formatResp(item, indent + label.length);
          return `${i ? pad : ""}${label}${body}`;
        })
        .join("\n");
    }
    case "map": {
      if (!r.v.length) return "(empty hash)";
      const w = String(r.v.length).length;
      return r.v
        .map(([k, v], i) => {
          const label = `${String(i + 1).padStart(w)}# `;
          const key = formatResp(k, indent + label.length);
          const body = formatResp(v, indent + label.length + key.length + 4);
          return `${i ? pad : ""}${label}${key} => ${body}`;
        })
        .join("\n");
    }
    default:
      return String(r.v ?? "");
  }
}

/** Argumento para exibir/copiar como comando (aspas só quando preciso). */
export function quoteArg(a) {
  const bytes = typeof a === "string" ? enc.encode(a) : a?.b64 !== undefined ? b64ToBytes(a.b64) : bulkBytes(a);
  const text = escapeBytes(bytes);
  return /^[^\s"'\\]+$/.test(text) && text === utf8(bytes) && text !== "" ? text : `"${text}"`;
}

export const commandText = (args) => args.map(quoteArg).join(" ");

// ---------- Linha de comando (redis-cli) ----------

/**
 * Divide uma linha como o redis-cli: "aspas duplas" com escapes (\n, \t, \xHH, \", \\),
 * 'aspas simples' literais (\' escapa). Argumentos que não são UTF-8 viram { b64 }.
 */
export function parseCommandLine(line) {
  const args = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const bytes = [];
    let quoted = false;
    const pushText = (t) => bytes.push(...enc.encode(t));
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i];
      if (ch === '"') {
        quoted = true;
        i++;
        let closed = false;
        while (i < s.length) {
          const c = s[i];
          if (c === "\\" && i + 1 < s.length) {
            const n = s[i + 1];
            if (n === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
              bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
              i += 4;
              continue;
            }
            pushText({ n: "\n", r: "\r", t: "\t", b: "\b", a: "\x07" }[n] ?? n);
            i += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            i++;
            break;
          }
          pushText(c);
          i++;
        }
        if (!closed) return { args, error: "Aspas duplas sem fechamento" };
      } else if (ch === "'") {
        quoted = true;
        i++;
        let closed = false;
        while (i < s.length) {
          const c = s[i];
          if (c === "\\" && s[i + 1] === "'") {
            pushText("'");
            i += 2;
            continue;
          }
          if (c === "'") {
            closed = true;
            i++;
            break;
          }
          pushText(c);
          i++;
        }
        if (!closed) return { args, error: "Aspas simples sem fechamento" };
      } else {
        // Caractere comum (inclui surrogate pairs).
        const cp = s.codePointAt(i);
        pushText(String.fromCodePoint(cp));
        i += cp > 0xffff ? 2 : 1;
      }
    }
    const u8 = Uint8Array.from(bytes);
    const text = utf8(u8);
    args.push(text === null ? { b64: bytesToB64(u8) } : text);
    if (!quoted && text === "") args.pop();
  }
  return { args, error: null };
}

/** Linhas executáveis de um texto (ignora vazias e comentários `#` / `//`). */
export function commandLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
}

const DANGER = {
  FLUSHALL: "apaga todas as chaves de todos os bancos",
  FLUSHDB: "apaga todas as chaves do banco",
  SHUTDOWN: "desliga o servidor",
  SWAPDB: "troca o conteúdo de dois bancos",
  MIGRATE: "move chaves para outro servidor",
  REPLICAOF: "muda a replicação do servidor",
  SLAVEOF: "muda a replicação do servidor",
  DEBUG: "pode travar ou derrubar o servidor",
  FAILOVER: "troca o master",
};
const DANGER_SUBS = {
  CONFIG: { SET: "altera a configuração do servidor", REWRITE: "regrava o redis.conf", RESETSTAT: "zera as estatísticas" },
  CLIENT: { KILL: "derruba conexões de clientes", PAUSE: "pausa todos os clientes" },
  SCRIPT: { FLUSH: "apaga o cache de scripts" },
  FUNCTION: { FLUSH: "apaga todas as funções", DELETE: "apaga uma biblioteca de funções" },
  CLUSTER: { RESET: "reinicia o nó do Cluster", FAILOVER: "força failover", FORGET: "remove um nó do Cluster", DELSLOTS: "remove slots" },
  ACL: { DELUSER: "remove usuários", SETUSER: "altera permissões" },
  SLOWLOG: { RESET: "apaga o slowlog" },
  LATENCY: { RESET: "apaga o histórico de latência" },
};
const BLOCKING = {
  KEYS: "KEYS percorre o banco inteiro e trava o servidor; prefira SCAN (a árvore usa SCAN)",
  SAVE: "SAVE trava o servidor até gravar o RDB; prefira BGSAVE",
};

/** Classifica um comando: { level: "danger" | "warn" | null, why }. */
export function classifyCommand(args) {
  const name = String(typeof args[0] === "string" ? args[0] : "").toUpperCase();
  const sub = String(typeof args[1] === "string" ? args[1] : "").toUpperCase();
  if (DANGER[name]) return { level: "danger", why: `${name} ${DANGER[name]}` };
  if (DANGER_SUBS[name]?.[sub]) return { level: "danger", why: `${name} ${sub} ${DANGER_SUBS[name][sub]}` };
  if (BLOCKING[name]) return { level: "warn", why: BLOCKING[name] };
  return { level: null, why: "" };
}

// ---------- INFO, CLIENT LIST, SLOWLOG, MONITOR ----------

/** INFO → { secao: { chave: valor } } (seções em minúsculas). */
export function parseInfo(text) {
  const out = {};
  let section = "info";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      section = line.slice(1).trim().toLowerCase();
      out[section] ||= {};
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    (out[section] ||= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** "keys=10,expires=2,avg_ttl=0" → { keys: 10, expires: 2, avg_ttl: 0 } */
export function parseKv(text, sep = ",") {
  const o = {};
  for (const part of String(text || "").split(sep)) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const v = part.slice(i + 1);
    o[part.slice(0, i)] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return o;
}

/** Chaves por banco a partir do INFO keyspace: { 0: { keys, expires, avg_ttl } }. */
export function keyspace(info) {
  const out = {};
  for (const [k, v] of Object.entries(info?.keyspace || {})) {
    const m = /^db(\d+)$/.exec(k);
    if (m) out[Number(m[1])] = parseKv(v);
  }
  return out;
}

/** CLIENT LIST: uma linha por cliente com campos chave=valor separados por espaço. */
export function parseClientList(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => parseKv(l.trim(), " "));
}

/** SLOWLOG GET → [{ id, at (ms), us, args, client, name }]. */
export function parseSlowlog(r) {
  return (r?.v || []).map((e) => {
    const p = e.v || [];
    return {
      id: respInt(p[0]),
      at: respInt(p[1]) * 1000,
      us: respInt(p[2]),
      args: (p[3]?.v || []).map(bulkLabel),
      client: p[4] ? respText(p[4]) : "",
      name: p[5] ? respText(p[5]) : "",
    };
  });
}

/** Linha do MONITOR: `1700000000.123456 [0 127.0.0.1:5000] "GET" "k"`. */
export function parseMonitorLine(line) {
  const m = /^(\d+)\.(\d+) \[(\d+) ([^\]]*)\] (.*)$/.exec(String(line));
  if (!m) return { at: Date.now(), db: null, client: "", args: [String(line)], raw: String(line) };
  const args = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let a;
  while ((a = re.exec(m[5]))) args.push(a[1]);
  return { at: Number(m[1]) * 1000 + Math.floor(Number(m[2].padEnd(6, "0").slice(0, 6)) / 1000), db: Number(m[3]), client: m[4], args, raw: String(line) };
}

// ---------- Árvore de chaves ----------

/**
 * Linhas visíveis da árvore (pré-ordem): pastas pelo separador, contagem agregada, pastas
 * antes das chaves, ordem natural. `expanded`: Set de caminhos de pasta abertos ("a:b:").
 * keys: [{ k: { t, v }, type }]. Com `sep` vazio ou `flat`, lista simples.
 */
export function keyTreeRows(keys, sep, expanded, { flat = false } = {}) {
  const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
  if (flat || !sep) {
    return [...keys].sort((a, b) => collator.compare(bulkLabel(a.k), bulkLabel(b.k))).map((e) => ({ kind: "key", depth: 0, label: bulkLabel(e.k), entry: e }));
  }
  const root = { folders: new Map(), keys: [], count: 0 };
  for (const e of keys) {
    const label = bulkLabel(e.k);
    const parts = label.split(sep);
    let node = root;
    node.count++;
    let path = "";
    for (let i = 0; i < parts.length - 1; i++) {
      path += parts[i] + sep;
      let f = node.folders.get(parts[i]);
      if (!f) {
        f = { name: parts[i], path, folders: new Map(), keys: [], count: 0 };
        node.folders.set(parts[i], f);
      }
      f.count++;
      node = f;
    }
    node.keys.push({ e, name: parts[parts.length - 1], label });
  }
  const rows = [];
  const walk = (node, depth) => {
    for (const f of [...node.folders.values()].sort((a, b) => collator.compare(a.name, b.name))) {
      const open = expanded.has(f.path);
      rows.push({ kind: "folder", depth, label: f.name, path: f.path, count: f.count, open });
      if (open) walk(f, depth + 1);
    }
    for (const k of node.keys.sort((a, b) => collator.compare(a.name, b.name))) rows.push({ kind: "key", depth, label: k.name, full: k.label, entry: k.e });
  };
  walk(root, 0);
  return rows;
}

// ---------- Valores ----------

/** Como mostrar um valor: { kind: json | text | binary | empty, text, pretty } */
export function detectFormat(r) {
  if (!r || r.t === "nil") return { kind: "empty", text: "", pretty: "" };
  if (r.t === "bin") return { kind: "binary", text: bulkLabel(r), pretty: "" };
  const text = String(r.v ?? "");
  if (!text) return { kind: "empty", text: "", pretty: "" };
  const t = text.trim();
  if (/^[[{]/.test(t) || /^"/.test(t)) {
    try {
      return { kind: "json", text, pretty: JSON.stringify(JSON.parse(t), null, 2) };
    } catch {
      /* texto */
    }
  }
  return { kind: "text", text, pretty: text };
}

/** Hex dump (offset, hex, ASCII) dos primeiros `max` bytes. */
export function hexDumpBytes(bytes, max = 65536) {
  const b = bytes.subarray(0, max);
  const lines = [];
  for (let i = 0; i < b.length; i += 16) {
    const chunk = [...b.subarray(i, i + 16)];
    lines.push(`${i.toString(16).padStart(8, "0")}  ${chunk.map((x) => x.toString(16).padStart(2, "0")).join(" ").padEnd(47)}  ${chunk.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("")}`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} byte(s) a mais`);
  return lines.join("\n");
}

/** TTL em ms (PTTL) → texto. -1 = sem expiração, -2 = não existe. */
export function fmtTtl(ms) {
  if (ms === -1 || ms === null || ms === undefined) return "sem expiração";
  if (ms === -2) return "expirou";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}min`, !d && !h && s % 60 && `${s % 60}s`].filter(Boolean).join(" ");
}

/** "1h30m", "90", "2d" → segundos (null = inválido). */
export function parseTtl(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const re = /(\d+)\s*(d|h|min|m|s)/g;
  let total = 0;
  let m;
  let matched = "";
  while ((m = re.exec(s))) {
    total += Number(m[1]) * { d: 86400, h: 3600, min: 60, m: 60, s: 1 }[m[2]];
    matched += m[0];
  }
  return matched.replace(/\s/g, "") === s.replace(/\s/g, "") && total > 0 ? total : null;
}

/** Id de entrada de stream: "1700000000000-0" → data. */
export function streamIdTime(id) {
  const ms = Number(String(id).split("-")[0]);
  return Number.isFinite(ms) ? ms : null;
}

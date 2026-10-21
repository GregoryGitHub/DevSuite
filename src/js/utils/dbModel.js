// Aba "Banco": formato do databases.json (conexões sem segredos, consoles, abas e histórico).
// Senhas e tokens ficam no cofre do sistema (src-tauri/src/db/secrets.rs), nunca aqui.

export const DB_VERSION = 1;
const HISTORY_LIMIT = 300;

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** Cores para marcar conexões (ex.: vermelho para produção). */
export const CONN_COLORS = ["", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"];

export function newConnection(patch = {}) {
  return normalizeConnection({ id: uid(), name: "", ...patch });
}

export function normalizeConnection(c = {}) {
  const auth = c.auth || {};
  return {
    id: c.id || uid(),
    name: String(c.name || ""),
    driver: c.driver === "mongo" ? "mongo" : "mssql",
    host: String(c.host || ""),
    port: Number.isInteger(c.port) ? c.port : c.port === null ? null : 1433,
    instance: String(c.instance || ""),
    database: String(c.database || ""),
    auth: {
      kind: auth.kind === "entra" ? "entra" : "sql",
      user: String(auth.user || ""),
      tenant: String(auth.tenant || ""),
      client_id: String(auth.client_id || ""),
    },
    encrypt: ["on", "strict", "off"].includes(c.encrypt) ? c.encrypt : "on",
    trust_server_certificate: !!c.trust_server_certificate,
    read_intent: !!c.read_intent,
    connect_timeout_s: Number(c.connect_timeout_s) > 0 ? Number(c.connect_timeout_s) : 15,
    color: CONN_COLORS.includes(c.color) ? c.color : "",
    read_only: !!c.read_only,
    /** MongoDB: connection string sem a senha (que fica no cofre). */
    uri: String(c.uri || ""),
    tls_insecure: !!c.tls_insecure,
    /** Bancos visíveis no Explorer (vazio = todos). */
    databases_filter: Array.isArray(c.databases_filter) ? c.databases_filter.map(String) : [],
  };
}

export const isMongo = (c) => c?.driver === "mongo";

/** Nome exibido: o salvo ou "host/banco". */
export function connLabel(c) {
  if (c.name.trim()) return c.name.trim();
  if (isMongo(c)) {
    const host = parseMongoUri(c.uri).hosts.split(",")[0] || "mongodb";
    return c.database ? `${host}/${c.database}` : host;
  }
  const host = c.host.replace(/\.database\.windows\.net$/i, "") || "nova conexão";
  return c.database ? `${host}/${c.database}` : host;
}

export function isAzureHost(host) {
  return /\.database\.(windows\.net|azure\.com|chinacloudapi\.cn|usgovcloudapi\.net)$/i.test(host.trim());
}

/** Payload aceito pelo Rust (ConnConfig): só os campos de conexão. */
export function connConfig(c) {
  return {
    id: c.id,
    driver: c.driver,
    host: c.host.trim(),
    port: c.instance.trim() && !c.port ? null : c.port || 1433,
    instance: c.instance.trim() || null,
    database: c.database.trim(),
    auth: { ...c.auth },
    encrypt: c.encrypt,
    trust_server_certificate: c.trust_server_certificate,
    read_intent: c.read_intent,
    connect_timeout_s: c.connect_timeout_s,
    uri: c.uri.trim(),
    tls_insecure: c.tls_insecure,
  };
}

/** Onde um comando roda no Rust: sessão + conexão + banco. */
export function target(conn, sessionId, database = "") {
  return { session_id: sessionId, conn: connConfig(conn), database: database || "" };
}

export const metaSession = (connId, database) => `meta:${connId}:${database || ""}`;

function normalizeConsole(c = {}) {
  return {
    id: c.id || uid(),
    conn_id: String(c.conn_id || ""),
    database: String(c.database || ""),
    name: String(c.name || "console"),
    sql: String(c.sql || ""),
  };
}

function normalizeTab(t = {}) {
  if (!t || !["table", "console", "ddl"].includes(t.type)) return null;
  return {
    id: t.id || uid(),
    type: t.type,
    conn_id: String(t.conn_id || ""),
    database: String(t.database || ""),
    schema: String(t.schema || ""),
    name: String(t.name || ""),
    kind: String(t.kind || ""),
    console_id: String(t.console_id || ""),
    where: String(t.where || ""),
    order_by: String(t.order_by || ""),
    /** MongoDB: projeção da aba de coleção. */
    projection: String(t.projection || ""),
    /** DDL do banco inteiro (kind "database"): opções do script (DbScriptOptions). */
    options: t.options && typeof t.options === "object" ? { ...t.options } : null,
  };
}

export function normalizeDbData(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const ui = d.ui || {};
  const connections = (Array.isArray(d.connections) ? d.connections : []).map(normalizeConnection);
  const ids = new Set(connections.map((c) => c.id));
  const consoles = (Array.isArray(d.consoles) ? d.consoles : []).map(normalizeConsole).filter((c) => ids.has(c.conn_id));
  const consoleIds = new Set(consoles.map((c) => c.id));
  const tabs = (Array.isArray(ui.tabs) ? ui.tabs : [])
    .map(normalizeTab)
    .filter((t) => t && ids.has(t.conn_id) && (t.type !== "console" || consoleIds.has(t.console_id)));
  return {
    version: DB_VERSION,
    connections,
    consoles,
    history: (Array.isArray(d.history) ? d.history : []).slice(0, HISTORY_LIMIT),
    ui: {
      tabs,
      active_tab: tabs.some((t) => t.id === ui.active_tab) ? ui.active_tab : tabs[0]?.id || null,
      explorer_w: clamp(Number(ui.explorer_w) || 300, 200, 640),
      log_h: clamp(Number(ui.log_h) || 180, 60, 600),
      log_open: ui.log_open !== false,
      explorer_open: ui.explorer_open !== false,
      page_size: [100, 200, 500, 1000, 5000].includes(ui.page_size) ? ui.page_size : 500,
      expanded: Array.isArray(ui.expanded) ? ui.expanded.slice(0, 400).map(String) : [],
    },
  };
}

export function newConsole(conn, database) {
  return normalizeConsole({ conn_id: conn.id, database: database || conn.database, name: `console` });
}

export function newTab(t) {
  return normalizeTab({ id: uid(), ...t });
}

/** Mensagem padrão de escrita (SQL e MongoDB): "(5) registro(s) afetado(s)". */
export function affectedText(n) {
  return `(${Number(n).toLocaleString("pt-BR")}) registro(s) afetado(s)`;
}

export function addHistory(data, entry) {
  data.history.unshift({ at: Date.now(), ...entry });
  if (data.history.length > HISTORY_LIMIT) data.history.length = HISTORY_LIMIT;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Lê uma connection string ADO.NET ("Server=tcp:x,1433;Initial Catalog=db;...") ou JDBC
 * ("jdbc:sqlserver://x:1433;databaseName=db;...") e devolve { patch, password }.
 */
export function parseConnectionString(text) {
  let s = String(text || "").trim();
  const kv = {};
  let hostPart = "";
  const jdbc = /^jdbc:sqlserver:\/\/([^;]*);?(.*)$/i.exec(s);
  if (jdbc) {
    hostPart = jdbc[1];
    s = jdbc[2];
  }
  // chave=valor;... — valor entre aspas pode ter ; (aspas dobradas = aspas literais).
  const pairRe = /\s*([^=;]+?)\s*=\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|([^;]*))\s*(?:;|$)/gy;
  for (let pos = 0; pos < s.length; ) {
    pairRe.lastIndex = pos;
    const m = pairRe.exec(s);
    if (!m) {
      // Trecho sem "=": pula até o próximo ";".
      const next = s.indexOf(";", pos);
      if (next < 0) break;
      pos = next + 1;
      continue;
    }
    pos = pairRe.lastIndex;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, " ");
    kv[key] = m[2] !== undefined ? m[2].replace(/""/g, '"') : m[3] !== undefined ? m[3].replace(/''/g, "'") : m[4].trim();
  }
  const pick = (...keys) => keys.map((k) => kv[k]).find((v) => v !== undefined);
  const server = hostPart || pick("server", "data source", "address", "addr", "network address", "servername") || "";
  const patch = { auth: {} };
  if (server) {
    let host = server.replace(/^tcp:/i, "");
    const portMatch = /[,:](\d+)$/.exec(host);
    if (portMatch) {
      patch.port = Number(portMatch[1]);
      host = host.slice(0, portMatch.index);
    }
    const slash = host.indexOf("\\");
    if (slash >= 0) {
      patch.instance = host.slice(slash + 1);
      host = host.slice(0, slash);
      if (!portMatch) patch.port = null;
    }
    patch.host = host;
  }
  const instance = pick("instancename");
  if (instance) patch.instance = instance;
  const port = pick("port", "portnumber");
  if (port && /^\d+$/.test(port)) patch.port = Number(port);
  const db = pick("initial catalog", "database", "databasename");
  if (db !== undefined) patch.database = db;
  const user = pick("user id", "uid", "user", "username", "user name");
  if (user !== undefined) patch.auth.user = user;
  const auth = (pick("authentication") || "").toLowerCase();
  if (auth.includes("active directory") || auth.startsWith("activedirectory")) patch.auth.kind = "entra";
  else if (user !== undefined) patch.auth.kind = "sql";
  const encrypt = (pick("encrypt") || "").toLowerCase();
  if (encrypt) patch.encrypt = encrypt === "strict" ? "strict" : /^(false|no|optional)$/.test(encrypt) ? "off" : "on";
  const trust = (pick("trustservercertificate", "trust server certificate") || "").toLowerCase();
  if (trust) patch.trust_server_certificate = /^(true|yes)$/.test(trust);
  const intent = (pick("applicationintent", "application intent") || "").toLowerCase();
  if (intent) patch.read_intent = intent === "readonly";
  const timeout = pick("connect timeout", "connection timeout", "logintimeout");
  if (timeout && /^\d+$/.test(timeout)) patch.connect_timeout_s = Number(timeout);
  if (!Object.keys(patch.auth).length) delete patch.auth;
  return { patch, password: pick("password", "pwd") };
}

/** Valor de connection string ADO.NET: entre aspas quando tem ; = aspas ou espaço nas pontas. */
function adoValue(v) {
  const s = String(v);
  if (!/[;="']|^\s|\s$/.test(s)) return s;
  return s.includes('"') ? `'${s.replace(/'/g, "''")}'` : `"${s}"`;
}

/**
 * Connection string para usar em outro software: ADO.NET (SQL Server) ou a URI do MongoDB.
 * `password` (opcional) entra na string; sem ela, nenhum segredo sai daqui.
 */
export function buildConnectionString(c, password) {
  if (isMongo(c)) {
    const m = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]*)(\/[^?]*)?(\?.*)?$/i.exec(c.uri.trim());
    if (!m) return c.uri.trim();
    const [, scheme, hosts, path = "", query = ""] = m;
    const user = c.auth.user.trim();
    const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@` : "";
    let q = query;
    if (c.tls_insecure && !/[?&]tlsAllowInvalidCertificates=/i.test(q)) q += `${q ? "&" : "?"}tlsAllowInvalidCertificates=true`;
    // O banco padrão do diálogo vale mais que o do caminho.
    const db = c.database.trim() ? `/${encodeURIComponent(c.database.trim())}` : path || (q ? "/" : "");
    return `${scheme}${auth}${hosts}${db}${q}`;
  }
  const host = c.host.trim();
  const instance = c.instance.trim();
  const server = `tcp:${host}${instance ? `\\${instance}` : ""}${c.port && (!instance || c.port !== 1433) ? `,${c.port}` : ""}`;
  const parts = [["Server", server]];
  if (c.database.trim()) parts.push(["Initial Catalog", c.database.trim()]);
  if (c.auth.kind === "entra") {
    parts.push(["Authentication", "Active Directory Interactive"]);
    if (c.auth.user.trim()) parts.push(["User ID", c.auth.user.trim()]);
  } else {
    if (c.auth.user.trim()) parts.push(["User ID", c.auth.user.trim()]);
    if (password) parts.push(["Password", password]);
  }
  parts.push(["Encrypt", { on: "True", strict: "Strict", off: "False" }[c.encrypt] || "True"]);
  parts.push(["TrustServerCertificate", c.trust_server_certificate ? "True" : "False"]);
  if (c.read_intent) parts.push(["ApplicationIntent", "ReadOnly"]);
  parts.push(["Connect Timeout", c.connect_timeout_s]);
  return parts.map(([k, v]) => `${k}=${adoValue(v)}`).join(";") + ";";
}

/** Host de uma conexão MongoDB que é Atlas/Cosmos (para o rótulo). */
export function mongoFlavor(uri) {
  const u = uri.toLowerCase();
  if (u.includes("cosmos.azure.com") || u.includes("documents.azure.com")) return "Azure Cosmos DB";
  if (u.includes(".mongodb.net")) return "MongoDB Atlas";
  return "MongoDB";
}

/**
 * Separa uma connection string MongoDB: devolve a URI sem a senha (para salvar), o usuário,
 * a senha (para o cofre), os hosts e o banco padrão do caminho.
 */
export function parseMongoUri(text) {
  const raw = String(text || "").trim();
  const m = /^(mongodb(?:\+srv)?:\/\/)(?:([^@/]*)@)?([^/?]*)(\/[^?]*)?(\?.*)?$/i.exec(raw);
  if (!m) return { valid: false, uri: raw, user: "", password: undefined, hosts: "", database: "" };
  const [, scheme, auth, hosts, path = "", query = ""] = m;
  let user = "";
  let password;
  if (auth !== undefined) {
    const i = auth.indexOf(":");
    user = decodeURIComponent(i < 0 ? auth : auth.slice(0, i));
    if (i >= 0) password = decodeURIComponent(auth.slice(i + 1));
  }
  const database = decodeURIComponent(path.replace(/^\//, ""));
  const cleanAuth = user ? `${encodeURIComponent(user)}@` : "";
  return { valid: true, uri: `${scheme}${cleanAuth}${hosts}${path}${query}`, user, password, hosts, database };
}

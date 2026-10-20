// Data model of the HTTP tab (Postman-like): defaults, migration, variables,
// URL <-> params sync and building the final request sent to Rust.

import { normalizeFolderTree } from "./folderTree.js";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
export const BODY_MODES = [
  { id: "none", label: "nenhum" },
  { id: "form-data", label: "form-data" },
  { id: "urlencoded", label: "x-www-form-urlencoded" },
  { id: "raw", label: "raw" },
  { id: "binary", label: "binário" },
  { id: "graphql", label: "GraphQL" },
];
export const RAW_LANGS = [
  { id: "json", label: "JSON", type: "application/json" },
  { id: "text", label: "Texto", type: "text/plain" },
  { id: "javascript", label: "JavaScript", type: "application/javascript" },
  { id: "html", label: "HTML", type: "text/html" },
  { id: "xml", label: "XML", type: "application/xml" },
];
export const AUTH_TYPES = [
  { id: "inherit", label: "Herdar da coleção" },
  { id: "none", label: "Sem autenticação" },
  { id: "bearer", label: "Bearer Token" },
  { id: "basic", label: "Basic Auth" },
  { id: "apikey", label: "API Key" },
];
export const USER_AGENT = "DevSuite-HTTP/0.2";
export const DEFAULT_SETTINGS = { timeout_ms: 30000, use_cookies: true, history_limit: 100 };

let uidCounter = 0;
/** Numeric, sortable and unique within the session (fits in a safe integer). */
export function uid() {
  uidCounter = (uidCounter + 1) % 1000;
  return Date.now() * 1000 + uidCounter;
}

export const kv = (key = "", value = "", enabled = true) => ({ key, value, enabled, description: "" });

function normKvList(list, extra = () => ({})) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      key: String(r.key ?? ""),
      value: String(r.value ?? ""),
      enabled: r.enabled !== false,
      description: String(r.description ?? ""),
      ...extra(r),
    }));
}

export function newAuth(type = "inherit") {
  return {
    type,
    bearer: { token: "" },
    basic: { username: "", password: "" },
    apikey: { key: "", value: "", in: "header" },
  };
}

function normAuth(a, fallback = "inherit") {
  const base = newAuth(AUTH_TYPES.some((t) => t.id === a?.type) ? a.type : fallback);
  return {
    type: base.type,
    bearer: { token: String(a?.bearer?.token ?? "") },
    basic: { username: String(a?.basic?.username ?? ""), password: String(a?.basic?.password ?? "") },
    apikey: {
      key: String(a?.apikey?.key ?? ""),
      value: String(a?.apikey?.value ?? ""),
      in: a?.apikey?.in === "query" ? "query" : "header",
    },
  };
}

export function newRequest(fields = {}) {
  const now = Date.now();
  return normalizeRequest({ id: uid(), name: "Nova Requisição", method: "GET", url: "", created_at: now, updated_at: now, ...fields });
}

export function normalizeRequest(r) {
  const body = r.body || {};
  const now = Date.now();
  return {
    id: Number(r.id) || uid(),
    collection_id: Number(r.collection_id) || 0,
    folder_id: Number(r.folder_id) || 0,
    name: String(r.name ?? "Nova Requisição"),
    method: String(r.method || "GET").toUpperCase(),
    url: String(r.url ?? ""),
    params: normKvList(r.params),
    path_vars: normKvList(r.path_vars),
    headers: normKvList(r.headers),
    auth: normAuth(r.auth),
    body: {
      mode: BODY_MODES.some((m) => m.id === body.mode) ? body.mode : "none",
      raw: String(body.raw ?? ""),
      lang: RAW_LANGS.some((l) => l.id === body.lang) ? body.lang : "json",
      form: normKvList(body.form, (f) => ({ type: f.type === "file" ? "file" : "text", file_path: String(f.file_path ?? "") })),
      urlencoded: normKvList(body.urlencoded),
      binary_path: String(body.binary_path ?? ""),
      graphql: { query: String(body.graphql?.query ?? ""), variables: String(body.graphql?.variables ?? "") },
    },
    scripts: { pre: String(r.scripts?.pre ?? ""), test: String(r.scripts?.test ?? "") },
    settings: {
      timeout_ms: Math.max(0, Number(r.settings?.timeout_ms) || 0),
      follow_redirects: r.settings?.follow_redirects !== false,
      verify_ssl: r.settings?.verify_ssl !== false,
    },
    pinned: !!r.pinned,
    created_at: Number(r.created_at) || now,
    updated_at: Number(r.updated_at) || now,
  };
}

export function newCollection(name = "Nova Coleção") {
  return normalizeCollection({ id: uid(), name });
}

export function normalizeCollection(c) {
  return {
    id: Number(c.id) || uid(),
    name: String(c.name || "Coleção"),
    description: String(c.description ?? ""),
    auth: normAuth(c.auth, "none"),
    variables: normKvList(c.variables),
    scripts: { pre: String(c.scripts?.pre ?? ""), test: String(c.scripts?.test ?? "") },
    // Subpastas: parent_id = pasta-mãe (0 = raiz da coleção).
    folders: normalizeFolderTree(
      (Array.isArray(c.folders) ? c.folders : []).map((f) => ({
        id: Number(f.id) || uid(),
        name: String(f.name || "Pasta"),
        parent_id: Number(f.parent_id) || 0,
        collapsed: !!f.collapsed,
      })),
    ),
  };
}

export function normalizeEnvironment(e) {
  return { id: Number(e.id) || uid(), name: String(e.name || "Ambiente"), values: normKvList(e.values) };
}

/** Migrates/validates the whole http.json document. */
export function normalizeHttpData(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const collections = (Array.isArray(d.collections) ? d.collections : []).map(normalizeCollection);
  const collIds = new Set(collections.map((c) => c.id));
  if (!collections.length) {
    const c = newCollection("Minha Coleção");
    collections.push(c);
    collIds.add(c.id);
  }
  const requests = (Array.isArray(d.requests) ? d.requests : []).map(normalizeRequest);
  for (const r of requests) {
    if (!collIds.has(r.collection_id)) r.collection_id = collections[0].id;
    const coll = collections.find((c) => c.id === r.collection_id);
    if (r.folder_id && !coll.folders.some((f) => f.id === r.folder_id)) r.folder_id = 0;
  }
  const environments = (Array.isArray(d.environments) ? d.environments : []).map(normalizeEnvironment);
  const history = (Array.isArray(d.history) ? d.history : [])
    .filter((h) => h && h.request)
    .map((h) => ({ ...h, id: Number(h.id) || uid(), at: Number(h.at) || Date.now(), request: normalizeRequest(h.request) }));
  return {
    version: 1,
    collections,
    requests,
    environments,
    active_env: environments.some((e) => e.id === d.active_env) ? d.active_env : null,
    globals: normKvList(d.globals),
    history,
    settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
  };
}

/** Deep copy for duplicates/snapshots. */
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------- Variables ----------

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const FIRST_NAMES = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Felipe", "Gabriela", "Henrique", "Isabela", "João"];
const LAST_NAMES = ["Silva", "Souza", "Oliveira", "Santos", "Pereira", "Costa", "Almeida", "Ferreira"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const DYNAMIC_VARS = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomFirstName: () => pick(FIRST_NAMES),
  $randomLastName: () => pick(LAST_NAMES),
  $randomFullName: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
  $randomEmail: () => `${pick(FIRST_NAMES).toLowerCase()}.${Math.floor(Math.random() * 1e4)}@exemplo.com`,
};

/**
 * Variable lookup ordered like Postman: local (scripts) > environment > collection > globals.
 * Returns a Map of name -> { value, source }.
 */
export function buildScope({ globals = [], collection = null, environment = null, locals = null } = {}) {
  const scope = new Map();
  const add = (list, source) => {
    for (const v of list || []) if (v.enabled !== false && v.key) scope.set(v.key, { value: v.value, source });
  };
  add(globals, "Global");
  add(collection?.variables, "Coleção");
  add(environment?.values, environment ? environment.name : "Ambiente");
  if (locals) for (const [k, v] of locals) scope.set(k, { value: v, source: "Local" });
  return scope;
}

export function resolveVars(text, scope) {
  if (!text || !text.includes("{{")) return text ?? "";
  let out = text;
  for (let pass = 0; pass < 5 && out.includes("{{"); pass++) {
    const next = out.replace(VAR_RE, (m, name) => {
      if (DYNAMIC_VARS[name]) return DYNAMIC_VARS[name]();
      const hit = scope.get(name);
      return hit ? String(hit.value) : m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Splits text into plain/variable segments, used to highlight `{{var}}` in inputs. */
export function varSegments(text, scope) {
  const segs = [];
  let last = 0;
  for (const m of text.matchAll(VAR_RE)) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    const name = m[1];
    const known = !!DYNAMIC_VARS[name] || scope.has(name);
    segs.push({ text: m[0], name, known, value: DYNAMIC_VARS[name] ? "(dinâmica)" : scope.get(name)?.value, source: scope.get(name)?.source });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}

// ---------- URL <-> params ----------

function splitUrl(url) {
  const hashIdx = url.indexOf("#");
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = noHash.indexOf("?");
  return {
    base: qIdx >= 0 ? noHash.slice(0, qIdx) : noHash,
    query: qIdx >= 0 ? noHash.slice(qIdx + 1) : null,
    hash,
  };
}

/** Query string of the raw URL as params (values are kept raw, encoding happens on send). */
export function parseQueryParams(url) {
  const { query } = splitUrl(url);
  if (query === null || query === "") return [];
  return query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    return eq >= 0 ? kv(pair.slice(0, eq), pair.slice(eq + 1)) : kv(pair, "");
  });
}

/** Params edited in the table -> URL. Disabled params stay out of the URL (like Postman). */
export function urlWithParams(url, params) {
  const { base, hash } = splitUrl(url);
  const query = params
    .filter((p) => p.enabled && (p.key || p.value))
    .map((p) => (p.value === "" ? p.key : `${p.key}=${p.value}`))
    .join("&");
  return `${base}${query ? `?${query}` : ""}${hash}`;
}

/** URL typed by the user -> params, keeping descriptions and the disabled rows. */
export function mergeParamsFromUrl(url, oldParams) {
  const parsed = parseQueryParams(url);
  const enabledOld = oldParams.filter((p) => p.enabled);
  parsed.forEach((p, i) => {
    const prev = enabledOld[i];
    if (prev && prev.key === p.key) p.description = prev.description;
  });
  return [...parsed, ...oldParams.filter((p) => !p.enabled)];
}

/** `/users/:id` -> ["id"] (only in the path, never the port). */
export function pathVarNames(url) {
  const { base } = splitUrl(url);
  const path = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  return [...new Set([...path.matchAll(/\/:([A-Za-z_][\w-]*)/g)].map((m) => m[1]))];
}

export function syncPathVars(url, oldVars) {
  return pathVarNames(url).map((name) => oldVars.find((v) => v.key === name) || kv(name, ""));
}

// ---------- Building the final request ----------

export function effectiveAuth(request, collection) {
  if (request.auth.type !== "inherit") return request.auth;
  if (!collection || collection.auth.type === "inherit") return newAuth("none");
  return collection.auth;
}

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

const hasHeader = (headers, name) => headers.some((h) => h.key.toLowerCase() === name.toLowerCase());

/** Headers the app adds by itself (Content-Type, auth, User-Agent...), shown as "automáticos". */
export function autoHeaders(request, collection, scope) {
  const user = request.headers.filter((h) => h.enabled && h.key);
  const auto = [];
  const add = (key, value) => {
    if (!hasHeader(user, key) && !hasHeader(auto, key)) auto.push({ key, value, auto: true });
  };

  const auth = effectiveAuth(request, collection);
  if (auth.type === "bearer" && auth.bearer.token) add("Authorization", `Bearer ${resolveVars(auth.bearer.token, scope)}`);
  if (auth.type === "basic" && (auth.basic.username || auth.basic.password)) {
    const creds = `${resolveVars(auth.basic.username, scope)}:${resolveVars(auth.basic.password, scope)}`;
    add("Authorization", `Basic ${utf8Base64(creds)}`);
  }
  if (auth.type === "apikey" && auth.apikey.in === "header" && auth.apikey.key) {
    add(resolveVars(auth.apikey.key, scope), resolveVars(auth.apikey.value, scope));
  }

  const b = request.body;
  if (b.mode === "raw" && b.raw) add("Content-Type", RAW_LANGS.find((l) => l.id === b.lang)?.type || "text/plain");
  if (b.mode === "urlencoded") add("Content-Type", "application/x-www-form-urlencoded");
  if (b.mode === "graphql") add("Content-Type", "application/json");
  if (b.mode === "binary" && b.binary_path) add("Content-Type", "application/octet-stream");
  if (b.mode === "form-data") auto.push({ key: "Content-Type", value: "multipart/form-data; boundary=<calculado ao enviar>", auto: true, info: true });

  add("User-Agent", USER_AGENT);
  add("Accept", "*/*");
  add("Accept-Encoding", "gzip, deflate, br");
  return auto;
}

/**
 * Resolves variables, auth and body into the payload expected by `send_http_request`.
 * Throws a readable Error when the URL is invalid.
 */
export function buildHttpRequest(request, { collection, scope, settings }) {
  const R = (t) => resolveVars(t, scope);

  let url = R(request.url.trim());
  for (const v of request.path_vars) {
    url = url.replace(new RegExp(`/:${v.key}(?=[/?#]|$)`, "g"), `/${encodeURIComponent(R(v.value))}`);
  }
  if (!url) throw new Error("Informe a URL da requisição.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL inválida: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Protocolo não suportado: ${parsed.protocol}`);

  const auth = effectiveAuth(request, collection);
  if (auth.type === "apikey" && auth.apikey.in === "query" && auth.apikey.key) {
    parsed.searchParams.append(R(auth.apikey.key), R(auth.apikey.value));
  }

  const headers = [
    ...request.headers.filter((h) => h.enabled && h.key.trim()).map((h) => ({ key: R(h.key.trim()), value: R(h.value) })),
    ...autoHeaders(request, collection, scope).filter((h) => !h.info),
  ];

  const b = request.body;
  let body = { kind: "none" };
  let bodyPreview = "";
  if (b.mode === "raw" && b.raw) {
    bodyPreview = R(b.raw);
    body = { kind: "text", text: bodyPreview };
  } else if (b.mode === "urlencoded") {
    bodyPreview = b.urlencoded
      .filter((p) => p.enabled && p.key)
      .map((p) => `${encodeURIComponent(R(p.key))}=${encodeURIComponent(R(p.value))}`)
      .join("&");
    body = { kind: "text", text: bodyPreview };
  } else if (b.mode === "form-data") {
    const fields = b.form
      .filter((f) => f.enabled && f.key)
      .map((f) => (f.type === "file" ? { key: R(f.key), value: "", file_path: f.file_path } : { key: R(f.key), value: R(f.value) }));
    body = { kind: "multipart", fields };
    bodyPreview = fields.map((f) => `${f.key}: ${f.file_path ? `@${f.file_path}` : f.value}`).join("\n");
  } else if (b.mode === "binary" && b.binary_path) {
    body = { kind: "file", path: b.binary_path };
    bodyPreview = `@${b.binary_path}`;
  } else if (b.mode === "graphql") {
    let variables = {};
    const rawVars = R(b.graphql.variables).trim();
    if (rawVars) {
      try {
        variables = JSON.parse(rawVars);
      } catch {
        throw new Error("As variáveis do GraphQL não são um JSON válido.");
      }
    }
    bodyPreview = JSON.stringify({ query: R(b.graphql.query), variables });
    body = { kind: "text", text: bodyPreview };
  }

  return {
    id: String(uid()),
    method: request.method,
    url: parsed.href,
    headers,
    body,
    bodyPreview,
    timeout_ms: request.settings.timeout_ms || settings.timeout_ms || DEFAULT_SETTINGS.timeout_ms,
    follow_redirects: request.settings.follow_redirects,
    verify_ssl: request.settings.verify_ssl,
    use_cookies: settings.use_cookies !== false,
  };
}

// ---------- Formatting ----------

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function statusClass(code) {
  if (!code) return "err";
  if (code < 300) return "ok";
  if (code < 400) return "redirect";
  return "fail";
}

export function headerValue(headers, name) {
  const lower = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === lower)?.[1] ?? null;
}

/** Parses `Set-Cookie` response headers into rows for the "Cookies" tab. */
export function parseSetCookies(headers) {
  return headers
    .filter(([k]) => k.toLowerCase() === "set-cookie")
    .map(([, v]) => {
      const [pair, ...attrs] = v.split(";");
      const eq = pair.indexOf("=");
      const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: "", path: "", expires: "", httpOnly: false, secure: false };
      for (const a of attrs) {
        const [k, ...rest] = a.split("=");
        const key = k.trim().toLowerCase();
        const val = rest.join("=").trim();
        if (key === "domain") cookie.domain = val;
        else if (key === "path") cookie.path = val;
        else if (key === "expires") cookie.expires = val;
        else if (key === "max-age") cookie.expires = cookie.expires || `${val}s`;
        else if (key === "httponly") cookie.httpOnly = true;
        else if (key === "secure") cookie.secure = true;
      }
      return cookie;
    });
}

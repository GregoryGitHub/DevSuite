// Conversions for the HTTP tab: cURL import, code snippets and Postman v2.1 import/export.

import {
  kv,
  uid,
  newRequest,
  newCollection,
  newAuth,
  normalizeEnvironment,
  mergeParamsFromUrl,
  syncPathVars,
  RAW_LANGS,
} from "./httpModel.js";

// ---------- cURL import ----------

/** Shell-like tokenizer: quotes, escapes and line continuations (bash "\" or cmd.exe "^"). */
function tokenize(cmd) {
  let src = cmd.replace(/\\\r?\n/g, " ");
  // Chrome's "Copy as cURL (cmd)": ^ escapes every special character, including the quotes.
  if (/\^\r?\n|\^"/.test(src)) src = src.replace(/\^\r?\n/g, " ").replace(/\^(.)/g, "$1");
  const tokens = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(src[i + 1] || "")) cur += src[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "$" && src[i + 1] === "'") {
      // $'...' (ANSI-C quoting from Chrome's "Copy as cURL")
      i++;
      quote = "'";
      has = true;
    } else if (c === "\\" && i + 1 < src.length) {
      cur += src[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

const FLAGS_WITH_VALUE = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii",
  "--data-urlencode", "-F", "--form", "--form-string", "-u", "--user", "--url", "-A", "--user-agent",
  "-b", "--cookie", "-e", "--referer", "-m", "--max-time", "--connect-timeout", "-o", "--output", "-x", "--proxy",
]);

export function looksLikeCurl(text) {
  return /^\s*curl(\.exe)?\s/i.test(text);
}

/** Parses a cURL command into request fields. Throws when it is not a cURL command. */
export function parseCurl(cmd) {
  const tokens = tokenize(cmd.trim());
  if (!tokens.length || !/^curl(\.exe)?$/i.test(tokens[0])) throw new Error("O texto não começa com \"curl\".");

  let method = null;
  let url = "";
  let getMode = false;
  const headers = [];
  const data = [];
  const urlencoded = [];
  const form = [];
  const settings = { timeout_ms: 0, follow_redirects: false, verify_ssl: true };
  let auth = newAuth("none");

  for (let i = 1; i < tokens.length; i++) {
    let t = tokens[i];
    let val = null;
    if (t.startsWith("--") && t.includes("=")) {
      val = t.slice(t.indexOf("=") + 1);
      t = t.slice(0, t.indexOf("="));
    } else if (/^-[A-Za-z]./.test(t) && FLAGS_WITH_VALUE.has(t.slice(0, 2))) {
      val = t.slice(2);
      t = t.slice(0, 2);
    }
    const next = () => val ?? tokens[++i] ?? "";

    switch (t) {
      case "-X":
      case "--request":
        method = next().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = next();
        const idx = h.indexOf(":");
        if (idx > 0) headers.push(kv(h.slice(0, idx).trim(), h.slice(idx + 1).trim()));
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        data.push(next());
        break;
      case "--data-urlencode": {
        const v = next();
        const eq = v.indexOf("=");
        urlencoded.push(eq >= 0 ? kv(v.slice(0, eq), v.slice(eq + 1)) : kv(v, ""));
        break;
      }
      case "-F":
      case "--form":
      case "--form-string": {
        const v = next();
        const eq = v.indexOf("=");
        const key = eq >= 0 ? v.slice(0, eq) : v;
        const value = eq >= 0 ? v.slice(eq + 1) : "";
        if (t !== "--form-string" && value.startsWith("@")) {
          form.push({ ...kv(key, ""), type: "file", file_path: value.slice(1).split(";")[0] });
        } else form.push({ ...kv(key, value), type: "text", file_path: "" });
        break;
      }
      case "-u":
      case "--user": {
        const v = next();
        const idx = v.indexOf(":");
        auth = newAuth("basic");
        auth.basic = { username: idx >= 0 ? v.slice(0, idx) : v, password: idx >= 0 ? v.slice(idx + 1) : "" };
        break;
      }
      case "-A":
      case "--user-agent":
        headers.push(kv("User-Agent", next()));
        break;
      case "-b":
      case "--cookie":
        headers.push(kv("Cookie", next()));
        break;
      case "-e":
      case "--referer":
        headers.push(kv("Referer", next()));
        break;
      case "-m":
      case "--max-time":
        settings.timeout_ms = Math.round(parseFloat(next()) * 1000) || 0;
        break;
      case "--url":
        url = next();
        break;
      case "-G":
      case "--get":
        getMode = true;
        break;
      case "-I":
      case "--head":
        method = "HEAD";
        break;
      case "-L":
      case "--location":
        settings.follow_redirects = true;
        break;
      case "-k":
      case "--insecure":
        settings.verify_ssl = false;
        break;
      default:
        if (FLAGS_WITH_VALUE.has(t)) next();
        else if (!t.startsWith("-") && !url) url = t;
    }
  }

  if (!url) throw new Error("Nenhuma URL encontrada no comando cURL.");

  // Bearer tokens become proper auth instead of a raw header.
  const authIdx = headers.findIndex((h) => h.key.toLowerCase() === "authorization" && /^bearer\s+/i.test(h.value));
  if (authIdx >= 0 && auth.type === "none") {
    auth = newAuth("bearer");
    auth.bearer.token = headers[authIdx].value.replace(/^bearer\s+/i, "");
    headers.splice(authIdx, 1);
  }

  const body = { mode: "none", raw: "", lang: "json", form: [], urlencoded: [], binary_path: "", graphql: { query: "", variables: "" } };
  const ctIdx = headers.findIndex((h) => h.key.toLowerCase() === "content-type");
  const contentType = ctIdx >= 0 ? headers[ctIdx].value.toLowerCase() : "";

  if (getMode && (data.length || urlencoded.length)) {
    const qs = [...data, ...urlencoded.map((p) => `${p.key}=${encodeURIComponent(p.value)}`)].join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
  } else if (form.length) {
    body.mode = "form-data";
    body.form = form;
    if (contentType.startsWith("multipart/")) headers.splice(ctIdx, 1);
  } else if (urlencoded.length || (data.length && (contentType.includes("x-www-form-urlencoded") || (!contentType && data.every((d) => /^[^{[<\s][^=\s]*=/.test(d)))))) {
    body.mode = "urlencoded";
    body.urlencoded = [
      ...data.flatMap((d) => d.split("&")).map((pair) => {
        const eq = pair.indexOf("=");
        const dec = (s) => {
          try {
            return decodeURIComponent(s.replace(/\+/g, " "));
          } catch {
            return s;
          }
        };
        return eq >= 0 ? kv(dec(pair.slice(0, eq)), dec(pair.slice(eq + 1))) : kv(dec(pair), "");
      }),
      ...urlencoded,
    ];
    if (ctIdx >= 0) headers.splice(ctIdx, 1);
  } else if (data.length) {
    const raw = data.join("&");
    let lang = "text";
    if (contentType.includes("json")) lang = "json";
    else if (contentType.includes("xml")) lang = "xml";
    else if (contentType.includes("html")) lang = "html";
    else if (!contentType && /^\s*[[{]/.test(raw)) lang = "json";
    if (lang === "json") {
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj.query === "string" && contentType.includes("json") && /^\s*(query|mutation|\{)/.test(obj.query)) {
          body.mode = "graphql";
          body.graphql = { query: obj.query, variables: obj.variables ? JSON.stringify(obj.variables, null, 2) : "" };
        }
      } catch {
        /* keeps raw */
      }
    }
    if (body.mode === "none") {
      body.mode = "raw";
      body.raw = raw;
      body.lang = lang;
    }
    const auto = RAW_LANGS.find((l) => l.id === lang)?.type;
    if (ctIdx >= 0 && (contentType === auto || (body.mode === "graphql" && contentType.includes("json")))) headers.splice(ctIdx, 1);
  }

  if (!method) method = body.mode !== "none" ? "POST" : "GET";
  const name = (() => {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
      return `${method} ${u.pathname === "/" ? u.host : u.pathname}`;
    } catch {
      return "Requisição importada";
    }
  })();

  return newRequest({
    name,
    method,
    url,
    params: mergeParamsFromUrl(url, []),
    path_vars: syncPathVars(url, []),
    headers,
    auth,
    body,
    settings,
  });
}

// ---------- Code snippets ----------

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const jsStr = (s) => JSON.stringify(String(s));
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** `built` is the output of buildHttpRequest (variables already resolved). */
export const SNIPPETS = [
  {
    id: "curl",
    label: "cURL",
    gen(b) {
      const lines = [`curl --location --request ${b.method} ${shQuote(b.url)}`];
      if (!b.follow_redirects) lines[0] = lines[0].replace("--location ", "");
      if (!b.verify_ssl) lines.push("--insecure");
      for (const h of b.headers) {
        if (isDefaultHeader(h)) continue;
        lines.push(`--header ${shQuote(`${h.key}: ${h.value}`)}`);
      }
      if (b.body.kind === "text") lines.push(`--data-raw ${shQuote(b.body.text)}`);
      if (b.body.kind === "file") lines.push(`--data-binary ${shQuote(`@${b.body.path}`)}`);
      if (b.body.kind === "multipart") {
        for (const f of b.body.fields) lines.push(`--form ${shQuote(f.file_path ? `${f.key}=@"${f.file_path}"` : `${f.key}=${f.value}`)}`);
      }
      return lines.join(" \\\n  ");
    },
  },
  {
    id: "fetch",
    label: "JavaScript (fetch)",
    gen(b) {
      const headers = b.headers.filter((h) => !isDefaultHeader(h));
      const out = [];
      if (b.body.kind === "multipart") {
        out.push("const formData = new FormData();");
        for (const f of b.body.fields) {
          out.push(f.file_path ? `formData.append(${jsStr(f.key)}, fileInput.files[0], ${jsStr(f.file_path.split(/[\\/]/).pop())});` : `formData.append(${jsStr(f.key)}, ${jsStr(f.value)});`);
        }
        out.push("");
      }
      out.push(`const response = await fetch(${jsStr(b.url)}, {`);
      out.push(`  method: ${jsStr(b.method)},`);
      if (headers.length) {
        out.push("  headers: {");
        for (const h of headers) out.push(`    ${jsStr(h.key)}: ${jsStr(h.value)},`);
        out.push("  },");
      }
      if (b.body.kind === "text") {
        let bodyExpr = jsStr(b.body.text);
        try {
          const parsed = JSON.parse(b.body.text);
          if (parsed && typeof parsed === "object") bodyExpr = `JSON.stringify(${JSON.stringify(parsed, null, 2).replace(/\n/g, "\n  ")})`;
        } catch {
          /* plain string */
        }
        out.push(`  body: ${bodyExpr},`);
      }
      if (b.body.kind === "multipart") out.push("  body: formData,");
      if (b.follow_redirects === false) out.push('  redirect: "manual",');
      out.push("});");
      out.push("");
      out.push("console.log(response.status, await response.text());");
      return out.join("\n");
    },
  },
  {
    id: "python",
    label: "Python (requests)",
    gen(b) {
      const headers = b.headers.filter((h) => !isDefaultHeader(h));
      const py = (s) => JSON.stringify(String(s));
      const out = ["import requests", "", `url = ${py(b.url)}`];
      out.push(headers.length ? `headers = {\n${headers.map((h) => `    ${py(h.key)}: ${py(h.value)},`).join("\n")}\n}` : "headers = {}");
      const args = ["url", "headers=headers"];
      if (b.body.kind === "text") {
        out.push(`payload = ${py(b.body.text)}`);
        args.push("data=payload.encode()");
      }
      if (b.body.kind === "file") {
        out.push(`payload = open(${py(b.body.path)}, "rb")`);
        args.push("data=payload");
      }
      if (b.body.kind === "multipart") {
        const data = b.body.fields.filter((f) => !f.file_path);
        const files = b.body.fields.filter((f) => f.file_path);
        out.push(`data = {${data.map((f) => `${py(f.key)}: ${py(f.value)}`).join(", ")}}`);
        out.push(`files = {${files.map((f) => `${py(f.key)}: open(${py(f.file_path)}, "rb")`).join(", ")}}`);
        args.push("data=data", "files=files");
      }
      if (!b.verify_ssl) args.push("verify=False");
      if (!b.follow_redirects) args.push("allow_redirects=False");
      args.push(`timeout=${Math.round(b.timeout_ms / 1000)}`);
      out.push("", `response = requests.request(${py(b.method)}, ${args.join(", ")})`, "", "print(response.status_code)", "print(response.text)");
      return out.join("\n");
    },
  },
  {
    id: "powershell",
    label: "PowerShell",
    gen(b) {
      const headers = b.headers.filter((h) => !isDefaultHeader(h) && h.key.toLowerCase() !== "content-type");
      const ct = b.headers.find((h) => h.key.toLowerCase() === "content-type")?.value;
      const out = ["$headers = @{"];
      for (const h of headers) out.push(`    ${psQuote(h.key)} = ${psQuote(h.value)}`);
      out.push("}");
      const args = [`-Uri ${psQuote(b.url)}`, `-Method ${b.method}`, "-Headers $headers"];
      if (b.body.kind === "text") {
        out.push(`$body = @'\n${b.body.text}\n'@`);
        args.push("-Body $body");
      }
      if (b.body.kind === "file") args.push(`-InFile ${psQuote(b.body.path)}`);
      if (b.body.kind === "multipart") {
        out.push("$form = @{");
        for (const f of b.body.fields) out.push(`    ${psQuote(f.key)} = ${f.file_path ? `Get-Item ${psQuote(f.file_path)}` : psQuote(f.value)}`);
        out.push("}");
        args.push("-Form $form");
      }
      if (ct && b.body.kind !== "multipart") args.push(`-ContentType ${psQuote(ct)}`);
      if (!b.verify_ssl) args.push("-SkipCertificateCheck");
      if (!b.follow_redirects) args.push("-MaximumRedirection 0");
      out.push("", `$response = Invoke-WebRequest ${args.join(" `\n    ")}`, "$response.StatusCode", "$response.Content");
      return out.join("\n");
    },
  },
];

function isDefaultHeader(h) {
  return (
    (h.key === "User-Agent" && h.value.startsWith("TodoRS-HTTP")) ||
    (h.key === "Accept" && h.value === "*/*") ||
    (h.key === "Accept-Encoding" && h.value === "gzip, deflate, br")
  );
}

// ---------- Postman Collection v2.1 ----------

function pmKv(list) {
  return (list || []).map((x) => ({ key: String(x.key ?? ""), value: String(x.value ?? ""), enabled: !x.disabled, description: typeof x.description === "string" ? x.description : "" }));
}

function pmAuthIn(a) {
  if (!a || !a.type) return null;
  const get = (list, key) => (Array.isArray(list) ? list.find((x) => x.key === key)?.value ?? "" : list?.[key] ?? "");
  const auth = newAuth("none");
  if (a.type === "noauth") return auth;
  if (a.type === "bearer") {
    auth.type = "bearer";
    auth.bearer.token = String(get(a.bearer, "token"));
  } else if (a.type === "basic") {
    auth.type = "basic";
    auth.basic = { username: String(get(a.basic, "username")), password: String(get(a.basic, "password")) };
  } else if (a.type === "apikey") {
    auth.type = "apikey";
    auth.apikey = { key: String(get(a.apikey, "key")), value: String(get(a.apikey, "value")), in: get(a.apikey, "in") === "query" ? "query" : "header" };
  } else return null;
  return auth;
}

function pmScripts(events) {
  const scripts = { pre: "", test: "" };
  for (const ev of events || []) {
    const exec = Array.isArray(ev.script?.exec) ? ev.script.exec.join("\n") : String(ev.script?.exec ?? "");
    if (ev.listen === "prerequest") scripts.pre = exec;
    if (ev.listen === "test") scripts.test = exec;
  }
  return scripts;
}

function pmRequestIn(item, collectionId, folderId) {
  const r = typeof item.request === "string" ? { url: item.request, method: "GET" } : item.request || {};
  const url = typeof r.url === "string" ? r.url : r.url?.raw || "";
  const pathVars = typeof r.url === "object" ? pmKv(r.url.variable) : [];
  const b = r.body || {};
  const body = { mode: "none", raw: "", lang: "json", form: [], urlencoded: [], binary_path: "", graphql: { query: "", variables: "" } };
  if (b.mode === "raw") {
    body.mode = "raw";
    body.raw = b.raw || "";
    const lang = b.options?.raw?.language;
    body.lang = RAW_LANGS.some((l) => l.id === lang) ? lang : /^\s*[[{]/.test(body.raw) ? "json" : "text";
  } else if (b.mode === "urlencoded") {
    body.mode = "urlencoded";
    body.urlencoded = pmKv(b.urlencoded);
  } else if (b.mode === "formdata") {
    body.mode = "form-data";
    body.form = (b.formdata || []).map((f) => ({
      ...pmKv([f])[0],
      type: f.type === "file" ? "file" : "text",
      file_path: f.type === "file" ? String(Array.isArray(f.src) ? f.src[0] ?? "" : f.src ?? "") : "",
    }));
  } else if (b.mode === "file") {
    body.mode = "binary";
    body.binary_path = String(b.file?.src ?? "");
  } else if (b.mode === "graphql") {
    body.mode = "graphql";
    body.graphql = { query: b.graphql?.query || "", variables: b.graphql?.variables || "" };
  }
  const auth = pmAuthIn(r.auth) || newAuth("inherit");
  return newRequest({
    collection_id: collectionId,
    folder_id: folderId,
    name: item.name || url || "Requisição",
    method: r.method || "GET",
    url,
    params: mergeParamsFromUrl(url, []).map((p) => {
      const meta = typeof r.url === "object" ? (r.url.query || []).find((q) => q.key === p.key) : null;
      return { ...p, description: typeof meta?.description === "string" ? meta.description : "" };
    }).concat(typeof r.url === "object" ? pmKv((r.url.query || []).filter((q) => q.disabled)) : []),
    path_vars: syncPathVars(url, pathVars),
    headers: pmKv(r.header),
    auth,
    body,
    scripts: pmScripts(item.event),
  });
}

/**
 * Imports a Postman collection (v2.0/v2.1) or environment.
 * Returns { collection, requests } or { environment }.
 */
export function importPostman(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  if (data && Array.isArray(data.values) && !data.item) {
    return {
      environment: normalizeEnvironment({ id: uid(), name: data.name || "Ambiente importado", values: pmKv(data.values) }),
    };
  }
  if (!data || !Array.isArray(data.item)) throw new Error("Arquivo não reconhecido como coleção ou ambiente do Postman.");

  const collection = newCollection(data.info?.name || "Coleção importada");
  collection.description = typeof data.info?.description === "string" ? data.info.description : "";
  collection.variables = pmKv(data.variable);
  collection.auth = pmAuthIn(data.auth) || newAuth("none");
  collection.scripts = pmScripts(data.event);
  const requests = [];

  // Postman folders (any depth) become folders with parent_id. A folder's auth applies to
  // the requests below it that inherit (our requests only inherit from the collection).
  const walk = (items, folderId, inheritedAuth) => {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        const folder = { id: uid(), name: String(item.name || "Pasta"), parent_id: folderId, collapsed: false };
        collection.folders.push(folder);
        walk(item.item, folder.id, pmAuthIn(item.auth) || inheritedAuth);
      } else {
        const req = pmRequestIn(item, collection.id, folderId);
        if (req.auth.type === "inherit" && inheritedAuth) req.auth = JSON.parse(JSON.stringify(inheritedAuth));
        requests.push(req);
      }
    }
  };
  walk(data.item, 0, null);
  return { collection, requests };
}

function pmAuthOut(auth) {
  if (auth.type === "inherit") return undefined;
  if (auth.type === "none") return { type: "noauth" };
  if (auth.type === "bearer") return { type: "bearer", bearer: [{ key: "token", value: auth.bearer.token, type: "string" }] };
  if (auth.type === "basic") {
    return { type: "basic", basic: [{ key: "username", value: auth.basic.username, type: "string" }, { key: "password", value: auth.basic.password, type: "string" }] };
  }
  return {
    type: "apikey",
    apikey: [
      { key: "key", value: auth.apikey.key, type: "string" },
      { key: "value", value: auth.apikey.value, type: "string" },
      { key: "in", value: auth.apikey.in, type: "string" },
    ],
  };
}

function pmEventsOut(scripts) {
  const events = [];
  if (scripts.pre.trim()) events.push({ listen: "prerequest", script: { type: "text/javascript", exec: scripts.pre.split("\n") } });
  if (scripts.test.trim()) events.push({ listen: "test", script: { type: "text/javascript", exec: scripts.test.split("\n") } });
  return events.length ? events : undefined;
}

const pmKvOut = (list) =>
  list.filter((x) => x.key || x.value).map((x) => ({ key: x.key, value: x.value, ...(x.enabled ? {} : { disabled: true }), ...(x.description ? { description: x.description } : {}) }));

function pmRequestOut(r) {
  const b = r.body;
  let body;
  if (b.mode === "raw") body = { mode: "raw", raw: b.raw, options: { raw: { language: b.lang } } };
  if (b.mode === "urlencoded") body = { mode: "urlencoded", urlencoded: pmKvOut(b.urlencoded) };
  if (b.mode === "form-data") {
    body = {
      mode: "formdata",
      formdata: b.form.filter((f) => f.key).map((f) => (f.type === "file" ? { key: f.key, type: "file", src: f.file_path, ...(f.enabled ? {} : { disabled: true }) } : { key: f.key, value: f.value, type: "text", ...(f.enabled ? {} : { disabled: true }) })),
    };
  }
  if (b.mode === "binary") body = { mode: "file", file: { src: b.binary_path } };
  if (b.mode === "graphql") body = { mode: "graphql", graphql: { query: b.graphql.query, variables: b.graphql.variables } };

  return {
    name: r.name,
    event: pmEventsOut(r.scripts),
    request: {
      auth: pmAuthOut(r.auth),
      method: r.method,
      header: pmKvOut(r.headers),
      body,
      url: {
        raw: r.url,
        query: r.params.length ? pmKvOut(r.params) : undefined,
        variable: r.path_vars.length ? pmKvOut(r.path_vars) : undefined,
      },
    },
  };
}

export function exportPostman(collection, requests) {
  const ids = new Set(collection.folders.map((f) => f.id));
  // Requests in a folder that no longer exists go to the root.
  const inFolder = (fid) => requests.filter((r) => (ids.has(r.folder_id) ? r.folder_id : 0) === fid).map(pmRequestOut);
  const folderItems = (pid) =>
    collection.folders.filter((f) => (f.parent_id || 0) === pid).map((f) => ({ name: f.name, item: [...inFolder(f.id), ...folderItems(f.id)] }));
  return {
    info: {
      _postman_id: crypto.randomUUID(),
      name: collection.name,
      description: collection.description || undefined,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [...folderItems(0), ...inFolder(0)],
    auth: pmAuthOut(collection.auth),
    event: pmEventsOut(collection.scripts),
    variable: collection.variables.length ? pmKvOut(collection.variables) : undefined,
  };
}

export function exportPostmanEnvironment(env) {
  return {
    id: crypto.randomUUID(),
    name: env.name,
    values: env.values.map((v) => ({ key: v.key, value: v.value, type: "default", enabled: v.enabled })),
    _postman_variable_scope: "environment",
  };
}

// CLI: `devsuite http ...` (ver src-tauri/cli/commands.json), sobre o documento vivo (state.http).
// Envio, scripts e variáveis passam pelo mesmo pipeline da interface (httpHost.execute).

import { state } from "../state.js";
import { readTextFileApi, writeFileApi } from "../api.js";
import { httpHost as host } from "../components/http.js";
import {
  uid, kv, newRequest, newCollection, normalizeRequest, newAuth, mergeParamsFromUrl, urlWithParams, syncPathVars, normalizeEnvironment,
  METHODS, formatBytes,
} from "../utils/httpModel.js";
import { parseCurl, importPostman, exportPostman } from "../utils/httpConvert.js";
import { folderPath, ensureFolderPath, descendantIds } from "../utils/folderTree.js";
import { CliError, pick, list, splitPair, requireFlag, iso, fold, parseAuth } from "./cliUtils.js";

const data = () => {
  if (!state.http) throw new CliError("unavailable", "O HTTP ainda não carregou");
  return state.http;
};
const findColl = (id) => data().collections.find((c) => c.id === id) || null;

/** "Coleção/Pasta/Sub/Nome" de uma requisição. */
function pathOf(req) {
  const coll = findColl(req.collection_id);
  const folder = coll && req.folder_id ? folderPath(coll.folders, req.folder_id, "/") : "";
  return [coll?.name || "?", folder, req.name].filter(Boolean).join("/");
}

function findCollection(wanted) {
  return pick(data().collections, wanted, { what: "coleção" });
}

/** Pasta pelo caminho "a/b" dentro da coleção (criada se faltar com `create`); "" = raiz. */
function folderIn(coll, path, { create = false } = {}) {
  const names = String(path || "").split("/").map((x) => x.trim()).filter(Boolean);
  if (!names.length) return 0;
  let missing = false;
  const id = ensureFolderPath(coll.folders, 0, names, (name, parent) => {
    if (!create) {
      missing = true;
      return { id: -1 };
    }
    const f = { id: uid(), name: name.slice(0, 60), parent_id: parent, collapsed: false };
    coll.folders.push(f);
    return f;
  });
  if (missing) throw new CliError("not_found", `Pasta não encontrada em ${coll.name}: ${path}`);
  return id;
}

function findRequest(wanted) {
  const w = String(wanted ?? "").trim();
  const reqs = data().requests;
  // Caminho completo "Coleção/Pasta/Nome" (sem acento/maiúsculas).
  const byPath = reqs.filter((r) => fold(pathOf(r)) === fold(w));
  if (byPath.length === 1) return byPath[0];
  return pick(reqs, w, { what: "requisição", name: (r) => (w.includes("/") ? pathOf(r) : r.name), label: pathOf });
}

function findEnv(wanted) {
  return pick(data().environments, wanted, { what: "ambiente" });
}

/** --env: undefined = o ativo; "none" = nenhum. */
function envArg(wanted) {
  if (wanted === undefined || wanted === null) return undefined;
  if (["none", "nenhum", ""].includes(fold(wanted))) return null;
  return findEnv(wanted);
}

const localsOf = (vars) => list(vars).map((v) => splitPair(v));

function requestView(r, { full = false } = {}) {
  const base = { id: r.id, name: r.name, method: r.method, url: r.url, path: pathOf(r), updated: iso(r.updated_at) };
  if (!full) return base;
  const on = (l) => l.filter((x) => x.enabled).map((x) => ({ key: x.key, value: x.value }));
  const b = r.body;
  const body =
    b.mode === "raw" ? { mode: "raw", lang: b.lang, raw: b.raw }
    : b.mode === "urlencoded" ? { mode: "urlencoded", fields: on(b.urlencoded) }
    : b.mode === "form-data" ? { mode: "form-data", fields: b.form.filter((f) => f.enabled).map((f) => ({ key: f.key, value: f.value, type: f.type, file_path: f.file_path || undefined })) }
    : b.mode === "graphql" ? { mode: "graphql", query: b.graphql.query, variables: b.graphql.variables }
    : b.mode === "binary" ? { mode: "binary", path: b.binary_path }
    : { mode: "none" };
  return {
    ...base,
    params: on(r.params),
    path_vars: r.path_vars.map((x) => ({ key: x.key, value: x.value })),
    headers: on(r.headers),
    auth: r.auth.type === "bearer" ? { type: "bearer", token: r.auth.bearer.token }
      : r.auth.type === "basic" ? { type: "basic", username: r.auth.basic.username, password: r.auth.basic.password }
      : r.auth.type === "apikey" ? { type: "apikey", ...r.auth.apikey }
      : { type: r.auth.type },
    body,
    scripts: { pre: r.scripts.pre, test: r.scripts.test },
    settings: r.settings,
  };
}

// ---------- Edição ----------

const RAW_TYPES = ["json", "text", "xml", "html", "javascript"];

/** Aplica as opções de create/update na requisição (só as informadas). */
function applyFields(req, p) {
  if (p.name !== undefined) req.name = String(p.name).trim() || req.name;
  if (p.method !== undefined) {
    const m = String(p.method).toUpperCase();
    if (!METHODS.includes(m) && !/^[A-Z]+$/.test(m)) throw new CliError("usage", `Método inválido: ${p.method}`);
    req.method = m;
  }
  if (p.url !== undefined) {
    req.url = String(p.url).trim();
    req.params = mergeParamsFromUrl(req.url, []);
  }
  if (p.param !== undefined) {
    req.params = localsOf(p.param).map(([k, v]) => kv(k, v));
    req.url = urlWithParams(req.url, req.params);
  }
  if (p.url !== undefined || p.param !== undefined) req.path_vars = syncPathVars(req.url, req.path_vars);
  if (p.header !== undefined) req.headers = list(p.header).map((h) => kv(...splitPair(h, [":", "="])));
  const type = p.body_type !== undefined ? fold(p.body_type) : null;
  if (type !== null || p.body !== undefined || p.form !== undefined) {
    const t = type ?? (p.form !== undefined ? "urlencoded" : /^\s*[[{]/.test(p.body ?? "") ? "json" : "text");
    const body = req.body;
    if (t === "none") body.mode = "none";
    else if (RAW_TYPES.includes(t)) {
      body.mode = "raw";
      body.lang = t;
      if (p.body !== undefined) body.raw = String(p.body);
    } else if (t === "graphql") {
      body.mode = "graphql";
      if (p.body !== undefined) body.graphql.query = String(p.body);
    } else if (t === "urlencoded" || t === "form" || t === "form-data") {
      const fields = localsOf(p.form).map(([k, v]) => kv(k, v));
      if (t === "urlencoded") {
        body.mode = "urlencoded";
        if (p.form !== undefined) body.urlencoded = fields;
      } else {
        body.mode = "form-data";
        if (p.form !== undefined) {
          // "campo=@arquivo" = upload de arquivo.
          body.form = fields.map((f) =>
            f.value.startsWith("@") ? { ...f, value: "", type: "file", file_path: f.value.slice(1) } : { ...f, type: "text", file_path: "" },
          );
        }
      }
    } else throw new CliError("usage", `--body-type inválido: ${p.body_type}`);
  }
  if (p.auth !== undefined) req.auth = parseAuth(p.auth);
  if (p.pre_script !== undefined) req.scripts.pre = String(p.pre_script);
  if (p.test_script !== undefined) req.scripts.test = String(p.test_script);
  if (p.description !== undefined) req.description = String(p.description);
  req.updated_at = Date.now();
}

// ---------- Resposta ----------

function responseView(entry, { maxBody = 512, bodyOnly = false } = {}) {
  const res = entry.response;
  if (bodyOnly) {
    if (!res) throw new CliError("failed", entry.error || "Sem resposta");
    return res.body_base64 ? res.body_base64 : res.body;
  }
  const out = { ok: !!res && !entry.error && entry.tests.every((t) => t.passed !== false) };
  if (entry.sent) out.request = { method: entry.sent.method, url: entry.sent.url };
  if (res) {
    let body = res.body_base64 ? null : res.body;
    let truncated = false;
    const limit = maxBody * 1024;
    if (body && maxBody > 0 && body.length > limit) {
      body = body.slice(0, limit);
      truncated = true;
    }
    Object.assign(out, {
      status: res.status,
      status_text: res.status_text,
      time_ms: res.time_ms,
      size: formatBytes(res.body_size + res.headers_size),
      headers: Object.fromEntries(res.headers.map(([k, v]) => [k, v])),
      body,
    });
    if (res.body_base64) out.body_base64 = res.body_base64.length > maxBody * 1024 && maxBody > 0 ? "(binário grande omitido; use --max-body 0)" : res.body_base64;
    if (truncated) out.body_truncated = `corpo cortado em ${maxBody} KB (use --max-body)`;
  }
  if (entry.error) out.error = entry.error;
  if (entry.tests.length) out.tests = entry.tests.map((t) => ({ name: t.name, passed: t.passed, error: t.error || undefined }));
  if (entry.logs.length) out.logs = entry.logs.map((l) => (typeof l === "string" ? l : `${l.level || "log"}: ${l.text ?? l.message ?? JSON.stringify(l)}`));
  return out;
}

async function send(req, p, { record = true } = {}) {
  const entry = await host.execute(req, {
    key: `cli:${req.id}:${uid()}`,
    record,
    environment: envArg(p.env),
    locals: localsOf(p.var),
  });
  return responseView(entry, { maxBody: p.max_body ?? 512, bodyOnly: !!p.body_only });
}

// ---------- Comandos ----------

async function collections() {
  return data().collections.map((c) => ({
    id: c.id,
    name: c.name,
    requests: data().requests.filter((r) => r.collection_id === c.id).length,
    folders: c.folders.map((f) => folderPath(c.folders, f.id, "/")),
    variables: c.variables.filter((v) => v.enabled).map((v) => v.key),
    auth: c.auth.type,
  }));
}

async function requests(p) {
  let reqs = data().requests;
  if (p.collection !== undefined) {
    const coll = findCollection(p.collection);
    reqs = reqs.filter((r) => r.collection_id === coll.id);
    if (p.folder !== undefined) {
      const ids = descendantIds(coll.folders, folderIn(coll, p.folder));
      reqs = reqs.filter((r) => ids.has(r.folder_id));
    }
  } else if (p.folder !== undefined) throw new CliError("usage", "--folder exige --collection");
  if (p.query) {
    const q = fold(p.query);
    reqs = reqs.filter((r) => fold(r.name).includes(q) || fold(r.url).includes(q) || fold(r.method) === q);
  }
  return reqs.map((r) => requestView(r));
}

async function requestGet(p) {
  return requestView(findRequest(p.request), { full: true });
}

function ensureCollection(name) {
  const hits = data().collections.filter((c) => fold(c.name) === fold(name));
  if (hits.length) return hits[0];
  const coll = newCollection(String(name).trim());
  data().collections.push(coll);
  return coll;
}

async function requestCreate(p) {
  const coll = ensureCollection(p.collection);
  const folderId = folderIn(coll, p.folder, { create: true });
  const req = newRequest({ collection_id: coll.id, folder_id: folderId, name: p.name, auth: newAuth("inherit") });
  applyFields(req, p);
  data().requests.push(req);
  host.commit();
  return requestView(req, { full: true });
}

async function requestUpdate(p) {
  const req = findRequest(p.request);
  applyFields(req, p);
  if (p.folder !== undefined) req.folder_id = folderIn(findColl(req.collection_id), p.folder, { create: true });
  host.commit();
  return requestView(req, { full: true });
}

async function requestDelete(p) {
  requireFlag(p, "yes", "Excluir uma requisição exige --yes");
  const req = findRequest(p.request);
  const path = pathOf(req);
  host.deleteRequest(req.id);
  host.commit();
  return { id: req.id, path, deleted: true };
}

async function sendCmd(p) {
  return send(findRequest(p.request), p, { record: !p.no_history });
}

async function curl(p) {
  let parsed;
  try {
    parsed = parseCurl(String(p.command));
  } catch (e) {
    throw new CliError("usage", e.message || String(e));
  }
  if (p.save) {
    const coll = p.collection ? ensureCollection(p.collection) : data().collections[0];
    const req = normalizeRequest({ ...parsed, id: uid(), collection_id: coll.id, folder_id: 0, name: p.name || parsed.name, created_at: Date.now(), updated_at: Date.now() });
    data().requests.push(req);
    host.commit();
    const out = await send(req, p);
    return p.body_only ? out : { saved: pathOf(req), ...out };
  }
  // Sem salvar: uma requisição temporária, sem histórico, com as variáveis do ambiente.
  const coll = p.collection ? findCollection(p.collection) : null;
  const req = normalizeRequest({ ...parsed, id: uid(), collection_id: coll?.id || 0, folder_id: 0, auth: parsed.auth || newAuth("none") });
  const entry = await host.execute(req, { key: `cli:curl:${uid()}`, record: false, environment: envArg(p.env), locals: [] });
  return responseView(entry, { maxBody: p.max_body ?? 512, bodyOnly: !!p.body_only });
}

async function run(p, ctx) {
  const target = String(p.target);
  const slash = target.indexOf("/");
  const coll = findCollection(slash < 0 ? target : target.slice(0, slash));
  const folderIds = slash < 0 ? null : descendantIds(coll.folders, folderIn(coll, target.slice(slash + 1)));
  const reqs = host.runnerOrder(coll, folderIds);
  if (!reqs.length) throw new CliError("not_found", `Nenhuma requisição em ${target}`);
  const iterations = Math.max(1, p.iterations || 1);
  const environment = envArg(p.env);
  const results = [];
  let failed = 0;
  outer: for (let it = 0; it < iterations; it++) {
    for (const req of reqs) {
      if (ctx.cancelled) break outer;
      const entry = await host.execute(req, { key: `cli:run:${req.id}:${uid()}`, iteration: it, record: false, environment, locals: localsOf(p.var) });
      const res = entry.response;
      const tests = entry.tests;
      const bad = !res || !!entry.error || tests.some((t) => t.passed === false) || (res && res.status >= 400);
      if (bad) failed++;
      const row = {
        iteration: it + 1,
        path: pathOf(req),
        status: res?.status ?? null,
        time_ms: res?.time_ms ?? null,
        tests: tests.length ? `${tests.filter((t) => t.passed !== false).length}/${tests.length}` : "",
        error: entry.error || (tests.find((t) => t.passed === false)?.name ? `teste falhou: ${tests.find((t) => t.passed === false).name}` : ""),
      };
      results.push(row);
      ctx.event({ line: `${row.status ?? "ERR"}  ${req.method} ${row.path}  ${row.time_ms ?? "-"} ms  ${row.tests} ${row.error}`.trimEnd() });
      if (bad && p.bail) break outer;
      if (p.delay) await new Promise((r) => setTimeout(r, p.delay));
    }
  }
  return { collection: coll.name, requests: results.length, failed, results };
}

function envView(e) {
  return {
    id: e.id,
    name: e.name,
    active: e.id === data().active_env,
    variables: Object.fromEntries(e.values.filter((v) => v.enabled).map((v) => [v.key, v.value])),
  };
}

async function envs() {
  return {
    active: host.activeEnv()?.name || null,
    environments: data().environments.map(envView),
    globals: Object.fromEntries(data().globals.filter((v) => v.enabled).map((v) => [v.key, v.value])),
  };
}

async function envSet(p) {
  const name = String(p.env).trim();
  let values;
  let env = null;
  if (fold(name) === "globals" || fold(name) === "globais") values = data().globals;
  else {
    env = data().environments.find((e) => fold(e.name) === fold(name));
    if (!env) {
      env = normalizeEnvironment({ id: uid(), name, values: [] });
      data().environments.push(env);
    }
    values = env.values;
  }
  for (const [k, v] of localsOf(p.var)) {
    const row = values.find((x) => x.key === k);
    if (row) {
      row.value = v;
      row.enabled = true;
    } else values.push({ ...kv(k, v), ...(p.secret ? { secret: true } : {}) });
  }
  host.commit();
  return env ? envView(env) : { name: "globals", variables: Object.fromEntries(values.map((v) => [v.key, v.value])) };
}

async function envUse(p) {
  const env = envArg(p.env);
  host.setActiveEnv(env ? env.id : null);
  host.commit();
  return { active: env ? env.name : null };
}

async function history(p) {
  return data()
    .history.slice(0, p.limit ?? 20)
    .map((h) => ({ id: h.id, at: iso(h.at), method: h.request.method, url: h.request.url, name: h.request.name, status: h.status || null, time_ms: h.time_ms, error: h.error || "" }));
}

async function collectionCreate(p) {
  const name = String(p.name).trim();
  if (data().collections.some((c) => fold(c.name) === fold(name))) throw new CliError("failed", `Já existe a coleção ${name}`);
  const coll = newCollection(name);
  data().collections.push(coll);
  host.commit();
  return { id: coll.id, name: coll.name };
}

async function collectionDelete(p) {
  requireFlag(p, "yes", "Excluir uma coleção exige --yes");
  const coll = findCollection(p.collection);
  if (data().collections.length === 1) throw new CliError("failed", "A última coleção não pode ser excluída");
  const removed = data().requests.filter((r) => r.collection_id === coll.id).length;
  data().collections.splice(data().collections.indexOf(coll), 1);
  data().requests = data().requests.filter((r) => r.collection_id !== coll.id);
  if (state.httpUI.scope === `c:${coll.id}`) state.httpUI.scope = "all";
  if (state.httpUI.selectedId !== null && !data().requests.some((r) => r.id === state.httpUI.selectedId)) state.httpUI.selectedId = null;
  host.commit();
  return { collection: coll.name, requests: removed, deleted: true };
}

async function envDelete(p) {
  requireFlag(p, "yes", "Excluir um ambiente exige --yes");
  const env = findEnv(p.env);
  data().environments.splice(data().environments.indexOf(env), 1);
  if (data().active_env === env.id) host.setActiveEnv(null);
  host.commit();
  return { environment: env.name, deleted: true };
}

async function folderCreate(p) {
  const [collName, ...rest] = String(p.path).split("/");
  if (!rest.length) throw new CliError("usage", "Use \"Coleção/Pasta\"");
  const coll = findCollection(collName);
  const id = folderIn(coll, rest.join("/"), { create: true });
  host.commit();
  return { collection: coll.name, id, path: folderPath(coll.folders, id, "/") };
}

async function importCmd(p) {
  let result;
  try {
    result = importPostman(await readTextFileApi(p.file));
  } catch (e) {
    throw new CliError("failed", e.message || String(e));
  }
  if (result.environment) {
    data().environments.push(result.environment);
    host.commit();
    return { environment: result.environment.name, variables: result.environment.values.length };
  }
  data().collections.push(result.collection);
  data().requests.push(...result.requests);
  host.commit();
  return { collection: result.collection.name, requests: result.requests.length, folders: result.collection.folders.length };
}

async function exportCmd(p) {
  const coll = findCollection(p.collection);
  const json = exportPostman(coll, host.runnerOrder(coll));
  if (!p.out) return json;
  await writeFileApi(p.out, { text: JSON.stringify(json, null, 2) });
  return { collection: coll.name, path: p.out };
}

export const httpCli = {
  collections,
  requests,
  request_get: requestGet,
  request_create: requestCreate,
  request_update: requestUpdate,
  request_delete: requestDelete,
  send: sendCmd,
  curl,
  run,
  envs,
  env_set: envSet,
  env_use: envUse,
  history,
  collection_create: collectionCreate,
  collection_delete: collectionDelete,
  env_delete: envDelete,
  folder_create: folderCreate,
  import: importCmd,
  export: exportCmd,
};

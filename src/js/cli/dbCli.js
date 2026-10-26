// CLI: `devsuite db ...` (ver src-tauri/cli/commands.json). Conexões do databases.json vivo
// (state.db, sem senhas: o Rust lê do cofre); sessões próprias `cli:<conexão>:<banco>`, separadas das
// abas da interface. A divisão do script e o parser mongosh são os mesmos do console (dbLanguages.js).

import { state } from "../state.js";
import { dbApi, writeFileApi } from "../api.js";
import { uid, target, connLabel, isMongo, affectedText, newConnection, connConfig, parseMongoUri, newSavedQuery, normalizeFolder } from "../utils/dbModel.js";
import { findParams, bindParams, ParamError } from "../utils/sqlParams.js";
import { dialectFor } from "../utils/sqlDialect.js";
import { dbHost as host } from "../components/db.js";
import { languageFor } from "../components/dbLanguages.js";
import { CliError, pick, list, fold, requireFlag, sqlReadOnly } from "./cliUtils.js";
import { parsePlan, planSummary } from "../utils/sqlPlan.js";
import { parseStatsMessages, isStatsMessage } from "../utils/sqlStats.js";
import * as perf from "../utils/sqlPerf.js";

const conns = () => {
  if (!state.db) throw new CliError("unavailable", "O Banco ainda não carregou");
  return state.db.connections;
};

function findConn(wanted) {
  return pick(conns(), wanted, { what: "conexão", name: connLabel });
}

const session = (conn, database, kind = "q") => `cli:${kind}:${conn.id}:${database || ""}`;
const tgt = (conn, database, kind) => target(conn, session(conn, database, kind), database || "");
const meta = (conn, database) => tgt(conn, database, "meta");

/** Banco pedido (--db) ou o da conexão. */
const dbOf = (conn, p) => String(p.db ?? conn.database ?? "").trim();

/** "schema.nome" -> { schema, name } (sem schema: dbo no SQL Server). */
function splitName(conn, raw) {
  const s = String(raw).trim().replace(/[[\]"]/g, "");
  if (isMongo(conn)) return { schema: "", name: s };
  const i = s.indexOf(".");
  return i < 0 ? { schema: "dbo", name: s } : { schema: s.slice(0, i), name: s.slice(i + 1) };
}

// ---------- Comandos ----------

async function connsCmd() {
  return Promise.all(
    conns().map(async (c) => ({
      id: c.id,
      name: connLabel(c),
      driver: c.driver,
      host: isMongo(c) ? c.uri.replace(/\/\/[^@/]*@/, "//") : c.host + (c.instance ? `\\${c.instance}` : "") + (c.port && c.port !== 1433 ? `,${c.port}` : ""),
      database: c.database,
      auth: c.auth.kind === "entra" ? "entra" : c.auth.user ? `sql:${c.auth.user}` : "sql",
      read_only: c.read_only,
      has_password: c.auth.kind === "entra" ? null : await dbApi.hasPassword(c.id),
    })),
  );
}

async function connAdd(p) {
  const driver = p.driver ? fold(p.driver) : "mssql";
  if (!["mssql", "mongo"].includes(driver)) throw new CliError("usage", "--driver deve ser mssql ou mongo");
  if (conns().some((c) => fold(connLabel(c)) === fold(p.name))) throw new CliError("failed", `Já existe a conexão ${p.name}`);
  let password = p.password !== undefined ? String(p.password).replace(/\r?\n$/, "") : null;
  const patch = { name: String(p.name).trim(), driver, database: p.database || "", read_only: !!p.read_only };
  if (driver === "mongo") {
    const parsed = parseMongoUri(p.uri || "");
    if (!parsed.valid) throw new CliError("usage", "Informe --uri mongodb://... ou mongodb+srv://...");
    patch.uri = parsed.uri;
    patch.database ||= parsed.database;
    if (parsed.password !== undefined && password === null) password = parsed.password;
  } else {
    if (!p.host) throw new CliError("usage", "Informe --host");
    Object.assign(patch, {
      host: p.host,
      port: p.port ?? (p.instance ? null : 1433),
      instance: p.instance || "",
      encrypt: p.encrypt || "on",
      trust_server_certificate: !!p.trust_cert,
      auth: p.entra ? { kind: "entra", user: p.user || "", tenant: p.tenant || "" } : { kind: "sql", user: p.user || "" },
    });
  }
  const conn = newConnection(patch);
  if (p.test) await dbApi.test(connConfig(conn), password);
  await host.addConnection(conn, password);
  return { id: conn.id, name: connLabel(conn), driver: conn.driver, saved: true, password_saved: !!password };
}

async function connRemove(p) {
  requireFlag(p, "yes", "Remover uma conexão exige --yes");
  const conn = findConn(p.conn);
  await dbApi.disconnect(`cli:q:${conn.id}:`);
  await dbApi.disconnect(`cli:meta:${conn.id}:`);
  await host.removeConnection(conn);
  return { id: conn.id, name: connLabel(conn), removed: true };
}

async function disconnect(p) {
  const conn = findConn(p.conn);
  await dbApi.disconnect(`cli:q:${conn.id}:`);
  await dbApi.disconnect(`cli:meta:${conn.id}:`);
  return { conn: connLabel(conn), disconnected: true };
}

async function test(p) {
  const conn = findConn(p.conn);
  const info = await dbApi.test(target(conn, "", "").conn);
  return { conn: connLabel(conn), ...info };
}

async function databases(p) {
  const conn = findConn(p.conn);
  const nodes = await dbApi.introspect(meta(conn, ""), { kind: "databases" });
  return nodes.map((n) => ({ name: n.name, current: !!n.flag }));
}

async function schemas(p) {
  const conn = findConn(p.conn);
  if (isMongo(conn)) throw new CliError("usage", "MongoDB não tem schemas: use db objects");
  const nodes = await dbApi.introspect(meta(conn, dbOf(conn, p)), { kind: "schemas" });
  return nodes.map((n) => n.name);
}

async function objects(p) {
  const conn = findConn(p.conn);
  const db = dbOf(conn, p);
  const t = meta(conn, db);
  let nodes;
  if (isMongo(conn)) {
    nodes = (await dbApi.introspect(t, { kind: "collections" })).map((n) => ({ kind: n.kind, name: n.name }));
  } else {
    const names = p.schema ? [p.schema] : (await dbApi.introspect(t, { kind: "schemas" })).map((n) => n.name);
    nodes = [];
    for (const schema of names) {
      for (const n of await dbApi.introspect(t, { kind: "schema", schema })) nodes.push({ kind: n.kind, schema, name: n.name, rows: n.rows ?? null });
    }
  }
  const kind = p.kind ? fold(p.kind) : null;
  const f = p.filter ? fold(p.filter) : null;
  return nodes.filter((n) => (!kind || n.kind === kind) && (!f || fold(n.name).includes(f)));
}

async function describe(p) {
  const conn = findConn(p.conn);
  const db = dbOf(conn, p);
  const { schema, name } = splitName(conn, p.table);
  const t = meta(conn, db);
  if (isMongo(conn)) {
    const info = await dbApi.tableInfo(t, schema, name);
    const nodes = await dbApi.introspect(t, { kind: "collection", name });
    return {
      collection: name,
      database: db,
      documents_estimate: info.row_estimate,
      fields: info.columns.map((c) => ({ name: c.name, types: c.full_type })),
      indexes: nodes.filter((n) => n.kind === "index").map((n) => ({ name: n.name, keys: n.detail, unique: !!n.flag })),
    };
  }
  const [info, sch] = await Promise.all([dbApi.tableInfo(t, schema, name), dbApi.tableSchema(t, schema, name).catch(() => null)]);
  const out = {
    table: `${info.schema}.${info.name}`,
    kind: info.kind,
    rows_estimate: info.row_estimate,
    columns: info.columns.map((c) => ({
      name: c.name,
      type: c.full_type,
      nullable: c.nullable,
      pk: c.is_pk || undefined,
      identity: c.is_identity || undefined,
      computed: c.is_computed || undefined,
      default: sch?.columns.find((x) => x.name === c.name)?.default || undefined,
      fk: c.fk ? `${c.fk.schema}.${c.fk.table}.${c.fk.column}` : undefined,
    })),
  };
  if (sch) Object.assign(out, { indexes: sch.indexes, foreign_keys: sch.fks, checks: sch.checks });
  return out;
}

async function ddl(p) {
  const conn = findConn(p.conn);
  if (isMongo(conn)) throw new CliError("usage", "DDL só existe no SQL Server (no MongoDB use db describe)");
  const db = dbOf(conn, p);
  const { schema, name } = splitName(conn, p.object);
  const t = meta(conn, db);
  let kind = p.kind ? fold(p.kind) : null;
  if (!kind) {
    const found = (await dbApi.introspect(t, { kind: "schema", schema })).filter((n) => fold(n.name) === fold(name));
    if (!found.length) throw new CliError("not_found", `Objeto não encontrado: ${schema}.${name}`);
    kind = found[0].kind;
  }
  return dbApi.ddl(t, { kind, schema, name });
}

const SCRIPT_ALL = { types: true, sequences: true, tables: true, indexes: true, foreign_keys: true, views: true, functions: true, procedures: true, triggers: true, synonyms: true };

async function script(p) {
  const conn = findConn(p.conn);
  if (isMongo(conn)) throw new CliError("usage", "DDL do banco só existe no SQL Server");
  const res = await dbApi.databaseScript(meta(conn, dbOf(conn, p)), { ...SCRIPT_ALL, schemas: list(p.schema), if_not_exists: !!p.if_not_exists });
  if (!p.out) return res.sql;
  await writeFileApi(p.out, { text: res.sql });
  return { path: p.out, objects: res.objects, warnings: res.warnings };
}

/** Mongo: colunas/linhas a partir dos documentos (campos de topo), para tabela/CSV. */
function docsTable(docs) {
  const cols = [];
  for (const d of docs) for (const k of Object.keys(d || {})) if (!cols.includes(k)) cols.push(k);
  const cell = (v) => (v === undefined ? null : v !== null && typeof v === "object" ? (Object.keys(v).length === 1 && Object.keys(v)[0].startsWith("$") ? String(Object.values(v)[0]) : JSON.stringify(v)) : v);
  return { columns: cols.map((name) => ({ name })), rows: docs.map((d) => cols.map((c) => cell(d?.[c]))) };
}

async function query(p, ctx) {
  const conn = findConn(p.conn);
  const lang = languageFor(conn);
  const units = lang.units(String(p.sql), 0, 0, "all");
  if (!units.length) throw new CliError("usage", "Nada para executar");
  const bad = units.find((u) => u.error);
  if (bad) throw new CliError("usage", `${bad.error}: ${bad.display}`);
  const writes = units.filter((u) => !u.local && !(isMongo(conn) ? u.readOnly : sqlReadOnly(u.payload)));
  if (writes.length) {
    if (conn.read_only) throw new CliError("read_only", `A conexão ${connLabel(conn)} é somente leitura; comando recusado: ${writes[0].display.slice(0, 120)}`);
    if (!p.write) throw new CliError("needs_write", `Comando de escrita exige --write: ${writes[0].display.slice(0, 120)}`);
  }
  let database = dbOf(conn, p);
  const maxRows = Math.max(1, p.max_rows || 500);
  const results = [];
  const messages = [];
  let elapsed = 0;
  let queryId = null;
  ctx.onCancel.push(() => queryId && dbApi.cancel(queryId));
  for (const unit of units) {
    if (ctx.cancelled) throw new CliError("cancelled", "Cancelado");
    if (unit.local?.use) {
      database = unit.local.use;
      messages.push(`use ${database}`);
      continue;
    }
    const sets = new Map();
    queryId = uid();
    const t = tgt(conn, database);
    const summary = await dbApi.execute(t, queryId, unit.payload, {
      maxRows,
      onEvent: (ev) => {
        if (ev.type === "message") messages.push(ev.text.trim());
        else if (ev.type === "result_start") sets.set(ev.index, { columns: ev.columns.map((c) => ({ name: c.name, type: c.type })), rows: [], docs: null });
        else if (ev.type === "rows") sets.get(ev.index)?.rows.push(...ev.rows);
        else if (ev.type === "docs") {
          const r = sets.get(ev.index);
          if (r) (r.docs ??= []).push(...ev.docs);
        } else if (ev.type === "result_end") {
          const r = sets.get(ev.index);
          if (r) Object.assign(r, { row_count: ev.row_count, truncated: ev.truncated });
        }
      },
    });
    queryId = null;
    elapsed += summary.elapsed_ms || 0;
    for (const r of sets.values()) {
      if (r.docs) {
        const table = docsTable(r.docs);
        results.push({ docs: r.docs, columns: table.columns, rows: table.rows, row_count: r.docs.length, truncated: !!r.truncated });
      } else results.push({ columns: r.columns, rows: r.rows, row_count: r.row_count ?? r.rows.length, truncated: !!r.truncated });
    }
    if (summary.rows_affected !== null && summary.rows_affected !== undefined) messages.push(affectedText(summary.rows_affected));
    // A CLI não deixa transação aberta numa sessão que ninguém está vendo.
    if (summary.tran_count > 0) {
      await dbApi.tx(t, "rollback").catch(() => {});
      messages.push(`Transação deixada aberta pelo script foi desfeita (${summary.tran_count}); inclua COMMIT para gravar`);
    }
  }
  const out = { conn: connLabel(conn), database, results, messages, elapsed_ms: elapsed };
  // JSON: no MongoDB os documentos bastam (colunas/linhas são para tabela/CSV).
  if (!p.format || p.format === "json") for (const r of results) if (r.docs) delete r.columns, delete r.rows;
  return out;
}

// ---------- Desempenho (SQL Server) ----------

function sqlServerConn(p) {
  const conn = findConn(p.conn);
  if (isMongo(conn)) throw new CliError("usage", "Análise de desempenho só existe no SQL Server / Azure SQL");
  return conn;
}

const serverInfos = new Map();
async function serverInfo(conn, database) {
  if (!serverInfos.has(conn.id)) serverInfos.set(conn.id, await dbApi.connect(meta(conn, database)));
  return serverInfos.get(conn.id);
}

/** Executa SQL de desempenho na sessão de consultas da CLI e devolve os result sets como objetos. */
async function runPerf(conn, database, sql, ctx) {
  const queryId = uid();
  ctx.onCancel.push(() => dbApi.cancel(queryId));
  const sets = [];
  let cur = null;
  try {
    await dbApi.execute(tgt(conn, database), queryId, sql, {
      onEvent: (ev) => {
        if (ev.type === "result_start") sets.push((cur = { columns: ev.columns, rows: [] }));
        else if (ev.type === "rows") cur.rows.push(...ev.rows);
      },
    });
  } catch (e) {
    throw new CliError("failed", perf.friendlyError(String(e)));
  }
  return sets.map((x) => perf.rowsToObjects(x.columns, x.rows));
}

const strip = (o, keys = ["plan_handle", "statement_start_offset", "statement_end_offset", "query_hash"]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

async function plan(p, ctx) {
  const conn = sqlServerConn(p);
  const units = languageFor(conn).units(String(p.sql), 0, 0, "all").filter((u) => !u.local);
  if (!units.length) throw new CliError("usage", "Nada para analisar");
  const analyze = !!p.analyze;
  if (analyze) {
    const writes = units.filter((u) => !sqlReadOnly(u.payload));
    if (writes.length) {
      if (conn.read_only) throw new CliError("read_only", `A conexão ${connLabel(conn)} é somente leitura; --analyze executaria: ${writes[0].display.slice(0, 120)}`);
      if (!p.write) throw new CliError("needs_write", `--analyze executa o comando, que altera dados: use --write (ou analise sem --analyze, que não executa): ${writes[0].display.slice(0, 120)}`);
    }
  }
  const database = dbOf(conn, p);
  const xmls = [];
  const stats = [];
  const messages = [];
  let elapsed = 0;
  let queryId = null;
  ctx.onCancel.push(() => queryId && dbApi.cancel(queryId));
  for (const unit of units) {
    if (ctx.cancelled) throw new CliError("cancelled", "Cancelado");
    queryId = uid();
    const t = tgt(conn, database);
    let summary;
    try {
      summary = await dbApi.execute(t, queryId, unit.payload, {
        maxRows: 1,
        options: { plan: analyze ? "actual" : "estimated", stats_io: analyze, stats_time: analyze },
        onEvent: (ev) => {
          if (ev.type === "plan") xmls.push(ev.xml);
          else if (ev.type === "message") (isStatsMessage(ev) ? stats : messages).push(ev);
        },
      });
    } catch (e) {
      throw new CliError("failed", String(e));
    }
    queryId = null;
    elapsed += summary.elapsed_ms || 0;
    if (summary.tran_count > 0) {
      await dbApi.tx(t, "rollback").catch(() => {});
      messages.push({ text: `Transação deixada aberta pelo script foi desfeita (${summary.tran_count})` });
    }
  }
  if (!xmls.length) throw new CliError("failed", "O servidor não devolveu plano de execução");
  let files;
  if (p.out) {
    files = xmls.length === 1 ? [p.out] : xmls.map((_, i) => String(p.out).replace(/(\.[^.\\/]+)?$/, (ext) => `-${i + 1}${ext || ".sqlplan"}`));
    for (let i = 0; i < xmls.length; i++) await writeFileApi(files[i], { text: xmls[i] });
  }
  if (p.xml) return xmls.length === 1 ? xmls[0] : xmls.join("\n");
  const statements = [];
  for (const x of xmls) {
    try {
      statements.push(...planSummary(parsePlan(x), { top: Math.max(1, p.top || 5) }).statements);
    } catch (e) {
      statements.push({ error: String(e.message || e) });
    }
  }
  const out = { conn: connLabel(conn), database, mode: analyze ? "actual" : "estimated", statements };
  if (analyze) {
    const st = parseStatsMessages(stats);
    out.io = st.tables.map(({ table, scans, logical, physical, readAhead, lobLogical }) => ({ table, scans, logical_reads: logical, physical_reads: physical, read_ahead: readAhead, lob_logical_reads: lobLogical }));
    out.time = { cpu_ms: st.totals.execCpuMs, elapsed_ms: st.totals.execElapsedMs, compile_ms: st.totals.compileElapsedMs };
    out.elapsed_ms = elapsed;
  }
  if (messages.length) out.messages = messages.map((m) => m.text.trim());
  if (files) out.files = files;
  return out;
}

async function topQueries(p, ctx) {
  const conn = sqlServerConn(p);
  const database = dbOf(conn, p);
  const limit = Math.max(1, p.limit || 20);
  const major = perf.majorVersion(await serverInfo(conn, database));
  let rows;
  if (p.store || p.regressed) {
    if (major < 13) throw new CliError("usage", "O Query Store existe a partir do SQL Server 2016");
    const [opts] = await runPerf(conn, database, perf.qsOptionsSql(), ctx);
    const state = opts[0]?.actual_state_desc || "OFF";
    if (state === "OFF") throw new CliError("failed", `O Query Store está desligado em ${database || "(banco padrão)"} (ALTER DATABASE CURRENT SET QUERY_STORE = ON)`);
    const sql = p.regressed ? perf.qsRegressedSql({ hours: p.hours || 24, limit }) : perf.qsTopSql({ hours: p.hours || 24, by: p.by ? fold(p.by) : "duration", limit });
    [rows] = await runPerf(conn, database, sql, ctx);
  } else {
    const by = p.by ? fold(p.by) : "cpu";
    if (!perf.TOP_METRICS[by]) throw new CliError("usage", `--by deve ser ${Object.keys(perf.TOP_METRICS).join("|")}`);
    [rows] = await runPerf(conn, database, perf.topQueriesSql({ by, limit, thisDb: !p.all_dbs, major }), ctx);
    if (p.plan) {
      for (const r of rows.slice(0, 5)) {
        if (!r.plan_handle) continue;
        try {
          const [[x]] = await runPerf(conn, database, perf.cachedPlanSql(r.plan_handle, r.statement_start_offset ?? 0, r.statement_end_offset ?? -1), ctx);
          if (x?.query_plan) r.plan = planSummary(parsePlan(x.query_plan), { top: 3 }).statements[0] || null;
        } catch (e) {
          r.plan = { error: String(e.message || e) };
        }
      }
    }
  }
  return rows.map((r) => strip(r));
}

async function sessionsCmd(p, ctx) {
  const conn = sqlServerConn(p);
  const [rows] = await runPerf(conn, dbOf(conn, p), perf.sessionsSql({ all: !!p.all }), ctx);
  let tree = perf.blockingTree(rows);
  if (p.blocking) {
    const inChain = new Set();
    for (const t of tree) if (t.head || Number(t.row.blocking_session_id) > 0) inChain.add(t.row.session_id);
    tree = tree.filter((t) => inChain.has(t.row.session_id));
  }
  return tree.map((t) => ({ depth: t.depth, blocking_others: t.blocked, ...strip(t.row, ["plan_handle"]) }));
}

async function waitsCmd(p, ctx) {
  const conn = sqlServerConn(p);
  const database = dbOf(conn, p);
  const sample = Math.max(0, p.sample || 0);
  let rows;
  if (sample) {
    const [a] = await runPerf(conn, database, perf.waitsSql(), ctx);
    for (let i = 0; i < sample * 10 && !ctx.cancelled; i++) await new Promise((r) => setTimeout(r, 100));
    if (ctx.cancelled) throw new CliError("cancelled", "Cancelado");
    const [b] = await runPerf(conn, database, perf.waitsSql(), ctx);
    rows = perf.waitsDelta(a, b);
  } else rows = (await runPerf(conn, database, perf.waitsSql(), ctx)).flat();
  const sum = perf.summarizeWaits(rows);
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    sample_s: sample || null,
    total_wait_ms: sum.totalMs,
    categories: sum.categories.map((c) => ({ category: c.category, pct: r1(c.pct), wait_ms: c.waitMs, tip: c.tip || undefined })),
    waits: sum.waits.slice(0, Math.max(1, p.limit || 15)).map((w) => ({ wait_type: w.type, category: w.category, pct: r1(w.pct), wait_ms: w.waitMs, tasks: w.tasks, avg_ms: r1(w.avgMs), signal_ms: w.signalMs })),
  };
}

async function indexesCmd(p, ctx) {
  const conn = sqlServerConn(p);
  const database = dbOf(conn, p);
  const kind = p.kind ? fold(p.kind) : "missing";
  const table = p.table ? splitName(conn, p.table) : null;
  const limit = Math.max(1, p.limit || 50);
  const sql = {
    missing: () => perf.missingIndexesSql({ table, limit }),
    usage: () => perf.indexUsageSql({ table }),
    unused: () => perf.indexUsageSql({ table }),
    fragmentation: () => perf.fragmentationSql({ table }),
    stale: () => perf.staleStatsSql({ table, limit }),
  }[kind];
  if (!sql) throw new CliError("usage", "--kind deve ser missing|usage|unused|fragmentation|stale");
  let [rows] = await runPerf(conn, database, sql(), ctx);
  if (kind === "missing") rows = rows.map((r) => ({ ...r, ddl: perf.missingIndexRowDdl(r) }));
  if (kind === "unused") rows = rows.filter(perf.isUnusedIndex);
  if (kind === "fragmentation") rows = rows.map((r) => ({ ...r, maintenance: perf.maintenanceSql(r) || undefined }));
  if (kind === "stale") rows = rows.map((r) => ({ ...r, update: perf.updateStatsSql(r) }));
  return rows.slice(0, limit);
}

// ---------- Consultas salvas ----------

const queryView = (q) => ({
  id: q.id,
  conn: connLabel(conns().find((c) => c.id === q.conn_id) || { name: "?" }),
  database: q.database,
  folder: q.folder,
  name: q.name,
  description: q.description || undefined,
  params: findParams(q.sql, isMongo(conns().find((c) => c.id === q.conn_id)) ? "mongo" : "sql"),
  sql: q.sql,
});

async function queries(p) {
  conns();
  let list = state.db.queries;
  if (p.conn) {
    const conn = findConn(p.conn);
    list = list.filter((q) => q.conn_id === conn.id);
  }
  if (p.db) list = list.filter((q) => fold(q.database) === fold(p.db));
  if (p.folder) list = list.filter((q) => fold(q.folder) === fold(normalizeFolder(p.folder)) || fold(q.folder).startsWith(`${fold(normalizeFolder(p.folder))}/`));
  return list.map(queryView);
}

function findQuery(conn, wanted, db) {
  const list = state.db.queries.filter((q) => q.conn_id === conn.id && (!db || fold(q.database) === fold(db)));
  return pick(list, wanted, { what: "consulta salva", name: (q) => (q.folder ? `${q.folder}/${q.name}` : q.name), label: (q) => q.name });
}

/** Executa uma consulta salva: --param nome=valor (tipo "auto" ou o último usado; nome:tipo=valor força). */
async function runSaved(p, ctx) {
  const conn = findConn(p.conn);
  const q = findQuery(conn, p.query, p.db);
  const lang = isMongo(conn) ? "mongo" : "sql";
  const names = findParams(q.sql, lang);
  const values = {};
  for (const raw of list(p.param)) {
    const [key, value] = splitParam(raw);
    const [name, type] = key.split(":");
    values[name] = { type: type || q.params[name]?.type || "auto", value };
  }
  for (const n of names) {
    if (values[n]) continue;
    if (p.use_last && q.params[n]) values[n] = { type: q.params[n].type, value: q.params[n].last };
    else throw new CliError("usage", `Falta o parâmetro ${n} (--param ${n}=valor${q.params[n] ? ` ou --use-last; último: ${q.params[n].last}` : ""})`);
  }
  let sql;
  try {
    sql = names.length ? bindParams(q.sql, values, { lang, dialect: dialectFor("mssql") }) : q.sql;
  } catch (e) {
    throw new CliError("usage", e instanceof ParamError ? e.message : String(e));
  }
  if (names.length) host.rememberQueryParams(q, Object.fromEntries(names.map((n) => [n, values[n]])));
  const out = await query({ ...p, sql, db: p.db ?? (q.database || undefined) }, ctx);
  return { query: q.name, ...out };
}

function splitParam(raw) {
  const s = String(raw);
  const i = s.indexOf("=");
  if (i < 0) throw new CliError("usage", `Parâmetro sem "=": ${s}`);
  return [s.slice(0, i).trim(), s.slice(i + 1)];
}

async function saveQuery(p) {
  const conn = findConn(p.conn);
  const database = dbOf(conn, p);
  const folder = normalizeFolder(p.folder);
  const exists = state.db.queries.some((q) => q.conn_id === conn.id && q.database === database && q.folder === folder && fold(q.name) === fold(p.name));
  if (exists) throw new CliError("failed", `Já existe a consulta ${folder ? `${folder}/` : ""}${p.name} em ${database || "(banco padrão)"}`);
  const q = newSavedQuery({ conn_id: conn.id, database, folder, name: String(p.name).trim(), description: p.description || "", sql: String(p.sql) });
  host.addQuery(q);
  return { saved: true, ...queryView(q) };
}

export const dbCli = {
  queries,
  run_saved: runSaved,
  save_query: saveQuery,
  conns: connsCmd,
  conn_add: connAdd,
  conn_remove: connRemove,
  disconnect,
  test,
  databases,
  schemas,
  objects,
  describe,
  ddl,
  script,
  query,
  plan,
  top_queries: topQueries,
  sessions: sessionsCmd,
  waits: waitsCmd,
  indexes: indexesCmd,
};

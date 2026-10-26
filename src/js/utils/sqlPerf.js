// Desempenho do SQL Server pelas DMVs e pelo Query Store: SQL das consultas e leitura das
// linhas (sem DOM). Usado pela aba Desempenho (dbPerf.js) e pela CLI. Tudo roda no banco da
// sessão (o Azure SQL não aceita nomes de três partes).

import { mssql } from "./sqlDialect.js";
import { missingIndexDdl } from "./sqlPlan.js";

const int = (v, def, min = 1, max = 100000) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** `OBJECT_ID(N'[s].[t]')` ou NULL. */
const objectId = (table) => (table?.name ? `OBJECT_ID(${mssql.string(mssql.qualified(table.schema || "dbo", table.name))})` : "NULL");

/** Linhas do db_execute (arrays) → objetos pelo nome da coluna. */
export function rowsToObjects(columns, rows) {
  const names = columns.map((c) => c.name);
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

/** Versão principal do servidor ("16.0.4135.4" → 16). Azure SQL conta como a mais nova. */
export function majorVersion(info) {
  if (!info) return 16;
  if (/azure/i.test(info.product || "")) return 99;
  const m = /^(\d+)\./.exec(info.version || "");
  return m ? Number(m[1]) : 16;
}

/** Erro de permissão das DMVs → mensagem com o que pedir ao DBA. */
export function friendlyError(message) {
  const msg = String(message || "");
  if (/\[(297|300|262|229)\]|VIEW SERVER STATE|VIEW DATABASE STATE|VIEW SERVER PERFORMANCE STATE|permission/i.test(msg)) {
    return `${msg}\n\nAs consultas de desempenho exigem a permissão VIEW SERVER STATE (no SQL Server 2022: VIEW SERVER PERFORMANCE STATE; no Azure SQL Database: VIEW DATABASE STATE).`;
  }
  if (/\[208\].*query_store/i.test(msg)) return `${msg}\n\nO Query Store existe a partir do SQL Server 2016.`;
  return msg;
}

/** Trecho do comando dentro do lote (offsets em bytes de nvarchar). */
const STATEMENT_TEXT = (t, start, end) =>
  `SUBSTRING(${t}.text, (${start} / 2) + 1, ((CASE ${end} WHEN -1 THEN DATALENGTH(${t}.text) ELSE ${end} END - ${start}) / 2) + 1)`;

const isHex = (s) => typeof s === "string" && /^0x[0-9a-fA-F]+$/.test(s);

// ---------- Top consultas (cache de planos) ----------

export const TOP_METRICS = {
  cpu: { label: "CPU total", order: "qs.total_worker_time" },
  avg_cpu: { label: "CPU média", order: "qs.total_worker_time / qs.execution_count" },
  duration: { label: "Duração total", order: "qs.total_elapsed_time" },
  avg_duration: { label: "Duração média", order: "qs.total_elapsed_time / qs.execution_count" },
  reads: { label: "Leituras lógicas", order: "qs.total_logical_reads" },
  writes: { label: "Escritas lógicas", order: "qs.total_logical_writes" },
  physical: { label: "Leituras físicas", order: "qs.total_physical_reads" },
  executions: { label: "Execuções", order: "qs.execution_count" },
  memory: { label: "Memória (grant)", order: "qs.total_grant_kb", since: 13 },
};

/** Consultas mais caras do cache (`sys.dm_exec_query_stats`), agregadas por comando. */
export function topQueriesSql({ by = "cpu", limit = 50, thisDb = true, major = 16 } = {}) {
  const metric = TOP_METRICS[by] && (TOP_METRICS[by].since || 0) <= major ? TOP_METRICS[by] : TOP_METRICS.cpu;
  const grant = major >= 13 ? ",\n  qs.total_grant_kb / qs.execution_count AS avg_grant_kb, qs.max_grant_kb" : "";
  return `SELECT TOP (${int(limit, 50, 1, 1000)})
  ${STATEMENT_TEXT("st", "qs.statement_start_offset", "qs.statement_end_offset")} AS query_text,
  DB_NAME(pa.dbid) AS [database],
  CASE WHEN st.objectid IS NOT NULL THEN OBJECT_SCHEMA_NAME(st.objectid, st.dbid) + N'.' + OBJECT_NAME(st.objectid, st.dbid) END AS [object],
  qs.execution_count AS executions,
  CAST(qs.total_worker_time / 1000.0 AS decimal(18, 1)) AS total_cpu_ms,
  CAST(qs.total_worker_time / 1000.0 / qs.execution_count AS decimal(18, 2)) AS avg_cpu_ms,
  CAST(qs.total_elapsed_time / 1000.0 AS decimal(18, 1)) AS total_duration_ms,
  CAST(qs.total_elapsed_time / 1000.0 / qs.execution_count AS decimal(18, 2)) AS avg_duration_ms,
  qs.total_logical_reads, qs.total_logical_reads / qs.execution_count AS avg_logical_reads,
  qs.total_logical_writes, qs.total_physical_reads, qs.total_rows, qs.total_rows / qs.execution_count AS avg_rows${grant},
  qs.creation_time, qs.last_execution_time,
  qs.plan_handle, qs.statement_start_offset, qs.statement_end_offset, qs.query_hash
FROM sys.dm_exec_query_stats AS qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
OUTER APPLY (SELECT CAST(value AS int) AS dbid FROM sys.dm_exec_plan_attributes(qs.plan_handle) WHERE attribute = N'dbid') AS pa
${thisDb ? "WHERE pa.dbid = DB_ID()\n" : ""}ORDER BY ${metric.order} DESC`;
}

/** Procedures do banco por tempo total (`sys.dm_exec_procedure_stats`). */
export function procStatsSql({ limit = 50, proc = null } = {}) {
  return `SELECT TOP (${int(limit, 50, 1, 1000)})
  OBJECT_SCHEMA_NAME(ps.object_id, ps.database_id) + N'.' + OBJECT_NAME(ps.object_id, ps.database_id) AS [procedure],
  ps.type_desc, ps.execution_count AS executions,
  CAST(ps.total_worker_time / 1000.0 AS decimal(18, 1)) AS total_cpu_ms,
  CAST(ps.total_worker_time / 1000.0 / ps.execution_count AS decimal(18, 2)) AS avg_cpu_ms,
  CAST(ps.total_elapsed_time / 1000.0 AS decimal(18, 1)) AS total_duration_ms,
  CAST(ps.total_elapsed_time / 1000.0 / ps.execution_count AS decimal(18, 2)) AS avg_duration_ms,
  ps.total_logical_reads, ps.total_logical_reads / ps.execution_count AS avg_logical_reads,
  ps.total_logical_writes, ps.cached_time, ps.last_execution_time, ps.plan_handle
FROM sys.dm_exec_procedure_stats AS ps
WHERE ps.database_id = DB_ID()${proc ? ` AND ps.object_id = ${objectId(proc)}` : ""}
ORDER BY ps.total_elapsed_time DESC`;
}

/** Plano do cache de um comando (texto: o XML pode passar do limite de aninhamento do tipo xml). */
export function cachedPlanSql(planHandle, start = 0, end = -1) {
  if (!isHex(planHandle)) throw new Error("plan_handle inválido");
  return `SELECT query_plan FROM sys.dm_exec_text_query_plan(${planHandle}, ${int(start, 0, -1, 2 ** 31)}, ${int(end, -1, -1, 2 ** 31)})`;
}

// ---------- Query Store ----------

export const QS_METRICS = {
  duration: { label: "Duração total", order: "total_duration_ms" },
  avg_duration: { label: "Duração média", order: "avg_duration_ms" },
  cpu: { label: "CPU total", order: "total_cpu_ms" },
  reads: { label: "Leituras lógicas", order: "total_logical_reads" },
  executions: { label: "Execuções", order: "executions" },
  memory: { label: "Memória", order: "avg_memory_kb" },
};

export const qsOptionsSql = () => `SELECT actual_state_desc, desired_state_desc, readonly_reason, current_storage_size_mb, max_storage_size_mb,
  query_capture_mode_desc, interval_length_minutes, stale_query_threshold_days, size_based_cleanup_mode_desc
FROM sys.database_query_store_options`;

const QS_FROM = `FROM sys.query_store_runtime_stats AS rs
JOIN sys.query_store_runtime_stats_interval AS i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
JOIN sys.query_store_plan AS p ON p.plan_id = rs.plan_id
JOIN sys.query_store_query AS q ON q.query_id = p.query_id
JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id`;

const QS_AGG = `SUM(rs.count_executions) AS executions,
  CAST(SUM(rs.avg_duration * rs.count_executions) / 1000.0 AS decimal(18, 1)) AS total_duration_ms,
  CAST(SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS decimal(18, 2)) AS avg_duration_ms,
  CAST(SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS decimal(18, 1)) AS total_cpu_ms,
  CAST(SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS decimal(18, 2)) AS avg_cpu_ms,
  CAST(SUM(rs.avg_logical_io_reads * rs.count_executions) AS bigint) AS total_logical_reads,
  CAST(MAX(rs.avg_query_max_used_memory) * 8 AS bigint) AS avg_memory_kb,
  MAX(rs.last_execution_time) AS last_execution_time`;

const since = (hours) => `DATEADD(HOUR, -${int(hours, 24, 1, 24 * 90)}, SYSDATETIMEOFFSET())`;

export function qsTopSql({ hours = 24, by = "duration", limit = 50 } = {}) {
  const metric = QS_METRICS[by] || QS_METRICS.duration;
  return `SELECT TOP (${int(limit, 50, 1, 1000)}) q.query_id,
  CASE WHEN q.object_id <> 0 THEN OBJECT_SCHEMA_NAME(q.object_id) + N'.' + OBJECT_NAME(q.object_id) END AS [object],
  qt.query_sql_text AS query_text, COUNT(DISTINCT p.plan_id) AS plans, MAX(CAST(p.is_forced_plan AS int)) AS forced,
  ${QS_AGG}
${QS_FROM}
WHERE i.start_time >= ${since(hours)}
GROUP BY q.query_id, q.object_id, qt.query_sql_text
ORDER BY ${metric.order} DESC`;
}

/** Consultas cuja duração média recente piorou em relação à semana anterior. */
export function qsRegressedSql({ hours = 24, limit = 50, factor = 1.5 } = {}) {
  const h = int(hours, 24, 1, 24 * 30);
  const per = (where) => `SELECT p.query_id, SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) AS avg_d,
    SUM(rs.count_executions) AS n, COUNT(DISTINCT p.plan_id) AS plans
  FROM sys.query_store_runtime_stats AS rs
  JOIN sys.query_store_runtime_stats_interval AS i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
  JOIN sys.query_store_plan AS p ON p.plan_id = rs.plan_id
  WHERE ${where}
  GROUP BY p.query_id`;
  return `DECLARE @recent datetimeoffset = DATEADD(HOUR, -${h}, SYSDATETIMEOFFSET());
DECLARE @history datetimeoffset = DATEADD(HOUR, -${h + 24 * 7}, SYSDATETIMEOFFSET());
WITH r AS (${per("i.start_time >= @recent")}),
h AS (${per("i.start_time >= @history AND i.start_time < @recent")})
SELECT TOP (${int(limit, 50, 1, 1000)}) r.query_id, qt.query_sql_text AS query_text,
  CAST(h.avg_d / 1000.0 AS decimal(18, 2)) AS before_avg_ms, CAST(r.avg_d / 1000.0 AS decimal(18, 2)) AS recent_avg_ms,
  CAST(r.avg_d / NULLIF(h.avg_d, 0) AS decimal(18, 1)) AS ratio, r.n AS recent_executions, h.n AS before_executions,
  (SELECT COUNT(*) FROM sys.query_store_plan AS x WHERE x.query_id = r.query_id) AS plans
FROM r JOIN h ON h.query_id = r.query_id
JOIN sys.query_store_query AS q ON q.query_id = r.query_id
JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id
WHERE r.avg_d > h.avg_d * ${Number(factor) > 1 ? Number(factor) : 1.5}
ORDER BY (r.avg_d - h.avg_d) * r.n DESC`;
}

export function qsMultiPlanSql({ limit = 50 } = {}) {
  return `SELECT TOP (${int(limit, 50, 1, 1000)}) q.query_id, qt.query_sql_text AS query_text, COUNT(*) AS plans,
  MAX(CAST(p.is_forced_plan AS int)) AS forced, MAX(p.last_execution_time) AS last_execution_time
FROM sys.query_store_plan AS p
JOIN sys.query_store_query AS q ON q.query_id = p.query_id
JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id
GROUP BY q.query_id, qt.query_sql_text
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC, MAX(p.last_execution_time) DESC`;
}

export const qsForcedSql = () => `SELECT q.query_id, p.plan_id, qt.query_sql_text AS query_text, p.force_failure_count,
  p.last_force_failure_reason_desc, p.last_execution_time
FROM sys.query_store_plan AS p
JOIN sys.query_store_query AS q ON q.query_id = p.query_id
JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id
WHERE p.is_forced_plan = 1
ORDER BY p.last_execution_time DESC`;

/** Planos de uma consulta com as métricas do período. */
export function qsPlansSql(queryId, { hours = 24 } = {}) {
  return `SELECT p.plan_id, CAST(p.is_forced_plan AS int) AS forced, p.count_compiles, p.last_execution_time,
  SUM(rs.count_executions) AS executions,
  CAST(SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS decimal(18, 2)) AS avg_duration_ms,
  CAST(SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS decimal(18, 2)) AS avg_cpu_ms,
  CAST(SUM(rs.avg_logical_io_reads * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) AS bigint) AS avg_logical_reads
FROM sys.query_store_plan AS p
LEFT JOIN (sys.query_store_runtime_stats AS rs
  JOIN sys.query_store_runtime_stats_interval AS i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id AND i.start_time >= ${since(hours)})
  ON rs.plan_id = p.plan_id
WHERE p.query_id = ${int(queryId, 0, 0, 2 ** 53)}
GROUP BY p.plan_id, p.is_forced_plan, p.count_compiles, p.last_execution_time
ORDER BY p.last_execution_time DESC`;
}

/** Duração média por intervalo e plano (gráfico da consulta). */
export function qsTimelineSql(queryId, { hours = 24 } = {}) {
  return `SELECT rs.plan_id, i.start_time,
  SUM(rs.count_executions) AS executions,
  CAST(SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS float) AS avg_duration_ms
FROM sys.query_store_runtime_stats AS rs
JOIN sys.query_store_runtime_stats_interval AS i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
JOIN sys.query_store_plan AS p ON p.plan_id = rs.plan_id
WHERE p.query_id = ${int(queryId, 0, 0, 2 ** 53)} AND i.start_time >= ${since(hours)}
GROUP BY rs.plan_id, i.start_time
ORDER BY i.start_time`;
}

export const qsPlanXmlSql = (planId) => `SELECT query_plan FROM sys.query_store_plan WHERE plan_id = ${int(planId, 0, 0, 2 ** 53)}`;
export const qsForceSql = (queryId, planId) => `EXEC sys.sp_query_store_force_plan @query_id = ${int(queryId, 0, 0, 2 ** 53)}, @plan_id = ${int(planId, 0, 0, 2 ** 53)};`;
export const qsUnforceSql = (queryId, planId) => `EXEC sys.sp_query_store_unforce_plan @query_id = ${int(queryId, 0, 0, 2 ** 53)}, @plan_id = ${int(planId, 0, 0, 2 ** 53)};`;
export const qsEnableSql = () => "ALTER DATABASE CURRENT SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE);";

// ---------- Sessões e bloqueios ----------

/** Requisições em andamento + sessões que bloqueiam ou têm transação aberta (`all` = todas as de usuário). */
export function sessionsSql({ all = false } = {}) {
  return `SELECT s.session_id, ISNULL(r.blocking_session_id, 0) AS blocking_session_id,
  COALESCE(r.status, s.status) AS status, r.command,
  DB_NAME(COALESCE(r.database_id, s.database_id)) AS [database],
  s.login_name, s.host_name, s.program_name,
  r.wait_type, r.wait_time AS wait_ms, r.last_wait_type, r.wait_resource,
  r.total_elapsed_time AS elapsed_ms, COALESCE(r.cpu_time, s.cpu_time) AS cpu_ms,
  COALESCE(r.logical_reads, s.logical_reads) AS logical_reads, COALESCE(r.writes, s.writes) AS writes,
  r.granted_query_memory * 8 AS grant_kb, r.percent_complete, s.open_transaction_count AS open_tran,
  CASE WHEN r.session_id IS NOT NULL THEN ${STATEMENT_TEXT("t", "r.statement_start_offset", "r.statement_end_offset")} ELSE t.text END AS query_text,
  s.last_request_start_time, s.last_request_end_time, r.plan_handle
FROM sys.dm_exec_sessions AS s
LEFT JOIN sys.dm_exec_requests AS r ON r.session_id = s.session_id
LEFT JOIN sys.dm_exec_connections AS c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL
OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) AS t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID${
    all
      ? ""
      : `
  AND (r.session_id IS NOT NULL OR s.open_transaction_count > 0
       OR s.session_id IN (SELECT blocking_session_id FROM sys.dm_exec_requests WHERE blocking_session_id > 0))`
  }
ORDER BY CASE WHEN r.blocking_session_id > 0 THEN 0 ELSE 1 END, r.total_elapsed_time DESC`;
}

/** Plano ao vivo de uma sessão (2016 SP1+, com perfil leve) ou, sem ele, o do cache. */
export function livePlanSql(sessionId) {
  const spid = int(sessionId, 0, 1, 32767);
  return `IF OBJECT_ID('sys.dm_exec_query_statistics_xml') IS NOT NULL
  EXEC(N'SELECT CAST(query_plan AS nvarchar(max)) AS query_plan FROM sys.dm_exec_query_statistics_xml(${spid})');
ELSE
  SELECT CAST(p.query_plan AS nvarchar(max)) AS query_plan FROM sys.dm_exec_requests AS r CROSS APPLY sys.dm_exec_query_plan(r.plan_handle) AS p WHERE r.session_id = ${spid};`;
}

export function killSql(sessionId) {
  const spid = Number(sessionId);
  if (!Number.isInteger(spid) || spid < 1 || spid > 32767) throw new Error(`Sessão inválida: ${sessionId}`);
  return `KILL ${spid};`;
}

/**
 * Cadeia de bloqueio: `[{ row, depth, blocked: n }]` com quem bloqueia na raiz e os
 * bloqueados abaixo; sessões fora da cadeia vêm depois, no nível 0.
 */
export function blockingTree(rows) {
  const byId = new Map(rows.map((r) => [Number(r.session_id), r]));
  const childrenOf = new Map();
  for (const r of rows) {
    const b = Number(r.blocking_session_id) || 0;
    if (b > 0 && b !== Number(r.session_id)) {
      if (!byId.has(b)) {
        const ghost = { session_id: b, blocking_session_id: 0, status: "?", query_text: "" };
        byId.set(b, ghost);
        rows = [...rows, ghost];
      }
      if (!childrenOf.has(b)) childrenOf.set(b, []);
      childrenOf.get(b).push(r);
    }
  }
  const out = [];
  const seen = new Set();
  const count = (id, guard = new Set()) => {
    if (guard.has(id)) return 0;
    guard.add(id);
    return (childrenOf.get(id) || []).reduce((t, c) => t + 1 + count(Number(c.session_id), guard), 0);
  };
  const walk = (r, depth) => {
    const id = Number(r.session_id);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ row: r, depth, blocked: count(id), head: depth === 0 && childrenOf.has(id) });
    for (const c of childrenOf.get(id) || []) walk(c, depth + 1);
  };
  const heads = rows.filter((r) => !(Number(r.blocking_session_id) > 0) && childrenOf.has(Number(r.session_id)));
  heads.sort((a, b) => count(Number(b.session_id)) - count(Number(a.session_id)));
  heads.forEach((r) => walk(r, 0));
  // Ciclos (deadlock ainda não resolvido) e o resto.
  for (const r of rows) if (childrenOf.has(Number(r.session_id))) walk(r, 0);
  for (const r of rows) walk(r, 0);
  return out;
}

// ---------- Esperas ----------

export function waitsSql() {
  const cols = "wait_type, waiting_tasks_count, wait_time_ms, signal_wait_time_ms, max_wait_time_ms";
  return `IF CAST(SERVERPROPERTY('EngineEdition') AS int) = 5
  EXEC(N'SELECT ${cols} FROM sys.dm_db_wait_stats WHERE wait_time_ms > 0');
ELSE
  SELECT ${cols} FROM sys.dm_os_wait_stats WHERE wait_time_ms > 0;`;
}

// Esperas de fundo que não indicam problema (lista do Paul Randal, resumida).
const BENIGN = new Set(
  `BROKER_EVENTHANDLER BROKER_RECEIVE_WAITFOR BROKER_TASK_STOP BROKER_TO_FLUSH BROKER_TRANSMITTER CHECKPOINT_QUEUE CHKPT CLR_AUTO_EVENT
CLR_MANUAL_EVENT CLR_SEMAPHORE DBMIRROR_DBM_EVENT DBMIRROR_EVENTS_QUEUE DBMIRROR_WORKER_QUEUE DBMIRRORING_CMD DIRTY_PAGE_POLL DISPATCHER_QUEUE_SEMAPHORE
EXECSYNC FSAGENT FT_IFTS_SCHEDULER_IDLE_WAIT FT_IFTSHC_MUTEX HADR_CLUSAPI_CALL HADR_FILESTREAM_IOMGR_IOCOMPLETION HADR_LOGCAPTURE_WAIT
HADR_NOTIFICATION_DEQUEUE HADR_TIMER_TASK HADR_WORK_QUEUE KSOURCE_WAKEUP LAZYWRITER_SLEEP LOGMGR_QUEUE MEMORY_ALLOCATION_EXT ONDEMAND_TASK_QUEUE
PARALLEL_REDO_DRAIN_WORKER PARALLEL_REDO_LOG_CACHE PARALLEL_REDO_TRAN_LIST PARALLEL_REDO_WORKER_SYNC PARALLEL_REDO_WORKER_WAIT_WORK
PREEMPTIVE_XE_GETTARGETSTATE PREEMPTIVE_OS_FLUSHFILEBUFFERS PWAIT_ALL_COMPONENTS_INITIALIZED PWAIT_DIRECTLOGCONSUMER_GETNEXT PWAIT_EXTENSIBILITY_CLEANUP_TASK
QDS_PERSIST_TASK_MAIN_LOOP_SLEEP QDS_ASYNC_QUEUE QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP QDS_SHUTDOWN_QUEUE REDO_THREAD_PENDING_WORK
REQUEST_FOR_DEADLOCK_SEARCH RESOURCE_QUEUE SERVER_IDLE_CHECK SLEEP_BPOOL_FLUSH SLEEP_DBSTARTUP SLEEP_DCOMSTARTUP SLEEP_MASTERDBREADY
SLEEP_MASTERMDREADY SLEEP_MASTERUPGRADED SLEEP_MSDBSTARTUP SLEEP_SYSTEMTASK SLEEP_TASK SLEEP_TEMPDBSTARTUP SNI_HTTP_ACCEPT SOS_WORK_DISPATCHER
SP_SERVER_DIAGNOSTICS_SLEEP SQLTRACE_BUFFER_FLUSH SQLTRACE_INCREMENTAL_FLUSH_SLEEP SQLTRACE_WAIT_ENTRIES STARTUP_DEPENDENCY_MANAGER
UCS_SESSION_REGISTRATION VDI_CLIENT_OTHER WAIT_FOR_RESULTS WAITFOR WAITFOR_TASKSHUTDOWN WAIT_XTP_RECOVERY WAIT_XTP_HOST_WAIT
WAIT_XTP_OFFLINE_CKPT_NEW_LOG WAIT_XTP_CKPT_CLOSE XE_DISPATCHER_JOIN XE_DISPATCHER_WAIT XE_TIMER_EVENT XE_LIVE_TARGET_TVF
SOS_WORKER_MIGRATION VDI_CLIENT_WORKER`.split(/\s+/),
);

export const isBenignWait = (type) => BENIGN.has(type) || /^(SLEEP_|BROKER_|XE_|PWAIT_|QDS_|HADR_FABRIC|AZURE_|PVS_|WAIT_XTP_)/.test(type) || type === "SOS_SCHEDULER_YIELD_IDLE";

const CATEGORIES = [
  [/^LCK_M_/, "Bloqueio (lock)"],
  [/^PAGEIOLATCH_/, "Leitura de disco (buffer IO)"],
  [/^PAGELATCH_/, "Latch de página (buffer)"],
  [/^LATCH_/, "Latch"],
  [/^(CXPACKET|CXCONSUMER|CXSYNC_|EXCHANGE|CXROWSET_SYNC)/, "Paralelismo"],
  [/^(SOS_SCHEDULER_YIELD|THREADPOOL|SOS_WORKER)/, "CPU"],
  [/^(WRITELOG|LOGBUFFER|LOG_RATE_GOVERNOR|POOL_LOG_RATE_GOVERNOR|INSTANCE_LOG_RATE_GOVERNOR)/, "Log de transações"],
  [/^(ASYNC_NETWORK_IO|NET_WAITFOR_PACKET|EXTERNAL_SCRIPT_NETWORK_IO)/, "Rede / cliente"],
  [/^RESOURCE_SEMAPHORE_QUERY_COMPILE/, "Compilação"],
  [/^(RESOURCE_SEMAPHORE|CMEMTHREAD|SOS_RESERVEDMEMBLOCKLIST|SOS_VIRTUALMEMORY_LOW)/, "Memória"],
  [/^(ASYNC_IO_COMPLETION|IO_COMPLETION|WRITE_COMPLETION|BACKUPIO|IO_QUEUE_LIMIT|IO_RETRY)/, "Outro IO de disco"],
  [/^HADR_/, "Réplicas (Always On)"],
  [/^PREEMPTIVE_/, "Chamadas ao SO (preemptive)"],
  [/^(TRANSACTION_MUTEX|XACT|DTC)/, "Transações"],
];

export const waitCategory = (type) => CATEGORIES.find(([re]) => re.test(type))?.[1] || "Outros";

const WAIT_TIPS = {
  "Bloqueio (lock)": "Sessões esperando locks de outras: transações longas ou sem índice no filtro. Veja Sessões → cadeia de bloqueio.",
  "Leitura de disco (buffer IO)": "Páginas lidas do disco: falta memória ou consultas leem demais (scans). Veja Top consultas por leituras físicas e Índices faltantes.",
  "Latch de página (buffer)": "Disputa em páginas na memória: comum em inserções sequenciais (último bloco) ou no tempdb.",
  Paralelismo: "Planos paralelos esperando threads: ajuste MAXDOP e o cost threshold for parallelism; verifique estimativas erradas.",
  CPU: "Pressão de CPU: veja Top consultas por CPU.",
  "Log de transações": "Gravação do log: disco do log lento ou muitas transações pequenas.",
  "Rede / cliente": "O cliente demora a consumir os resultados (ex.: aplicação lendo linha a linha ou trazendo dados demais).",
  Compilação: "Muitas compilações simultâneas: consultas não parametrizadas ou planos muito grandes.",
  Memória: "Consultas esperando memory grant: ordenações/hash grandes ou estimativas altas demais.",
};
export const waitTip = (category) => WAIT_TIPS[category] || "";

/** Esperas (linhas da DMV) → por tipo, sem as benignas, com categoria e percentual. */
export function summarizeWaits(rows) {
  const list = rows
    .filter((r) => !isBenignWait(r.wait_type))
    .map((r) => ({
      type: r.wait_type,
      category: waitCategory(r.wait_type),
      tasks: Number(r.waiting_tasks_count) || 0,
      waitMs: Number(r.wait_time_ms) || 0,
      signalMs: Number(r.signal_wait_time_ms) || 0,
      maxMs: Number(r.max_wait_time_ms) || 0,
    }))
    .filter((w) => w.waitMs > 0);
  const total = list.reduce((t, w) => t + w.waitMs, 0);
  for (const w of list) {
    w.pct = total ? (w.waitMs / total) * 100 : 0;
    w.avgMs = w.tasks ? w.waitMs / w.tasks : 0;
  }
  list.sort((a, b) => b.waitMs - a.waitMs);
  const cats = new Map();
  for (const w of list) {
    const c = cats.get(w.category) || { category: w.category, waitMs: 0, tasks: 0, pct: 0, tip: waitTip(w.category) };
    c.waitMs += w.waitMs;
    c.tasks += w.tasks;
    c.pct += w.pct;
    cats.set(w.category, c);
  }
  return { waits: list, categories: [...cats.values()].sort((a, b) => b.waitMs - a.waitMs), totalMs: total };
}

/** Diferença entre duas leituras da DMV (amostra de N segundos). */
export function waitsDelta(before, after) {
  const prev = new Map(before.map((r) => [r.wait_type, r]));
  return after
    .map((r) => {
      const p = prev.get(r.wait_type);
      const d = (k) => Math.max(0, (Number(r[k]) || 0) - (Number(p?.[k]) || 0));
      return { wait_type: r.wait_type, waiting_tasks_count: d("waiting_tasks_count"), wait_time_ms: d("wait_time_ms"), signal_wait_time_ms: d("signal_wait_time_ms"), max_wait_time_ms: Number(r.max_wait_time_ms) || 0 };
    })
    .filter((r) => r.wait_time_ms > 0);
}

// ---------- Índices e estatísticas ----------

export function missingIndexesSql({ table = null, limit = 100 } = {}) {
  return `SELECT TOP (${int(limit, 100, 1, 1000)})
  OBJECT_SCHEMA_NAME(d.object_id, d.database_id) AS [schema], OBJECT_NAME(d.object_id, d.database_id) AS [table],
  d.equality_columns, d.inequality_columns, d.included_columns,
  gs.user_seeks, gs.user_scans, CAST(gs.avg_total_user_cost AS decimal(18, 4)) AS avg_cost, CAST(gs.avg_user_impact AS decimal(5, 1)) AS avg_impact,
  CAST(gs.avg_total_user_cost * gs.avg_user_impact * (gs.user_seeks + gs.user_scans) AS decimal(18, 0)) AS score,
  gs.last_user_seek, gs.last_user_scan
FROM sys.dm_db_missing_index_details AS d
JOIN sys.dm_db_missing_index_groups AS g ON g.index_handle = d.index_handle
JOIN sys.dm_db_missing_index_group_stats AS gs ON gs.group_handle = g.index_group_handle
WHERE d.database_id = DB_ID()${table ? ` AND d.object_id = ${objectId(table)}` : ""}
ORDER BY score DESC`;
}

/** "[a], [b c]" → ["a", "b c"]. */
export function splitColumnList(text) {
  if (!text) return [];
  const out = [];
  const re = /\[((?:[^\]]|\]\])*)\]/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/]]/g, "]"));
  return out;
}

export function missingIndexRowDdl(r) {
  return missingIndexDdl({
    schema: r.schema,
    table: r.table,
    equality: splitColumnList(r.equality_columns),
    inequality: splitColumnList(r.inequality_columns),
    include: splitColumnList(r.included_columns),
  });
}

export function indexUsageSql({ table = null } = {}) {
  return `SELECT OBJECT_SCHEMA_NAME(i.object_id) AS [schema], OBJECT_NAME(i.object_id) AS [table], i.name AS [index], i.type_desc,
  CAST(i.is_primary_key AS int) AS is_pk, CAST(i.is_unique AS int) AS is_unique,
  ISNULL(us.user_seeks, 0) AS seeks, ISNULL(us.user_scans, 0) AS scans, ISNULL(us.user_lookups, 0) AS lookups,
  ISNULL(us.user_seeks, 0) + ISNULL(us.user_scans, 0) + ISNULL(us.user_lookups, 0) AS reads,
  ISNULL(us.user_updates, 0) AS writes,
  (SELECT MAX(v) FROM (VALUES (us.last_user_seek), (us.last_user_scan), (us.last_user_lookup)) AS x(v)) AS last_read,
  ps.row_count AS [rows], ps.size_kb
FROM sys.indexes AS i
JOIN sys.objects AS o ON o.object_id = i.object_id AND o.is_ms_shipped = 0 AND o.type = 'U'
LEFT JOIN sys.dm_db_index_usage_stats AS us ON us.database_id = DB_ID() AND us.object_id = i.object_id AND us.index_id = i.index_id
OUTER APPLY (SELECT SUM(p.row_count) AS row_count, SUM(p.used_page_count) * 8 AS size_kb
  FROM sys.dm_db_partition_stats AS p WHERE p.object_id = i.object_id AND p.index_id = i.index_id) AS ps
WHERE i.type > 0${table ? ` AND i.object_id = ${objectId(table)}` : ""}
ORDER BY reads, writes DESC, ps.size_kb DESC`;
}

/** Índice que só custa (sem leituras desde o último restart) e não garante unicidade. */
export const isUnusedIndex = (r) => Number(r.reads) === 0 && !Number(r.is_pk) && !Number(r.is_unique) && !/^CLUSTERED/.test(r.type_desc || "");

export function fragmentationSql({ table = null, minPages = 100 } = {}) {
  return `SELECT OBJECT_SCHEMA_NAME(ips.object_id) AS [schema], OBJECT_NAME(ips.object_id) AS [table], i.name AS [index],
  ips.index_type_desc, ips.partition_number, CAST(ips.avg_fragmentation_in_percent AS decimal(5, 1)) AS fragmentation_pct,
  ips.page_count, ips.fragment_count
FROM sys.dm_db_index_physical_stats(DB_ID(), ${objectId(table)}, NULL, NULL, 'LIMITED') AS ips
JOIN sys.indexes AS i ON i.object_id = ips.object_id AND i.index_id = ips.index_id
WHERE ips.index_id > 0 AND ips.page_count >= ${int(minPages, 100, 0, 1e9)}
ORDER BY ips.avg_fragmentation_in_percent DESC`;
}

/** Recomendação usual: > 30% REBUILD, 5–30% REORGANIZE. */
export function maintenanceSql(r) {
  const pct = Number(r.fragmentation_pct) || 0;
  if (pct < 5 || !r.index) return "";
  const target = `${mssql.quote(r.index)} ON ${mssql.qualified(r.schema, r.table)}`;
  return pct > 30 ? `ALTER INDEX ${target} REBUILD;` : `ALTER INDEX ${target} REORGANIZE;`;
}

export function staleStatsSql({ table = null, limit = 200 } = {}) {
  return `SELECT TOP (${int(limit, 200, 1, 5000)}) OBJECT_SCHEMA_NAME(s.object_id) AS [schema], OBJECT_NAME(s.object_id) AS [table], s.name AS [statistic],
  CAST(s.auto_created AS int) AS auto_created, sp.last_updated, sp.[rows], sp.rows_sampled,
  CAST(100.0 * sp.rows_sampled / NULLIF(sp.[rows], 0) AS decimal(5, 1)) AS sample_pct,
  sp.modification_counter, CAST(100.0 * sp.modification_counter / NULLIF(sp.[rows], 0) AS decimal(9, 1)) AS modified_pct
FROM sys.stats AS s
JOIN sys.objects AS o ON o.object_id = s.object_id AND o.is_ms_shipped = 0 AND o.type = 'U'
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) AS sp
WHERE sp.modification_counter > 0${table ? ` AND s.object_id = ${objectId(table)}` : ""}
ORDER BY modified_pct DESC`;
}

export const updateStatsSql = (r) => `UPDATE STATISTICS ${mssql.qualified(r.schema, r.table)} ${mssql.quote(r.statistic)};`;

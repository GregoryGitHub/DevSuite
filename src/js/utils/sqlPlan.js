// Planos de execução do SQL Server (SHOWPLAN XML): parser, custos, diagnósticos e layout.
// Sem DOM (o DOMParser não existe no Node): o XML é lido por um tokenizer próprio.
// Usado pelo visualizador (dbPlan.js), pela aba Desempenho e pela CLI (`db plan`).

import { mssql } from "./sqlDialect.js";

// ---------- XML mínimo ----------

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Árvore `{ name, attrs, children, text }` (prefixos de namespace removidos). */
export function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const ATTR_RE = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const len = xml.length;
  let i = 0;
  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const text = xml.slice(i, lt);
      if (text.trim()) stack[stack.length - 1].text += decodeEntities(text);
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      stack[stack.length - 1].text += xml.slice(lt + 9, end < 0 ? len : end);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt);
      i = end < 0 ? len : end + 1;
      continue;
    }
    // Fim da tag: o primeiro ">" fora de aspas.
    let j = lt + 1;
    let quote = "";
    for (; j < len; j++) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s/]|$/);
    const name = inner.slice(0, nameEnd).replace(/^[\w.-]+:/, "");
    const attrs = {};
    ATTR_RE.lastIndex = nameEnd;
    let m;
    while ((m = ATTR_RE.exec(inner))) {
      const key = m[1].replace(/^[\w.-]+:/, "");
      if (m[1].startsWith("xmlns")) continue;
      attrs[key] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    const node = { name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const child = (n, name) => n?.children.find((c) => c.name === name) || null;
const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);

/** Descendentes com `name`, sem entrar em `stop` (ex.: RelOps filhos). */
function own(n, name, stop = "RelOp") {
  const out = [];
  const walk = (x) => {
    for (const c of x.children) {
      if (c.name === name) out.push(c);
      if (c.name !== stop) walk(c);
    }
  };
  walk(n);
  return out;
}

function firstOwn(n, name, stop = "RelOp") {
  for (const c of n.children) {
    if (c.name === name) return c;
    if (c.name !== stop) {
      const r = firstOwn(c, name, stop);
      if (r) return r;
    }
  }
  return null;
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const unbracket = (s) => (s ? String(s).replace(/^\[(.*)\]$/, "$1").replace(/]]/g, "]") : "");

/** `[tabela].[coluna]` de um ColumnReference (alias quando houver). */
export function columnName(cr) {
  if (!cr) return "";
  const a = cr.attrs;
  const owner = a.Alias || a.Table;
  const col = a.Column || "";
  return owner ? `${owner}.${col.startsWith("[") ? col : `[${col}]`}` : col;
}

// ---------- Plano ----------

const STATEMENT_TAGS = new Set(["StmtSimple", "StmtCond", "StmtCursor", "StmtReceive", "StmtUseDb", "ExternalDistributedComputation"]);

/**
 * Lê um SHOWPLAN XML. Devolve `{ statements, actual, version, build }`; cada comando tem a
 * árvore de operadores (`root`) já com custos próprios e percentuais calculados.
 */
export function parsePlan(xml) {
  const doc = parseXml(String(xml || ""));
  const top = child(doc, "ShowPlanXML");
  if (!top) throw new Error("Não é um plano de execução (ShowPlanXML)");
  const statements = [];
  const visit = (n) => {
    for (const c of n.children) {
      if (STATEMENT_TAGS.has(c.name)) statements.push(statementOf(c, statements.length));
      visit(c);
    }
  };
  visit(top);
  const actual = statements.some((s) => s.actual);
  return { statements, actual, version: top.attrs.Version || "", build: top.attrs.Build || "" };
}

function statementOf(el, index) {
  const a = el.attrs;
  const qp = child(el, "QueryPlan");
  const st = {
    index,
    text: (a.StatementText || "").replace(/^[\s;]+/, "").trim(),
    type: a.StatementType || el.name.replace(/^Stmt/, "").toUpperCase(),
    subtreeCost: num(a.StatementSubTreeCost) ?? 0,
    estRows: num(a.StatementEstRows),
    optimizationLevel: a.StatementOptmLevel || "",
    earlyAbort: a.StatementOptmEarlyAbortReason || "",
    cardinalityEstimator: a.CardinalityEstimationModelVersion || "",
    queryHash: a.QueryHash || "",
    planHash: a.QueryPlanHash || "",
    retrievedFromCache: a.RetrievedFromCache === "true",
    nonParallelReason: qp?.attrs.NonParallelPlanReason || "",
    dop: num(qp?.attrs.DegreeOfParallelism),
    cachedPlanKb: num(qp?.attrs.CachedPlanSize),
    compileMs: num(qp?.attrs.CompileTime),
    compileCpuMs: num(qp?.attrs.CompileCPU),
    compileMemoryKb: num(qp?.attrs.CompileMemory),
    memoryGrant: null,
    timeStats: null,
    waits: [],
    parameters: [],
    warnings: [],
    missingIndexes: [],
    root: null,
    nodes: [],
    actual: false,
  };
  if (!qp) return st;

  const mg = child(qp, "MemoryGrantInfo");
  if (mg) {
    const g = mg.attrs;
    st.memoryGrant = {
      requestedKb: num(g.RequestedMemory),
      grantedKb: num(g.GrantedMemory),
      maxUsedKb: num(g.MaxUsedMemory),
      desiredKb: num(g.DesiredMemory),
      serialRequiredKb: num(g.SerialRequiredMemory),
      waitMs: num(g.GrantWaitTime),
    };
  }
  const ts = child(qp, "QueryTimeStats");
  if (ts) st.timeStats = { cpuMs: num(ts.attrs.CpuTime), elapsedMs: num(ts.attrs.ElapsedTime) };
  const ws = child(qp, "WaitStats");
  if (ws) st.waits = kids(ws, "Wait").map((w) => ({ type: w.attrs.WaitType, ms: num(w.attrs.WaitTimeMs) ?? 0, count: num(w.attrs.WaitCount) ?? 0 }));
  const pl = child(qp, "ParameterList");
  if (pl) {
    st.parameters = kids(pl, "ColumnReference").map((p) => ({
      name: p.attrs.Column,
      type: p.attrs.ParameterDataType || "",
      compiled: p.attrs.ParameterCompiledValue ?? null,
      runtime: p.attrs.ParameterRuntimeValue ?? null,
    }));
  }
  st.warnings = warningsOf(child(qp, "Warnings"));
  const mis = child(qp, "MissingIndexes");
  if (mis) {
    for (const g of kids(mis, "MissingIndexGroup")) {
      for (const mi of kids(g, "MissingIndex")) {
        const cols = { EQUALITY: [], INEQUALITY: [], INCLUDE: [] };
        for (const cg of kids(mi, "ColumnGroup")) {
          for (const c of kids(cg, "Column")) (cols[cg.attrs.Usage] ||= []).push(unbracket(c.attrs.Name));
        }
        st.missingIndexes.push({
          impact: num(g.attrs.Impact) ?? 0,
          database: unbracket(mi.attrs.Database),
          schema: unbracket(mi.attrs.Schema),
          table: unbracket(mi.attrs.Table),
          equality: cols.EQUALITY,
          inequality: cols.INEQUALITY,
          include: cols.INCLUDE,
        });
      }
    }
    st.missingIndexes.sort((x, y) => y.impact - x.impact);
  }
  const rel = child(qp, "RelOp");
  if (rel) {
    st.root = relOpOf(rel, null);
    finishCosts(st);
  }
  return st;
}

const PRED_OPS = { EQ: "=", NE: "<>", GT: ">", GE: ">=", LT: "<", LE: "<=", IS: "IS", ISNOT: "IS NOT" };

function scalar(n) {
  const so = n && (n.name === "ScalarOperator" ? n : firstOwn(n, "ScalarOperator"));
  return so?.attrs.ScalarString || "";
}

function seekText(sp) {
  const parts = [];
  for (const spn of own(sp, "SeekKeys")) {
    const ranges = [];
    for (const r of spn.children) {
      const cols = kids(child(r, "RangeColumns"), "ColumnReference").map(columnName);
      const exprs = kids(child(r, "RangeExpressions"), "ScalarOperator").map(scalar);
      const op = PRED_OPS[r.attrs.ScanType] || r.attrs.ScanType || "=";
      cols.forEach((c, i) => ranges.push(`${c} ${op} ${exprs[i] ?? "?"}`));
    }
    if (ranges.length) parts.push(ranges.join(" AND "));
  }
  return parts.join("; ");
}

function relOpOf(el, parent) {
  const a = el.attrs;
  const op = el.children.find((c) => !["OutputList", "Warnings", "MemoryFractions", "RunTimeInformation", "RunTimePartitionSummary", "InternalInfo"].includes(c.name)) || null;
  const obj = op ? firstOwn(op, "Object") : null;
  const node = {
    id: num(a.NodeId) ?? 0,
    physicalOp: a.PhysicalOp || "",
    logicalOp: a.LogicalOp || "",
    element: op?.name || "",
    estRows: num(a.EstimateRows) ?? 0,
    estRowsRead: num(a.EstimatedRowsRead),
    tableCardinality: num(a.TableCardinality),
    estIO: num(a.EstimateIO) ?? 0,
    estCPU: num(a.EstimateCPU) ?? 0,
    avgRowSize: num(a.AvgRowSize),
    subtreeCost: num(a.EstimatedTotalSubtreeCost) ?? 0,
    estRebinds: num(a.EstimateRebinds) ?? 0,
    estRewinds: num(a.EstimateRewinds) ?? 0,
    executionMode: a.EstimatedExecutionMode || "Row",
    parallel: a.Parallel === "1" || a.Parallel === "true",
    ordered: op?.attrs.Ordered === "1" || op?.attrs.Ordered === "true",
    lookup: op?.attrs.Lookup === "1" || op?.attrs.Lookup === "true",
    object: obj
      ? {
          database: unbracket(obj.attrs.Database),
          schema: unbracket(obj.attrs.Schema),
          table: unbracket(obj.attrs.Table),
          index: unbracket(obj.attrs.Index),
          alias: unbracket(obj.attrs.Alias),
          kind: obj.attrs.IndexKind || "",
        }
      : null,
    seekPredicate: "",
    predicate: "",
    residual: "",
    outputList: kids(child(el, "OutputList"), "ColumnReference").map(columnName),
    warnings: warningsOf(child(el, "Warnings")),
    actual: null,
    attrs: { ...a, ...(op ? Object.fromEntries(Object.entries(op.attrs).map(([k, v]) => [`${op.name}.${k}`, v])) : {}) },
    ownCost: 0,
    costPct: 0,
    parent,
    children: [],
  };
  if (op) {
    const sp = firstOwn(op, "SeekPredicates");
    if (sp) node.seekPredicate = seekText(sp);
    const pr = op.children.find((c) => c.name === "Predicate");
    if (pr) node.predicate = scalar(pr);
    const res = op.children.find((c) => c.name === "ProbeResidual" || c.name === "Residual" || c.name === "BuildResidual");
    if (res) node.residual = scalar(res);
  }
  const rti = child(el, "RunTimeInformation");
  if (rti) {
    const threads = kids(rti, "RunTimeCountersPerThread");
    const sum = (k) => threads.reduce((t, x) => t + (num(x.attrs[k]) ?? 0), 0);
    const max = (k) => threads.reduce((t, x) => Math.max(t, num(x.attrs[k]) ?? 0), 0);
    const has = (k) => threads.some((x) => x.attrs[k] !== undefined);
    node.actual = {
      rows: sum("ActualRows"),
      rowsRead: has("ActualRowsRead") ? sum("ActualRowsRead") : null,
      executions: sum("ActualExecutions"),
      elapsedMs: has("ActualElapsedms") ? max("ActualElapsedms") : null,
      cpuMs: has("ActualCPUms") ? sum("ActualCPUms") : null,
      logicalReads: has("ActualLogicalReads") ? sum("ActualLogicalReads") : null,
      physicalReads: has("ActualPhysicalReads") ? sum("ActualPhysicalReads") : null,
      readAheads: has("ActualReadAheads") ? sum("ActualReadAheads") : null,
      threads: threads.length,
      mode: threads[0]?.attrs.ActualExecutionMode || "",
    };
  }
  if (op) node.children = own(op, "RelOp").map((c) => relOpOf(c, node));
  return node;
}

function warningsOf(w) {
  if (!w) return [];
  const out = [];
  const a = w.attrs;
  if (a.NoJoinPredicate === "1" || a.NoJoinPredicate === "true") out.push({ kind: "noJoinPredicate", text: "Sem predicado de junção (produto cartesiano)" });
  if (a.UnmatchedIndexes === "1" || a.UnmatchedIndexes === "true") out.push({ kind: "unmatchedIndexes", text: "Índice filtrado não usado por causa da parametrização" });
  if (a.FullUpdateForOnlineIndexBuild === "1") out.push({ kind: "other", text: "Atualização completa por build online de índice" });
  for (const c of w.children) {
    const x = c.attrs;
    switch (c.name) {
      case "ColumnsWithNoStatistics":
        out.push({ kind: "noStatistics", text: `Colunas sem estatísticas: ${kids(c, "ColumnReference").map(columnName).join(", ")}` });
        break;
      case "SpillToTempDb":
        out.push({ kind: "spill", text: `Spill para o tempdb (nível ${x.SpillLevel ?? "?"}${x.SpilledThreadCount ? `, ${x.SpilledThreadCount} thread(s)` : ""})` });
        break;
      case "SortSpillDetails":
      case "HashSpillDetails":
      case "ExchangeSpillDetails": {
        // Detalhe do SpillToTempDb do mesmo operador: completa o aviso em vez de repetir.
        const detail = `${x.WritesToTempDb ?? "?"} página(s) gravada(s) no tempdb`;
        const spill = out.find((o) => o.kind === "spill");
        if (spill) spill.text += `: ${detail}`;
        else out.push({ kind: "spill", text: `Spill para o tempdb: ${detail}` });
        break;
      }
      case "PlanAffectingConvert":
        out.push({ kind: "implicitConversion", issue: x.ConvertIssue || "", text: `Conversão de tipo afeta ${x.ConvertIssue === "Seek Plan" ? "o uso de índice (seek)" : "a estimativa de linhas"}: ${x.Expression || ""}` });
        break;
      case "MemoryGrantWarning":
        out.push({
          kind: "memoryGrant",
          text: `Memory grant ${x.GrantWarningKind === "Excessive Grant" ? "excessivo" : x.GrantWarningKind === "Used More Than Granted" ? "insuficiente" : "com aviso"}: pedido ${kb(x.RequestedMemory)}, concedido ${kb(x.GrantedMemory)}, usado ${kb(x.MaxUsedMemory)}`,
        });
        break;
      case "Wait":
        out.push({ kind: "wait", text: `Espera ${x.WaitType}: ${x.WaitTime} ms` });
        break;
      case "UnmatchedIndexes":
        out.push({ kind: "unmatchedIndexes", text: "Índice filtrado não usado por causa da parametrização" });
        break;
      default:
        out.push({ kind: "other", text: c.name });
    }
  }
  return out;
}

const kb = (v) => {
  const n = num(v);
  if (n === null) return "?";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} GB` : n >= 1024 ? `${(n / 1024).toFixed(1)} MB` : `${n} KB`;
};

function finishCosts(st) {
  const total = st.root.subtreeCost || st.subtreeCost || 0;
  const all = [];
  const walk = (n) => {
    all.push(n);
    const childCost = n.children.reduce((t, c) => t + c.subtreeCost, 0);
    n.ownCost = Math.max(0, n.subtreeCost - childCost);
    n.children.forEach(walk);
  };
  walk(st.root);
  for (const n of all) n.costPct = total > 0 ? (n.ownCost / total) * 100 : 0;
  st.nodes = all;
  st.actual = all.some((n) => n.actual);
}

/** Nome exibido do operador (Key Lookup = Clustered Index Seek com Lookup). */
export function opLabel(n) {
  if (n.lookup) return n.physicalOp.includes("Clustered") ? "Key Lookup" : `${n.physicalOp} (Lookup)`;
  return n.physicalOp;
}

/** Linhas estimadas no total (por execução × execuções estimadas). */
export const estTotalRows = (n) => n.estRows * Math.max(1, 1 + n.estRebinds + n.estRewinds);

/** Linhas que saem do operador: reais se houver, senão estimadas. */
export const flowRows = (n) => (n.actual ? n.actual.rows : estTotalRows(n));

/** `[schema].[tabela].[índice]` do operador. */
export function objectText(n) {
  const o = n.object;
  if (!o) return "";
  const t = [o.schema, o.table].filter(Boolean).map((x) => `[${x}]`).join(".");
  return o.index ? `${t}.[${o.index}]` : t;
}

// ---------- Índices faltantes ----------

export function missingIndexDdl(mi) {
  const keys = [...mi.equality, ...mi.inequality];
  const name = `IX_${mi.table}_${keys.join("_")}`.replace(/[^\w]/g, "_").slice(0, 128);
  let sql = `CREATE NONCLUSTERED INDEX ${mssql.quote(name)}\nON ${mssql.qualified(mi.schema, mi.table)} (${keys.map((c) => mssql.quote(c)).join(", ")})`;
  if (mi.include.length) sql += `\nINCLUDE (${mi.include.map((c) => mssql.quote(c)).join(", ")})`;
  return `${sql};`;
}

// ---------- Diagnósticos ----------

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const fmt = (n) => formatCount(n);

/**
 * Pontos de atenção do plano, mais graves primeiro:
 * `[{ level: error|warn|info, statement, nodeId, kind, title, detail }]`.
 */
export function planInsights(plan) {
  const out = [];
  for (const st of plan.statements) {
    const push = (level, kind, title, detail = "", nodeId = null) => out.push({ level, statement: st.index, nodeId, kind, title, detail });
    if (st.earlyAbort === "TimeOut") push("info", "timeout", "Otimização encerrada por tempo limite", "O otimizador parou antes de explorar todos os planos (StatementOptmEarlyAbortReason = TimeOut). Simplificar a consulta pode gerar um plano melhor.");
    else if (st.earlyAbort === "MemoryLimitExceeded") push("warn", "timeout", "Otimização encerrada por falta de memória", "");
    for (const mi of st.missingIndexes) {
      push(mi.impact >= 50 ? "warn" : "info", "missingIndex", `Índice faltante em [${mi.schema}].[${mi.table}] (impacto estimado ${mi.impact.toFixed(1)}%)`, missingIndexDdl(mi));
    }
    for (const w of st.warnings) push(w.kind === "noJoinPredicate" ? "error" : w.kind === "spill" || w.kind === "implicitConversion" ? "warn" : "info", w.kind, w.text);
    const sniff = st.parameters.filter((p) => p.compiled !== null && p.runtime !== null && p.compiled !== p.runtime);
    if (sniff.length) {
      push("info", "parameterSniffing", "Plano compilado com valores de parâmetro diferentes", sniff.map((p) => `${p.name}: compilado ${p.compiled}, execução ${p.runtime}`).join("\n"));
    }
    if (st.memoryGrant?.grantedKb && st.memoryGrant.maxUsedKb !== null && st.memoryGrant.grantedKb >= 10240 && st.memoryGrant.maxUsedKb < st.memoryGrant.grantedKb * 0.1) {
      push("info", "memoryGrant", `Memory grant muito maior que o usado (${kb(st.memoryGrant.grantedKb)} concedido, ${kb(st.memoryGrant.maxUsedKb)} usado)`, "Estimativas de linhas altas demais reservam memória que outras consultas poderiam usar.");
    }
    if (!st.root) continue;
    for (const n of st.nodes) {
      const label = `${opLabel(n)}${n.object ? ` em ${objectText(n)}` : ""}`;
      for (const w of n.warnings) push(w.kind === "noJoinPredicate" ? "error" : w.kind === "spill" || w.kind === "implicitConversion" ? "warn" : "info", w.kind, `${label}: ${w.text}`, "", n.id);
      if (n.costPct >= 25 && st.nodes.length > 1 && st.subtreeCost >= 0.05) push(n.costPct >= 50 ? "warn" : "info", "costly", `${label} concentra ${n.costPct.toFixed(0)}% do custo`, n.predicate ? `Predicado: ${n.predicate}` : "", n.id);
      if (n.actual && n.actual.executions > 0) {
        const est = estTotalRows(n);
        const act = n.actual.rows;
        const ratio = est > 0 ? act / est : act > 0 ? Infinity : 1;
        if (Math.max(est, act) >= 100 && (ratio >= 10 || ratio <= 0.1)) {
          push("warn", "estimate", `Estimativa errada em ${label}: ${fmt(Math.round(est))} estimada(s), ${fmt(act)} real(is)`, "Estatísticas desatualizadas, predicados com funções/conversões ou variáveis de tabela costumam causar isso. Tente UPDATE STATISTICS ou reescrever o filtro.", n.id);
        }
      }
      if (n.lookup) {
        const execs = n.actual ? n.actual.executions : 1 + n.estRebinds + n.estRewinds;
        if (execs >= 100) push("warn", "lookup", `${opLabel(n)} executado ${fmt(execs)} vez(es) em ${objectText(n)}`, "Inclua as colunas buscadas no índice usado pelo seek (INCLUDE) para eliminar o lookup.", n.id);
      }
      if (/Scan/.test(n.physicalOp) && !n.lookup && n.predicate && (n.tableCardinality ?? n.estRowsRead ?? 0) >= 1000) {
        const read = n.actual?.rowsRead ?? n.estRowsRead ?? n.tableCardinality;
        const rows = flowRows(n);
        if (read && rows < read * 0.1) push("info", "scanPredicate", `${label} lê ${fmt(Math.round(read))} linha(s) para devolver ${fmt(Math.round(rows))}`, `Um índice sobre as colunas do filtro permitiria um seek.\nPredicado: ${n.predicate}`, n.id);
      }
      if (/CONVERT_IMPLICIT/i.test(n.predicate) || /CONVERT_IMPLICIT/i.test(n.seekPredicate)) {
        if (![...n.warnings, ...st.warnings].some((w) => w.kind === "implicitConversion")) push("info", "implicitConversion", `Conversão implícita no filtro de ${label}`, n.predicate || n.seekPredicate, n.id);
      }
    }
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** Resumo compacto (CLI e logs): custos, operadores mais caros, avisos, índices faltantes. */
export function planSummary(plan, { top = 5 } = {}) {
  const insights = planInsights(plan);
  return {
    actual: plan.actual,
    statements: plan.statements
      .filter((st) => st.root)
      .map((st) => ({
        index: st.index,
        type: st.type,
        text: st.text,
        cost: round(st.subtreeCost, 4),
        est_rows: st.estRows,
        dop: st.dop,
        compile_ms: st.compileMs,
        cpu_ms: st.timeStats?.cpuMs ?? null,
        elapsed_ms: st.timeStats?.elapsedMs ?? null,
        memory_grant_kb: st.memoryGrant?.grantedKb ?? null,
        top_operators: [...st.nodes]
          .sort((a, b) => b.ownCost - a.ownCost)
          .slice(0, top)
          .map((n) => ({
            node: n.id,
            operator: opLabel(n),
            object: objectText(n),
            cost_pct: round(n.costPct, 1),
            est_rows: round(estTotalRows(n), 1),
            actual_rows: n.actual?.rows ?? null,
            executions: n.actual?.executions ?? null,
            logical_reads: n.actual?.logicalReads ?? null,
            predicate: n.seekPredicate || n.predicate || "",
          })),
        missing_indexes: st.missingIndexes.map((mi) => ({ impact: round(mi.impact, 1), table: `${mi.schema}.${mi.table}`, ddl: missingIndexDdl(mi) })),
        insights: insights.filter((i) => i.statement === st.index).map(({ level, title, detail }) => (detail ? { level, title, detail } : { level, title })),
      })),
  };
}

const round = (n, d) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

// ---------- Layout (estilo SSMS: raiz à esquerda, filhos à direita) ----------

export const NODE_W = 168;
export const NODE_H = 100;
const GAP_X = 56;
const GAP_Y = 22;

/**
 * Posições dos nós: cada pai na altura do primeiro filho, folhas empilhadas (sem sobreposição).
 * Devolve `{ nodes: [{ node, x, y }], edges: [{ from, to, rows, width }], width, height }`.
 */
export function planLayout(root) {
  const nodes = [];
  const edges = [];
  if (!root) return { nodes, edges, width: 0, height: 0 };
  let nextY = 0;
  let maxDepth = 0;
  const place = (n, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const item = { node: n, x: depth * (NODE_W + GAP_X), y: 0 };
    nodes.push(item);
    if (!n.children.length) {
      item.y = nextY;
      nextY += NODE_H + GAP_Y;
    } else {
      const placed = n.children.map((c) => place(c, depth + 1));
      item.y = placed[0].y;
      for (const p of placed) edges.push({ from: item, to: p, rows: flowRows(p.node), width: 0 });
    }
    return item;
  };
  place(root, 0);
  const maxRows = Math.max(1, ...edges.map((e) => e.rows));
  for (const e of edges) e.width = 1.5 + 8 * (Math.log10(e.rows + 1) / Math.log10(maxRows + 1));
  return { nodes, edges, width: (maxDepth + 1) * NODE_W + maxDepth * GAP_X, height: Math.max(NODE_H, nextY - GAP_Y) };
}

// ---------- Formatação ----------

export function formatCount(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("pt-BR");
}

/** 1234567 → "1,2 mi"; para rótulos curtos dos nós. */
export function shortCount(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const f = (v, s) => `${v.toLocaleString("pt-BR", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${s}`;
  if (a >= 1e9) return f(n / 1e9, "bi");
  if (a >= 1e6) return f(n / 1e6, "mi");
  if (a >= 1e4) return f(n / 1e3, "mil");
  return n % 1 ? n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : n.toLocaleString("pt-BR");
}

export function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms >= 60000) return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  if (ms >= 1000) return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} s`;
  return `${Math.round(ms).toLocaleString("pt-BR")} ms`;
}

const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\r/g, "&#xD;").replace(/\n/g, "&#xA;");
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** XML indentado (o servidor manda tudo numa linha). */
export function prettyXml(xml, indent = "  ") {
  const doc = parseXml(String(xml || ""));
  const lines = [];
  const walk = (n, depth) => {
    const pad = indent.repeat(depth);
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
    if (!n.children.length && !n.text) lines.push(`${pad}<${n.name}${attrs} />`);
    else if (!n.children.length) lines.push(`${pad}<${n.name}${attrs}>${escText(n.text)}</${n.name}>`);
    else {
      lines.push(`${pad}<${n.name}${attrs}>`);
      n.children.forEach((c) => walk(c, depth + 1));
      lines.push(`${pad}</${n.name}>`);
    }
  };
  doc.children.forEach((c) => walk(c, 0));
  return lines.join("\n");
}

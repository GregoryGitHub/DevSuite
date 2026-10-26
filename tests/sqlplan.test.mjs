import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = new URL("../src/js/utils/", import.meta.url).href;
const fixture = (name) => readFileSync(new URL(`./fixtures/plans/${name}`, import.meta.url), "utf8");

const plan = await import(base + "sqlPlan.js");
const stats = await import(base + "sqlStats.js");
const perf = await import(base + "sqlPerf.js");

// --- XML
{
  const doc = plan.parseXml(`<?xml version="1.0"?><!-- c --><a x="1 &lt; 2" y='&quot;q&quot;'><b/><c z="&#x41;&#66;">t&amp;u</c></a>`);
  const a = doc.children[0];
  assert.equal(a.name, "a");
  assert.equal(a.attrs.x, "1 < 2");
  assert.equal(a.attrs.y, '"q"');
  assert.deepEqual(a.children.map((c) => c.name), ["b", "c"]);
  assert.equal(a.children[1].attrs.z, "AB");
  assert.equal(a.children[1].text, "t&u");
  const ns = plan.parseXml(`<p:root xmlns:p="urn:x" p:k="v"><p:item a=">"/></p:root>`);
  assert.equal(ns.children[0].name, "root");
  assert.equal(ns.children[0].attrs.k, "v");
  assert.equal(ns.children[0].children[0].attrs.a, ">");
  assert.throws(() => plan.parsePlan("<nada/>"), /ShowPlanXML/);
}

// --- plano real: junção com scan caro e índices faltantes
{
  const p = plan.parsePlan(fixture("actual_join.sqlplan"));
  assert.equal(p.actual, true);
  assert.equal(p.statements.length, 1);
  const st = p.statements[0];
  assert.equal(st.type, "SELECT");
  assert.match(st.text, /^SELECT c\.city/);
  assert.equal(st.nodes.length, 6);
  assert.equal(st.root.physicalOp, "Sort");
  assert.deepEqual(st.timeStats, { cpuMs: 19, elapsedMs: 19 });
  assert.equal(st.memoryGrant.grantedKb, 2128);
  // custos próprios somam o custo do comando
  const own = st.nodes.reduce((t, n) => t + n.ownCost, 0);
  assert.ok(Math.abs(own - st.root.subtreeCost) < 1e-6);
  assert.ok(Math.abs(st.nodes.reduce((t, n) => t + n.costPct, 0) - 100) < 1e-6);
  const scan = st.nodes.find((n) => n.physicalOp === "Clustered Index Scan");
  assert.equal(scan.object.table, "perf_orders");
  assert.equal(scan.actual.rows, 7459);
  assert.equal(scan.actual.executions, 1);
  assert.match(scan.predicate, /\[status\]=\(2\)/);
  assert.ok(scan.costPct > 80);
  const seek = st.nodes.find((n) => n.physicalOp === "Clustered Index Seek");
  assert.equal(seek.seekPredicate, "[c].[id] < (3000)");
  assert.equal(st.missingIndexes.length, 2);
  assert.equal(st.missingIndexes[0].impact > st.missingIndexes[1].impact, true);
  assert.deepEqual(st.missingIndexes[0].include, ["total"]);
  const ddl = plan.missingIndexDdl(st.missingIndexes[0]);
  assert.match(ddl, /^CREATE NONCLUSTERED INDEX \[IX_perf_orders_customer_id_status\]\nON \[dbo\]\.\[perf_orders\] \(\[customer_id\], \[status\]\)\nINCLUDE \(\[total\]\);$/);

  const ins = plan.planInsights(p);
  assert.ok(ins.some((i) => i.kind === "missingIndex" && i.level === "warn"));
  assert.ok(ins.some((i) => i.kind === "costly" && i.nodeId === scan.id));
  assert.ok(ins.some((i) => i.kind === "scanPredicate" && /200\.000/.test(i.title)));
  for (let k = 1; k < ins.length; k++) assert.ok(["error", "warn", "info"].indexOf(ins[k - 1].level) <= ["error", "warn", "info"].indexOf(ins[k].level));

  const sum = plan.planSummary(p, { top: 2 });
  assert.equal(sum.statements[0].top_operators.length, 2);
  assert.equal(sum.statements[0].top_operators[0].operator, "Clustered Index Scan");
  assert.equal(sum.statements[0].missing_indexes.length, 2);

  // layout: sem sobreposição, raiz à esquerda, pai na altura do 1º filho
  const L = plan.planLayout(st.root);
  assert.equal(L.nodes.length, 6);
  assert.equal(L.edges.length, 5);
  for (const a of L.nodes)
    for (const b of L.nodes) {
      if (a === b) continue;
      const overlap = a.x < b.x + plan.NODE_W && b.x < a.x + plan.NODE_W && a.y < b.y + plan.NODE_H && b.y < a.y + plan.NODE_H;
      assert.ok(!overlap, `sobreposição ${a.node.id}/${b.node.id}`);
    }
  assert.equal(L.nodes[0].x, 0);
  for (const e of L.edges) {
    assert.ok(e.to.x > e.from.x);
    assert.ok(e.width >= 1.5 && e.width <= 9.6);
  }
  const hash = L.nodes.find((n) => n.node.id === 3);
  assert.equal(hash.y, L.nodes.find((n) => n.node.id === 4).y);
}

// --- spill + parâmetros
{
  const p = plan.parsePlan(fixture("actual_spill.sqlplan"));
  const sort = p.statements[0].root;
  assert.equal(sort.physicalOp, "Sort");
  assert.equal(sort.warnings.length, 1, "SpillToTempDb + SortSpillDetails num aviso só");
  assert.match(sort.warnings[0].text, /nível 2.*12843 página/);
  assert.ok(plan.planInsights(p).some((i) => i.kind === "spill" && i.level === "warn"));

  const q = plan.parsePlan(fixture("actual_params.sqlplan"));
  assert.deepEqual(q.statements[0].parameters, [{ name: "@cid", type: "int", compiled: "(42)", runtime: "(42)" }]);
  assert.ok(!plan.planInsights(q).some((i) => i.kind === "parameterSniffing"));
  q.statements[0].parameters[0].runtime = "(7)";
  assert.ok(plan.planInsights(q).some((i) => i.kind === "parameterSniffing"));
}

// --- estimado com vários comandos: conversão implícita, Key Lookup
{
  const p = plan.parsePlan(fixture("estimated_multi.sqlplan"));
  assert.equal(p.actual, false);
  assert.deepEqual(p.statements.map((s) => s.type), ["ASSIGN", "SELECT", "SELECT"]);
  assert.equal(p.statements[0].root, null);
  assert.match(p.statements[2].text, /^SELECT name/);
  const st = p.statements[1];
  const lookup = st.nodes.find((n) => n.lookup);
  assert.equal(plan.opLabel(lookup), "Key Lookup");
  assert.equal(st.warnings[0].kind, "implicitConversion");
  assert.equal(st.warnings[0].issue, "Seek Plan");
  const ins = plan.planInsights(p);
  assert.ok(ins.some((i) => i.kind === "implicitConversion" && i.level === "warn"));
  assert.equal(ins.filter((i) => i.kind === "implicitConversion").length, 1, "sem repetir a conversão do comando no nó");
  assert.ok(!ins.some((i) => i.kind === "costly" && i.statement === 2), "comando trivial não gera 'operador caro'");
  assert.equal(plan.flowRows(lookup), plan.estTotalRows(lookup));
}

// --- estimativa errada
{
  const xml = `<ShowPlanXML><BatchSequence><Batch><Statements><StmtSimple StatementText="x" StatementType="SELECT" StatementSubTreeCost="1"><QueryPlan>
  <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="1" EstimatedTotalSubtreeCost="1">
   <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="5000" ActualExecutions="1"/></RunTimeInformation>
   <NestedLoops>
    <RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.2"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="50" ActualExecutions="1"/></RunTimeInformation><IndexScan><Object Schema="[dbo]" Table="[t]" Index="[ix]"/></IndexScan></RelOp>
    <RelOp NodeId="2" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimateRebinds="0" EstimateRewinds="0" EstimatedTotalSubtreeCost="0.7">
      <RunTimeInformation><RunTimeCountersPerThread Thread="1" ActualRows="2500" ActualExecutions="25"/><RunTimeCountersPerThread Thread="2" ActualRows="2500" ActualExecutions="25"/></RunTimeInformation>
      <IndexScan Lookup="1"><Object Schema="[dbo]" Table="[t]" Index="[pk]"/></IndexScan></RelOp>
   </NestedLoops></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
  const p = plan.parsePlan(xml);
  const st = p.statements[0];
  assert.equal(st.nodes[2].actual.rows, 5000, "soma por thread");
  assert.equal(st.nodes[2].actual.executions, 50);
  assert.equal(st.nodes[2].actual.threads, 2);
  assert.ok(Math.abs(st.nodes[0].ownCost - 0.1) < 1e-9);
  const ins = plan.planInsights(p);
  assert.ok(ins.some((i) => i.kind === "estimate" && i.nodeId === 0));
  assert.ok(!ins.some((i) => i.kind === "estimate" && i.nodeId === 1), "50 linhas: pequeno demais para avisar");
  assert.ok(!ins.some((i) => i.kind === "lookup"), "50 execuções: abaixo do limite");
  assert.equal(plan.objectText(st.nodes[1]), "[dbo].[t].[ix]");
}

// --- formatação
assert.equal(plan.shortCount(1234567), "1,2 mi");
assert.equal(plan.shortCount(15000), "15 mil");
assert.equal(plan.shortCount(42), "42");
assert.equal(plan.formatMs(1500), "1,5 s");
assert.equal(plan.formatMs(12), "12 ms");

// --- STATISTICS IO/TIME (inglês e português)
{
  const en = [
    { number: 3613, text: "SQL Server parse and compile time: \n   CPU time = 1 ms, elapsed time = 2 ms." },
    { number: 3615, text: "Table 'perf_orders'. Scan count 1, logical reads 3523, physical reads 2, page server reads 0, read-ahead reads 10, page server read-ahead reads 0, lob logical reads 4, lob physical reads 0, lob page server reads 0, lob read-ahead reads 0, lob page server read-ahead reads 0." },
    { number: 3615, text: "Table 'Worktable'. Scan count 0, logical reads 0, physical reads 0, read-ahead reads 0, lob logical reads 0, lob physical reads 0, lob read-ahead reads 0." },
    { number: 3612, text: "\n SQL Server Execution Times:\n   CPU time = 20 ms,  elapsed time = 21 ms." },
    { number: 0, text: "olá" },
  ];
  const r = stats.parseStatsMessages(en);
  assert.equal(r.tables.length, 2);
  assert.deepEqual(
    { t: r.tables[0].table, s: r.tables[0].scans, l: r.tables[0].logical, p: r.tables[0].physical, ra: r.tables[0].readAhead, lob: r.tables[0].lobLogical },
    { t: "perf_orders", s: 1, l: 3523, p: 2, ra: 10, lob: 4 },
  );
  assert.equal(r.tables[1].table, "Worktable");
  assert.equal(r.totals.logical, 3523);
  assert.equal(r.totals.execCpuMs, 20);
  assert.equal(r.totals.execElapsedMs, 21);
  assert.equal(r.totals.compileElapsedMs, 2);
  assert.equal(r.statements.length, 1);
  assert.equal(r.statements[0].io.length, 2);

  const pt = [
    { number: 3615, text: "Tabela “perf_orders”. Contagem de digitalização 1, leituras lógicas 3523, leituras físicas 0, servidor de páginas lê 0, lê com antecedência 0, servidor de páginas lê com antecedência 0, leituras lógicas lob 0, leituras físicas lob 0, servidor de páginas lob lê 0, lob lê com antecedência 0, servidor de páginas lob lê com antecedência 0." },
    { number: 3615, text: "Tabela 'perf_orders'. Contagem de leitura 2, leitura lógica 10, leitura física 0, leitura do servidor de página 0, leitura antecipada 0, a 0, b 0, c 0, d 0, e 0, f 0." },
    { number: 3612, text: " Tempos de Execução do SQL Server: \n Tempo de CPU = 19 ms, tempo decorrido = 19 ms." },
  ];
  const q = stats.parseStatsMessages(pt);
  assert.equal(q.tables.length, 1, "mesma tabela somada");
  assert.equal(q.tables[0].table, "perf_orders");
  assert.equal(q.tables[0].logical, 3533);
  assert.equal(q.tables[0].scans, 3);
  assert.equal(q.totals.execCpuMs, 19);
  assert.ok(stats.isStatsMessage({ number: 3615 }) && !stats.isStatsMessage({ number: 0 }));
  assert.equal(stats.pagesText(3523), "27,5 MB");
}

// --- DMVs
{
  const sql = perf.topQueriesSql({ by: "memory", limit: 5000, major: 12 });
  assert.match(sql, /TOP \(1000\)/);
  assert.match(sql, /ORDER BY qs\.total_worker_time DESC/, "memory não existe antes do 2016");
  assert.doesNotMatch(sql, /grant/);
  assert.match(perf.topQueriesSql({ by: "reads" }), /WHERE pa\.dbid = DB_ID\(\)[\s\S]*ORDER BY qs\.total_logical_reads DESC/);
  assert.doesNotMatch(perf.topQueriesSql({ thisDb: false }), /WHERE pa\.dbid/);
  assert.throws(() => perf.cachedPlanSql("0x12; DROP TABLE x"), /inválido/);
  assert.equal(perf.cachedPlanSql("0x0600AB", 10, -1), "SELECT query_plan FROM sys.dm_exec_text_query_plan(0x0600AB, 10, -1)");
  assert.match(perf.missingIndexesSql({ table: { schema: "dbo", name: "o'k" } }), /OBJECT_ID\(N'\[dbo\]\.\[o''k\]'\)/);
  assert.equal(perf.killSql(53), "KILL 53;");
  assert.throws(() => perf.killSql("53; DROP"), /inválida/);
  assert.equal(perf.qsForceSql(12, 3), "EXEC sys.sp_query_store_force_plan @query_id = 12, @plan_id = 3;");
  assert.equal(perf.majorVersion({ product: "SQL Server Developer Edition", version: "15.0.4415.2" }), 15);
  assert.equal(perf.majorVersion({ product: "Azure SQL", version: "12.0.2000.8" }), 99);
  assert.match(perf.friendlyError("[297] The user does not have permission"), /VIEW SERVER STATE/);

  assert.deepEqual(perf.splitColumnList("[a], [b c], [x]]y]"), ["a", "b c", "x]y"]);
  assert.equal(
    perf.missingIndexRowDdl({ schema: "dbo", table: "perf_orders", equality_columns: "[status]", inequality_columns: "[customer_id]", included_columns: "[total]" }),
    "CREATE NONCLUSTERED INDEX [IX_perf_orders_status_customer_id]\nON [dbo].[perf_orders] ([status], [customer_id])\nINCLUDE ([total]);",
  );
  assert.equal(perf.maintenanceSql({ schema: "dbo", table: "t", index: "ix", fragmentation_pct: 45 }), "ALTER INDEX [ix] ON [dbo].[t] REBUILD;");
  assert.equal(perf.maintenanceSql({ schema: "dbo", table: "t", index: "ix", fragmentation_pct: 12 }), "ALTER INDEX [ix] ON [dbo].[t] REORGANIZE;");
  assert.equal(perf.maintenanceSql({ schema: "dbo", table: "t", index: "ix", fragmentation_pct: 2 }), "");
  assert.ok(perf.isUnusedIndex({ reads: 0, is_pk: 0, is_unique: 0, type_desc: "NONCLUSTERED" }));
  assert.ok(!perf.isUnusedIndex({ reads: 0, is_pk: 0, is_unique: 1, type_desc: "NONCLUSTERED" }));

  const cols = [{ name: "a" }, { name: "b" }];
  assert.deepEqual(perf.rowsToObjects(cols, [[1, 2]]), [{ a: 1, b: 2 }]);

  // esperas: benignas fora, categorias, delta
  const before = [
    { wait_type: "LCK_M_S", waiting_tasks_count: 2, wait_time_ms: 100, signal_wait_time_ms: 0, max_wait_time_ms: 80 },
    { wait_type: "PAGEIOLATCH_SH", waiting_tasks_count: 10, wait_time_ms: 50, signal_wait_time_ms: 1, max_wait_time_ms: 9 },
  ];
  const after = [
    { wait_type: "LCK_M_S", waiting_tasks_count: 3, wait_time_ms: 400, signal_wait_time_ms: 0, max_wait_time_ms: 300 },
    { wait_type: "PAGEIOLATCH_SH", waiting_tasks_count: 10, wait_time_ms: 50, signal_wait_time_ms: 1, max_wait_time_ms: 9 },
    { wait_type: "SLEEP_TASK", waiting_tasks_count: 999, wait_time_ms: 99999, signal_wait_time_ms: 0, max_wait_time_ms: 1 },
    { wait_type: "CXPACKET", waiting_tasks_count: 4, wait_time_ms: 100, signal_wait_time_ms: 0, max_wait_time_ms: 1 },
  ];
  const d = perf.waitsDelta(before, after);
  assert.deepEqual(d.map((r) => [r.wait_type, r.wait_time_ms]), [["LCK_M_S", 300], ["SLEEP_TASK", 99999], ["CXPACKET", 100]]);
  const s = perf.summarizeWaits(d);
  assert.deepEqual(s.waits.map((w) => w.type), ["LCK_M_S", "CXPACKET"]);
  assert.equal(s.totalMs, 400);
  assert.equal(s.waits[0].pct, 75);
  assert.equal(s.waits[0].category, "Bloqueio (lock)");
  assert.equal(s.categories[1].category, "Paralelismo");
  assert.ok(s.categories[0].tip);

  // cadeia de bloqueio: 51 bloqueia 52, que bloqueia 53; 60 bloqueado por 70 (fora da lista)
  const rows = [
    { session_id: 53, blocking_session_id: 52 },
    { session_id: 52, blocking_session_id: 51 },
    { session_id: 51, blocking_session_id: 0 },
    { session_id: 54, blocking_session_id: 0 },
    { session_id: 60, blocking_session_id: 70 },
  ];
  const tree = perf.blockingTree(rows);
  assert.deepEqual(tree.map((t) => [t.row.session_id, t.depth]), [[51, 0], [52, 1], [53, 2], [70, 0], [60, 1], [54, 0]]);
  assert.equal(tree[0].blocked, 2);
  assert.ok(tree[0].head && !tree[5].head);
  // ciclo não trava
  const cyc = perf.blockingTree([{ session_id: 1, blocking_session_id: 2 }, { session_id: 2, blocking_session_id: 1 }]);
  assert.equal(cyc.length, 2);
}

console.log("sqlplan: ok");

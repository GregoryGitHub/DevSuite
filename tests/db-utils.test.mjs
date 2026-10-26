// Testes dos utilitários da aba Banco (sem framework): node tests/db-utils.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const { splitBatches, splitStatements, statementAt, isReadOnlyQuery } = await import(base + "sqlSplit.js");
const { mssql, DEFAULT, GENERATED } = await import(base + "sqlDialect.js");
const { GridModel, parseInput, aggregate, compareValues } = await import(base + "gridModel.js");
const { buildChanges } = await import(base + "sqlGen.js");
const { toTSV, parseTSV, toJSON, toSqlInList } = await import(base + "gridExport.js");
const { normalizeDbData, connConfig, newConnection } = await import(base + "dbModel.js");

// --- sqlSplit
let b = splitBatches("SELECT 1\nGO\nSELECT ';GO'\ngo 3\n-- só comentário\nGO");
assert.deepEqual(b.map((x) => [x.sql, x.repeat]), [["SELECT 1", 1], ["SELECT ';GO'", 3]]);
let st = splitStatements("SELECT 1; SELECT 'a;b' FROM [x;y];\nUPDATE t SET a=1");
assert.deepEqual(st.map((s) => s.sql), ["SELECT 1", "SELECT 'a;b' FROM [x;y]", "UPDATE t SET a=1"]);
st = splitStatements("SELECT *\nFROM a\n\nSELECT * FROM b\n\nWHERE x = 1");
assert.deepEqual(st.map((s) => s.sql), ["SELECT *\nFROM a", "SELECT * FROM b\n\nWHERE x = 1"]);
st = splitStatements("CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n\n  SELECT 2;\nEND\nGO\nEXEC p");
assert.equal(st.length, 2);
assert.ok(st[0].sql.startsWith("CREATE PROCEDURE") && st[0].sql.endsWith("END"));
st = splitStatements("IF 1=1\nBEGIN\n  SELECT CASE WHEN 1=1 THEN 2 END;\n  SELECT 3;\nEND; SELECT 4");
assert.equal(st.length, 2);
st = splitStatements("WITH x AS (SELECT 1 a)\n\nSELECT * FROM x");
assert.equal(st.length, 1);
st = splitStatements("BEGIN TRAN; UPDATE t SET a = 1; COMMIT");
assert.equal(st.length, 3);
const text = "SELECT 1;\nSELECT 2 FROM t;\n";
assert.equal(statementAt(text, text.indexOf("2")).sql, "SELECT 2 FROM t");
assert.equal(statementAt(text, text.length).sql, "SELECT 2 FROM t");
assert.ok(isReadOnlyQuery("with a as (select 1) select * from a"));
assert.ok(!isReadOnlyQuery("SELECT * INTO x FROM y"));

// --- dialect
assert.equal(mssql.quote("a]b"), "[a]]b]");
assert.equal(mssql.literal("O'Neil"), "N'O''Neil'");
assert.equal(mssql.literal("12.50", "dec"), "12.50");
assert.equal(mssql.literal("1; DROP", "int"), "N'1; DROP'");
assert.equal(mssql.literal(true, "bool"), "1");
assert.equal(mssql.literal(null), "NULL");
assert.equal(mssql.literal(DEFAULT), "DEFAULT");
assert.equal(mssql.literal("0xAB", "bin"), "0xAB");
assert.match(mssql.selectPage({ schema: "dbo", name: "t", offset: 0, limit: 500 }), /OFFSET 0 ROWS FETCH NEXT 501 ROWS ONLY$/);

// --- parseInput / compare
assert.equal(parseInput("42", "int"), 42);
assert.equal(parseInput("9007199254740993", "int"), "9007199254740993");
assert.equal(parseInput("", "int"), null);
assert.throws(() => parseInput("abc", "int"));
assert.equal(parseInput("10.50", "dec"), "10.50");
assert.equal(parseInput("sim", "bool"), true);
assert.equal(compareValues("10", "9", "int"), 1);
assert.equal(compareValues("9007199254740993", "9007199254740992", "int"), 1);
assert.equal(compareValues(null, 1, "int"), -1);

// --- GridModel
const cols = [
  { name: "id", kind: "int", is_pk: true, is_identity: true },
  { name: "name", kind: "str", nullable: true },
  { name: "qty", kind: "int", nullable: false, has_default: true },
];
const m = new GridModel(cols, [[1, "a", 5], [2, "b", 7], [3, null, 5]]);
assert.deepEqual(m.distinct(2).map((d) => [d.key, d.count]), [["5", 2], ["7", 1]]);
m.setFilter(2, new Set(["5"]));
assert.deepEqual(m.view, [0, 2]);
assert.deepEqual(m.distinct(1).map((d) => d.count), [1, 1]);
m.clearFilters();
m.setSort(1, -1);
assert.deepEqual(m.view, [1, 0, 2]);
m.setSort(1, 0);
m.setCell(0, 1, "A");
m.setCell(1, 2, 7); // sem mudança real
assert.equal(m.pendingCount, 1);
m.setCell(0, 1, "a"); // voltou ao original
assert.equal(m.pendingCount, 0);
m.setCell(0, 1, "x'y");
const nr = m.addRow(m.blankRow());
assert.deepEqual(m.rows[nr], [GENERATED, null, DEFAULT]);
m.setCell(nr, 1, "novo");
m.deleteRows([2]);
const changes = buildChanges(mssql, { schema: "dbo", name: "t", kind: "table", columns: cols }, m.pending());
assert.deepEqual(changes.map((c) => c.sql), [
  "DELETE FROM [dbo].[t] WHERE [id] = 3",
  "UPDATE [dbo].[t] SET [name] = N'x''y' WHERE [id] = 1",
  "INSERT INTO [dbo].[t] ([name]) VALUES (N'novo')",
]);
m.revertAll();
assert.equal(m.pendingCount, 0);
assert.equal(m.rows[0][1], "a");
assert.deepEqual(m.view, [0, 1, 2]);
const nr2 = m.addRow(m.blankRow());
m.acceptPending();
assert.equal(m.pendingCount, 0);
assert.ok(m.view.includes(nr2));
assert.deepEqual(aggregate([1, "2", null, "x"], ["int", "int", "int", "str"]), { count: 4, nonNull: 3, numeric: 2, sum: 3, avg: 1.5, min: 1, max: 2 });

// --- export
const tsv = toTSV(["a", "b"], [["x\ty", 'q"'], [null, true]]);
assert.equal(tsv, 'a\tb\n"x\ty"\t"q"""\n\t1');
assert.deepEqual(parseTSV('1\t"multi\nline"\t\n2\tb\t"c""d"\n'), [["1", "multi\nline", ""], ["2", "b", 'c"d']]);
assert.equal(toJSON([{ name: "a", kind: "int" }, { name: "b", kind: "dec" }], [["9007199254740993", "1.50"]]), '[\n  {\n    "a": "9007199254740993",\n    "b": 1.5\n  }\n]');
assert.equal(toSqlInList(mssql, { name: "id", kind: "int" }, [1, 2, 1]), "[id] IN (1, 2)");

// --- dbModel
const d = normalizeDbData({ connections: [{ id: "c1", host: "x", auth: { kind: "entra" } }], ui: { tabs: [{ type: "table", conn_id: "c1" }, { type: "table", conn_id: "zz" }] } });
assert.equal(d.ui.tabs.length, 1);
{
  // abas de plano (só a de arquivo volta) e de desempenho; console com IO/TIME
  const t = normalizeDbData({
    connections: [{ id: "c1", host: "x", auth: { kind: "sql" } }],
    consoles: [{ id: "k1", conn_id: "c1", stats: true }, { id: "k2", conn_id: "c1" }],
    ui: { tabs: [{ type: "plan", conn_id: "c1" }, { type: "plan", conn_id: "c1", options: { path: "C:/x.sqlplan" } }, { type: "perf", conn_id: "c1", database: "db", options: { section: "waits" } }, { type: "bogus", conn_id: "c1" }] },
  });
  assert.deepEqual(t.ui.tabs.map((x) => x.type), ["plan", "perf"]);
  assert.equal(t.ui.tabs[1].options.section, "waits");
  assert.deepEqual(t.consoles.map((c) => c.stats), [true, false]);
}
assert.equal(d.connections[0].auth.kind, "entra");
assert.equal(connConfig(newConnection({ host: "h", instance: "SQLEXPRESS", port: null })).port, null);


// --- connection string
const { parseConnectionString } = await import(base + "dbModel.js");

let r = parseConnectionString("Server=tcp:myserver.database.windows.net,1433;Initial Catalog=mydb;Persist Security Info=False;User ID=adm;Password=p;MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;");
assert.deepEqual(r.patch, { auth: { user: "adm", kind: "sql" }, port: 1433, host: "myserver.database.windows.net", database: "mydb", encrypt: "on", trust_server_certificate: false, connect_timeout_s: 30 });
assert.equal(r.password, "p");

r = parseConnectionString(String.raw`Data Source=PC\SQLEXPRESS;Database=x;Authentication=Active Directory Interactive;User Id=a@b.com`);
assert.equal(r.patch.host, "PC");
assert.equal(r.patch.instance, "SQLEXPRESS");
assert.equal(r.patch.port, null);
assert.equal(r.patch.auth.kind, "entra");

r = parseConnectionString("jdbc:sqlserver://h.example:1444;databaseName=db1;encrypt=false;user=sa;password=x");
assert.equal(r.patch.host, "h.example");
assert.equal(r.patch.port, 1444);
assert.equal(r.patch.encrypt, "off");
assert.equal(r.password, "x");

r = parseConnectionString(`Server=h;Password="a;b""c";User ID='o''k';Lixo;Database=d`);
assert.equal(r.password, 'a;b"c');
assert.equal(r.patch.auth.user, "o'k");
assert.equal(r.patch.database, "d");

// buildConnectionString: ida e volta pelo parser
{
  const { buildConnectionString, newConnection: nc, isMongo } = await import(base + "dbModel.js");
  const sql = nc({ host: "srv.database.windows.net", port: 1444, database: "db", auth: { kind: "sql", user: "adm" }, trust_server_certificate: true, read_intent: true, connect_timeout_s: 20 });
  const s = buildConnectionString(sql, "p;w=d");
  assert.ok(!buildConnectionString(sql).includes("Password"));
  const back = parseConnectionString(s);
  assert.equal(back.password, "p;w=d");
  assert.deepEqual(back.patch, { auth: { user: "adm", kind: "sql" }, port: 1444, host: "srv.database.windows.net", database: "db", encrypt: "on", trust_server_certificate: true, read_intent: true, connect_timeout_s: 20 });

  const inst = parseConnectionString(buildConnectionString(nc({ host: "PC", instance: "SQLEXPRESS", auth: { kind: "entra", user: "a@b.com" } }), "ignorada"));
  assert.equal(inst.patch.host, "PC");
  assert.equal(inst.patch.instance, "SQLEXPRESS");
  assert.equal(inst.patch.auth.kind, "entra");
  assert.equal(inst.password, undefined);

  const mongo = nc({ driver: "mongo", uri: "mongodb+srv://joao%40x@cluster0.ab12.mongodb.net/?retryWrites=true", auth: { kind: "sql", user: "joao@x" } });
  assert.ok(isMongo(mongo));
  assert.equal(buildConnectionString(mongo), "mongodb+srv://joao%40x@cluster0.ab12.mongodb.net/?retryWrites=true");
  assert.equal(buildConnectionString(mongo, "p@ss:1"), "mongodb+srv://joao%40x:p%40ss%3A1@cluster0.ab12.mongodb.net/?retryWrites=true");
  const local = nc({ driver: "mongo", uri: "mongodb://localhost:27017", database: "loja", tls_insecure: true, auth: { kind: "sql", user: "admin" } });
  assert.equal(buildConnectionString(local, "x"), "mongodb://admin:x@localhost:27017/loja?tlsAllowInvalidCertificates=true");
}
// --- sqlDdl (Modificar tabela)
{
  const ddl = await import(base + "sqlDdl.js");
  assert.equal(ddl.stripParens("((0))"), "0");
  assert.equal(ddl.stripParens("(a) + (b)"), "(a) + (b)");
  assert.deepEqual(ddl.parseColumnList("Id, [Nome, Completo] DESC ,x asc"), [{ name: "Id", desc: false }, { name: "Nome, Completo", desc: true }, { name: "x", desc: false }]);
  assert.equal(ddl.formatColumnList([{ name: "Id", desc: false }, { name: "a b", desc: true }]), "Id, [a b] DESC");
  assert.ok(ddl.validType("decimal(18, 2)") && ddl.validType("nvarchar(max)") && ddl.validType("double precision"));
  assert.ok(!ddl.validType("int; DROP TABLE x") && !ddl.validType("int)--"));

  const schema = {
    schema: "dbo",
    name: "pedidos",
    columns: [
      { name: "id", type: "int", nullable: false, identity: true, seed: 1, increment: 1, computed: "", default: "", default_name: "" },
      { name: "cliente", type: "nvarchar(100)", nullable: true, identity: false, seed: 1, increment: 1, computed: "", default: "", default_name: "" },
      { name: "qtd", type: "int", nullable: false, identity: false, seed: 1, increment: 1, computed: "", default: "((1))", default_name: "DF_pedidos_qtd" },
      { name: "obs", type: "nvarchar(max)", nullable: true, identity: false, seed: 1, increment: 1, computed: "", default: "", default_name: "" },
    ],
    indexes: [
      { name: "PK_pedidos", kind: "pk", clustered: true, columns: [{ name: "id", desc: false }], include: [], filter: "", type_desc: "CLUSTERED" },
      { name: "IX_pedidos_cliente", kind: "index", clustered: false, columns: [{ name: "cliente", desc: false }], include: ["qtd"], filter: "", type_desc: "NONCLUSTERED" },
    ],
    fks: [],
    checks: [{ name: "CK_qtd", definition: "([qtd]>(0))" }],
  };
  const d = mssql;
  // Sem mudanças: nenhum comando.
  assert.deepEqual(ddl.buildSchemaChanges(d, ddl.fromSchema(schema)), []);

  let m = ddl.fromSchema(schema);
  const [, cliente, qtd, obs] = m.columns;
  cliente.name = "cliente_nome";
  ddl.renameColumnRefs(m, "cliente", "cliente_nome");
  qtd.type = "bigint"; // índice, default e check dependem dela: saem e voltam
  ddl.dropColumn(m, obs);
  const c = ddl.newColumn(m);
  Object.assign(c, { name: "criado", type: "datetime2(7)", nullable: false, default: "sysutcdatetime()" });
  m.columns.push(c);
  m.name = "pedido";
  let sql = ddl.buildSchemaChanges(d, m);
  assert.deepEqual(sql, [
    "ALTER TABLE [dbo].[pedidos] DROP CONSTRAINT [CK_qtd]",
    "DROP INDEX [IX_pedidos_cliente] ON [dbo].[pedidos]",
    "ALTER TABLE [dbo].[pedidos] DROP CONSTRAINT [DF_pedidos_qtd]",
    "ALTER TABLE [dbo].[pedidos] DROP COLUMN [obs]",
    "EXEC sp_rename N'[dbo].[pedidos].[cliente]', N'cliente_nome', 'COLUMN'",
    "ALTER TABLE [dbo].[pedidos] ALTER COLUMN [qtd] bigint NOT NULL",
    "ALTER TABLE [dbo].[pedidos] ADD CONSTRAINT [DF_pedidos_qtd] DEFAULT (1) FOR [qtd]",
    "ALTER TABLE [dbo].[pedidos] ADD [criado] datetime2(7) NOT NULL CONSTRAINT [DF_pedido_criado] DEFAULT (sysutcdatetime())",
    "CREATE NONCLUSTERED INDEX [IX_pedidos_cliente] ON [dbo].[pedidos] ([cliente_nome]) INCLUDE ([qtd])",
    "ALTER TABLE [dbo].[pedidos] ADD CONSTRAINT [CK_qtd] CHECK ([qtd]>(0))",
    "EXEC sp_rename N'[dbo].[pedidos]', N'pedido'",
  ]);
  assert.deepEqual(ddl.validate(m), []);

  // Excluir a coluna leva o índice junto; restaurar devolve.
  m = ddl.fromSchema(schema);
  ddl.dropColumn(m, m.columns[1]);
  assert.ok(m.indexes[1].dropped);
  ddl.restoreColumn(m, m.columns[1]);
  assert.ok(!m.indexes[1].dropped);

  // Só renomear o índice usa sp_rename; PK nova via checkbox.
  m = ddl.fromSchema(schema);
  m.indexes[1].name = "IX_cli";
  ddl.togglePk(m, m.columns[0], false);
  assert.ok(m.indexes[0].dropped);
  sql = ddl.buildSchemaChanges(d, m);
  assert.deepEqual(sql, ["ALTER TABLE [dbo].[pedidos] DROP CONSTRAINT [PK_pedidos]", "EXEC sp_rename N'[dbo].[pedidos].[IX_pedidos_cliente]', N'IX_cli', 'INDEX'"]);

  // Nova tabela.
  m = ddl.newTableModel("dbo");
  m.name = "itens";
  m.columns.push(Object.assign(ddl.newColumn(m), { name: "pedido_id", type: "int", nullable: false }));
  const fk = ddl.newFk();
  Object.assign(fk, { columns: ["pedido_id"], ref_table: "pedidos", ref_columns: ["id"], on_delete: "CASCADE" });
  m.fks.push(fk);
  assert.deepEqual(ddl.buildSchemaChanges(d, m), [
    `CREATE TABLE [dbo].[itens]
(
    [Id] int IDENTITY(1, 1) NOT NULL,
    [pedido_id] int NOT NULL,
    CONSTRAINT [PK_itens] PRIMARY KEY CLUSTERED ([Id]),
    CONSTRAINT [FK_itens_pedidos] FOREIGN KEY ([pedido_id]) REFERENCES [dbo].[pedidos] ([id]) ON DELETE CASCADE
)`,
  ]);
  m.columns[0].nullable = true;
  assert.ok(ddl.validate(m).some((e) => /chave primária/.test(e)));
  assert.equal(ddl.renameObjectSql(d, { schema: "dbo", name: "a'b" }, "c"), "EXEC sp_rename N'[dbo].[a''b]', N'c'");
}

// --- Parâmetros (:nome / {{nome}}) e consultas salvas
{
  const { findParams, bindParams, inferType, ParamError } = await import(base + "sqlParams.js");
  const { queriesFor, queryFolders, normalizeFolder } = await import(base + "dbModel.js");
  const opts = { lang: "sql", dialect: mssql };
  assert.deepEqual(findParams("SELECT * FROM t WHERE id = :id AND n = :nome OR id = :id"), ["id", "nome"]);
  // strings, comentários, identificadores, :: e SQLCMD não contam
  assert.deepEqual(findParams("SELECT ':x', [a:b], \"c:d\" -- :y\n/* :z */ FROM t WHERE a::int = 1"), []);
  assert.deepEqual(findParams(":setvar x 1\nSELECT 1"), []);
  assert.deepEqual(findParams("SELECT 'it''s :no', :yes"), ["yes"]);
  assert.deepEqual(findParams("WHERE nome LIKE '%{{q}}%' AND id = {{ id }}"), ["q", "id"]);
  assert.deepEqual(findParams("GRANT SELECT ON SCHEMA::dbo TO x"), []);
  assert.equal(bindParams("WHERE id = :id AND n = :n", { id: { type: "auto", value: "42" }, n: { type: "auto", value: "O'Neil" } }, opts), "WHERE id = 42 AND n = N'O''Neil'");
  assert.equal(bindParams("LIKE '%{{q}}%'", { q: { type: "text", value: "a'b" } }, opts), "LIKE '%a''b%'");
  assert.equal(bindParams("= :d", { d: { type: "date", value: "2026-01-02" } }, opts), "= '2026-01-02'");
  assert.equal(bindParams("= :b", { b: { type: "bool", value: "true" } }, opts), "= 1");
  assert.equal(bindParams("= :x", { x: { type: "null", value: "" } }, opts), "= NULL");
  assert.equal(bindParams("IN (:ids)", { ids: { type: "raw", value: "1, 2" } }, opts), "IN (1, 2)");
  assert.equal(bindParams("= :n", { n: { type: "text", value: "12" } }, opts), "= N'12'");
  assert.throws(() => bindParams("= :n", { n: { type: "number", value: "1; DROP" } }, opts), ParamError);
  assert.throws(() => bindParams("= :n", {}, opts), ParamError);
  assert.equal(inferType("-3.5"), "number");
  assert.equal(inferType("abc"), "text");
  // MongoDB: só {{ }}; literais do mongosh e escape dentro de strings
  const mo = { lang: "mongo" };
  assert.deepEqual(findParams("db.c.find({ a: :x, b: {{y}} }) // {{z}}", "mongo"), ["y"]);
  assert.equal(bindParams('db.c.find({ s: {{s}}, n: {{n}} })', { s: { type: "auto", value: 'a"b' }, n: { type: "auto", value: "5" } }, mo), 'db.c.find({ s: "a\\"b", n: 5 })');
  assert.equal(bindParams('db.c.find({ s: "x{{s}}" })', { s: { type: "text", value: 'q"' } }, mo), 'db.c.find({ s: "xq\\"" })');
  assert.equal(bindParams("db.c.find({ d: {{d}} })", { d: { type: "date", value: "2026-01-01" } }, mo), 'db.c.find({ d: ISODate("2026-01-01") })');

  assert.equal(normalizeFolder(" a / b//c "), "a/b/c");
  const conn = newConnection({ host: "h" });
  const data = normalizeDbData({
    connections: [conn],
    queries: [
      { conn_id: conn.id, database: "db1", folder: "Rel/Mensal", name: "q1", sql: "SELECT 1", params: { id: { type: "number", last: 3 } } },
      { conn_id: conn.id, database: "", name: "q2" },
      { conn_id: "outra", database: "db1", name: "órfã" },
    ],
  });
  assert.equal(data.queries.length, 2);
  assert.deepEqual(data.queries[0].params, { id: { type: "number", last: "3" } });
  assert.equal(queriesFor(data, conn.id, "db1").length, 1);
  assert.equal(queriesFor(data, conn.id, "db1", true).length, 2);
  assert.deepEqual(queryFolders(data.queries), ["Rel", "Rel/Mensal"]);
  assert.equal(normalizeDbData({ connections: [conn], consoles: [{ conn_id: conn.id, saved_id: "x" }] }).consoles[0].saved_id, "x");
}

console.log("db utils: ok");


//! Testes de integração do driver SQL Server. Só rodam com um servidor disponível:
//!
//! ```text
//! docker run -d -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=TodoRs#Test2026" -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest
//! TODORS_MSSQL_TEST="localhost,14333,sa,TodoRs#Test2026" cargo test it_ -- --test-threads=1
//! ```

use std::time::Duration;

use serde_json::{json, Value};

use super::driver::*;

struct Collect(Vec<ExecEvent>);

impl EventSink for Collect {
    fn send(&mut self, event: ExecEvent) -> DbResult<()> {
        self.0.push(event);
        Ok(())
    }
}

impl Collect {
    fn rows(&self, index: usize) -> Vec<Vec<Value>> {
        self.0
            .iter()
            .filter_map(|e| match e {
                ExecEvent::Rows { index: i, rows } if *i == index => Some(rows.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn columns(&self, index: usize) -> Vec<ColumnMeta> {
        self.0
            .iter()
            .find_map(|e| match e {
                ExecEvent::ResultStart { index: i, columns } if *i == index => Some(columns.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }
}

fn config(database: &str) -> Option<(ConnConfig, String)> {
    let spec = std::env::var("TODORS_MSSQL_TEST").ok().filter(|s| !s.is_empty())?;
    let parts: Vec<&str> = spec.splitn(4, ',').collect();
    let cfg = ConnConfig {
        id: "it".into(),
        driver: "mssql".into(),
        host: parts[0].into(),
        port: Some(parts[1].parse().unwrap()),
        instance: None,
        database: database.into(),
        auth: AuthConfig { kind: "sql".into(), user: parts[2].into(), tenant: String::new(), client_id: String::new() },
        encrypt: "on".into(),
        trust_server_certificate: true,
        read_intent: false,
        connect_timeout_s: 15,
        uri: String::new(),
        tls_insecure: false,
        long_running: true,
    };
    Some((cfg, parts[3].to_string()))
}

async fn session(database: &str) -> Option<Box<dyn Session>> {
    let (cfg, pw) = config(database)?;
    Some(driver_for("mssql").unwrap().connect(&cfg, "", Secret::Password(pw)).await.expect("connect"))
}

async fn exec(s: &mut Box<dyn Session>, sql: &str) -> (Collect, ExecSummary) {
    let mut sink = Collect(Vec::new());
    let summary = s.execute(sql, &mut sink, None).await.unwrap_or_else(|e| panic!("{sql}\n=> {e}"));
    (sink, summary)
}

const SETUP: &str = "
IF DB_ID('TodoRsIt') IS NULL CREATE DATABASE TodoRsIt;
";

const SCHEMA: &str = "
IF OBJECT_ID('dbo.orders') IS NOT NULL DROP TABLE dbo.orders;
IF OBJECT_ID('dbo.patients') IS NOT NULL DROP TABLE dbo.patients;
CREATE TABLE dbo.patients (
    id uniqueidentifier NOT NULL CONSTRAINT pk_patients PRIMARY KEY DEFAULT NEWID(),
    name nvarchar(200) NOT NULL,
    born date NULL,
    weight decimal(9,3) NULL,
    big bigint NULL,
    active bit NOT NULL DEFAULT 1,
    created datetime2(7) NOT NULL DEFAULT SYSDATETIME(),
    avatar varbinary(max) NULL,
    notes nvarchar(max) NULL
);
CREATE TABLE dbo.orders (
    id int IDENTITY(1,1) PRIMARY KEY,
    patient_id uniqueidentifier NOT NULL CONSTRAINT fk_orders_patient REFERENCES dbo.patients(id),
    total money NOT NULL,
    total_x2 AS (total * 2)
);
CREATE INDEX ix_orders_patient ON dbo.orders(patient_id) INCLUDE (total);
";

#[tokio::test]
async fn it_end_to_end() {
    let Some(mut master) = session("master").await else {
        eprintln!("TODORS_MSSQL_TEST não definido; teste ignorado");
        return;
    };
    let info = master.server_info().await.unwrap();
    assert!(info.product.starts_with("SQL Server"), "{info:?}");
    exec(&mut master, SETUP).await;
    master.close().await;

    let mut s = session("TodoRsIt").await.unwrap();
    exec(&mut s, SCHEMA).await;

    // DML simples devolve linhas afetadas.
    let (_, sum) = exec(
        &mut s,
        "INSERT INTO dbo.patients (id, name, born, weight, big, avatar, notes) VALUES \
         ('6F9619FF-8B86-D011-B42D-00C04FC964FF', N'Ana ''Lú''', '1990-05-01', 61.250, 9007199254740993, 0xCAFE, N'linha1\nlinha2'), \
         (NEWID(), N'Bruno', NULL, NULL, NULL, NULL, NULL)",
    )
    .await;
    assert_eq!(sum.rows_affected, Some(2));

    // Tipos convertidos sem perder precisão.
    let (c, sum) = exec(&mut s, "SELECT id, name, born, weight, big, active, created, avatar, notes FROM dbo.patients ORDER BY name").await;
    assert_eq!(sum.result_sets, 1);
    let cols = c.columns(0);
    let kinds: Vec<&str> = cols.iter().map(|c| c.kind).collect();
    assert_eq!(kinds, ["guid", "str", "date", "dec", "int", "bool", "datetime", "bin", "str"]);
    let rows = c.rows(0);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][0], json!("6F9619FF-8B86-D011-B42D-00C04FC964FF"));
    assert_eq!(rows[0][1], json!("Ana 'Lú'"));
    assert_eq!(rows[0][2], json!("1990-05-01"));
    assert_eq!(rows[0][3], json!("61.250"));
    assert_eq!(rows[0][4], json!("9007199254740993"));
    assert_eq!(rows[0][5], json!(true));
    assert_eq!(rows[0][7], json!("0xCAFE"));
    assert_eq!(rows[1][2], Value::Null);
    let created = rows[0][6].as_str().unwrap();
    assert_eq!(created.len(), "2026-01-01 00:00:00.0000000".len(), "{created}");
    let (c, _) = exec(&mut s, "SELECT CAST('2026-01-02 03:04:05.123' AS datetime), CAST('2026-01-02 03:04:05.1234567 -03:00' AS datetimeoffset), CAST('10:11:12.5' AS time(7))").await;
    assert_eq!(c.rows(0), vec![vec![json!("2026-01-02 03:04:05.123"), json!("2026-01-02 03:04:05.1234567 -03:00"), json!("10:11:12.5000000")]]);

    // Vários result sets e limite de linhas por result set.
    let (_, _) = exec(&mut s, "INSERT INTO dbo.orders (patient_id, total) SELECT TOP 1 id, 10.5 FROM dbo.patients").await;
    let mut sink = Collect(Vec::new());
    let sum = s
        .execute("SELECT TOP 50 a.object_id FROM sys.objects a CROSS JOIN sys.objects b; SELECT total, total_x2 FROM dbo.orders", &mut sink, Some(10))
        .await
        .unwrap();
    assert_eq!(sum.result_sets, 2);
    assert!(sum.truncated);
    assert_eq!(sink.rows(0).len(), 10);
    assert_eq!(sink.rows(1), vec![vec![json!(10.5), json!(21.0)]]);

    // Erro do servidor não derruba a sessão.
    let mut sink = Collect(Vec::new());
    let err = s.execute("SELECT * FROM tabela_que_nao_existe", &mut sink, None).await.unwrap_err();
    assert!(err.contains("208"), "{err}");
    assert!(!s.is_broken());
    let (c, _) = exec(&mut s, "SELECT 1 AS ok").await;
    assert_eq!(c.rows(0), vec![vec![json!(1)]]);

    // Introspecção.
    let schemas = s.introspect(&ObjectPath { kind: "schemas".into(), schema: String::new(), name: String::new() }).await.unwrap();
    assert!(schemas.iter().any(|n| n.name == "dbo"));
    let objects = s.introspect(&ObjectPath { kind: "schema".into(), schema: "dbo".into(), name: String::new() }).await.unwrap();
    assert!(objects.iter().any(|n| n.name == "patients" && n.kind == "table" && n.rows == Some(2)));
    let children = s.introspect(&ObjectPath { kind: "table".into(), schema: "dbo".into(), name: "orders".into() }).await.unwrap();
    assert!(children.iter().any(|n| n.kind == "fk" && n.name == "fk_orders_patient"));
    assert!(children.iter().any(|n| n.kind == "index" && n.name == "ix_orders_patient"));
    let info = s.table_info("dbo", "orders").await.unwrap();
    assert!(info.columns[0].is_pk && info.columns[0].is_identity);
    assert_eq!(info.columns[1].fk.as_ref().unwrap().table, "patients");
    assert!(info.columns[3].is_computed);
    let ddl = s.ddl(&ObjectPath { kind: "table".into(), schema: "dbo".into(), name: "orders".into() }).await.unwrap();
    assert!(ddl.contains("IDENTITY(1, 1)") && ddl.contains("FOREIGN KEY") && ddl.contains("INCLUDE ([total])"), "{ddl}");

    // Contagem de registros afetados em scripts (sp_executesql), sem contar linhas de SELECT.
    let (c, sum) = exec(&mut s, "UPDATE dbo.patients SET weight = weight WHERE 1 = 1; SELECT name FROM dbo.patients; DELETE FROM dbo.orders WHERE 1 = 0").await;
    assert_eq!(sum.rows_affected, Some(2), "{sum:?}");
    assert_eq!(c.rows(0).len(), 2);
    let (_, sum) = exec(&mut s, "DECLARE @n int = 2; IF @n > 1 UPDATE dbo.patients SET weight = weight").await;
    assert_eq!(sum.rows_affected, Some(2));
    let (_, sum) = exec(&mut s, "BEGIN TRAN; DELETE FROM dbo.orders WHERE 1 = 0; UPDATE dbo.patients SET weight = weight; COMMIT").await;
    assert_eq!(sum.rows_affected, Some(2), "transação explícita no lote");
    let (_, sum) = exec(&mut s, "MERGE dbo.patients AS t USING (SELECT N'Bruno' AS name) AS src ON t.name = src.name WHEN MATCHED THEN UPDATE SET t.weight = t.weight;").await;
    assert_eq!(sum.rows_affected, Some(1), "MERGE");
    let (_, sum) = exec(&mut s, "SELECT * FROM dbo.patients; DECLARE @x int = 1; SET @x = 2;").await;
    assert_eq!(sum.rows_affected, None, "sem DML: sem contagem");
    let (_, sum) = exec(&mut s, "WITH x AS (SELECT TOP 1 id FROM dbo.patients ORDER BY name) UPDATE p SET weight = weight FROM dbo.patients p JOIN x ON x.id = p.id").await;
    assert_eq!(sum.rows_affected, Some(1));

    // apply: transação própria, tudo ou nada.
    let err = s
        .apply(&["UPDATE dbo.patients SET name = N'X' WHERE name = N'Bruno'".into(), "INSERT INTO dbo.orders (patient_id, total) VALUES (NEWID(), 1)".into()], true)
        .await
        .unwrap_err();
    assert!(err.starts_with("Comando 2 de 2"), "{err}");
    let (c, _) = exec(&mut s, "SELECT COUNT(*) FROM dbo.patients WHERE name = N'X'").await;
    assert_eq!(c.rows(0), vec![vec![json!(0)]], "rollback esperado");
    let affected = s.apply(&["UPDATE dbo.patients SET name = N'Bia' WHERE name = N'Bruno'".into()], true).await.unwrap();
    assert_eq!(affected, vec![1]);

    // Transação manual.
    assert_eq!(s.begin().await.unwrap(), 1);
    exec(&mut s, "DELETE FROM dbo.orders").await;
    assert_eq!(s.rollback().await.unwrap(), 0);
    let (c, _) = exec(&mut s, "SELECT COUNT(*) FROM dbo.orders").await;
    assert_eq!(c.rows(0), vec![vec![json!(1)]]);

    // Cancelamento: o future é descartado e a sessão se marca para reabrir;
    // fechar o socket aborta o lote e desfaz a transação no servidor.
    assert_eq!(s.begin().await.unwrap(), 1);
    exec(&mut s, "UPDATE dbo.patients SET name = N'cancelado' WHERE name = N'Bia'").await;
    {
        let mut sink = Collect(Vec::new());
        let fut = s.execute("WAITFOR DELAY '00:00:30'; SELECT 1", &mut sink, None);
        let r = tokio::time::timeout(Duration::from_millis(500), fut).await;
        assert!(r.is_err(), "deveria estar esperando");
    }
    s.cancel().await;
    assert!(s.is_broken());
    drop(s);
    let mut s = session("TodoRsIt").await.unwrap();
    let (c, _) = exec(&mut s, "SELECT COUNT(*) FROM dbo.patients WHERE name = N'cancelado'").await;
    assert_eq!(c.rows(0), vec![vec![json!(0)]], "transação desfeita pelo servidor");
    s.close().await;
}

/// Análise de desempenho: mensagens (PRINT, STATISTICS IO/TIME) e planos estimado/real.
#[tokio::test]
async fn it_plans_and_messages() {
    let Some(mut master) = session("master").await else {
        eprintln!("TODORS_MSSQL_TEST não definido; teste ignorado");
        return;
    };
    exec(&mut master, SETUP).await;
    master.close().await;
    let mut s = session("TodoRsIt").await.unwrap();
    exec(&mut s, "IF OBJECT_ID('dbo.perf_it') IS NOT NULL DROP TABLE dbo.perf_it; CREATE TABLE dbo.perf_it (id int PRIMARY KEY, v int);                   INSERT INTO dbo.perf_it SELECT TOP 500 ROW_NUMBER() OVER (ORDER BY (SELECT 1)), 1 FROM sys.objects a CROSS JOIN sys.objects b").await;

    let messages = |c: &Collect| -> Vec<(u32, String)> {
        c.0.iter().filter_map(|e| match e { ExecEvent::Message { number, text, .. } => Some((*number, text.clone())), _ => None }).collect()
    };
    let plans = |c: &Collect| -> Vec<String> {
        c.0.iter().filter_map(|e| match e { ExecEvent::Plan { xml, .. } => Some(xml.clone()), _ => None }).collect()
    };

    // PRINT vira mensagem.
    let (c, _) = exec(&mut s, "PRINT 'olá'; SELECT 1").await;
    assert_eq!(messages(&c).last().map(|m| m.1.as_str()), Some("olá"));

    // Estimado: devolve o plano e não executa.
    let mut c = Collect(Vec::new());
    let opts = ExecOptions { plan: Some("estimated".into()), ..Default::default() };
    let sum = s.execute_with("INSERT INTO dbo.perf_it VALUES (100000, 1); SELECT COUNT(*) FROM dbo.perf_it WHERE v = 1", &mut c, None, &opts).await.unwrap();
    assert_eq!(sum.result_sets, 0);
    let p = plans(&c);
    assert_eq!(p.len(), 1, "um plano por lote no SHOWPLAN_XML");
    assert!(p[0].contains("<ShowPlanXML") && p[0].contains("StatementType=\"INSERT\""), "{}", &p[0][..200.min(p[0].len())]);
    let (c, _) = exec(&mut s, "SELECT COUNT(*) FROM dbo.perf_it WHERE id = 100000").await;
    assert_eq!(c.rows(0), vec![vec![json!(0)]], "SHOWPLAN não executa e foi desligado");

    // Real + IO/TIME: resultado normal, plano com ActualRows e mensagens de estatística.
    let mut c = Collect(Vec::new());
    let opts = ExecOptions { plan: Some("actual".into()), stats_io: true, stats_time: true };
    let sum = s.execute_with("SELECT COUNT(*) FROM dbo.perf_it WHERE v = 1", &mut c, None, &opts).await.unwrap();
    assert_eq!(sum.result_sets, 1);
    assert_eq!(c.rows(0), vec![vec![json!(500)]]);
    let p = plans(&c);
    assert_eq!(p.len(), 1);
    assert!(p[0].contains("ActualRows=\"500\""), "plano real");
    let nums: Vec<u32> = messages(&c).iter().map(|m| m.0).collect();
    assert!(nums.contains(&3615), "STATISTICS IO: {nums:?}");
    assert!(nums.contains(&3612), "STATISTICS TIME: {nums:?}");

    // Depois as opções estão desligadas.
    let (c, sum) = exec(&mut s, "SELECT COUNT(*) FROM dbo.perf_it").await;
    assert_eq!(sum.result_sets, 1);
    assert!(plans(&c).is_empty() && !messages(&c).iter().any(|m| m.0 == 3615));

    // Erro de compilação no estimado: erro devolvido e a sessão volta ao normal.
    let mut c = Collect(Vec::new());
    let opts = ExecOptions { plan: Some("estimated".into()), ..Default::default() };
    assert!(s.execute_with("SELECT * FROM nao_existe_xyz", &mut c, None, &opts).await.is_err());
    let (c, _) = exec(&mut s, "SELECT 2").await;
    assert_eq!(c.rows(0), vec![vec![json!(2)]]);
    s.close().await;
}

/// Estrutura editável (db_table_schema) e o DDL gerado por `sqlDdl.js` (mesmos comandos que
/// `tests/db-utils.test.mjs` espera), executado como o diálogo faz: numa transação.
#[tokio::test]
async fn it_table_schema() {
    let Some(mut master) = session("master").await else {
        eprintln!("TODORS_MSSQL_TEST não definido; teste ignorado");
        return;
    };
    exec(&mut master, SETUP).await;
    master.close().await;
    let mut s = session("TodoRsIt").await.unwrap();
    exec(
        &mut s,
        "IF OBJECT_ID('dbo.itens') IS NOT NULL DROP TABLE dbo.itens;
         IF OBJECT_ID('dbo.pedido') IS NOT NULL DROP TABLE dbo.pedido;
         IF OBJECT_ID('dbo.pedidos') IS NOT NULL DROP TABLE dbo.pedidos;
         CREATE TABLE dbo.pedidos (
             id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_pedidos PRIMARY KEY CLUSTERED,
             cliente nvarchar(100) NULL,
             qtd int NOT NULL CONSTRAINT DF_pedidos_qtd DEFAULT 1,
             obs nvarchar(max) NULL,
             CONSTRAINT CK_qtd CHECK (qtd > 0));
         CREATE INDEX IX_pedidos_cliente ON dbo.pedidos(cliente) INCLUDE (qtd);
         INSERT INTO dbo.pedidos (cliente, obs) VALUES (N'Ana', N'x');",
    )
    .await;

    let t = s.table_schema("dbo", "pedidos").await.unwrap();
    let qtd = &t.columns[2];
    assert!(t.columns[0].identity && !t.columns[0].nullable);
    assert_eq!((qtd.default.as_str(), qtd.default_name.as_str()), ("((1))", "DF_pedidos_qtd"));
    assert_eq!(t.columns[3].full_type, "nvarchar(max)");
    assert_eq!((t.indexes[0].name.as_str(), t.indexes[0].kind.as_str(), t.indexes[0].clustered), ("PK_pedidos", "pk", true));
    let ix = &t.indexes[1];
    assert_eq!((ix.kind.as_str(), ix.columns[0].name.as_str(), ix.include.clone()), ("index", "cliente", vec!["qtd".to_string()]));
    assert_eq!(t.checks[0].definition, "([qtd]>(0))");
    assert!(s.table_schema("dbo", "nao_existe").await.is_err());

    // Nova tabela com FK (sqlDdl.newTableModel + FK).
    s.apply(&["SET LOCK_TIMEOUT 15000;\nCREATE TABLE [dbo].[itens]\n(\n    [Id] int IDENTITY(1, 1) NOT NULL,\n    [pedido_id] int NOT NULL,\n    CONSTRAINT [PK_itens] PRIMARY KEY CLUSTERED ([Id]),\n    CONSTRAINT [FK_itens_pedidos] FOREIGN KEY ([pedido_id]) REFERENCES [dbo].[pedidos] ([id]) ON DELETE CASCADE\n)".into()], true)
        .await
        .unwrap();

    // Renomeia coluna, troca tipo (índice, default e check dependentes saem e voltam), exclui
    // coluna, adiciona coluna NOT NULL com default e renomeia a tabela.
    let script = [
        "SET LOCK_TIMEOUT 15000;\nALTER TABLE [dbo].[pedidos] DROP CONSTRAINT [CK_qtd]",
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
    ];
    s.apply(&script.map(String::from), true).await.unwrap();
    let t = s.table_schema("dbo", "pedido").await.unwrap();
    let names: Vec<_> = t.columns.iter().map(|c| format!("{} {}", c.name, c.full_type)).collect();
    assert_eq!(names, ["id int", "cliente_nome nvarchar(100)", "qtd bigint", "criado datetime2(7)"]);
    assert_eq!(t.columns[2].default_name, "DF_pedidos_qtd");
    assert_eq!(t.indexes[1].columns[0].name, "cliente_nome");
    assert_eq!(t.checks.len(), 1);
    let itens = s.table_schema("dbo", "itens").await.unwrap();
    assert_eq!((itens.fks[0].ref_table.as_str(), itens.fks[0].on_delete.as_str()), ("pedido", "CASCADE"));

    // Tirar a PK referenciada por FK falha e nada muda (tudo ou nada).
    let err = s
        .apply(&["SET LOCK_TIMEOUT 15000;\nEXEC sp_rename N'[dbo].[pedido].[IX_pedidos_cliente]', N'IX_cli', 'INDEX'".into(), "ALTER TABLE [dbo].[pedido] DROP CONSTRAINT [PK_pedidos]".into()], true)
        .await
        .unwrap_err();
    assert!(err.starts_with("Comando 2 de 2"), "{err}");
    let t = s.table_schema("dbo", "pedido").await.unwrap();
    assert_eq!(t.indexes[1].name, "IX_pedidos_cliente", "rename desfeito");

    exec(&mut s, "DROP TABLE dbo.itens; TRUNCATE TABLE dbo.pedido; DROP TABLE dbo.pedido;").await;
    s.close().await;
}

const SCRIPT_SOURCE: &[&str] = &[
    "CREATE SCHEMA vendas",
    "CREATE TYPE dbo.Nome FROM nvarchar(80) NOT NULL;
     CREATE TYPE dbo.ListaIds AS TABLE (id int NOT NULL PRIMARY KEY, peso int NULL DEFAULT 1, CHECK (peso > 0));
     CREATE SEQUENCE dbo.seq_pedido AS int START WITH 100 INCREMENT BY 5;",
    "CREATE FUNCTION dbo.fn_dobro(@x int) RETURNS int WITH SCHEMABINDING AS BEGIN RETURN @x * 2 END",
    // Filha antes da mãe em ordem alfabética: aitens -> pedidos -> clientes.
    "CREATE TABLE dbo.clientes (
         id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_clientes PRIMARY KEY,
         nome dbo.Nome,
         codigo varchar(10) COLLATE Latin1_General_BIN NULL);
     CREATE UNIQUE INDEX UX_clientes_nome ON dbo.clientes(nome);
     CREATE TABLE dbo.pedidos (
         id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_pedidos PRIMARY KEY,
         numero int NOT NULL CONSTRAINT DF_pedidos_numero DEFAULT (NEXT VALUE FOR dbo.seq_pedido),
         cliente_id int NOT NULL CONSTRAINT FK_pedidos_clientes REFERENCES dbo.clientes(id),
         total money NOT NULL CONSTRAINT DF_pedidos_total DEFAULT 0,
         total_x2 AS (total * 2) PERSISTED);
     CREATE INDEX IX_pedidos_cliente ON dbo.pedidos(cliente_id DESC) INCLUDE (total) WHERE total > 0;
     CREATE TABLE dbo.aitens (
         id int IDENTITY(1,1) PRIMARY KEY,
         pedido_id int NOT NULL CONSTRAINT FK_aitens_pedidos REFERENCES dbo.pedidos(id) ON DELETE CASCADE,
         qtd int NOT NULL CONSTRAINT DF_aitens_qtd DEFAULT 1,
         dobro AS dbo.fn_dobro(qtd),
         CONSTRAINT CK_aitens_qtd CHECK (qtd > 0));
     CREATE TABLE vendas.depto (id int PRIMARY KEY, gerente_id int NULL);
     CREATE TABLE vendas.funcionario (id int PRIMARY KEY, depto_id int NULL, chefe_id int NULL CONSTRAINT FK_func_chefe REFERENCES vendas.funcionario(id));
     ALTER TABLE vendas.depto ADD CONSTRAINT FK_depto_gerente FOREIGN KEY (gerente_id) REFERENCES vendas.funcionario(id);
     ALTER TABLE vendas.funcionario ADD CONSTRAINT FK_func_depto FOREIGN KEY (depto_id) REFERENCES vendas.depto(id);",
    "CREATE VIEW dbo.v1 AS SELECT 1 AS x",
    "CREATE VIEW dbo.v2 AS SELECT id AS x FROM dbo.pedidos",
    // v1 (criada antes) passa a depender de v2.
    "ALTER VIEW dbo.v1 AS SELECT x FROM dbo.v2",
    "CREATE FUNCTION dbo.fn_pedidos(@c int) RETURNS TABLE AS RETURN SELECT id FROM dbo.pedidos WHERE cliente_id = @c",
    "CREATE PROCEDURE vendas.p_total AS SELECT COUNT(*) FROM dbo.v1",
    "CREATE TRIGGER dbo.tr_pedidos ON dbo.pedidos AFTER INSERT AS SET NOCOUNT ON",
    "CREATE SYNONYM dbo.syn_cli FOR dbo.clientes",
];

/// Objetos, índices e tipos do banco (sem os nomes gerados das tabelas internas dos tipos de tabela).
const SCRIPT_INVENTORY: &str = "
SELECT (o.type + ' ' + SCHEMA_NAME(o.schema_id) + '.' + o.name) COLLATE DATABASE_DEFAULT FROM sys.objects o
WHERE o.is_ms_shipped = 0 AND o.type <> 'TT' AND o.parent_object_id NOT IN (SELECT object_id FROM sys.objects WHERE type = 'TT')
UNION ALL SELECT ('IX ' + OBJECT_NAME(i.object_id) + '.' + i.name) COLLATE DATABASE_DEFAULT FROM sys.indexes i
WHERE i.name IS NOT NULL AND OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1 AND OBJECTPROPERTY(i.object_id, 'IsMSShipped') = 0
UNION ALL SELECT ('TY ' + name) COLLATE DATABASE_DEFAULT FROM sys.types WHERE is_user_defined = 1
ORDER BY 1";

fn all_script_options(if_not_exists: bool) -> DbScriptOptions {
    DbScriptOptions {
        schemas: Vec::new(),
        types: true,
        sequences: true,
        tables: true,
        indexes: true,
        foreign_keys: true,
        views: true,
        functions: true,
        procedures: true,
        triggers: true,
        synonyms: true,
        if_not_exists,
    }
}

async fn inventory(s: &mut Box<dyn Session>) -> Vec<String> {
    let (c, _) = exec(s, SCRIPT_INVENTORY).await;
    c.rows(0).into_iter().map(|r| r[0].as_str().unwrap_or_default().to_string()).collect()
}

/// Roda o script lote a lote (como o console, que divide por GO).
async fn run_script(s: &mut Box<dyn Session>, sql: &str) {
    let mut batch = String::new();
    for line in sql.lines().chain(std::iter::once("GO")) {
        if line.trim().eq_ignore_ascii_case("GO") {
            if !batch.trim().is_empty() {
                exec(s, &batch).await;
            }
            batch.clear();
        } else {
            batch.push_str(line);
            batch.push('\n');
        }
    }
}

#[tokio::test]
async fn it_database_script() {
    let Some(mut master) = session("master").await else {
        eprintln!("TODORS_MSSQL_TEST não definido; teste ignorado");
        return;
    };
    for db in ["TodoRsDdlSrc", "TodoRsDdlDst"] {
        exec(&mut master, &format!("IF DB_ID('{db}') IS NOT NULL BEGIN ALTER DATABASE {db} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE {db}; END; CREATE DATABASE {db};")).await;
    }
    master.close().await;

    let mut src = session("TodoRsDdlSrc").await.unwrap();
    for sql in SCRIPT_SOURCE {
        exec(&mut src, sql).await;
    }
    let script = src.database_script(&all_script_options(false)).await.unwrap();
    let sql = &script.sql;
    let at = |needle: &str| sql.find(needle).unwrap_or_else(|| panic!("{needle} ausente:\n{sql}"));
    // Pais antes das filhas, função antes da tabela que a usa, v2 antes de v1, triggers no fim.
    assert!(at("CREATE TABLE [dbo].[clientes]") < at("CREATE TABLE [dbo].[pedidos]"));
    assert!(at("CREATE TABLE [dbo].[pedidos]") < at("CREATE TABLE [dbo].[aitens]"));
    assert!(at("dbo.fn_dobro") < at("CREATE TABLE [dbo].[aitens]"));
    assert!(at("CREATE VIEW dbo.v2") < at("CREATE VIEW dbo.v1"));
    assert!(at("CREATE TABLE [vendas].[funcionario]") < at("CREATE VIEW dbo.v2"), "ciclo de FKs fica com as tabelas");
    assert!(at("CREATE TRIGGER") > at("CREATE PROCEDURE vendas.p_total"));
    assert!(sql.contains("CONSTRAINT [DF_pedidos_numero] DEFAULT (NEXT VALUE FOR [dbo].[seq_pedido])"), "{sql}");
    assert!(sql.contains("[nome] [dbo].[Nome] NOT NULL"), "{sql}");
    assert!(sql.contains("COLLATE Latin1_General_BIN"), "{sql}");
    assert!(sql.contains("-- FK circular de [vendas]"), "{sql}");
    assert!(script.warnings.is_empty(), "{:?}", script.warnings);

    let mut dst = session("TodoRsDdlDst").await.unwrap();
    run_script(&mut dst, sql).await;
    assert_eq!(inventory(&mut dst).await, inventory(&mut src).await);

    // Com guardas, roda de novo sobre o banco já criado sem erro e sem mudar nada.
    let guarded = src.database_script(&all_script_options(true)).await.unwrap();
    assert!(guarded.sql.contains("IF OBJECT_ID(N'[dbo].[v2]') IS NULL EXEC(N'CREATE VIEW dbo.v2"), "{}", guarded.sql);
    run_script(&mut dst, &guarded.sql).await;
    assert_eq!(inventory(&mut dst).await, inventory(&mut src).await);

    // Só um schema: nada dos outros, mas o schema é criado.
    let only = src.database_script(&DbScriptOptions { schemas: vec!["vendas".into()], ..all_script_options(false) }).await.unwrap();
    assert!(!only.sql.contains("[dbo].[pedidos]") && only.sql.contains("CREATE TABLE [vendas].[depto]"), "{}", only.sql);
    assert!(only.sql.contains("CREATE SCHEMA [vendas]"));

    src.close().await;
    dst.close().await;
}

// ---------- MongoDB ----------
// docker run -d -p 27019:27017 -e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD=TodoRs#Mongo2026 mongo:7
// TODORS_MONGO_TEST="mongodb://admin@localhost:27019/?authSource=admin|TodoRs#Mongo2026" cargo test it_mongo

async fn mongo_session(database: &str) -> Option<Box<dyn Session>> {
    let spec = std::env::var("TODORS_MONGO_TEST").ok().filter(|s| !s.is_empty())?;
    let (uri, pw) = spec.split_once('|').unwrap();
    let cfg = ConnConfig {
        id: "it-mongo".into(),
        driver: "mongo".into(),
        host: String::new(),
        port: None,
        instance: None,
        database: database.into(),
        auth: AuthConfig { kind: "sql".into(), user: String::new(), tenant: String::new(), client_id: String::new() },
        encrypt: "on".into(),
        trust_server_certificate: false,
        read_intent: false,
        connect_timeout_s: 10,
        uri: uri.into(),
        tls_insecure: false,
        long_running: true,
    };
    Some(driver_for("mongo").unwrap().connect(&cfg, database, Secret::Password(pw.into())).await.expect("connect mongo"))
}

fn docs(c: &Collect, index: usize) -> Vec<Value> {
    c.0.iter()
        .filter_map(|e| match e {
            ExecEvent::Docs { index: i, docs } if *i == index => Some(docs.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

#[tokio::test]
async fn it_mongo_end_to_end() {
    let Some(mut s) = mongo_session("todors_it").await else {
        eprintln!("TODORS_MONGO_TEST não definido; teste ignorado");
        return;
    };
    let info = s.server_info().await.unwrap();
    assert_eq!(info.dialect, "mongo");
    assert!(!info.version.is_empty());

    exec(&mut s, r#"{"op":"drop","collection":"patients"}"#).await;
    let (_, sum) = exec(
        &mut s,
        r#"{"op":"insertMany","collection":"patients","documents":[
            {"_id":{"$oid":"65f1a2b3c4d5e6f708192a3b"},"name":"Ana","age":30,"weight":{"$numberDouble":"61.0"},"big":{"$numberLong":"9007199254740993"},"born":{"$date":"1994-05-01T00:00:00Z"},"tags":["a","b"],"addr":{"city":"Rio"}},
            {"name":"Bruno","age":41,"price":{"$numberDecimal":"10.50"}},
            {"name":"Caio","age":17}
        ]}"#,
    )
    .await;
    assert_eq!(sum.rows_affected, Some(3));

    // find com filtro, ordenação, projeção e limite do console
    let mut sink = Collect(Vec::new());
    let sum = s
        .execute(r#"{"op":"find","collection":"patients","filter":{"age":{"$gte":18}},"sort":{"age":-1},"projection":{"name":1,"age":1}}"#, &mut sink, Some(1))
        .await
        .unwrap();
    assert!(sum.truncated);
    assert_eq!(docs(&sink, 0).len(), 1);
    assert_eq!(docs(&sink, 0)[0]["name"], json!("Bruno"));

    let (c, _) = exec(&mut s, r#"{"op":"find","collection":"patients","filter":{"_id":{"$oid":"65f1a2b3c4d5e6f708192a3b"}}}"#).await;
    let ana = &docs(&c, 0)[0];
    assert_eq!(ana["_id"], json!({ "$oid": "65f1a2b3c4d5e6f708192a3b" }));
    assert_eq!(ana["big"], json!({ "$numberLong": "9007199254740993" }));
    assert_eq!(ana["weight"], json!({ "$numberDouble": "61.0" }));
    assert!(ana["born"]["$date"].is_string(), "{ana}");
    assert_eq!(ana["addr"], json!({ "city": "Rio" }));

    // aggregate, count, distinct
    let (c, _) = exec(&mut s, r#"{"op":"aggregate","collection":"patients","pipeline":[{"$group":{"_id":null,"total":{"$sum":"$age"}}}]}"#).await;
    assert_eq!(docs(&c, 0)[0]["total"], json!(88));
    let (c, _) = exec(&mut s, r#"{"op":"countDocuments","collection":"patients","filter":{"age":{"$lt":18}}}"#).await;
    assert_eq!(docs(&c, 0)[0]["count"], json!(1));
    let (c, _) = exec(&mut s, r#"{"op":"distinct","collection":"patients","field":"name"}"#).await;
    assert_eq!(docs(&c, 0).len(), 3);

    // edição como o grid faz: updateOne por _id preservando o tipo
    let affected = s
        .apply(&[r#"{"op":"updateOne","collection":"patients","filter":{"_id":{"$oid":"65f1a2b3c4d5e6f708192a3b"}},"update":{"$set":{"weight":{"$numberDouble":"62.0"},"name":"Ana Lú"}}}"#.into()], true)
        .await
        .unwrap();
    assert_eq!(affected, vec![1]);
    let (c, _) = exec(&mut s, r#"{"op":"find","collection":"patients","filter":{"name":"Ana Lú"}}"#).await;
    assert_eq!(docs(&c, 0)[0]["weight"], json!({ "$numberDouble": "62.0" }));

    // erro de operação
    let err = s.apply(&[r#"{"op":"insertOne","collection":"patients","document":{"_id":{"$oid":"65f1a2b3c4d5e6f708192a3b"}}}"#.into()], true).await.unwrap_err();
    assert!(err.contains("E11000") || err.contains("duplicate"), "{err}");

    // introspecção e DDL
    exec(&mut s, r#"{"op":"createIndex","collection":"patients","keys":{"name":1},"options":{"unique":true}}"#).await;
    let dbs = s.introspect(&ObjectPath { kind: "databases".into(), schema: String::new(), name: String::new() }).await.unwrap();
    assert!(dbs.iter().any(|d| d.name == "todors_it" && d.flag));
    let colls = s.introspect(&ObjectPath { kind: "collections".into(), schema: String::new(), name: String::new() }).await.unwrap();
    assert!(colls.iter().any(|c| c.name == "patients"));
    let fields = s.introspect(&ObjectPath { kind: "collection".into(), schema: String::new(), name: "patients".into() }).await.unwrap();
    assert!(fields.iter().any(|f| f.kind == "field" && f.name == "age" && f.detail == "int"));
    assert!(fields.iter().any(|f| f.kind == "index" && f.name == "name_1" && f.flag));
    let info = s.table_info("", "patients").await.unwrap();
    assert!(info.columns[0].is_pk);
    let ddl = s.ddl(&ObjectPath { kind: "collection".into(), schema: String::new(), name: "patients".into() }).await.unwrap();
    assert!(ddl.contains("createIndex({\"name\":1}"), "{ddl}");
}

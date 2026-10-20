//! Introspecção do SQL Server (Database Explorer, colunas das tabelas, DDL e script do banco inteiro).
//!
//! Tudo roda no banco da sessão (sem nomes de três partes): o Azure SQL não permite
//! consultar outros bancos, então cada banco da árvore usa uma sessão própria.

use std::collections::{BTreeSet, HashMap, HashSet};

use tiberius::{Row, ToSql};

use super::driver::*;
use super::mssql::{describe, Conn};

/// `[schema].[nome]` com `]` escapado.
pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote(schema), quote(name))
}

pub fn quote(ident: &str) -> String {
    format!("[{}]", ident.replace(']', "]]"))
}

async fn rows(client: &mut Conn, sql: &str, params: &[&dyn ToSql]) -> DbResult<Vec<Row>> {
    client
        .query(sql, params)
        .await
        .map_err(|e| describe(&e))?
        .into_first_result()
        .await
        .map_err(|e| describe(&e))
}

fn text(row: &Row, i: usize) -> String {
    row.try_get::<&str, _>(i).ok().flatten().unwrap_or("").to_string()
}

fn flag(row: &Row, i: usize) -> bool {
    row.try_get::<bool, _>(i).ok().flatten().unwrap_or(false)
}

fn int(row: &Row, i: usize) -> Option<i64> {
    row.try_get::<i64, _>(i).ok().flatten()
}

fn object_kind(code: &str) -> &'static str {
    match code.trim() {
        "U" => "table",
        "V" => "view",
        "P" => "procedure",
        "FN" | "IF" | "TF" => "function",
        "TR" => "trigger",
        _ => "other",
    }
}

pub async fn introspect(client: &mut Conn, path: &ObjectPath) -> DbResult<Vec<ObjectNode>> {
    match path.kind.as_str() {
        "databases" => databases(client).await,
        "schemas" => schemas(client).await,
        "schema" => objects(client, &path.schema).await,
        "table" | "view" => table_children(client, &path.schema, &path.name).await,
        "procedure" | "function" => parameters(client, &path.schema, &path.name).await,
        other => Err(format!("Nó desconhecido: {other}")),
    }
}

async fn databases(client: &mut Conn) -> DbResult<Vec<ObjectNode>> {
    let list = rows(
        client,
        "SELECT name, CAST(CASE WHEN name = DB_NAME() THEN 1 ELSE 0 END AS bit) \
         FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name",
        &[],
    )
    .await?;
    Ok(list
        .iter()
        .map(|r| ObjectNode { kind: "database".into(), name: text(r, 0), flag: flag(r, 1), ..Default::default() })
        .collect())
}

async fn schemas(client: &mut Conn) -> DbResult<Vec<ObjectNode>> {
    let list = rows(
        client,
        "SELECT s.name, CAST((SELECT COUNT(*) FROM sys.objects o WHERE o.schema_id = s.schema_id AND o.is_ms_shipped = 0 \
            AND o.type IN ('U','V','P','FN','IF','TF')) AS bigint) \
         FROM sys.schemas s \
         WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND s.schema_id < 16384 \
         ORDER BY CASE WHEN s.name = SCHEMA_NAME() THEN 0 ELSE 1 END, s.name",
        &[],
    )
    .await?;
    Ok(list
        .iter()
        .map(|r| ObjectNode { kind: "schema".into(), name: text(r, 0), rows: int(r, 1), ..Default::default() })
        .collect())
}

async fn objects(client: &mut Conn, schema: &str) -> DbResult<Vec<ObjectNode>> {
    let list = rows(
        client,
        "SELECT o.name, o.type, CAST(p.rows AS bigint) \
         FROM sys.objects o \
         LEFT JOIN (SELECT object_id, SUM(rows) AS rows FROM sys.partitions WHERE index_id IN (0, 1) GROUP BY object_id) p \
           ON p.object_id = o.object_id \
         WHERE o.schema_id = SCHEMA_ID(@P1) AND o.is_ms_shipped = 0 AND o.type IN ('U','V','P','FN','IF','TF') \
         ORDER BY o.name",
        &[&schema],
    )
    .await?;
    Ok(list
        .iter()
        .map(|r| ObjectNode {
            kind: object_kind(&text(r, 1)).into(),
            name: text(r, 0),
            schema: schema.to_string(),
            rows: int(r, 2),
            ..Default::default()
        })
        .collect())
}

/// Tipo completo para exibição: nvarchar(200), decimal(18,2), datetime2(7)...
fn full_type(name: &str, max_length: i64, precision: i64, scale: i64) -> String {
    match name {
        "nvarchar" | "nchar" => {
            if max_length < 0 {
                format!("{name}(max)")
            } else {
                format!("{name}({})", max_length / 2)
            }
        }
        "varchar" | "char" | "varbinary" | "binary" => {
            if max_length < 0 {
                format!("{name}(max)")
            } else {
                format!("{name}({max_length})")
            }
        }
        "decimal" | "numeric" => format!("{name}({precision},{scale})"),
        "datetime2" | "time" | "datetimeoffset" => format!("{name}({scale})"),
        _ => name.to_string(),
    }
}

const COLUMNS_SQL: &str = "SELECT c.name, TYPE_NAME(c.user_type_id), CAST(c.max_length AS bigint), CAST(c.precision AS bigint), CAST(c.scale AS bigint),   c.is_nullable, c.is_identity, c.is_computed, CAST(CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS bit),   CAST(CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit),   rs.name, rt.name, rc.name FROM sys.columns c LEFT JOIN (SELECT ic.column_id FROM sys.indexes i            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id            WHERE i.object_id = OBJECT_ID(@P1) AND i.is_primary_key = 1) pk ON pk.column_id = c.column_id OUTER APPLY (SELECT TOP 1 fkc.referenced_object_id, fkc.referenced_column_id FROM sys.foreign_key_columns fkc              WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id) fk LEFT JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id LEFT JOIN sys.schemas rs ON rs.schema_id = rt.schema_id LEFT JOIN sys.columns rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fk.referenced_column_id WHERE c.object_id = OBJECT_ID(@P1) ORDER BY c.column_id";

async fn column_rows(client: &mut Conn, schema: &str, name: &str) -> DbResult<Vec<TableColumn>> {
    let obj = qualified(schema, name);
    let list = rows(client, COLUMNS_SQL, &[&obj.as_str()]).await?;
    Ok(list
        .iter()
        .map(|r| {
            let type_name = text(r, 1);
            let fk_table = text(r, 11);
            TableColumn {
                name: text(r, 0),
                full_type: full_type(&type_name, int(r, 2).unwrap_or(0), int(r, 3).unwrap_or(0), int(r, 4).unwrap_or(0)),
                type_name,
                nullable: flag(r, 5),
                is_identity: flag(r, 6),
                is_computed: flag(r, 7),
                has_default: flag(r, 8),
                is_pk: flag(r, 9),
                fk: (!fk_table.is_empty()).then(|| FkTarget { schema: text(r, 10), table: fk_table, column: text(r, 12) }),
            }
        })
        .collect())
}

pub async fn table_info(client: &mut Conn, schema: &str, name: &str) -> DbResult<TableInfo> {
    let obj = qualified(schema, name);
    let meta = rows(
        client,
        "SELECT o.type, CAST((SELECT SUM(rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS bigint) \
         FROM sys.objects o WHERE o.object_id = OBJECT_ID(@P1)",
        &[&obj.as_str()],
    )
    .await?;
    let meta = meta.first().ok_or_else(|| format!("Objeto {obj} não encontrado"))?;
    let columns = column_rows(client, schema, name).await?;
    Ok(TableInfo {
        schema: schema.to_string(),
        name: name.to_string(),
        kind: object_kind(&text(meta, 0)).into(),
        columns,
        row_estimate: int(meta, 1),
    })
}

const INDEXES_SQL: &str = "\
SELECT i.name, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.type_desc, \
  STUFF((SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END \
         FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 \
         ORDER BY ic.key_ordinal FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
  STUFF((SELECT ', ' + QUOTENAME(c.name) \
         FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1 \
         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
  i.filter_definition \
FROM sys.indexes i WHERE i.object_id = OBJECT_ID(@P1) AND i.type > 0 \
ORDER BY i.is_primary_key DESC, i.name";

const FKS_SQL: &str = "\
SELECT fk.name, \
  STUFF((SELECT ', ' + QUOTENAME(pc.name) FROM sys.foreign_key_columns k \
         JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id \
         WHERE k.constraint_object_id = fk.object_id ORDER BY k.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
  QUOTENAME(rs.name) + '.' + QUOTENAME(rt.name), \
  STUFF((SELECT ', ' + QUOTENAME(rc.name) FROM sys.foreign_key_columns k \
         JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id \
         WHERE k.constraint_object_id = fk.object_id ORDER BY k.constraint_column_id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, ''), \
  fk.delete_referential_action_desc, fk.update_referential_action_desc \
FROM sys.foreign_keys fk \
JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id \
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
WHERE fk.parent_object_id = OBJECT_ID(@P1) ORDER BY fk.name";

async fn table_children(client: &mut Conn, schema: &str, name: &str) -> DbResult<Vec<ObjectNode>> {
    let obj = qualified(schema, name);
    let mut out: Vec<ObjectNode> = column_rows(client, schema, name)
        .await?
        .into_iter()
        .map(|c| ObjectNode {
            kind: "column".into(),
            detail: format!("{}{}", c.full_type, if c.nullable { "" } else { " NOT NULL" }),
            name: c.name,
            flag: c.is_pk,
            ..Default::default()
        })
        .collect();
    for r in rows(client, INDEXES_SQL, &[&obj.as_str()]).await? {
        let is_key = flag(&r, 2) || flag(&r, 3);
        out.push(ObjectNode {
            kind: if is_key { "key" } else { "index" }.into(),
            name: text(&r, 0),
            detail: format!("({})", text(&r, 5)),
            flag: flag(&r, 1),
            ..Default::default()
        });
    }
    for r in rows(client, FKS_SQL, &[&obj.as_str()]).await? {
        out.push(ObjectNode {
            kind: "fk".into(),
            name: text(&r, 0),
            detail: format!("({}) → {}({})", text(&r, 1), text(&r, 2), text(&r, 3)),
            ..Default::default()
        });
    }
    for r in rows(client, "SELECT name FROM sys.triggers WHERE parent_id = OBJECT_ID(@P1) ORDER BY name", &[&obj.as_str()]).await? {
        out.push(ObjectNode { kind: "trigger".into(), name: text(&r, 0), schema: schema.to_string(), ..Default::default() });
    }
    Ok(out)
}

async fn parameters(client: &mut Conn, schema: &str, name: &str) -> DbResult<Vec<ObjectNode>> {
    let obj = qualified(schema, name);
    let list = rows(
        client,
        "SELECT CASE WHEN p.name = '' THEN '(retorno)' ELSE p.name END, TYPE_NAME(p.user_type_id), \
           CAST(p.max_length AS bigint), CAST(p.precision AS bigint), CAST(p.scale AS bigint), p.is_output \
         FROM sys.parameters p WHERE p.object_id = OBJECT_ID(@P1) ORDER BY p.parameter_id",
        &[&obj.as_str()],
    )
    .await?;
    Ok(list
        .iter()
        .map(|r| {
            let ty = full_type(&text(r, 1), int(r, 2).unwrap_or(0), int(r, 3).unwrap_or(0), int(r, 4).unwrap_or(0));
            ObjectNode {
                kind: "param".into(),
                name: text(r, 0),
                detail: if flag(r, 5) { format!("{ty} OUTPUT") } else { ty },
                ..Default::default()
            }
        })
        .collect())
}


// ---------- Estrutura editável ----------

/// "CASCADE", "SET_NULL" → "SET NULL"...
fn referential(desc: &str) -> String {
    desc.replace('_', " ")
}

/// Objetos das ferramentas da Microsoft (diagramas: sysdiagrams, sp_*diagram*) não são do usuário.
fn not_tools(col: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM sys.extended_properties ep WHERE ep.class = 1 AND ep.major_id = {col} \
         AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support')"
    )
}

/// Quais tabelas [`load_tables`] carrega. Cada categoria (colunas, índices, FKs, checks) é uma
/// consulta só, para o banco inteiro: nada de uma ida ao servidor por tabela.
enum Scope<'a> {
    /// Uma tabela (`[schema].[nome]`).
    One(&'a str),
    /// Todas as tabelas de usuário.
    Tables,
    /// Tabelas internas dos tipos de tabela (`CREATE TYPE … AS TABLE`).
    TableTypes,
}

impl Scope<'_> {
    fn filter(&self, col: &str) -> String {
        match self {
            Scope::One(_) => format!("{col} = OBJECT_ID(@P1)"),
            Scope::Tables => format!("{col} IN (SELECT t.object_id FROM sys.tables t WHERE t.is_ms_shipped = 0 AND {})", not_tools("t.object_id")),
            Scope::TableTypes => format!("{col} IN (SELECT type_table_object_id FROM sys.table_types WHERE is_user_defined = 1)"),
        }
    }

    fn params(&self) -> Vec<&dyn ToSql> {
        match self {
            Scope::One(obj) => vec![obj as &dyn ToSql],
            _ => Vec::new(),
        }
    }
}

const SCHEMA_TABLES_SQL: &str = "\
SELECT CAST(o.object_id AS bigint), SCHEMA_NAME(o.schema_id), o.name FROM sys.objects o \
WHERE {scope} ORDER BY SCHEMA_NAME(o.schema_id), o.name";

const SCHEMA_COLUMNS_SQL: &str = "\
SELECT CAST(c.object_id AS bigint), c.name, t.name, CAST(c.max_length AS bigint), CAST(c.precision AS bigint), CAST(c.scale AS bigint), \
  c.is_nullable, c.is_identity, CAST(ic.seed_value AS bigint), CAST(ic.increment_value AS bigint), \
  cc.definition, CAST(ISNULL(cc.is_persisted, 0) AS bit), dc.definition, dc.name, \
  CASE WHEN c.collation_name <> CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS sysname) THEN c.collation_name ELSE N'' END, \
  t.is_user_defined, SCHEMA_NAME(t.schema_id) \
FROM sys.columns c \
JOIN sys.types t ON t.user_type_id = c.user_type_id \
LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
WHERE {scope} ORDER BY c.object_id, c.column_id";

const SCHEMA_INDEXES_SQL: &str = "\
SELECT CAST(i.object_id AS bigint), i.index_id, i.name, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.type_desc, i.filter_definition \
FROM sys.indexes i WHERE i.type > 0 AND i.is_hypothetical = 0 AND {scope} \
ORDER BY i.object_id, i.is_primary_key DESC, i.index_id";

/// Colunas de partição (key_ordinal 0, fora do INCLUDE) não fazem parte da definição do índice;
/// no columnstore todas as colunas têm key_ordinal 0.
const SCHEMA_INDEX_COLUMNS_SQL: &str = "\
SELECT CAST(ic.object_id AS bigint), ic.index_id, c.name, ic.is_descending_key, ic.is_included_column \
FROM sys.index_columns ic \
JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
WHERE (ic.key_ordinal > 0 OR ic.is_included_column = 1 OR i.type IN (5, 6)) AND {scope} \
ORDER BY ic.object_id, ic.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id";

const SCHEMA_FKS_SQL: &str = "\
SELECT CAST(fk.parent_object_id AS bigint), CAST(fk.object_id AS bigint), fk.name, rs.name, rt.name, \
  fk.delete_referential_action_desc, fk.update_referential_action_desc \
FROM sys.foreign_keys fk \
JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id \
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
WHERE {scope} ORDER BY fk.parent_object_id, fk.name";

const SCHEMA_FK_COLUMNS_SQL: &str = "\
SELECT CAST(k.constraint_object_id AS bigint), pc.name, rc.name FROM sys.foreign_key_columns k \
JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id \
JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id \
WHERE {scope} ORDER BY k.constraint_object_id, k.constraint_column_id";

const SCHEMA_CHECKS_SQL: &str = "\
SELECT CAST(parent_object_id AS bigint), name, definition FROM sys.check_constraints \
WHERE {scope} ORDER BY parent_object_id, name";

/// Estrutura das tabelas do escopo, com o object_id de cada uma.
async fn load_tables(client: &mut Conn, scope: Scope<'_>) -> DbResult<Vec<(i64, TableSchema)>> {
    let p = scope.params();
    let sql = |q: &str, col: &str| q.replace("{scope}", &scope.filter(col));
    let id = |r: &Row| int(r, 0).unwrap_or(0);

    let mut tables: Vec<(i64, TableSchema)> = rows(client, &sql(SCHEMA_TABLES_SQL, "o.object_id"), &p)
        .await?
        .iter()
        .map(|r| (id(r), TableSchema { schema: text(r, 1), name: text(r, 2), ..Default::default() }))
        .collect();
    let pos: HashMap<i64, usize> = tables.iter().enumerate().map(|(i, t)| (t.0, i)).collect();

    for r in rows(client, &sql(SCHEMA_COLUMNS_SQL, "c.object_id"), &p).await? {
        let Some(&i) = pos.get(&id(&r)) else { continue };
        let type_name = text(&r, 2);
        let full = if flag(&r, 15) {
            qualified(&text(&r, 16), &type_name)
        } else {
            full_type(&type_name, int(&r, 3).unwrap_or(0), int(&r, 4).unwrap_or(0), int(&r, 5).unwrap_or(0))
        };
        tables[i].1.columns.push(SchemaColumn {
            name: text(&r, 1),
            full_type: full,
            nullable: flag(&r, 6),
            identity: flag(&r, 7),
            seed: int(&r, 8).unwrap_or(1),
            increment: int(&r, 9).unwrap_or(1),
            computed: text(&r, 10),
            persisted: flag(&r, 11),
            default: text(&r, 12),
            default_name: text(&r, 13),
            collation: text(&r, 14),
        });
    }

    let mut index_cols: HashMap<(i64, i32), (Vec<IndexColumn>, Vec<String>)> = HashMap::new();
    for r in rows(client, &sql(SCHEMA_INDEX_COLUMNS_SQL, "ic.object_id"), &p).await? {
        let entry = index_cols.entry((id(&r), r.try_get::<i32, _>(1).ok().flatten().unwrap_or(-1))).or_default();
        if flag(&r, 4) {
            entry.1.push(text(&r, 2));
        } else {
            entry.0.push(IndexColumn { name: text(&r, 2), desc: flag(&r, 3) });
        }
    }
    for r in rows(client, &sql(SCHEMA_INDEXES_SQL, "i.object_id"), &p).await? {
        let Some(&i) = pos.get(&id(&r)) else { continue };
        let index_id = r.try_get::<i32, _>(1).ok().flatten().unwrap_or(-1);
        let type_desc = text(&r, 6);
        let kind = if flag(&r, 4) {
            "pk"
        } else if flag(&r, 5) {
            "unique"
        } else if type_desc != "CLUSTERED" && type_desc != "NONCLUSTERED" {
            "other"
        } else if flag(&r, 3) {
            "uindex"
        } else {
            "index"
        };
        let (columns, include) = index_cols.remove(&(id(&r), index_id)).unwrap_or_default();
        tables[i].1.indexes.push(SchemaIndex {
            name: text(&r, 2),
            kind: kind.into(),
            clustered: type_desc.starts_with("CLUSTERED"),
            columns,
            include,
            filter: text(&r, 7),
            type_desc,
        });
    }

    let mut fk_cols: HashMap<i64, (Vec<String>, Vec<String>)> = HashMap::new();
    for r in rows(client, &sql(SCHEMA_FK_COLUMNS_SQL, "k.parent_object_id"), &p).await? {
        let entry = fk_cols.entry(id(&r)).or_default();
        entry.0.push(text(&r, 1));
        entry.1.push(text(&r, 2));
    }
    for r in rows(client, &sql(SCHEMA_FKS_SQL, "fk.parent_object_id"), &p).await? {
        let Some(&i) = pos.get(&id(&r)) else { continue };
        let (columns, ref_columns) = fk_cols.remove(&int(&r, 1).unwrap_or(0)).unwrap_or_default();
        tables[i].1.fks.push(SchemaFk {
            name: text(&r, 2),
            columns,
            ref_schema: text(&r, 3),
            ref_table: text(&r, 4),
            ref_columns,
            on_delete: referential(&text(&r, 5)),
            on_update: referential(&text(&r, 6)),
        });
    }

    for r in rows(client, &sql(SCHEMA_CHECKS_SQL, "parent_object_id"), &p).await? {
        let Some(&i) = pos.get(&id(&r)) else { continue };
        tables[i].1.checks.push(SchemaCheck { name: text(&r, 1), definition: text(&r, 2) });
    }
    Ok(tables)
}

pub async fn table_schema(client: &mut Conn, schema: &str, name: &str) -> DbResult<TableSchema> {
    let obj = qualified(schema, name);
    let kind = rows(client, "SELECT type FROM sys.objects WHERE object_id = OBJECT_ID(@P1)", &[&obj.as_str()]).await?;
    match kind.first().map(|r| text(r, 0)) {
        None => return Err(format!("Tabela {obj} não encontrada")),
        Some(t) if t.trim() != "U" => return Err(format!("{obj} não é uma tabela")),
        _ => {}
    }
    load_tables(client, Scope::One(&obj))
        .await?
        .pop()
        .map(|t| t.1)
        .ok_or_else(|| format!("Tabela {obj} não encontrada"))
}

// ---------- DDL ----------

pub async fn ddl(client: &mut Conn, path: &ObjectPath) -> DbResult<String> {
    match path.kind.as_str() {
        "table" => table_ddl(client, &path.schema, &path.name).await,
        "view" | "procedure" | "function" | "trigger" => {
            let obj = qualified(&path.schema, &path.name);
            let list = rows(client, "SELECT OBJECT_DEFINITION(OBJECT_ID(@P1))", &[&obj.as_str()]).await?;
            let def = list.first().map(|r| text(r, 0)).unwrap_or_default();
            if def.is_empty() {
                Err("Definição indisponível (objeto criptografado ou sem permissão VIEW DEFINITION)".into())
            } else {
                Ok(def.trim().to_string())
            }
        }
        other => Err(format!("DDL não disponível para {other}")),
    }
}

async fn table_ddl(client: &mut Conn, schema: &str, name: &str) -> DbResult<String> {
    let t = table_schema(client, schema, name).await?;
    let mut out = create_table_sql(&t, false);
    let (indexes, skipped) = index_sqls(&t, false);
    let after: Vec<String> = indexes.into_iter().chain(t.fks.iter().map(|fk| fk_sql(&t, fk, false))).collect();
    if !after.is_empty() {
        out.push_str("\n\n");
        out.push_str(&after.join("\n"));
    }
    for s in skipped {
        out.push_str(&format!("\n-- Índice {s} não incluído (XML/espacial)"));
    }
    out.push('\n');
    Ok(out)
}

/// Literal N'…' com aspas escapadas.
fn nstr(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

fn key_list(cols: &[IndexColumn]) -> String {
    cols.iter().map(|c| format!("{}{}", quote(&c.name), if c.desc { " DESC" } else { "" })).collect::<Vec<_>>().join(", ")
}

fn name_list(cols: &[String]) -> String {
    cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ")
}

/// Definição de uma coluna. `named`: nomeia o DEFAULT (tipos de tabela não aceitam nomes).
fn column_def(c: &SchemaColumn, named: bool) -> String {
    let mut s = format!("{} ", quote(&c.name));
    if !c.computed.is_empty() {
        s.push_str(&format!("AS {}", c.computed));
        if c.persisted {
            s.push_str(" PERSISTED");
            if !c.nullable {
                s.push_str(" NOT NULL");
            }
        }
        return s;
    }
    s.push_str(&c.full_type);
    if !c.collation.is_empty() {
        s.push_str(&format!(" COLLATE {}", c.collation));
    }
    if c.identity {
        s.push_str(&format!(" IDENTITY({}, {})", c.seed, c.increment));
    }
    s.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
    if !c.default.is_empty() {
        if named && !c.default_name.is_empty() {
            s.push_str(&format!(" CONSTRAINT {}", quote(&c.default_name)));
        }
        s.push_str(&format!(" DEFAULT {}", c.default));
    }
    s
}

/// Colunas, PK/UNIQUE e checks entre parênteses. Tipos de tabela (`named = false`) não aceitam
/// constraints com nome e levam os índices dentro da definição.
fn table_body(t: &TableSchema, named: bool) -> String {
    let constraint = |n: &str| if named { format!("CONSTRAINT {} ", quote(n)) } else { String::new() };
    let mut lines: Vec<String> = t.columns.iter().map(|c| format!("    {}", column_def(c, named))).collect();
    for ix in &t.indexes {
        let clustered = if ix.clustered { "CLUSTERED" } else { "NONCLUSTERED" };
        match ix.kind.as_str() {
            "pk" | "unique" => lines.push(format!(
                "    {}{} {clustered} ({})",
                constraint(&ix.name),
                if ix.kind == "pk" { "PRIMARY KEY" } else { "UNIQUE" },
                key_list(&ix.columns)
            )),
            "uindex" if !named => lines.push(format!("    UNIQUE {clustered} ({})", key_list(&ix.columns))),
            "index" if !named => lines.push(format!("    INDEX {} {clustered} ({})", quote(&ix.name), key_list(&ix.columns))),
            _ => {}
        }
    }
    for c in &t.checks {
        lines.push(format!("    {}CHECK {}", constraint(&c.name), c.definition));
    }
    format!("(\n{}\n)", lines.join(",\n"))
}

fn create_table_sql(t: &TableSchema, guard: bool) -> String {
    let obj = qualified(&t.schema, &t.name);
    let mut s = String::new();
    if guard {
        s.push_str(&format!("IF OBJECT_ID({}, N'U') IS NULL\n", nstr(&obj)));
    }
    s.push_str(&format!("CREATE TABLE {obj}\n{};", table_body(t, true)));
    s
}

/// CREATE INDEX dos índices que não são constraints; o segundo vetor tem os não suportados.
fn index_sqls(t: &TableSchema, guard: bool) -> (Vec<String>, Vec<String>) {
    let obj = qualified(&t.schema, &t.name);
    let (mut out, mut skipped) = (Vec::new(), Vec::new());
    for ix in &t.indexes {
        let mut s = match ix.kind.as_str() {
            "index" | "uindex" => {
                let mut s = format!(
                    "CREATE {}{} INDEX {} ON {obj} ({})",
                    if ix.kind == "uindex" { "UNIQUE " } else { "" },
                    if ix.clustered { "CLUSTERED" } else { "NONCLUSTERED" },
                    quote(&ix.name),
                    key_list(&ix.columns)
                );
                if !ix.include.is_empty() {
                    s.push_str(&format!(" INCLUDE ({})", name_list(&ix.include)));
                }
                s
            }
            "other" if ix.type_desc == "CLUSTERED COLUMNSTORE" => format!("CREATE CLUSTERED COLUMNSTORE INDEX {} ON {obj}", quote(&ix.name)),
            "other" if ix.type_desc == "NONCLUSTERED COLUMNSTORE" => {
                let cols: Vec<String> = ix.columns.iter().map(|c| c.name.clone()).chain(ix.include.iter().cloned()).collect();
                format!("CREATE NONCLUSTERED COLUMNSTORE INDEX {} ON {obj} ({})", quote(&ix.name), name_list(&cols))
            }
            "other" => {
                skipped.push(format!("{obj}.{}", quote(&ix.name)));
                continue;
            }
            _ => continue,
        };
        if !ix.filter.is_empty() {
            s.push_str(&format!(" WHERE {}", ix.filter));
        }
        s.push(';');
        if guard {
            s = format!(
                "IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID({}) AND name = {})\n{s}",
                nstr(&obj),
                nstr(&ix.name)
            );
        }
        out.push(s);
    }
    (out, skipped)
}

fn fk_sql(t: &TableSchema, fk: &SchemaFk, guard: bool) -> String {
    let obj = qualified(&t.schema, &t.name);
    let mut s = format!(
        "ALTER TABLE {obj} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        quote(&fk.name),
        name_list(&fk.columns),
        qualified(&fk.ref_schema, &fk.ref_table),
        name_list(&fk.ref_columns)
    );
    if fk.on_delete != "NO ACTION" {
        s.push_str(&format!(" ON DELETE {}", fk.on_delete));
    }
    if fk.on_update != "NO ACTION" {
        s.push_str(&format!(" ON UPDATE {}", fk.on_update));
    }
    s.push(';');
    if guard {
        s = format!("IF OBJECT_ID({}, N'F') IS NULL\n{s}", nstr(&qualified(&t.schema, &fk.name)));
    }
    s
}

/// Ordem topológica: `deps` = (a, b) quando `a` depende de `b`. Entre os prontos sai o de menor
/// prioridade (tipo do objeto, posição de entrada), o que deixa as tabelas juntas e a saída
/// determinística. Ciclos (FKs circulares) viram um bloco só, com os membros por prioridade; as
/// FKs que ainda apontam para tabelas não criadas são adiadas por quem monta o script.
fn topo_order(prio: &[(u8, usize)], deps: &[(usize, usize)]) -> Vec<usize> {
    let n = prio.len();
    let mut adj = vec![Vec::new(); n];
    for &(a, b) in deps.iter().collect::<HashSet<_>>() {
        if a != b && a < n && b < n {
            adj[a].push(b);
        }
    }
    let comp = components(&adj);
    let nc = comp.iter().max().map_or(0, |m| m + 1);
    let mut members = vec![Vec::new(); nc];
    for i in 0..n {
        members[comp[i]].push(i);
    }
    for m in &mut members {
        m.sort_by_key(|&i| prio[i]);
    }

    let mut indegree = vec![0usize; nc];
    let mut dependents = vec![Vec::new(); nc];
    let cedges: HashSet<(usize, usize)> = (0..n).flat_map(|a| adj[a].iter().map(move |&b| (a, b))).map(|(a, b)| (comp[a], comp[b])).filter(|(a, b)| a != b).collect();
    for (a, b) in cedges {
        indegree[a] += 1;
        dependents[b].push(a);
    }
    let mut ready: BTreeSet<((u8, usize), usize)> = (0..nc).filter(|&c| indegree[c] == 0).map(|c| (prio[members[c][0]], c)).collect();
    let mut out = Vec::with_capacity(n);
    while let Some((_, c)) = ready.pop_first() {
        out.extend_from_slice(&members[c]);
        for &d in &dependents[c] {
            indegree[d] -= 1;
            if indegree[d] == 0 {
                ready.insert((prio[members[d][0]], d));
            }
        }
    }
    out
}

/// Componentes fortemente conexos (Tarjan, iterativo para não estourar a pilha em cadeias longas).
fn components(adj: &[Vec<usize>]) -> Vec<usize> {
    let n = adj.len();
    let unseen = usize::MAX;
    let (mut index, mut low, mut on_stack, mut comp) = (vec![unseen; n], vec![0; n], vec![false; n], vec![unseen; n]);
    let (mut next, mut ncomp, mut stack) = (0, 0, Vec::new());
    for root in 0..n {
        if index[root] != unseen {
            continue;
        }
        let mut call = vec![(root, 0usize)];
        index[root] = next;
        low[root] = next;
        next += 1;
        stack.push(root);
        on_stack[root] = true;
        while let Some(top) = call.last_mut() {
            let v = top.0;
            if top.1 < adj[v].len() {
                let w = adj[v][top.1];
                top.1 += 1;
                if index[w] == unseen {
                    index[w] = next;
                    low[w] = next;
                    next += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    call.push((w, 0));
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
                continue;
            }
            call.pop();
            if let Some(&(u, _)) = call.last() {
                low[u] = low[u].min(low[v]);
            }
            if low[v] == index[v] {
                loop {
                    let w = stack.pop().expect("pilha do Tarjan");
                    on_stack[w] = false;
                    comp[w] = ncomp;
                    if w == v {
                        break;
                    }
                }
                ncomp += 1;
            }
        }
    }
    comp
}

struct Module {
    id: i64,
    schema: String,
    name: String,
    /// "V" | "FN" | "IF" | "TF" | "P" | "TR"
    kind: String,
    definition: String,
    ansi_nulls: bool,
    quoted_identifier: bool,
}

/// Monta o texto do script em lotes separados por `GO`.
#[derive(Default)]
struct ScriptOut {
    body: String,
    objects: u32,
    warnings: Vec<String>,
}

impl ScriptOut {
    fn section(&mut self, title: &str) {
        self.body.push_str(&format!("\n-- ==================== {title} ====================\n\n"));
    }

    /// Tabelas e módulos se alternam quando uma tabela precisa de uma função: só o primeiro
    /// título de cada um é completo.
    fn switch(&mut self, current: &mut &'static str, next: &'static str, seen: &mut HashSet<&'static str>) {
        if *current != next {
            let title = if seen.insert(next) { next.to_string() } else { format!("{next} (continuação)") };
            self.section(&title);
            *current = next;
        }
    }

    /// Um lote: o texto e um `GO`.
    fn batch(&mut self, sql: &str, objects: u32) {
        self.body.push_str(sql.trim_end());
        self.body.push_str("\nGO\n\n");
        self.objects += objects;
    }
}

const SCHEMAS_SQL: &str = "SELECT name FROM sys.schemas WHERE schema_id BETWEEN 5 AND 16383 ORDER BY name";

const ALIAS_TYPES_SQL: &str = "\
SELECT SCHEMA_NAME(t.schema_id), t.name, TYPE_NAME(t.system_type_id), CAST(t.max_length AS bigint), CAST(t.precision AS bigint), \
  CAST(t.scale AS bigint), t.is_nullable \
FROM sys.types t WHERE t.is_user_defined = 1 AND t.is_table_type = 0 AND t.is_assembly_type = 0 ORDER BY 1, 2";

const TABLE_TYPES_SQL: &str = "\
SELECT CAST(tt.type_table_object_id AS bigint), SCHEMA_NAME(tt.schema_id), tt.name FROM sys.table_types tt WHERE tt.is_user_defined = 1";

const SEQUENCES_SQL: &str = "\
SELECT SCHEMA_NAME(s.schema_id), s.name, TYPE_NAME(s.user_type_id), CAST(s.precision AS bigint), \
  CAST(s.start_value AS nvarchar(64)), CAST(s.increment AS nvarchar(64)), CAST(s.minimum_value AS nvarchar(64)), \
  CAST(s.maximum_value AS nvarchar(64)), s.is_cycling, s.is_cached, s.cache_size \
FROM sys.sequences s ORDER BY 1, 2";

const SYNONYMS_SQL: &str = "SELECT SCHEMA_NAME(schema_id), name, base_object_name FROM sys.synonyms ORDER BY 1, 2";

const MODULES_SQL: &str = "\
SELECT CAST(o.object_id AS bigint), SCHEMA_NAME(o.schema_id), o.name, o.type, m.definition, \
  CAST(ISNULL(m.uses_ansi_nulls, 1) AS bit), CAST(ISNULL(m.uses_quoted_identifier, 1) AS bit) \
FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id \
WHERE o.is_ms_shipped = 0 AND o.type IN ('V','FN','IF','TF','P','TR') AND {tools} \
ORDER BY o.create_date, o.object_id";

/// Quem depende de quem. Defaults e checks contam como a própria tabela (uma tabela cujo CHECK
/// chama uma função precisa da função antes); colunas calculadas já vêm com o id da tabela.
const DEPENDENCIES_SQL: &str = "\
SELECT DISTINCT CAST(CASE WHEN r.type IN ('C','D') THEN r.parent_object_id ELSE d.referencing_id END AS bigint), \
  CAST(d.referenced_id AS bigint) \
FROM sys.sql_expression_dependencies d JOIN sys.objects r ON r.object_id = d.referencing_id \
WHERE d.referencing_class = 1 AND d.referenced_id IS NOT NULL";

/// Script de criação do banco da sessão: schemas → tipos → sequences → sinônimos → tabelas
/// (pais antes das filhas, cada uma com seus índices e FKs; funções exigidas por elas entram
/// logo antes) → views/funções/procedures em ordem de dependência → triggers.
pub async fn database_script(client: &mut Conn, opts: &DbScriptOptions) -> DbResult<DbScript> {
    let wanted: HashSet<&str> = opts.schemas.iter().map(String::as_str).collect();
    let in_scope = |schema: &str| wanted.is_empty() || wanted.contains(schema);
    let guard = opts.if_not_exists;
    let mut out = ScriptOut::default();

    let info = rows(client, "SELECT @@SERVERNAME, DB_NAME(), CONVERT(varchar(19), SYSDATETIME(), 120)", &[]).await?;
    let (server, database, now) = info.first().map(|r| (text(r, 0), text(r, 1), text(r, 2))).unwrap_or_default();

    // Schemas (sempre: os objetos dependem deles).
    let schemas: Vec<String> = rows(client, SCHEMAS_SQL, &[]).await?.iter().map(|r| text(r, 0)).filter(|s| in_scope(s)).collect();
    if !schemas.is_empty() {
        out.section("Schemas");
        for s in &schemas {
            let create = format!("CREATE SCHEMA {}", quote(s));
            if guard {
                out.batch(&format!("IF SCHEMA_ID({}) IS NULL EXEC({});", nstr(s), nstr(&create)), 1);
            } else {
                out.batch(&format!("{create};"), 1);
            }
        }
    }

    // Tipos de usuário: alias primeiro (os tipos de tabela podem usá-los).
    if opts.types {
        let mut types = Vec::new();
        for r in rows(client, ALIAS_TYPES_SQL, &[]).await? {
            let (schema, name) = (text(&r, 0), text(&r, 1));
            if !in_scope(&schema) {
                continue;
            }
            let base = full_type(&text(&r, 2), int(&r, 3).unwrap_or(0), int(&r, 4).unwrap_or(0), int(&r, 5).unwrap_or(0));
            types.push((qualified(&schema, &name), format!("FROM {base}{}", if flag(&r, 6) { " NULL" } else { " NOT NULL" })));
        }
        let names: HashMap<i64, (String, String)> =
            rows(client, TABLE_TYPES_SQL, &[]).await?.iter().map(|r| (int(r, 0).unwrap_or(0), (text(r, 1), text(r, 2)))).collect();
        for (id, t) in load_tables(client, Scope::TableTypes).await? {
            let Some((schema, name)) = names.get(&id) else { continue };
            if in_scope(schema) {
                types.push((qualified(schema, name), format!("AS TABLE\n{}", table_body(&t, false))));
            }
        }
        if !types.is_empty() {
            out.section("Tipos de usuário");
            for (obj, def) in types {
                let g = if guard { format!("IF TYPE_ID({}) IS NULL\n", nstr(&obj)) } else { String::new() };
                out.batch(&format!("{g}CREATE TYPE {obj} {def};"), 1);
            }
        }
    }

    if opts.sequences {
        let mut list = Vec::new();
        for r in rows(client, SEQUENCES_SQL, &[]).await? {
            let schema = text(&r, 0);
            if !in_scope(&schema) {
                continue;
            }
            let obj = qualified(&schema, &text(&r, 1));
            let ty = match text(&r, 2).as_str() {
                t @ ("decimal" | "numeric") => format!("{t}({}, 0)", int(&r, 3).unwrap_or(18)),
                t => t.to_string(),
            };
            let cache = match (flag(&r, 9), r.try_get::<i32, _>(10).ok().flatten()) {
                (false, _) => "NO CACHE".to_string(),
                (true, Some(n)) => format!("CACHE {n}"),
                (true, None) => "CACHE".to_string(),
            };
            let mut s = if guard { format!("IF OBJECT_ID({}, N'SO') IS NULL\n", nstr(&obj)) } else { String::new() };
            s.push_str(&format!(
                "CREATE SEQUENCE {obj} AS {ty} START WITH {} INCREMENT BY {} MINVALUE {} MAXVALUE {} {} {cache};",
                text(&r, 4),
                text(&r, 5),
                text(&r, 6),
                text(&r, 7),
                if flag(&r, 8) { "CYCLE" } else { "NO CYCLE" }
            ));
            list.push(s);
        }
        if !list.is_empty() {
            out.section("Sequences");
            for s in list {
                out.batch(&s, 1);
            }
        }
    }

    if opts.synonyms {
        let list: Vec<Row> = rows(client, SYNONYMS_SQL, &[]).await?.into_iter().filter(|r| in_scope(&text(r, 0))).collect();
        if !list.is_empty() {
            out.section("Sinônimos");
            for r in list {
                let obj = qualified(&text(&r, 0), &text(&r, 1));
                let g = if guard { format!("IF OBJECT_ID({}, N'SN') IS NULL\n", nstr(&obj)) } else { String::new() };
                out.batch(&format!("{g}CREATE SYNONYM {obj} FOR {};", text(&r, 2)), 1);
            }
        }
    }

    // Tabelas e módulos num grafo só: assim uma função usada em CHECK/coluna calculada sai antes
    // da tabela, e views saem depois das tabelas e das views que elas leem.
    let tables: Vec<(i64, TableSchema)> = if opts.tables {
        load_tables(client, Scope::Tables).await?.into_iter().filter(|t| in_scope(&t.1.schema)).collect()
    } else {
        Vec::new()
    };
    let modules: Vec<Module> = rows(client, &MODULES_SQL.replace("{tools}", &not_tools("o.object_id")), &[])
        .await?
        .iter()
        .map(|r| Module {
            id: int(r, 0).unwrap_or(0),
            schema: text(r, 1),
            name: text(r, 2),
            kind: text(r, 3).trim().to_string(),
            definition: text(r, 4),
            ansi_nulls: flag(r, 5),
            quoted_identifier: flag(r, 6),
        })
        .filter(|m| {
            in_scope(&m.schema)
                && match m.kind.as_str() {
                    "V" => opts.views,
                    "P" => opts.procedures,
                    "TR" => opts.triggers,
                    _ => opts.functions,
                }
        })
        .collect();
    let (triggers, modules): (Vec<Module>, Vec<Module>) = modules.into_iter().partition(|m| m.kind == "TR");

    // Nós: tabelas (0..nt) e depois módulos. Prioridade: tabelas, views/funções, procedures.
    let nt = tables.len();
    let mut node_of: HashMap<i64, usize> = HashMap::new();
    let mut by_name: HashMap<(String, String), usize> = HashMap::new();
    let mut prio = Vec::with_capacity(nt + modules.len());
    for (i, (id, t)) in tables.iter().enumerate() {
        node_of.insert(*id, i);
        by_name.insert((t.schema.clone(), t.name.clone()), i);
        prio.push((0u8, i));
    }
    for (j, m) in modules.iter().enumerate() {
        node_of.insert(m.id, nt + j);
        prio.push((if m.kind == "P" { 2 } else { 1 }, nt + j));
    }
    let mut deps = Vec::new();
    for (i, (_, t)) in tables.iter().enumerate() {
        for fk in &t.fks {
            if let Some(&p) = by_name.get(&(fk.ref_schema.clone(), fk.ref_table.clone())) {
                deps.push((i, p));
            }
        }
    }
    for r in rows(client, DEPENDENCIES_SQL, &[]).await? {
        if let (Some(&a), Some(&b)) = (node_of.get(&int(&r, 0).unwrap_or(0)), node_of.get(&int(&r, 1).unwrap_or(0))) {
            deps.push((a, b));
        }
    }

    let mut created: HashSet<usize> = HashSet::new();
    // FKs à espera da tabela referenciada (ciclos): (tabela dona, índice da FK, tabela referenciada).
    let mut waiting: Vec<(usize, usize, usize)> = Vec::new();
    let mut outside: Vec<String> = Vec::new();
    let (mut current, mut seen) = ("", HashSet::new());
    const TABLES: &str = "Tabelas (na ordem de criação)";
    const MODULES: &str = "Views, funções e procedures (na ordem de dependência)";
    for node in topo_order(&prio, &deps) {
        if node < nt {
            out.switch(&mut current, TABLES, &mut seen);
            let t = &tables[node].1;
            created.insert(node);
            let mut parts = vec![create_table_sql(t, guard)];
            let mut objects = 1;
            if opts.indexes {
                let (indexes, skipped) = index_sqls(t, guard);
                objects += indexes.len() as u32;
                parts.extend(indexes);
                for s in skipped {
                    parts.push(format!("-- Índice {s} não incluído (XML/espacial)"));
                    out.warnings.push(format!("Índice XML/espacial {s} não incluído"));
                }
            }
            if opts.foreign_keys {
                for (k, fk) in t.fks.iter().enumerate() {
                    match by_name.get(&(fk.ref_schema.clone(), fk.ref_table.clone())) {
                        Some(&p) if created.contains(&p) => {
                            parts.push(fk_sql(t, fk, guard));
                            objects += 1;
                        }
                        Some(&p) => waiting.push((node, k, p)),
                        None => outside.push(fk_sql(t, fk, guard)),
                    }
                }
                // FKs de tabelas anteriores que esperavam por esta (referência circular).
                let (now, still): (Vec<_>, Vec<_>) = waiting.drain(..).partition(|w| w.2 == node);
                waiting = still;
                for (owner, k, _) in now {
                    parts.push(format!("-- FK circular de {}", qualified(&tables[owner].1.schema, &tables[owner].1.name)));
                    parts.push(fk_sql(&tables[owner].1, &tables[owner].1.fks[k], guard));
                    objects += 1;
                }
            }
            out.batch(&parts.join("\n\n"), objects);
        } else {
            out.switch(&mut current, MODULES, &mut seen);
            emit_module(&mut out, &modules[node - nt], guard);
        }
    }
    if !outside.is_empty() {
        out.section("FKs para tabelas fora do script");
        out.warnings.push(format!("{} FK(s) referenciam tabelas fora do script (schema não selecionado)", outside.len()));
        let n = outside.len() as u32;
        out.batch(&outside.join("\n\n"), n);
    }
    if !triggers.is_empty() {
        out.section("Triggers");
        for m in &triggers {
            emit_module(&mut out, m, guard);
        }
    }

    let mut head = format!("-- Script do banco {} gerado pelo Dev Suite em {now}", quote(&database));
    if !server.is_empty() {
        head.push_str(&format!(" (servidor {server})"));
    }
    head.push_str(&format!(
        "\n-- {} objeto(s). Rode num banco vazio (sem USE: vale o banco do console).\
         \n-- Não inclui dados, usuários, permissões, filegroups/partições nem propriedades estendidas.\n",
        out.objects
    ));
    if guard {
        head.push_str("-- Protegido com IF NOT EXISTS: só cria o que falta, objetos existentes não são alterados.\n");
    }
    for w in &out.warnings {
        head.push_str(&format!("-- Aviso: {w}\n"));
    }
    head.push_str("\nSET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;\nGO\n");
    Ok(DbScript { sql: format!("{head}{}", out.body.trim_end()) + "\n", objects: out.objects, warnings: out.warnings })
}

fn emit_module(out: &mut ScriptOut, m: &Module, guard: bool) {
    let obj = qualified(&m.schema, &m.name);
    if m.definition.trim().is_empty() {
        out.body.push_str(&format!("-- {obj}: definição indisponível (criptografado ou sem VIEW DEFINITION)\n\n"));
        out.warnings.push(format!("{obj} sem definição (criptografado ou sem permissão VIEW DEFINITION)"));
        return;
    }
    let def = m.definition.trim();
    // Com guarda, só cria o que falta: CREATE OR ALTER falharia em funções SCHEMABINDING já
    // referenciadas por tabelas.
    let def = if guard { format!("IF OBJECT_ID({}) IS NULL EXEC({});", nstr(&obj), nstr(def)) } else { def.to_string() };
    // CREATE precisa ser o primeiro comando do lote: os SET vão num lote próprio.
    let off: Vec<&str> = [(!m.ansi_nulls, "ANSI_NULLS"), (!m.quoted_identifier, "QUOTED_IDENTIFIER")]
        .into_iter()
        .filter_map(|(o, n)| o.then_some(n))
        .collect();
    for n in &off {
        out.batch(&format!("SET {n} OFF;"), 0);
    }
    out.batch(&def, 1);
    for n in &off {
        out.batch(&format!("SET {n} ON;"), 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote("a]b"), "[a]]b]");
        assert_eq!(qualified("dbo", "x"), "[dbo].[x]");
        assert_eq!(nstr("[o'k]"), "N'[o''k]'");
    }

    #[test]
    fn formats_types() {
        assert_eq!(full_type("nvarchar", 400, 0, 0), "nvarchar(200)");
        assert_eq!(full_type("varchar", -1, 0, 0), "varchar(max)");
        assert_eq!(full_type("decimal", 9, 18, 2), "decimal(18,2)");
        assert_eq!(full_type("datetime2", 8, 27, 7), "datetime2(7)");
        assert_eq!(full_type("int", 4, 10, 0), "int");
    }

    fn tables(prio: &[(u8, usize)], deps: &[(usize, usize)]) -> Vec<usize> {
        topo_order(prio, deps)
    }

    #[test]
    fn orders_tables_parents_first() {
        // 0 = itens -> 1 = pedidos -> 2 = clientes
        let prio = [(0, 0), (0, 1), (0, 2)];
        assert_eq!(tables(&prio, &[(0, 1), (1, 2)]), [2, 1, 0]);
        // Sem dependências: ordem de entrada (alfabética).
        assert_eq!(tables(&prio, &[]), [0, 1, 2]);
        // Auto-referência é ignorada.
        assert_eq!(tables(&prio, &[(1, 1), (0, 1)]), [1, 0, 2]);
    }

    #[test]
    fn breaks_cycles_by_priority() {
        // 0 <-> 1 em ciclo, 2 depende de 0: o ciclo é quebrado pelo de menor prioridade.
        let prio = [(0, 0), (0, 1), (0, 2)];
        assert_eq!(tables(&prio, &[(0, 1), (1, 0), (2, 0)]), [0, 1, 2]);
    }

    #[test]
    fn modules_follow_dependencies_and_tables_come_first() {
        // 0 tabela que usa a função 3 numa coluna calculada; 1 tabela; 2 view sobre a view 4;
        // 4 view sobre a tabela 1; 5 procedure sem dependências.
        let prio = [(0, 0), (0, 1), (1, 2), (1, 3), (1, 4), (2, 5)];
        let order = tables(&prio, &[(0, 3), (2, 4), (4, 1)]);
        assert_eq!(order, [1, 3, 0, 4, 2, 5]);
    }

    fn sample() -> TableSchema {
        TableSchema {
            schema: "dbo".into(),
            name: "pedidos".into(),
            columns: vec![
                SchemaColumn { name: "id".into(), full_type: "int".into(), identity: true, seed: 1, increment: 1, ..Default::default() },
                SchemaColumn {
                    name: "qtd".into(),
                    full_type: "int".into(),
                    default: "((1))".into(),
                    default_name: "DF_qtd".into(),
                    ..Default::default()
                },
                SchemaColumn { name: "nome".into(), full_type: "varchar(50)".into(), nullable: true, collation: "Latin1_General_BIN".into(), ..Default::default() },
                SchemaColumn { name: "dobro".into(), computed: "([qtd]*(2))".into(), persisted: true, ..Default::default() },
            ],
            indexes: vec![
                SchemaIndex { name: "PK_pedidos".into(), kind: "pk".into(), clustered: true, columns: vec![IndexColumn { name: "id".into(), desc: false }], ..Default::default() },
                SchemaIndex {
                    name: "IX_nome".into(),
                    kind: "index".into(),
                    columns: vec![IndexColumn { name: "nome".into(), desc: true }],
                    include: vec!["qtd".into()],
                    filter: "([nome] IS NOT NULL)".into(),
                    type_desc: "NONCLUSTERED".into(),
                    ..Default::default()
                },
                SchemaIndex { name: "IX_xml".into(), kind: "other".into(), type_desc: "XML".into(), ..Default::default() },
            ],
            fks: vec![SchemaFk {
                name: "FK_cli".into(),
                columns: vec!["qtd".into()],
                ref_schema: "dbo".into(),
                ref_table: "clientes".into(),
                ref_columns: vec!["id".into()],
                on_delete: "CASCADE".into(),
                on_update: "NO ACTION".into(),
            }],
            checks: vec![SchemaCheck { name: "CK_qtd".into(), definition: "([qtd]>(0))".into() }],
        }
    }

    #[test]
    fn renders_table() {
        let t = sample();
        assert_eq!(
            create_table_sql(&t, false),
            "CREATE TABLE [dbo].[pedidos]\n(\n    [id] int IDENTITY(1, 1) NOT NULL,\n    [qtd] int NOT NULL CONSTRAINT [DF_qtd] DEFAULT ((1)),\n    \
             [nome] varchar(50) COLLATE Latin1_General_BIN NULL,\n    [dobro] AS ([qtd]*(2)) PERSISTED NOT NULL,\n    \
             CONSTRAINT [PK_pedidos] PRIMARY KEY CLUSTERED ([id]),\n    CONSTRAINT [CK_qtd] CHECK ([qtd]>(0))\n);"
        );
        let (ix, skipped) = index_sqls(&t, false);
        assert_eq!(ix, ["CREATE NONCLUSTERED INDEX [IX_nome] ON [dbo].[pedidos] ([nome] DESC) INCLUDE ([qtd]) WHERE ([nome] IS NOT NULL);"]);
        assert_eq!(skipped, ["[dbo].[pedidos].[IX_xml]"]);
        assert_eq!(
            fk_sql(&t, &t.fks[0], false),
            "ALTER TABLE [dbo].[pedidos] ADD CONSTRAINT [FK_cli] FOREIGN KEY ([qtd]) REFERENCES [dbo].[clientes] ([id]) ON DELETE CASCADE;"
        );
    }

    #[test]
    fn renders_guards() {
        let t = sample();
        assert!(create_table_sql(&t, true).starts_with("IF OBJECT_ID(N'[dbo].[pedidos]', N'U') IS NULL\nCREATE TABLE"));
        assert!(index_sqls(&t, true).0[0].starts_with("IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'[dbo].[pedidos]') AND name = N'IX_nome')\n"));
        assert!(fk_sql(&t, &t.fks[0], true).starts_with("IF OBJECT_ID(N'[dbo].[FK_cli]', N'F') IS NULL\nALTER TABLE"));
    }

    #[test]
    fn renders_table_type_without_names() {
        let mut t = sample();
        t.indexes.truncate(2);
        let body = table_body(&t, false);
        assert!(body.contains("[qtd] int NOT NULL DEFAULT ((1))"), "{body}");
        assert!(body.contains("    PRIMARY KEY CLUSTERED ([id])"), "{body}");
        assert!(body.contains("    INDEX [IX_nome] NONCLUSTERED ([nome] DESC)"), "{body}");
        assert!(body.contains("    CHECK ([qtd]>(0))"), "{body}");
    }
}

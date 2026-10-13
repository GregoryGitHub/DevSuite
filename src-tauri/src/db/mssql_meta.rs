//! Introspecção do SQL Server (Database Explorer, colunas das tabelas e DDL).
//!
//! Tudo roda no banco da sessão (sem nomes de três partes): o Azure SQL não permite
//! consultar outros bancos, então cada banco da árvore usa uma sessão própria.

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

const COLUMNS_SQL: &str = "\
SELECT c.name, TYPE_NAME(c.user_type_id), CAST(c.max_length AS bigint), CAST(c.precision AS bigint), CAST(c.scale AS bigint), \
  c.is_nullable, c.is_identity, c.is_computed, CAST(CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS bit), \
  CAST(CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit), \
  rs.name, rt.name, rc.name, dc.definition, cc.definition, \
  CAST(IDENT_SEED(@P1) AS bigint), CAST(IDENT_INCR(@P1) AS bigint), dc.name \
FROM sys.columns c \
LEFT JOIN (SELECT ic.column_id FROM sys.indexes i \
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
           WHERE i.object_id = OBJECT_ID(@P1) AND i.is_primary_key = 1) pk ON pk.column_id = c.column_id \
OUTER APPLY (SELECT TOP 1 fkc.referenced_object_id, fkc.referenced_column_id FROM sys.foreign_key_columns fkc \
             WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id) fk \
LEFT JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id \
LEFT JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
LEFT JOIN sys.columns rc ON rc.object_id = fk.referenced_object_id AND rc.column_id = fk.referenced_column_id \
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
WHERE c.object_id = OBJECT_ID(@P1) \
ORDER BY c.column_id";

struct ColumnRow {
    col: TableColumn,
    default_def: String,
    computed_def: String,
    default_name: String,
    ident: (i64, i64),
}

async fn column_rows(client: &mut Conn, schema: &str, name: &str) -> DbResult<Vec<ColumnRow>> {
    let obj = qualified(schema, name);
    let list = rows(client, COLUMNS_SQL, &[&obj.as_str()]).await?;
    Ok(list
        .iter()
        .map(|r| {
            let type_name = text(r, 1);
            let fk_table = text(r, 11);
            ColumnRow {
                col: TableColumn {
                    name: text(r, 0),
                    full_type: full_type(&type_name, int(r, 2).unwrap_or(0), int(r, 3).unwrap_or(0), int(r, 4).unwrap_or(0)),
                    type_name,
                    nullable: flag(r, 5),
                    is_identity: flag(r, 6),
                    is_computed: flag(r, 7),
                    has_default: flag(r, 8),
                    is_pk: flag(r, 9),
                    fk: (!fk_table.is_empty()).then(|| FkTarget { schema: text(r, 10), table: fk_table, column: text(r, 12) }),
                },
                default_def: text(r, 13),
                computed_def: text(r, 14),
                default_name: text(r, 17),
                ident: (int(r, 15).unwrap_or(1), int(r, 16).unwrap_or(1)),
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
    let columns = column_rows(client, schema, name).await?.into_iter().map(|c| c.col).collect();
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
            name: c.col.name,
            detail: format!("{}{}", c.col.full_type, if c.col.nullable { "" } else { " NOT NULL" }),
            flag: c.col.is_pk,
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

pub async fn table_schema(client: &mut Conn, schema: &str, name: &str) -> DbResult<TableSchema> {
    let obj = qualified(schema, name);
    let kind = rows(client, "SELECT type FROM sys.objects WHERE object_id = OBJECT_ID(@P1)", &[&obj.as_str()]).await?;
    match kind.first().map(|r| text(r, 0)) {
        None => return Err(format!("Tabela {obj} não encontrada")),
        Some(t) if t.trim() != "U" => return Err(format!("{obj} não é uma tabela")),
        _ => {}
    }

    let columns = column_rows(client, schema, name)
        .await?
        .into_iter()
        .map(|c| SchemaColumn {
            name: c.col.name,
            full_type: c.col.full_type,
            nullable: c.col.nullable,
            identity: c.col.is_identity,
            seed: c.ident.0,
            increment: c.ident.1,
            computed: c.computed_def,
            default: c.default_def,
            default_name: c.default_name,
        })
        .collect();

    let index_cols = rows(
        client,
        "SELECT ic.index_id, c.name, ic.is_descending_key, ic.is_included_column          FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id          WHERE ic.object_id = OBJECT_ID(@P1) ORDER BY ic.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id",
        &[&obj.as_str()],
    )
    .await?;
    let mut indexes = Vec::new();
    for r in rows(
        client,
        "SELECT i.index_id, i.name, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.type_desc, i.filter_definition          FROM sys.indexes i WHERE i.object_id = OBJECT_ID(@P1) AND i.type > 0 ORDER BY i.is_primary_key DESC, i.index_id",
        &[&obj.as_str()],
    )
    .await?
    {
        let id = r.try_get::<i32, _>(0).ok().flatten().unwrap_or(-1);
        let type_desc = text(&r, 5);
        let kind = if flag(&r, 3) {
            "pk"
        } else if flag(&r, 4) {
            "unique"
        } else if type_desc != "CLUSTERED" && type_desc != "NONCLUSTERED" {
            "other"
        } else if flag(&r, 2) {
            "uindex"
        } else {
            "index"
        };
        let mine = index_cols.iter().filter(|c| c.try_get::<i32, _>(0).ok().flatten() == Some(id));
        let (mut cols, mut include) = (Vec::new(), Vec::new());
        for c in mine {
            if flag(c, 3) {
                include.push(text(c, 1));
            } else {
                cols.push(IndexColumn { name: text(c, 1), desc: flag(c, 2) });
            }
        }
        indexes.push(SchemaIndex {
            name: text(&r, 1),
            kind: kind.into(),
            clustered: type_desc.starts_with("CLUSTERED"),
            columns: cols,
            include,
            filter: text(&r, 6),
            type_desc,
        });
    }

    let fk_cols = rows(
        client,
        "SELECT CAST(k.constraint_object_id AS bigint), pc.name, rc.name FROM sys.foreign_key_columns k          JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id          JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id          WHERE k.parent_object_id = OBJECT_ID(@P1) ORDER BY k.constraint_object_id, k.constraint_column_id",
        &[&obj.as_str()],
    )
    .await?;
    let fks = rows(
        client,
        "SELECT CAST(fk.object_id AS bigint), fk.name, rs.name, rt.name, fk.delete_referential_action_desc, fk.update_referential_action_desc          FROM sys.foreign_keys fk          JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id          JOIN sys.schemas rs ON rs.schema_id = rt.schema_id          WHERE fk.parent_object_id = OBJECT_ID(@P1) ORDER BY fk.name",
        &[&obj.as_str()],
    )
    .await?
    .iter()
    .map(|r| {
        let mine: Vec<&Row> = fk_cols.iter().filter(|c| int(c, 0) == int(r, 0)).collect();
        SchemaFk {
            name: text(r, 1),
            columns: mine.iter().map(|c| text(c, 1)).collect(),
            ref_schema: text(r, 2),
            ref_table: text(r, 3),
            ref_columns: mine.iter().map(|c| text(c, 2)).collect(),
            on_delete: referential(&text(r, 4)),
            on_update: referential(&text(r, 5)),
        }
    })
    .collect();

    let checks = rows(
        client,
        "SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(@P1) ORDER BY name",
        &[&obj.as_str()],
    )
    .await?
    .iter()
    .map(|r| SchemaCheck { name: text(r, 0), definition: text(r, 1) })
    .collect();

    Ok(TableSchema { schema: schema.to_string(), name: name.to_string(), columns, indexes, fks, checks })
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
    let obj = qualified(schema, name);
    let cols = column_rows(client, schema, name).await?;
    let indexes = rows(client, INDEXES_SQL, &[&obj.as_str()]).await?;
    let fks = rows(client, FKS_SQL, &[&obj.as_str()]).await?;

    let mut lines: Vec<String> = cols
        .iter()
        .map(|c| {
            if c.col.is_computed {
                return format!("    {} AS {}", quote(&c.col.name), c.computed_def);
            }
            let mut s = format!("    {} {}", quote(&c.col.name), c.col.full_type);
            if c.col.is_identity {
                s.push_str(&format!(" IDENTITY({}, {})", c.ident.0, c.ident.1));
            }
            if !c.default_def.is_empty() {
                s.push_str(&format!(" DEFAULT {}", c.default_def));
            }
            s.push_str(if c.col.nullable { " NULL" } else { " NOT NULL" });
            s
        })
        .collect();

    let mut after = Vec::new();
    for r in &indexes {
        let (idx_name, unique, pk, uq, type_desc, keys, include, filter) =
            (text(r, 0), flag(r, 1), flag(r, 2), flag(r, 3), text(r, 4), text(r, 5), text(r, 6), text(r, 7));
        let clustered = if type_desc == "CLUSTERED" { "CLUSTERED" } else { "NONCLUSTERED" };
        if pk || uq {
            lines.push(format!(
                "    CONSTRAINT {} {} {clustered} ({keys})",
                quote(&idx_name),
                if pk { "PRIMARY KEY" } else { "UNIQUE" }
            ));
        } else {
            let mut s = format!(
                "CREATE {}{} INDEX {} ON {obj} ({keys})",
                if unique { "UNIQUE " } else { "" },
                if type_desc.contains("COLUMNSTORE") { type_desc.as_str() } else { clustered },
                quote(&idx_name)
            );
            if !include.is_empty() {
                s.push_str(&format!(" INCLUDE ({include})"));
            }
            if !filter.is_empty() {
                s.push_str(&format!(" WHERE {filter}"));
            }
            after.push(format!("{s};"));
        }
    }
    for r in &fks {
        let mut s = format!(
            "ALTER TABLE {obj} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            quote(&text(r, 0)),
            text(r, 1),
            text(r, 2),
            text(r, 3)
        );
        let (on_delete, on_update) = (text(r, 4), text(r, 5));
        if on_delete != "NO_ACTION" {
            s.push_str(&format!(" ON DELETE {}", on_delete.replace('_', " ")));
        }
        if on_update != "NO_ACTION" {
            s.push_str(&format!(" ON UPDATE {}", on_update.replace('_', " ")));
        }
        after.push(format!("{s};"));
    }

    let mut out = format!("CREATE TABLE {obj}\n(\n{}\n);\n", lines.join(",\n"));
    if !after.is_empty() {
        out.push('\n');
        out.push_str(&after.join("\n"));
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote("a]b"), "[a]]b]");
        assert_eq!(qualified("dbo", "x"), "[dbo].[x]");
    }

    #[test]
    fn formats_types() {
        assert_eq!(full_type("nvarchar", 400, 0, 0), "nvarchar(200)");
        assert_eq!(full_type("varchar", -1, 0, 0), "varchar(max)");
        assert_eq!(full_type("decimal", 9, 18, 2), "decimal(18,2)");
        assert_eq!(full_type("datetime2", 8, 27, 7), "datetime2(7)");
        assert_eq!(full_type("int", 4, 10, 0), "int");
    }
}

//! Dados da aba RabbitMQ em SQLite (`<app_data>/rabbit.db`).
//!
//!  - `connections`: configuração de cada host (JSON sem a senha, que fica no cofre do sistema);
//!  - `meta`: estado da interface e preferências (JSON);
//!  - `captures`: gravações (tap/firehose/exchange) com início, fim e contagem;
//!  - `messages`: mensagens gravadas e as salvas a partir da visualização de uma fila.
//!    O corpo em texto vai para `body_text` (busca FTS5 trigram, como nas notas) e o
//!    binário (corpo que não é UTF-8) para `payload`.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY,
    conn_id TEXT NOT NULL,
    vhost TEXT NOT NULL DEFAULT '/',
    mode TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    error TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    capture_id INTEGER,
    conn_id TEXT NOT NULL,
    vhost TEXT NOT NULL DEFAULT '/',
    at INTEGER NOT NULL,
    event TEXT NOT NULL,
    exchange TEXT NOT NULL DEFAULT '',
    routing_key TEXT NOT NULL DEFAULT '',
    queues TEXT NOT NULL DEFAULT '',
    properties TEXT NOT NULL DEFAULT '{}',
    body_text TEXT,
    payload BLOB,
    size INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    redelivered INTEGER NOT NULL DEFAULT 0,
    client TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS messages_capture ON messages(capture_id, id);
CREATE INDEX IF NOT EXISTS messages_conn ON messages(conn_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body_text, content='messages', content_rowid='id', tokenize='trigram remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body_text) VALUES (new.id, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body_text) VALUES ('delete', old.id, old.body_text);
END;
";

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(SCHEMA)
}

// ---------- Conexões e estado da interface ----------

/// Conexões na ordem salva (cada uma é o JSON definido em `rabbitModel.js`).
pub fn connections(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    let mut st = conn.prepare("SELECT data FROM connections ORDER BY position, rowid")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect())
}

/// Substitui a lista (é pequena; a ordem do array vira `position`).
pub fn save_connections(conn: &mut Connection, list: &[Value]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM connections", [])?;
    {
        let mut st = tx.prepare("INSERT OR REPLACE INTO connections (id, position, data) VALUES (?1, ?2, ?3)")?;
        for (pos, c) in list.iter().enumerate() {
            let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            st.execute(params![id, pos as i64, c.to_string()])?;
        }
    }
    tx.commit()
}

pub fn get_meta(conn: &Connection, key: &str) -> rusqlite::Result<Value> {
    let raw: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0)).optional()?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
}

pub fn set_meta(conn: &Connection, key: &str, value: &Value) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, value.to_string()])?;
    Ok(())
}

// ---------- Gravações ----------

#[derive(Serialize, Clone, Debug, Default)]
pub struct Capture {
    pub id: i64,
    pub conn_id: String,
    pub vhost: String,
    pub mode: String,
    pub name: String,
    pub source: String,
    pub started_at: i64,
    pub stopped_at: Option<i64>,
    pub error: Option<String>,
    pub count: i64,
}

pub fn insert_capture(conn: &Connection, c: &Capture) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO captures (conn_id, vhost, mode, name, source, started_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![c.conn_id, c.vhost, c.mode, c.name, c.source, c.started_at],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn finish_capture(conn: &Connection, id: i64, stopped_at: i64, error: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE captures SET stopped_at = ?2, error = ?3 WHERE id = ?1", params![id, stopped_at, error])?;
    Ok(())
}

/// Gravações interrompidas (app fechado no meio): ficam marcadas como encerradas.
pub fn close_dangling(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE captures SET stopped_at = COALESCE((SELECT MAX(at) FROM messages WHERE capture_id = captures.id), started_at), error = COALESCE(error, 'Interrompida (app fechado)') WHERE stopped_at IS NULL AND started_at < ?1",
        params![now],
    )?;
    Ok(())
}

pub fn captures(conn: &Connection, conn_id: Option<&str>) -> rusqlite::Result<Vec<Capture>> {
    let mut st = conn.prepare(
        "SELECT c.id, c.conn_id, c.vhost, c.mode, c.name, c.source, c.started_at, c.stopped_at, c.error,
                (SELECT COUNT(*) FROM messages m WHERE m.capture_id = c.id)
         FROM captures c WHERE (?1 IS NULL OR c.conn_id = ?1) ORDER BY c.id DESC",
    )?;
    let rows = st.query_map(params![conn_id], |r| {
        Ok(Capture {
            id: r.get(0)?,
            conn_id: r.get(1)?,
            vhost: r.get(2)?,
            mode: r.get(3)?,
            name: r.get(4)?,
            source: r.get(5)?,
            started_at: r.get(6)?,
            stopped_at: r.get(7)?,
            error: r.get(8)?,
            count: r.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn rename_capture(conn: &Connection, id: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE captures SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Apaga a gravação e as mensagens dela.
pub fn delete_capture(conn: &mut Connection, id: i64) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let n = tx.execute("DELETE FROM messages WHERE capture_id = ?1", params![id])?;
    tx.execute("DELETE FROM captures WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(n)
}

// ---------- Mensagens ----------

/// Mensagem a gravar (vinda da captura AMQP ou salva da visualização de uma fila).
#[derive(Deserialize, Clone, Debug, Default)]
pub struct MsgIn {
    #[serde(default)]
    pub capture_id: Option<i64>,
    #[serde(default)]
    pub conn_id: String,
    #[serde(default)]
    pub vhost: String,
    /// ms desde 1970
    #[serde(default)]
    pub at: i64,
    /// publish | deliver | peek
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub exchange: String,
    #[serde(default)]
    pub routing_key: String,
    #[serde(default)]
    pub queues: Vec<String>,
    /// Propriedades AMQP no formato da API de management (inclui `headers`).
    #[serde(default)]
    pub properties: Value,
    #[serde(skip)]
    pub payload: Vec<u8>,
    /// Corpo vindo do JS: texto ou base64 conforme `payload_encoding`.
    #[serde(default)]
    pub payload_text: String,
    #[serde(default)]
    pub payload_encoding: String,
    /// Tamanho original (pode ser maior que o gravado quando truncado).
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub redelivered: bool,
    #[serde(default)]
    pub client: String,
}

impl MsgIn {
    /// Converte o corpo vindo do JS (texto/base64) em bytes.
    pub fn decode_js_payload(&mut self) {
        if self.payload.is_empty() && !self.payload_text.is_empty() {
            self.payload = if self.payload_encoding == "base64" {
                B64.decode(self.payload_text.trim()).unwrap_or_else(|_| self.payload_text.clone().into_bytes())
            } else {
                std::mem::take(&mut self.payload_text).into_bytes()
            };
        }
    }
}

/// Resumo para a lista (sem o corpo inteiro).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MsgRow {
    pub id: i64,
    pub capture_id: Option<i64>,
    pub conn_id: String,
    pub vhost: String,
    pub at: i64,
    pub event: String,
    pub exchange: String,
    pub routing_key: String,
    pub queues: String,
    pub size: i64,
    pub truncated: bool,
    pub redelivered: bool,
    pub client: String,
    pub preview: String,
    pub binary: bool,
    pub content_type: String,
    pub message_id: String,
    pub correlation_id: String,
}

/// Mensagem completa (detalhe).
#[derive(Serialize, Clone, Debug)]
pub struct MsgFull {
    #[serde(flatten)]
    pub row: MsgRow,
    pub properties: Value,
    /// Texto (UTF-8) ou base64 conforme `payload_encoding`.
    pub payload: String,
    pub payload_encoding: String,
}

/// Grava em lote (uma transação). Corpo acima de `max_body` bytes é truncado.
pub fn insert_messages(conn: &mut Connection, msgs: &[MsgIn], max_body: usize) -> rusqlite::Result<usize> {
    if msgs.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare(
            "INSERT INTO messages (capture_id, conn_id, vhost, at, event, exchange, routing_key, queues, properties, body_text, payload, size, truncated, redelivered, client)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for m in msgs {
            let size = if m.size > 0 { m.size } else { m.payload.len() as i64 };
            let body = if m.payload.len() > max_body { &m.payload[..max_body] } else { &m.payload[..] };
            let truncated = body.len() < m.payload.len() || (size as usize) > m.payload.len();
            // Corte no meio de um caractere UTF-8 não deve virar "binário".
            let (text, blob) = match std::str::from_utf8(body) {
                Ok(s) => (Some(s.to_string()), None),
                Err(e) if truncated && e.error_len().is_none() => (Some(String::from_utf8_lossy(&body[..e.valid_up_to()]).into_owned()), None),
                Err(_) => (None, Some(body.to_vec())),
            };
            let props = if m.properties.is_null() { "{}".to_string() } else { m.properties.to_string() };
            st.execute(params![
                m.capture_id,
                m.conn_id,
                m.vhost,
                m.at,
                m.event,
                m.exchange,
                m.routing_key,
                m.queues.join(" "),
                props,
                text,
                blob,
                size,
                truncated,
                m.redelivered,
                m.client,
            ])?;
        }
    }
    tx.commit()?;
    Ok(msgs.len())
}

/// Mantém no máximo `max` mensagens (apaga as mais antigas).
pub fn enforce_limit(conn: &Connection, max: i64) -> rusqlite::Result<usize> {
    let cut: Option<i64> = conn
        .query_row("SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?1", params![max], |r| r.get(0))
        .optional()?;
    match cut {
        Some(id) => conn.execute("DELETE FROM messages WHERE id <= ?1", params![id]),
        None => Ok(0),
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct MsgFilter {
    #[serde(default)]
    pub conn_id: Option<String>,
    #[serde(default)]
    pub capture_id: Option<i64>,
    #[serde(default)]
    pub vhost: String,
    /// Texto contido no corpo (FTS trigram), nos headers/propriedades ou na routing key.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub exchange: String,
    /// Aceita `*` como curinga.
    #[serde(default)]
    pub routing_key: String,
    #[serde(default)]
    pub queue: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub from: Option<i64>,
    #[serde(default)]
    pub to: Option<i64>,
    /// Caminho JSON no corpo (`$.pedido.id`) comparado com `json_value`.
    #[serde(default)]
    pub json_path: String,
    /// eq | ne | contains | exists | gt | lt
    #[serde(default)]
    pub json_op: String,
    #[serde(default)]
    pub json_value: String,
    /// Paginação: só ids menores que este (lista do mais novo para o mais antigo).
    #[serde(default)]
    pub before_id: Option<i64>,
    /// Ordem crescente (do mais antigo), usada pela exportação.
    #[serde(default)]
    pub ascending: bool,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Debug)]
pub struct MsgPage {
    pub rows: Vec<MsgRow>,
    /// Total que casa com o filtro (só na primeira página).
    pub total: Option<i64>,
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Normaliza `pedido.id` / `$.pedido.id` / `$[0].x` para o formato do json_extract.
pub fn json_path(p: &str) -> String {
    let p = p.trim();
    if p.starts_with('$') {
        p.to_string()
    } else if p.starts_with('[') {
        format!("${p}")
    } else {
        format!("$.{p}")
    }
}

/// Monta o WHERE (sem paginação) e os parâmetros.
fn filter_sql(f: &MsgFilter) -> (String, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value as V;
    let mut w: Vec<String> = vec!["1 = 1".into()];
    let mut p: Vec<V> = Vec::new();
    let mut push = |cond: String, vals: Vec<V>, w: &mut Vec<String>| {
        w.push(cond);
        p.extend(vals);
    };
    if let Some(c) = &f.conn_id {
        push("m.conn_id = ?".into(), vec![V::Text(c.clone())], &mut w);
    }
    if let Some(c) = f.capture_id {
        push("m.capture_id = ?".into(), vec![V::Integer(c)], &mut w);
    }
    if !f.vhost.is_empty() {
        push("m.vhost = ?".into(), vec![V::Text(f.vhost.clone())], &mut w);
    }
    if !f.event.is_empty() {
        push("m.event = ?".into(), vec![V::Text(f.event.clone())], &mut w);
    }
    if !f.exchange.trim().is_empty() {
        let pat = format!("%{}%", like_escape(f.exchange.trim()));
        push("m.exchange LIKE ? ESCAPE '\\'".into(), vec![V::Text(pat)], &mut w);
    }
    if !f.routing_key.trim().is_empty() {
        let rk = f.routing_key.trim();
        let pat = if rk.contains('*') { like_escape(rk).replace('*', "%") } else { format!("%{}%", like_escape(rk)) };
        push("m.routing_key LIKE ? ESCAPE '\\'".into(), vec![V::Text(pat)], &mut w);
    }
    if !f.queue.trim().is_empty() {
        // `queues` é uma lista separada por espaço: casa o nome inteiro.
        let q = f.queue.trim();
        push(
            "(' ' || m.queues || ' ') LIKE ? ESCAPE '\\'".into(),
            vec![V::Text(format!("% {} %", like_escape(q)))],
            &mut w,
        );
    }
    if let Some(t) = f.from {
        push("m.at >= ?".into(), vec![V::Integer(t)], &mut w);
    }
    if let Some(t) = f.to {
        push("m.at <= ?".into(), vec![V::Integer(t)], &mut w);
    }
    let text = f.text.trim();
    if !text.is_empty() {
        let like = format!("%{}%", like_escape(text));
        if text.chars().count() >= 3 {
            let phrase = format!("\"{}\"", text.replace('"', "\"\""));
            push(
                "(m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) OR m.properties LIKE ? ESCAPE '\\' OR m.routing_key LIKE ? ESCAPE '\\')".into(),
                vec![V::Text(phrase), V::Text(like.clone()), V::Text(like)],
                &mut w,
            );
        } else {
            push(
                "(m.body_text LIKE ? ESCAPE '\\' OR m.properties LIKE ? ESCAPE '\\' OR m.routing_key LIKE ? ESCAPE '\\')".into(),
                vec![V::Text(like.clone()), V::Text(like.clone()), V::Text(like)],
                &mut w,
            );
        }
    }
    if !f.json_path.trim().is_empty() {
        let path = json_path(&f.json_path);
        // json_valid evita erro de SQL em corpos que não são JSON.
        let base = "json_valid(m.body_text) AND ";
        let val = f.json_value.trim().to_string();
        let num = val.parse::<f64>().ok();
        match f.json_op.as_str() {
            "exists" => push(format!("{base}json_type(m.body_text, ?) IS NOT NULL"), vec![V::Text(path)], &mut w),
            "ne" => push(
                format!("{base}COALESCE(CAST(json_extract(m.body_text, ?) AS TEXT), '') <> ?"),
                vec![V::Text(path), V::Text(val)],
                &mut w,
            ),
            "contains" => push(
                format!("{base}CAST(json_extract(m.body_text, ?) AS TEXT) LIKE ? ESCAPE '\\'"),
                vec![V::Text(path), V::Text(format!("%{}%", like_escape(&val)))],
                &mut w,
            ),
            "gt" | "lt" if num.is_some() => {
                let op = if f.json_op == "gt" { ">" } else { "<" };
                push(
                    format!("{base}CAST(json_extract(m.body_text, ?) AS REAL) {op} ?"),
                    vec![V::Text(path), V::Real(num.unwrap())],
                    &mut w,
                )
            }
            _ => {
                // Igualdade textual (true/false/null/números viram texto no CAST).
                let v = match val.as_str() {
                    "true" => "1".to_string(),
                    "false" => "0".to_string(),
                    _ => val.trim_matches('"').to_string(),
                };
                push(format!("{base}CAST(json_extract(m.body_text, ?) AS TEXT) = ?"), vec![V::Text(path), V::Text(v)], &mut w)
            }
        }
    }
    (w.join(" AND "), p)
}

const ROW_COLS: &str = "m.id, m.capture_id, m.conn_id, m.vhost, m.at, m.event, m.exchange, m.routing_key, m.queues, m.size, m.truncated, m.redelivered, m.client, substr(m.body_text, 1, 240), m.payload IS NOT NULL, m.properties";

fn row_of(r: &rusqlite::Row) -> rusqlite::Result<(MsgRow, String)> {
    let props: String = r.get(15)?;
    let pv: Value = serde_json::from_str(&props).unwrap_or(Value::Null);
    let s = |k: &str| pv.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let preview: Option<String> = r.get(13)?;
    Ok((
        MsgRow {
            id: r.get(0)?,
            capture_id: r.get(1)?,
            conn_id: r.get(2)?,
            vhost: r.get(3)?,
            at: r.get(4)?,
            event: r.get(5)?,
            exchange: r.get(6)?,
            routing_key: r.get(7)?,
            queues: r.get(8)?,
            size: r.get(9)?,
            truncated: r.get(10)?,
            redelivered: r.get(11)?,
            client: r.get(12)?,
            preview: preview.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" "),
            binary: r.get(14)?,
            content_type: s("content_type"),
            message_id: s("message_id"),
            correlation_id: s("correlation_id"),
        },
        props,
    ))
}

pub fn query_messages(conn: &Connection, f: &MsgFilter) -> rusqlite::Result<MsgPage> {
    let (where_sql, mut p) = filter_sql(f);
    let total = if f.before_id.is_none() {
        let sql = format!("SELECT COUNT(*) FROM messages m WHERE {where_sql}");
        Some(conn.query_row(&sql, params_from_iter(p.iter()), |r| r.get(0))?)
    } else {
        None
    };
    let mut sql = format!("SELECT {ROW_COLS} FROM messages m WHERE {where_sql}");
    if let Some(b) = f.before_id {
        sql.push_str(if f.ascending { " AND m.id > ?" } else { " AND m.id < ?" });
        p.push(rusqlite::types::Value::Integer(b));
    }
    sql.push_str(if f.ascending { " ORDER BY m.id ASC" } else { " ORDER BY m.id DESC" });
    sql.push_str(&format!(" LIMIT {}", f.limit.unwrap_or(200).clamp(1, 100_000)));
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(params_from_iter(p.iter()), |r| row_of(r).map(|(row, _)| row))?;
    Ok(MsgPage { rows: rows.collect::<rusqlite::Result<_>>()?, total })
}

pub fn get_message(conn: &Connection, id: i64) -> rusqlite::Result<Option<MsgFull>> {
    let sql = format!("SELECT {ROW_COLS}, m.body_text, m.payload FROM messages m WHERE m.id = ?1");
    conn.query_row(&sql, params![id], |r| {
        let (row, props) = row_of(r)?;
        let text: Option<String> = r.get(16)?;
        let blob: Option<Vec<u8>> = r.get(17)?;
        let (payload, enc) = match (text, blob) {
            (Some(t), _) => (t, "string"),
            (None, Some(b)) => (B64.encode(b), "base64"),
            _ => (String::new(), "string"),
        };
        Ok(MsgFull { row, properties: serde_json::from_str(&props).unwrap_or(Value::Null), payload, payload_encoding: enc.into() })
    })
    .optional()
}

/// Várias mensagens completas (exportação / republicar em lote).
pub fn get_messages(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<MsgFull>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(m) = get_message(conn, *id)? {
            out.push(m);
        }
    }
    Ok(out)
}

pub fn delete_messages(conn: &mut Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut n = 0;
    {
        let mut st = tx.prepare("DELETE FROM messages WHERE id = ?1")?;
        for id in ids {
            n += st.execute(params![id])?;
        }
    }
    tx.commit()?;
    Ok(n)
}

/// Apaga tudo que casa com o filtro (ex.: "limpar resultado da busca").
pub fn delete_matching(conn: &Connection, f: &MsgFilter) -> rusqlite::Result<usize> {
    let (where_sql, p) = filter_sql(f);
    let sql = format!("DELETE FROM messages WHERE id IN (SELECT m.id FROM messages m WHERE {where_sql})");
    conn.execute(&sql, params_from_iter(p.iter()))
}

pub fn stats(conn: &Connection) -> rusqlite::Result<Value> {
    let (count, bytes): (i64, i64) = conn.query_row("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM messages", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(serde_json::json!({ "messages": count, "bytes": bytes }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn msg(rk: &str, body: &str) -> MsgIn {
        MsgIn {
            conn_id: "c1".into(),
            vhost: "/".into(),
            at: 1000,
            event: "publish".into(),
            exchange: "orders".into(),
            routing_key: rk.into(),
            queues: vec!["q.orders".into(), "q.audit".into()],
            properties: json!({ "content_type": "application/json", "message_id": "m-1", "headers": { "tenant": "acme" } }),
            payload: body.as_bytes().to_vec(),
            ..Default::default()
        }
    }

    #[test]
    fn connections_roundtrip_in_order() {
        let mut c = db();
        save_connections(&mut c, &[json!({ "id": "b", "name": "B" }), json!({ "id": "a", "name": "A" })]).unwrap();
        let list = connections(&c).unwrap();
        assert_eq!(list.iter().map(|v| v["id"].as_str().unwrap()).collect::<Vec<_>>(), ["b", "a"]);
        set_meta(&c, "ui", &json!({ "section": "queues" })).unwrap();
        assert_eq!(get_meta(&c, "ui").unwrap()["section"], "queues");
        assert!(get_meta(&c, "nope").unwrap().is_null());
    }

    #[test]
    fn search_filters() {
        let mut c = db();
        insert_messages(
            &mut c,
            &[
                msg("order.created", r#"{"pedido":{"id":42,"cliente":"José"},"total":10.5}"#),
                msg("order.paid", r#"{"pedido":{"id":7},"total":99}"#),
                msg("user.created", "plain text body"),
            ],
            1 << 20,
        )
        .unwrap();
        let q = |f: MsgFilter| query_messages(&c, &f).unwrap();
        // Texto: corpo sem acento/maiúsculas (trigram), headers e routing key.
        assert_eq!(q(MsgFilter { text: "jose".into(), ..Default::default() }).total, Some(1));
        assert_eq!(q(MsgFilter { text: "acme".into(), ..Default::default() }).total, Some(3));
        assert_eq!(q(MsgFilter { text: "dy".into(), ..Default::default() }).total, Some(1));
        // Routing key com curinga.
        assert_eq!(q(MsgFilter { routing_key: "order.*".into(), ..Default::default() }).total, Some(2));
        assert_eq!(q(MsgFilter { routing_key: "created".into(), ..Default::default() }).total, Some(2));
        // Fila: nome inteiro.
        assert_eq!(q(MsgFilter { queue: "q.audit".into(), ..Default::default() }).total, Some(3));
        assert_eq!(q(MsgFilter { queue: "q.aud".into(), ..Default::default() }).total, Some(0));
        // Caminho JSON.
        let j = |path: &str, op: &str, v: &str| q(MsgFilter { json_path: path.into(), json_op: op.into(), json_value: v.into(), ..Default::default() }).total;
        assert_eq!(j("pedido.id", "eq", "42"), Some(1));
        assert_eq!(j("$.pedido.cliente", "eq", "\"José\""), Some(1));
        assert_eq!(j("total", "gt", "50"), Some(1));
        assert_eq!(j("pedido.cliente", "exists", ""), Some(1));
        assert_eq!(j("pedido.cliente", "contains", "os"), Some(1));
        assert_eq!(j("pedido.id", "ne", "42"), Some(1)); // o corpo texto não é JSON
        // Paginação do mais novo para o mais antigo.
        let p1 = q(MsgFilter { limit: Some(2), ..Default::default() });
        assert_eq!(p1.rows.len(), 2);
        assert_eq!(p1.rows[0].routing_key, "user.created");
        let p2 = q(MsgFilter { limit: Some(2), before_id: Some(p1.rows[1].id), ..Default::default() });
        assert_eq!(p2.total, None);
        assert_eq!(p2.rows.len(), 1);
        assert_eq!(p1.rows[0].content_type, "application/json");
        assert_eq!(p1.rows[0].message_id, "m-1");
    }

    #[test]
    fn binary_truncation_and_limits() {
        let mut c = db();
        let mut bin = msg("x", "");
        bin.payload = vec![0xff, 0x00, 0xfe];
        let mut big = msg("y", "");
        big.payload = "ação".repeat(10).into_bytes(); // corte no meio de um caractere
        insert_messages(&mut c, &[bin, big], 4).unwrap();
        let rows = query_messages(&c, &MsgFilter::default()).unwrap().rows;
        let full_big = get_message(&c, rows[0].id).unwrap().unwrap();
        assert!(full_big.row.truncated && !full_big.row.binary);
        assert_eq!(full_big.payload, "aç");
        let full_bin = get_message(&c, rows[1].id).unwrap().unwrap();
        assert!(full_bin.row.binary);
        assert_eq!(full_bin.payload_encoding, "base64");
        assert_eq!(B64.decode(full_bin.payload).unwrap(), vec![0xff, 0x00, 0xfe]);

        for _ in 0..5 {
            insert_messages(&mut c, &[msg("z", "abc")], 1024).unwrap();
        }
        enforce_limit(&c, 3).unwrap();
        assert_eq!(query_messages(&c, &MsgFilter::default()).unwrap().total, Some(3));
        // Apagadas também saem do índice de busca.
        assert_eq!(query_messages(&c, &MsgFilter { text: "abc".into(), ..Default::default() }).unwrap().total, Some(3));
        let n = delete_matching(&c, &MsgFilter { text: "abc".into(), ..Default::default() }).unwrap();
        assert_eq!(n, 3);
        assert_eq!(query_messages(&c, &MsgFilter { text: "abc".into(), ..Default::default() }).unwrap().total, Some(0));
    }

    #[test]
    fn captures_count_and_delete() {
        let mut c = db();
        let id = insert_capture(&c, &Capture { conn_id: "c1".into(), vhost: "/".into(), mode: "tap".into(), source: "q".into(), started_at: 5, ..Default::default() }).unwrap();
        let mut m = msg("a", "x");
        m.capture_id = Some(id);
        insert_messages(&mut c, &[m.clone(), m], 100).unwrap();
        insert_messages(&mut c, &[msg("b", "y")], 100).unwrap();
        let list = captures(&c, Some("c1")).unwrap();
        assert_eq!(list[0].count, 2);
        assert_eq!(list[0].stopped_at, None);
        close_dangling(&c, 10).unwrap();
        assert_eq!(captures(&c, None).unwrap()[0].stopped_at, Some(1000));
        assert_eq!(delete_capture(&mut c, id).unwrap(), 2);
        assert!(captures(&c, None).unwrap().is_empty());
        assert_eq!(query_messages(&c, &MsgFilter::default()).unwrap().total, Some(1));
    }
}

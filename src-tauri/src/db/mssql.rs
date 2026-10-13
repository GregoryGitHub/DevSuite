//! Driver SQL Server / Azure SQL (TDS via `tiberius`).

use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use serde_json::{json, Value};
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql, QueryItem, SqlBrowser};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::driver::*;
use super::mssql_meta;

pub type Conn = Client<Compat<TcpStream>>;

/// Binários maiores que isso chegam truncados ao grid (só exibição).
const BINARY_PREVIEW: usize = 4096;
/// O primeiro lote sai cedo para o grid pintar rápido; os seguintes são maiores.
const FIRST_BATCH: usize = 100;
const BATCH: usize = 1000;

pub struct MssqlDriver;

#[async_trait]
impl Driver for MssqlDriver {
    async fn connect(&self, cfg: &ConnConfig, database: &str, secret: Secret) -> DbResult<Box<dyn Session>> {
        let client = open(cfg, database, secret).await?;
        Ok(Box::new(MssqlSession { client, broken: false }))
    }
}

async fn open(cfg: &ConnConfig, database: &str, secret: Secret) -> DbResult<Conn> {
    let mut config = Config::new();
    config.host(cfg.host.trim());
    if let Some(port) = cfg.port {
        config.port(port);
    }
    if let Some(instance) = cfg.instance.as_deref().filter(|s| !s.trim().is_empty()) {
        config.instance_name(instance.trim());
    }
    let database = if database.is_empty() { cfg.database.as_str() } else { database };
    if !database.is_empty() {
        config.database(database);
    }
    config.application_name("TodoRS");
    config.encryption(match cfg.encrypt.as_str() {
        "off" => EncryptionLevel::Off,
        "strict" => EncryptionLevel::Strict,
        _ => EncryptionLevel::Required,
    });
    if cfg.trust_server_certificate {
        config.trust_cert();
    }
    config.readonly(cfg.read_intent);
    config.authentication(match secret {
        Secret::Password(pw) => AuthMethod::sql_server(&cfg.auth.user, pw),
        Secret::AccessToken(token) => AuthMethod::aad_token(token),
    });

    let timeout = Duration::from_secs(cfg.connect_timeout_s.clamp(1, 300));
    let attempt = async {
        // O gateway do Azure SQL pode redirecionar para o nó que hospeda o banco.
        for _ in 0..3 {
            let tcp = connect_tcp(&config, cfg).await?;
            match Client::connect(config.clone(), tcp.compat_write()).await {
                Ok(client) => return Ok(client),
                Err(tiberius::error::Error::Routing { host, port }) => {
                    config.host(&host);
                    config.port(port);
                }
                Err(e) => return Err(describe(&e)),
            }
        }
        Err("Redirecionamentos demais ao conectar".to_string())
    };
    tokio::time::timeout(timeout, attempt)
        .await
        .map_err(|_| format!("Tempo limite de conexão esgotado ({}s)", timeout.as_secs()))?
}

async fn connect_tcp(config: &Config, cfg: &ConnConfig) -> DbResult<TcpStream> {
    let named = cfg.port.is_none() && cfg.instance.as_deref().is_some_and(|s| !s.trim().is_empty());
    let tcp = if named {
        TcpStream::connect_named(config).await.map_err(|e| describe(&e))?
    } else {
        TcpStream::connect(config.get_addr())
            .await
            .map_err(|e| format!("Falha ao conectar em {}: {e}", config.get_addr()))?
    };
    let _ = tcp.set_nodelay(true);
    Ok(tcp)
}

/// Mensagem legível para o usuário (erros do servidor no formato do SSMS).
pub fn describe(e: &tiberius::error::Error) -> String {
    match e {
        tiberius::error::Error::Server(t) => {
            let mut msg = format!("[{}] {}", t.code(), t.message());
            if t.line() > 0 {
                msg.push_str(&format!(" (linha {})", t.line()));
            }
            msg
        }
        other => other.to_string(),
    }
}

pub struct MssqlSession {
    pub(super) client: Conn,
    /// Erro de transporte/protocolo: a conexão não pode mais ser usada.
    broken: bool,
}

/// Falha durante uma execução: do banco (mensagem do servidor ou conexão) ou do destino dos eventos.
enum Fail {
    Db(tiberius::error::Error),
    Sink(String),
}

impl From<tiberius::error::Error> for Fail {
    fn from(e: tiberius::error::Error) -> Self {
        Fail::Db(e)
    }
}

impl MssqlSession {
    /// Converte o erro em mensagem e marca a sessão como inutilizável se não foi um erro "normal" do servidor.
    fn fail(&mut self, e: Fail) -> String {
        match e {
            Fail::Db(e) => {
                if !matches!(e, tiberius::error::Error::Server(_)) {
                    self.broken = true;
                }
                describe(&e)
            }
            Fail::Sink(msg) => {
                // O frontend parou de ouvir no meio do stream: a resposta ficou pela metade.
                self.broken = true;
                msg
            }
        }
    }

    async fn tran_count(&mut self) -> DbResult<u32> {
        let row = self
            .client
            .simple_query("SELECT CAST(@@TRANCOUNT AS int)")
            .await
            .map_err(|e| describe(&e))?
            .into_row()
            .await
            .map_err(|e| describe(&e))?;
        Ok(row.and_then(|r| r.get::<i32, _>(0)).unwrap_or(0).max(0) as u32)
    }

    async fn batch(&mut self, sql: &str) -> DbResult<()> {
        self.client
            .simple_query(sql)
            .await
            .map_err(|e| describe(&e))?
            .into_results()
            .await
            .map_err(|e| describe(&e))?;
        Ok(())
    }

    /// Executa o lote na sessão e envia os result sets para `sink`. Devolve a soma das linhas
    /// afetadas por INSERT/UPDATE/DELETE/MERGE (contagem do DONE de cada comando, via o patch
    /// do tiberius em vendor/), ou None se o lote não alterou dados.
    async fn stream(&mut self, sql: &str, sink: &mut dyn EventSink, max_rows: Option<u64>, summary: &mut ExecSummary) -> Result<Option<u64>, Fail> {
        let mut stream = self.client.simple_query_counted(sql).await?;
        let mut affected: Option<u64> = None;
        let mut current: Option<usize> = None;
        let mut buf: Vec<Vec<Value>> = Vec::new();
        let mut count = 0u64;
        let mut truncated = false;
        let mut first = true;

        while let Some(item) = stream.try_next().await? {
            match item {
                QueryItem::RowsAffected { rows, command } => {
                    if is_dml_command(command) {
                        affected = Some(affected.unwrap_or(0) + rows);
                    }
                }
                QueryItem::Metadata(meta) => {
                    if let Some(index) = current {
                        flush(sink, index, &mut buf)?;
                        send(sink, ExecEvent::ResultEnd { index, row_count: count, truncated })?;
                    }
                    let index = meta.result_index();
                    current = Some(index);
                    count = 0;
                    truncated = false;
                    first = true;
                    summary.result_sets += 1;
                    let columns = meta.columns().iter().map(|c| column_meta(c.name(), c.column_type())).collect();
                    send(sink, ExecEvent::ResultStart { index, columns })?;
                }
                QueryItem::Row(row) => {
                    if max_rows.is_some_and(|max| count >= max) {
                        // Excedentes são descartados; o resto do lote continua rodando no servidor.
                        truncated = true;
                        summary.truncated = true;
                        continue;
                    }
                    buf.push(row.cells().map(|(_, data)| cell(data)).collect());
                    count += 1;
                    if buf.len() >= if first { FIRST_BATCH } else { BATCH } {
                        first = false;
                        flush(sink, current.unwrap_or(0), &mut buf)?;
                    }
                }
            }
        }
        if let Some(index) = current {
            flush(sink, index, &mut buf)?;
            send(sink, ExecEvent::ResultEnd { index, row_count: count, truncated })?;
        }
        Ok(affected)
    }
}

/// CurCmd (MS-TDS) de comandos que alteram linhas. SELECT (0xC1), atribuições de variável,
/// DDL etc. também mandam contagem, mas não são "registros afetados".
fn is_dml_command(command: u16) -> bool {
    matches!(command, DML_INSERT | DML_DELETE | DML_UPDATE | DML_MERGE)
}

const DML_INSERT: u16 = 0xC3;
const DML_DELETE: u16 = 0xC4;
const DML_UPDATE: u16 = 0xC5;
const DML_MERGE: u16 = 0x117;

fn send(sink: &mut dyn EventSink, event: ExecEvent) -> Result<(), Fail> {
    sink.send(event).map_err(Fail::Sink)
}

fn flush(sink: &mut dyn EventSink, index: usize, buf: &mut Vec<Vec<Value>>) -> Result<(), Fail> {
    if buf.is_empty() {
        return Ok(());
    }
    send(sink, ExecEvent::Rows { index, rows: std::mem::take(buf) })
}

#[async_trait]
impl Session for MssqlSession {
    async fn server_info(&mut self) -> DbResult<ServerInfo> {
        let row = self
            .client
            .simple_query(
                "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), \
                 DB_NAME(), SUSER_SNAME()",
            )
            .await
            .map_err(|e| describe(&e))?
            .into_row()
            .await
            .map_err(|e| describe(&e))?
            .ok_or("Servidor não respondeu")?;
        let text = |i: usize| row.try_get::<&str, _>(i).ok().flatten().unwrap_or("").to_string();
        let edition = text(1);
        Ok(ServerInfo {
            product: if edition.contains("Azure") { "Azure SQL".into() } else { format!("SQL Server {edition}") },
            version: text(0),
            database: text(2),
            user: text(3),
            dialect: "mssql".into(),
        })
    }

    async fn execute(&mut self, sql: &str, sink: &mut dyn EventSink, max_rows: Option<u64>) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let mut summary = ExecSummary::default();
        match self.stream(sql, sink, max_rows, &mut summary).await {
            Ok(affected) => summary.rows_affected = affected,
            Err(e) => return Err(self.fail(e)),
        }
        summary.elapsed_ms = started.elapsed().as_millis() as u64;
        summary.tran_count = self.tran_count().await.unwrap_or(0);
        Ok(summary)
    }

    async fn cancel(&mut self) {
        // O Attention do tiberius não drena com segurança uma resposta interrompida no meio
        // (a conexão fica dessincronizada). Fechar o socket é o cancelamento confiável: o
        // servidor aborta o lote e desfaz a transação aberta; a sessão é reaberta no próximo uso.
        self.broken = true;
    }

    fn is_broken(&self) -> bool {
        self.broken
    }

    async fn apply(&mut self, statements: &[String], atomic: bool) -> DbResult<Vec<u64>> {
        let own_tx = atomic && self.tran_count().await? == 0;
        if own_tx {
            self.batch("BEGIN TRANSACTION").await?;
        }
        let mut affected = Vec::with_capacity(statements.len());
        for (i, sql) in statements.iter().enumerate() {
            match self.client.execute(sql.as_str(), &[]).await {
                Ok(res) => affected.push(res.total()),
                Err(e) => {
                    let msg = self.fail(Fail::Db(e));
                    if own_tx && !self.broken {
                        let _ = self.batch("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await;
                    }
                    return Err(format!("Comando {} de {}: {msg}", i + 1, statements.len()));
                }
            }
        }
        if own_tx {
            self.batch("COMMIT TRANSACTION").await?;
        }
        Ok(affected)
    }

    async fn introspect(&mut self, path: &ObjectPath) -> DbResult<Vec<ObjectNode>> {
        mssql_meta::introspect(&mut self.client, path).await
    }

    async fn table_info(&mut self, schema: &str, name: &str) -> DbResult<TableInfo> {
        mssql_meta::table_info(&mut self.client, schema, name).await
    }

    async fn ddl(&mut self, path: &ObjectPath) -> DbResult<String> {
        mssql_meta::ddl(&mut self.client, path).await
    }

    async fn table_schema(&mut self, schema: &str, name: &str) -> DbResult<TableSchema> {
        mssql_meta::table_schema(&mut self.client, schema, name).await
    }

    async fn begin(&mut self) -> DbResult<u32> {
        self.batch("BEGIN TRANSACTION").await?;
        self.tran_count().await
    }

    async fn commit(&mut self) -> DbResult<u32> {
        self.batch("IF @@TRANCOUNT > 0 COMMIT TRANSACTION").await?;
        self.tran_count().await
    }

    async fn rollback(&mut self) -> DbResult<u32> {
        self.batch("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await?;
        self.tran_count().await
    }

    async fn close(self: Box<Self>) {
        let _ = self.client.close().await;
    }
}

// ---------- Tipos ----------

fn column_meta(name: &str, ty: ColumnType) -> ColumnMeta {
    let (type_name, kind) = match ty {
        ColumnType::Bit | ColumnType::Bitn => ("bit", "bool"),
        ColumnType::Int1 => ("tinyint", "int"),
        ColumnType::Int2 => ("smallint", "int"),
        ColumnType::Int4 | ColumnType::Intn => ("int", "int"),
        ColumnType::Int8 => ("bigint", "int"),
        ColumnType::Float4 => ("real", "num"),
        ColumnType::Float8 | ColumnType::Floatn => ("float", "num"),
        ColumnType::Money | ColumnType::Money4 => ("money", "dec"),
        ColumnType::Decimaln | ColumnType::Numericn => ("decimal", "dec"),
        ColumnType::Datetime | ColumnType::Datetimen => ("datetime", "datetime"),
        ColumnType::Datetime4 => ("smalldatetime", "datetime"),
        ColumnType::Datetime2 => ("datetime2", "datetime"),
        ColumnType::DatetimeOffsetn => ("datetimeoffset", "datetime"),
        ColumnType::Daten => ("date", "date"),
        ColumnType::Timen => ("time", "time"),
        ColumnType::Guid => ("uniqueidentifier", "guid"),
        ColumnType::BigVarChar => ("varchar", "str"),
        ColumnType::BigChar => ("char", "str"),
        ColumnType::NVarchar => ("nvarchar", "str"),
        ColumnType::NChar => ("nchar", "str"),
        ColumnType::Text => ("text", "str"),
        ColumnType::NText => ("ntext", "str"),
        ColumnType::Xml => ("xml", "xml"),
        ColumnType::BigVarBin => ("varbinary", "bin"),
        ColumnType::BigBinary => ("binary", "bin"),
        ColumnType::Image => ("image", "bin"),
        ColumnType::Udt => ("udt", "other"),
        ColumnType::SSVariant => ("sql_variant", "other"),
        ColumnType::Null => ("null", "other"),
    };
    ColumnMeta { name: name.to_string(), type_name: type_name.into(), kind }
}

const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

fn float(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        Value::String(v.to_string())
    }
}

/// Converte uma célula para JSON sem perder precisão: inteiros grandes e decimais viram string.
pub fn cell(data: &ColumnData<'static>) -> Value {
    match data {
        ColumnData::U8(v) => v.map_or(Value::Null, |v| json!(v)),
        ColumnData::I16(v) => v.map_or(Value::Null, |v| json!(v)),
        ColumnData::I32(v) => v.map_or(Value::Null, |v| json!(v)),
        ColumnData::I64(v) => v.map_or(Value::Null, |v| if v.abs() <= MAX_SAFE_INT { json!(v) } else { Value::String(v.to_string()) }),
        ColumnData::F32(v) => v.map_or(Value::Null, |v| float(v as f64)),
        ColumnData::F64(v) => v.map_or(Value::Null, float),
        ColumnData::Bit(v) => v.map_or(Value::Null, Value::Bool),
        ColumnData::String(v) => v.as_ref().map_or(Value::Null, |s| Value::String(s.to_string())),
        ColumnData::Guid(v) => v.map_or(Value::Null, |g| Value::String(g.to_string().to_uppercase())),
        ColumnData::Binary(v) => v.as_ref().map_or(Value::Null, |b| Value::String(hex(b))),
        ColumnData::Numeric(v) => v.map_or(Value::Null, |n| {
            Value::String(if n.scale() == 0 { n.value().to_string() } else { n.to_string() })
        }),
        ColumnData::Xml(v) => v.as_ref().map_or(Value::Null, |x| Value::String(x.to_string())),
        // Mesma precisão que o SQL Server exibe: datetime com 3 casas, datetime2/time/offset com 7.
        ColumnData::DateTime(_) => date_value::<chrono::NaiveDateTime>(data, "%Y-%m-%d %H:%M:%S%.3f", 0),
        ColumnData::SmallDateTime(_) => date_value::<chrono::NaiveDateTime>(data, "%Y-%m-%d %H:%M:%S", 0),
        ColumnData::DateTime2(_) => date_value::<chrono::NaiveDateTime>(data, "%Y-%m-%d %H:%M:%S%.9f", 2),
        ColumnData::Date(_) => date_value::<chrono::NaiveDate>(data, "%Y-%m-%d", 0),
        ColumnData::Time(_) => date_value::<chrono::NaiveTime>(data, "%H:%M:%S%.9f", 2),
        ColumnData::DateTimeOffset(_) => date_value::<chrono::DateTime<chrono::FixedOffset>>(data, "%Y-%m-%d %H:%M:%S%.9f %:z", 2),
    }
}

trait Fmt {
    fn fmt_with(&self, f: &str) -> String;
}
impl Fmt for chrono::NaiveDateTime {
    fn fmt_with(&self, f: &str) -> String {
        self.format(f).to_string()
    }
}
impl Fmt for chrono::NaiveDate {
    fn fmt_with(&self, f: &str) -> String {
        self.format(f).to_string()
    }
}
impl Fmt for chrono::NaiveTime {
    fn fmt_with(&self, f: &str) -> String {
        self.format(f).to_string()
    }
}
impl Fmt for chrono::DateTime<chrono::FixedOffset> {
    fn fmt_with(&self, f: &str) -> String {
        self.format(f).to_string()
    }
}

/// `trim_ns`: dígitos a cortar das 9 casas de nanossegundos (2 → 7 casas, como o datetime2(7)).
fn date_value<'a, T: FromSql<'a> + Fmt>(data: &'a ColumnData<'static>, fmt: &str, trim_ns: usize) -> Value {
    match T::from_sql(data) {
        Ok(Some(v)) => {
            let mut s = v.fmt_with(fmt);
            if trim_ns > 0 {
                // A fração fica logo depois do primeiro "." (o offset vem depois de um espaço).
                if let Some(dot) = s.find('.') {
                    let end = dot + 10;
                    if end <= s.len() {
                        s.replace_range(end - trim_ns..end, "");
                    }
                }
            }
            Value::String(s)
        }
        Ok(None) => Value::Null,
        Err(e) => Value::String(format!("<{e}>")),
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let shown = &bytes[..bytes.len().min(BINARY_PREVIEW)];
    let mut s = String::with_capacity(2 + shown.len() * 2 + 1);
    s.push_str("0x");
    for b in shown {
        let _ = write!(s, "{b:02X}");
    }
    if bytes.len() > BINARY_PREVIEW {
        s.push('…');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dml_commands() {
        assert!(is_dml_command(0xC5) && is_dml_command(0xC3) && is_dml_command(0xC4) && is_dml_command(0x117));
        assert!(!is_dml_command(0xC1));
    }

    #[test]
    fn hex_is_truncated() {
        assert_eq!(hex(&[0xAB, 0x01]), "0xAB01");
        assert!(hex(&vec![0u8; BINARY_PREVIEW + 1]).ends_with('…'));
    }

    #[test]
    fn numeric_cells_keep_precision() {
        let n = tiberius::numeric::Numeric::new_with_scale(12345678901234567890, 2);
        assert_eq!(cell(&ColumnData::Numeric(Some(n))), json!("123456789012345678.90"));
        let big = ColumnData::I64(Some(9_007_199_254_740_993));
        assert_eq!(cell(&big), json!("9007199254740993"));
        assert_eq!(cell(&ColumnData::I32(None)), Value::Null);
    }
}

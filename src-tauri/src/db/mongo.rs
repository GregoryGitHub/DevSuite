//! Driver MongoDB (Atlas, servidor/replica set, Azure Cosmos DB API Mongo).
//!
//! O frontend interpreta a sintaxe do mongosh (`src/js/utils/mongoShell.js`) e envia a operação
//! como JSON ([`Op`]) com valores em Extended JSON (`{"$oid": ...}`, `{"$date": ...}`...).
//! Os documentos voltam em Extended JSON relaxado pelo evento [`ExecEvent::Docs`].

use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bson::{doc, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::options::{ClientOptions, Credential, Tls, TlsOptions};
use mongodb::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use super::driver::*;

const FIRST_BATCH: usize = 100;
const BATCH: usize = 500;
/// Documentos lidos para descobrir os campos de uma coleção.
const SAMPLE: i64 = 200;

pub struct MongoDriver;

/// Um `Client` (pool de conexões) por conexão salva, compartilhado entre as sessões dela.
/// É recriado quando a configuração ou a senha mudam (impressão digital diferente).
fn clients() -> &'static Mutex<HashMap<String, (u64, Client)>> {
    static CLIENTS: OnceLock<Mutex<HashMap<String, (u64, Client)>>> = OnceLock::new();
    CLIENTS.get_or_init(Default::default)
}

fn fingerprint(cfg: &ConnConfig, password: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&cfg.uri, &cfg.auth.user, password, cfg.tls_insecure, cfg.connect_timeout_s).hash(&mut h);
    h.finish()
}

async fn client_for(cfg: &ConnConfig, password: &str) -> DbResult<Client> {
    let fp = fingerprint(cfg, password);
    if let Some((f, c)) = clients().lock().unwrap().get(&cfg.id) {
        if *f == fp {
            return Ok(c.clone());
        }
    }
    let uri = cfg.uri.trim();
    if !(uri.starts_with("mongodb://") || uri.starts_with("mongodb+srv://")) {
        return Err("Informe a connection string (mongodb:// ou mongodb+srv://)".into());
    }
    let timeout = Duration::from_secs(cfg.connect_timeout_s.clamp(1, 300));
    let mut opts = tokio::time::timeout(timeout, ClientOptions::parse(uri))
        .await
        .map_err(|_| "Tempo esgotado resolvendo a connection string (DNS do mongodb+srv)".to_string())?
        .map_err(|e| format!("Connection string inválida: {e}"))?;
    opts.app_name = Some("Dev Suite".into());
    opts.connect_timeout = Some(timeout);
    opts.server_selection_timeout = Some(timeout);
    if !password.is_empty() {
        match opts.credential.as_mut() {
            Some(c) => c.password = Some(password.to_string()),
            None => {
                let user = cfg.auth.user.trim();
                if !user.is_empty() {
                    opts.credential = Some(Credential::builder().username(user.to_string()).password(password.to_string()).build());
                }
            }
        }
    }
    if cfg.tls_insecure {
        let mut tls = match opts.tls.take() {
            Some(Tls::Enabled(t)) => t,
            _ => TlsOptions::default(),
        };
        tls.allow_invalid_certificates = Some(true);
        opts.tls = Some(Tls::Enabled(tls));
    }
    let client = Client::with_options(opts).map_err(|e| e.to_string())?;
    // Valida servidor e credenciais agora (o driver é preguiçoso).
    client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .await
        .map_err(|e| describe(&e))?;
    clients().lock().unwrap().insert(cfg.id.clone(), (fp, client.clone()));
    Ok(client)
}

/// Mensagem legível: o driver costuma embrulhar a causa útil em vários níveis.
fn describe(e: &mongodb::error::Error) -> String {
    let s = e.to_string();
    let s = s.strip_prefix("Kind: ").unwrap_or(&s);
    let s = s.split(", labels:").next().unwrap_or(s);
    if s.contains("Server selection timeout") {
        format!("Não foi possível alcançar o servidor (seleção de servidor esgotou o tempo). Verifique host, rede/firewall e a lista de IPs liberados no Atlas/Cosmos. Detalhe: {s}")
    } else {
        s.to_string()
    }
}

#[async_trait]
impl Driver for MongoDriver {
    async fn connect(&self, cfg: &ConnConfig, database: &str, secret: Secret) -> DbResult<Box<dyn Session>> {
        let password = match secret {
            Secret::Password(p) => p,
            Secret::AccessToken(_) => return Err("MongoDB usa usuário e senha (SCRAM) na connection string".into()),
        };
        let client = client_for(cfg, &password).await?;
        let db = if !database.is_empty() {
            database.to_string()
        } else if !cfg.database.is_empty() {
            cfg.database.clone()
        } else {
            client.default_database().map(|d| d.name().to_string()).unwrap_or_else(|| "test".into())
        };
        Ok(Box::new(MongoSession { client, db, user: cfg.auth.user.clone(), host: cfg.uri.clone() }))
    }
}

pub struct MongoSession {
    client: Client,
    db: String,
    user: String,
    host: String,
}

/// Operação montada pelo frontend a partir da sintaxe do mongosh.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    Find {
        collection: String,
        #[serde(default)]
        filter: Value,
        #[serde(default)]
        projection: Option<Value>,
        #[serde(default)]
        sort: Option<Value>,
        #[serde(default)]
        skip: Option<u64>,
        #[serde(default)]
        limit: Option<i64>,
    },
    Aggregate {
        collection: String,
        pipeline: Vec<Value>,
    },
    CountDocuments {
        collection: String,
        #[serde(default)]
        filter: Value,
    },
    EstimatedDocumentCount {
        collection: String,
    },
    Distinct {
        collection: String,
        field: String,
        #[serde(default)]
        filter: Value,
    },
    InsertOne {
        collection: String,
        document: Value,
    },
    InsertMany {
        collection: String,
        documents: Vec<Value>,
    },
    UpdateOne {
        collection: String,
        filter: Value,
        update: Value,
        #[serde(default)]
        upsert: bool,
    },
    UpdateMany {
        collection: String,
        filter: Value,
        update: Value,
        #[serde(default)]
        upsert: bool,
    },
    ReplaceOne {
        collection: String,
        filter: Value,
        replacement: Value,
        #[serde(default)]
        upsert: bool,
    },
    DeleteOne {
        collection: String,
        filter: Value,
    },
    DeleteMany {
        collection: String,
        filter: Value,
    },
    CreateIndex {
        collection: String,
        keys: Value,
        #[serde(default)]
        options: Option<Value>,
    },
    DropIndex {
        collection: String,
        name: String,
    },
    GetIndexes {
        collection: String,
    },
    Drop {
        collection: String,
    },
    CreateCollection {
        name: String,
        #[serde(default)]
        options: Option<Value>,
    },
    ListCollections,
    ListDatabases,
    RunCommand {
        command: Value,
        #[serde(default)]
        admin: bool,
    },
}


fn parse_op(text: &str) -> DbResult<Op> {
    serde_json::from_str(text).map_err(|e| format!("Operação MongoDB inválida: {e}"))
}

/// Extended JSON → documento BSON (null/ausente = documento vazio).
fn to_doc(v: Value) -> DbResult<Document> {
    match v {
        Value::Null => Ok(Document::new()),
        Value::Object(map) => Document::try_from(map).map_err(|e| format!("Documento inválido: {e}")),
        other => Err(format!("Esperava um documento {{...}}, recebi {other}")),
    }
}

fn opt_doc(v: Option<Value>) -> DbResult<Option<Document>> {
    v.filter(|v| !v.is_null()).map(to_doc).transpose()
}

/// Documento BSON → Extended JSON relaxado (o que o grid mostra), exceto `long` e `double`
/// inteiros, que vão na forma canônica: em JS viram `number` e a edição trocaria o tipo.
pub fn doc_json(d: Document) -> Value {
    bson_json(Bson::Document(d))
}

pub fn bson_json(b: Bson) -> Value {
    match b {
        Bson::Document(d) => Value::Object(d.into_iter().map(|(k, v)| (k, bson_json(v))).collect()),
        Bson::Array(a) => Value::Array(a.into_iter().map(bson_json).collect()),
        Bson::Int64(n) => json!({ "$numberLong": n.to_string() }),
        Bson::Double(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 => json!({ "$numberDouble": format!("{f:.1}") }),
        other => other.into_relaxed_extjson(),
    }
}

fn send(sink: &mut dyn EventSink, ev: ExecEvent) -> DbResult<()> {
    sink.send(ev)
}

impl MongoSession {
    fn database(&self) -> mongodb::Database {
        self.client.database(&self.db)
    }

    fn coll(&self, name: &str) -> mongodb::Collection<Document> {
        self.database().collection::<Document>(name)
    }

    /// Envia uma lista de documentos já prontos como um result set.
    fn emit(&self, sink: &mut dyn EventSink, index: usize, docs: Vec<Value>) -> DbResult<u64> {
        let n = docs.len() as u64;
        send(sink, ExecEvent::ResultStart { index, columns: Vec::new() })?;
        for chunk in docs.chunks(BATCH) {
            send(sink, ExecEvent::Docs { index, docs: chunk.to_vec() })?;
        }
        send(sink, ExecEvent::ResultEnd { index, row_count: n, truncated: false })?;
        Ok(n)
    }

    /// Lê um cursor em lotes; passado `max_rows`, para de ler (o cursor é encerrado ao ser descartado).
    async fn stream(&self, mut cursor: mongodb::Cursor<Document>, sink: &mut dyn EventSink, max_rows: Option<u64>) -> DbResult<bool> {
        send(sink, ExecEvent::ResultStart { index: 0, columns: Vec::new() })?;
        let mut buf = Vec::new();
        let mut count = 0u64;
        let mut first = true;
        let mut truncated = false;
        while let Some(d) = cursor.try_next().await.map_err(|e| describe(&e))? {
            if max_rows.is_some_and(|m| count >= m) {
                truncated = true;
                break;
            }
            buf.push(doc_json(d));
            count += 1;
            if buf.len() >= if first { FIRST_BATCH } else { BATCH } {
                first = false;
                send(sink, ExecEvent::Docs { index: 0, docs: std::mem::take(&mut buf) })?;
            }
        }
        if !buf.is_empty() {
            send(sink, ExecEvent::Docs { index: 0, docs: buf })?;
        }
        send(sink, ExecEvent::ResultEnd { index: 0, row_count: count, truncated })?;
        Ok(truncated)
    }

    async fn command(&self, cmd: Document, admin: bool) -> DbResult<Document> {
        let db = if admin { self.client.database("admin") } else { self.database() };
        db.run_command(cmd).await.map_err(|e| describe(&e))
    }

    async fn first_batch(&self, cmd: Document) -> DbResult<Vec<Document>> {
        let res = self.command(cmd, false).await?;
        let batch = res
            .get_document("cursor")
            .ok()
            .and_then(|c| c.get_array("firstBatch").ok())
            .cloned()
            .unwrap_or_default();
        Ok(batch.into_iter().filter_map(|b| b.as_document().cloned()).collect())
    }

    /// Coleções com `options` (usadas no DDL). Usuário sem a ação listCollections no banco
    /// (só privilégios por coleção) recebe Unauthorized: `authorizedCollections` só vale com
    /// `nameOnly: true`, que ainda traz `name` e `type` (como faz o Compass).
    async fn collections(&self) -> DbResult<Vec<Document>> {
        match self
            .first_batch(doc! { "listCollections": 1, "authorizedCollections": true, "nameOnly": false, "cursor": { "batchSize": 100_000 } })
            .await
        {
            Ok(list) => Ok(list),
            Err(full) => self
                .first_batch(doc! { "listCollections": 1, "authorizedCollections": true, "nameOnly": true, "cursor": { "batchSize": 100_000 } })
                .await
                .map_err(|_| full),
        }
    }

    async fn indexes(&self, coll: &str) -> DbResult<Vec<Document>> {
        self.first_batch(doc! { "listIndexes": coll, "cursor": { "batchSize": 10_000 } }).await
    }

    /// Campos encontrados numa amostra da coleção, com os tipos BSON vistos em cada um.
    async fn sample_fields(&self, coll: &str) -> DbResult<Vec<(String, Vec<&'static str>)>> {
        let mut cursor = self
            .coll(coll)
            .find(Document::new())
            .sort(doc! { "$natural": -1 })
            .limit(SAMPLE)
            .await
            .map_err(|e| describe(&e))?;
        let mut order: Vec<String> = vec!["_id".into()];
        let mut types: HashMap<String, BTreeMap<&'static str, ()>> = HashMap::new();
        while let Some(d) = cursor.try_next().await.map_err(|e| describe(&e))? {
            for (k, v) in d {
                if !order.contains(&k) {
                    order.push(k.clone());
                }
                types.entry(k).or_default().insert(type_name(&v), ());
            }
        }
        Ok(order
            .into_iter()
            .filter_map(|k| types.remove(&k).map(|t| (k, t.into_keys().collect())))
            .collect())
    }
}

pub fn type_name(v: &Bson) -> &'static str {
    match v {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Decimal128(_) => "decimal",
        Bson::Symbol(_) => "symbol",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// Classe usada pelo grid para um conjunto de tipos BSON.
fn kind_of(types: &[&str]) -> &'static str {
    let real: Vec<&&str> = types.iter().filter(|t| **t != "null").collect();
    match real.as_slice() {
        [t] => match **t {
            "int" | "long" => "int",
            "double" => "num",
            "decimal" => "dec",
            "bool" => "bool",
            "string" => "str",
            "date" => "datetime",
            "objectId" => "oid",
            "object" | "array" => "json",
            "binData" => "bin",
            _ => "other",
        },
        _ if real.iter().all(|t| matches!(**t, "int" | "long" | "double" | "decimal")) && !real.is_empty() => "num",
        _ => "other",
    }
}

/// Resumo de uma escrita como documento (para mostrar no console).
fn write_doc(pairs: Vec<(&str, Bson)>) -> Value {
    let mut d = Document::new();
    d.insert("acknowledged", true);
    for (k, v) in pairs {
        d.insert(k, v);
    }
    doc_json(d)
}

#[async_trait]
impl Session for MongoSession {
    async fn server_info(&mut self) -> DbResult<ServerInfo> {
        let build = self.command(doc! { "buildInfo": 1 }, true).await.unwrap_or_default();
        let version = build.get_str("version").unwrap_or("").to_string();
        let host = self.host.to_ascii_lowercase();
        let product = if host.contains("cosmos.azure.com") || host.contains("documents.azure.com") {
            "Azure Cosmos DB (MongoDB)"
        } else if host.contains(".mongodb.net") {
            "MongoDB Atlas"
        } else {
            "MongoDB"
        };
        Ok(ServerInfo { product: product.into(), version, database: self.db.clone(), user: self.user.clone(), dialect: "mongo".into() })
    }

    async fn execute(&mut self, text: &str, sink: &mut dyn EventSink, max_rows: Option<u64>) -> DbResult<ExecSummary> {
        let started = Instant::now();
        let op = parse_op(text)?;
        let mut s = ExecSummary { result_sets: 1, ..Default::default() };
        match op {
            Op::Find { collection, filter, projection, sort, skip, limit } => {
                // Limite do usuário vence; senão o limite do console evita trazer a coleção inteira.
                let effective = match (limit, max_rows) {
                    (Some(l), _) if l > 0 => Some(l),
                    (_, Some(m)) => Some(m as i64 + 1),
                    _ => None,
                };
                let coll = self.coll(&collection);
                let mut find = coll.find(to_doc(filter)?);
                if let Some(p) = opt_doc(projection)? {
                    find = find.projection(p);
                }
                if let Some(o) = opt_doc(sort)? {
                    find = find.sort(o);
                }
                if let Some(k) = skip {
                    find = find.skip(k);
                }
                if let Some(l) = effective {
                    find = find.limit(l);
                }
                let cursor = find.await.map_err(|e| describe(&e))?;
                let user_limited = limit.is_some_and(|l| l > 0);
                s.truncated = self.stream(cursor, sink, if user_limited { None } else { max_rows }).await?;
            }
            Op::Aggregate { collection, pipeline } => {
                let stages = pipeline.into_iter().map(to_doc).collect::<DbResult<Vec<_>>>()?;
                let cursor = self.coll(&collection).aggregate(stages).await.map_err(|e| describe(&e))?;
                s.truncated = self.stream(cursor, sink, max_rows).await?;
            }
            Op::CountDocuments { collection, filter } => {
                let n = self.coll(&collection).count_documents(to_doc(filter)?).await.map_err(|e| describe(&e))?;
                self.emit(sink, 0, vec![json!({ "count": n })])?;
            }
            Op::EstimatedDocumentCount { collection } => {
                let n = self.coll(&collection).estimated_document_count().await.map_err(|e| describe(&e))?;
                self.emit(sink, 0, vec![json!({ "count": n })])?;
            }
            Op::Distinct { collection, field, filter } => {
                let values = self.coll(&collection).distinct(&field, to_doc(filter)?).await.map_err(|e| describe(&e))?;
                let docs = values.into_iter().map(|v| json!({ "value": bson_json(v) })).collect();
                self.emit(sink, 0, docs)?;
            }
            Op::InsertOne { collection, document } => {
                let r = self.coll(&collection).insert_one(to_doc(document)?).await.map_err(|e| describe(&e))?;
                s.rows_affected = Some(1);
                self.emit(sink, 0, vec![write_doc(vec![("insertedId", r.inserted_id)])])?;
            }
            Op::InsertMany { collection, documents } => {
                let docs = documents.into_iter().map(to_doc).collect::<DbResult<Vec<_>>>()?;
                let r = self.coll(&collection).insert_many(docs).await.map_err(|e| describe(&e))?;
                s.rows_affected = Some(r.inserted_ids.len() as u64);
                let ids: Vec<Bson> = {
                    let mut v: Vec<(usize, Bson)> = r.inserted_ids.into_iter().collect();
                    v.sort_by_key(|(i, _)| *i);
                    v.into_iter().map(|(_, id)| id).collect()
                };
                self.emit(sink, 0, vec![write_doc(vec![("insertedIds", Bson::Array(ids))])])?;
            }
            op @ (Op::UpdateOne { .. } | Op::UpdateMany { .. }) => {
                let (many, collection, filter, update, upsert) = match op {
                    Op::UpdateOne { collection, filter, update, upsert } => (false, collection, filter, update, upsert),
                    Op::UpdateMany { collection, filter, update, upsert } => (true, collection, filter, update, upsert),
                    _ => unreachable!(),
                };
                let filter = to_doc(filter)?;
                let coll = self.coll(&collection);
                let r = match update {
                    // Pipeline de atualização: [{ $set: ... }, ...]
                    Value::Array(stages) => {
                        let stages = stages.into_iter().map(to_doc).collect::<DbResult<Vec<_>>>()?;
                        if many { coll.update_many(filter, stages).upsert(upsert).await } else { coll.update_one(filter, stages).upsert(upsert).await }
                    }
                    other => {
                        let u = to_doc(other)?;
                        if many { coll.update_many(filter, u).upsert(upsert).await } else { coll.update_one(filter, u).upsert(upsert).await }
                    }
                }
                .map_err(|e| describe(&e))?;
                s.rows_affected = Some(r.modified_count);
                let mut pairs = vec![("matchedCount", Bson::Int64(r.matched_count as i64)), ("modifiedCount", Bson::Int64(r.modified_count as i64))];
                if let Some(id) = r.upserted_id {
                    pairs.push(("upsertedId", id));
                }
                self.emit(sink, 0, vec![write_doc(pairs)])?;
            }
            Op::ReplaceOne { collection, filter, replacement, upsert } => {
                let r = self
                    .coll(&collection)
                    .replace_one(to_doc(filter)?, to_doc(replacement)?)
                    .upsert(upsert)
                    .await
                    .map_err(|e| describe(&e))?;
                s.rows_affected = Some(r.modified_count);
                self.emit(sink, 0, vec![write_doc(vec![("matchedCount", Bson::Int64(r.matched_count as i64)), ("modifiedCount", Bson::Int64(r.modified_count as i64))])])?;
            }
            Op::DeleteOne { collection, filter } => {
                let r = self.coll(&collection).delete_one(to_doc(filter)?).await.map_err(|e| describe(&e))?;
                s.rows_affected = Some(r.deleted_count);
                self.emit(sink, 0, vec![write_doc(vec![("deletedCount", Bson::Int64(r.deleted_count as i64))])])?;
            }
            Op::DeleteMany { collection, filter } => {
                let r = self.coll(&collection).delete_many(to_doc(filter)?).await.map_err(|e| describe(&e))?;
                s.rows_affected = Some(r.deleted_count);
                self.emit(sink, 0, vec![write_doc(vec![("deletedCount", Bson::Int64(r.deleted_count as i64))])])?;
            }
            Op::CreateIndex { collection, keys, options } => {
                let mut index = opt_doc(options)?.unwrap_or_default();
                let keys = to_doc(keys)?;
                if !index.contains_key("name") {
                    let name: Vec<String> = keys.iter().map(|(k, v)| format!("{k}_{}", v.to_string().trim_matches('"'))).collect();
                    index.insert("name", name.join("_"));
                }
                index.insert("key", keys);
                let r = self.command(doc! { "createIndexes": &collection, "indexes": [index] }, false).await?;
                self.emit(sink, 0, vec![doc_json(r)])?;
            }
            Op::DropIndex { collection, name } => {
                let r = self.command(doc! { "dropIndexes": &collection, "index": name }, false).await?;
                self.emit(sink, 0, vec![doc_json(r)])?;
            }
            Op::GetIndexes { collection } => {
                let docs = self.indexes(&collection).await?.into_iter().map(doc_json).collect();
                self.emit(sink, 0, docs)?;
            }
            Op::Drop { collection } => {
                self.coll(&collection).drop().await.map_err(|e| describe(&e))?;
                self.emit(sink, 0, vec![json!({ "dropped": collection })])?;
            }
            Op::CreateCollection { name, options } => {
                let mut cmd = doc! { "create": &name };
                if let Some(o) = opt_doc(options)? {
                    cmd.extend(o);
                }
                let r = self.command(cmd, false).await?;
                self.emit(sink, 0, vec![doc_json(r)])?;
            }
            Op::ListCollections => {
                let docs = self
                    .collections()
                    .await?
                    .into_iter()
                    .map(|d| json!({ "name": d.get_str("name").unwrap_or(""), "type": d.get_str("type").unwrap_or("collection") }))
                    .collect();
                self.emit(sink, 0, docs)?;
            }
            Op::ListDatabases => {
                let r = self.command(doc! { "listDatabases": 1, "authorizedDatabases": true }, true).await?;
                let docs = r.get_array("databases").cloned().unwrap_or_default().into_iter().map(bson_json).collect();
                self.emit(sink, 0, docs)?;
            }
            Op::RunCommand { command, admin } => {
                let r = self.command(to_doc(command)?, admin).await?;
                self.emit(sink, 0, vec![doc_json(r)])?;
            }
        }
        s.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(s)
    }

    async fn cancel(&mut self) {
        // Descartar o future encerra o cursor no servidor; o pool continua utilizável.
    }

    fn is_broken(&self) -> bool {
        false
    }

    async fn apply(&mut self, statements: &[String], _atomic: bool) -> DbResult<Vec<u64>> {
        // Sem transação (exigiria replica set e o Cosmos limita): aplica em ordem e para no primeiro erro.
        struct Discard;
        impl EventSink for Discard {
            fn send(&mut self, _: ExecEvent) -> DbResult<()> {
                Ok(())
            }
        }
        let mut out = Vec::with_capacity(statements.len());
        for (i, text) in statements.iter().enumerate() {
            match self.execute(text, &mut Discard, None).await {
                Ok(s) => out.push(s.rows_affected.unwrap_or(0)),
                Err(e) => {
                    return Err(format!(
                        "Operação {} de {}: {e}{}",
                        i + 1,
                        statements.len(),
                        if i > 0 { format!(" (as {i} anteriores já foram gravadas)") } else { String::new() }
                    ))
                }
            }
        }
        Ok(out)
    }

    async fn introspect(&mut self, path: &ObjectPath) -> DbResult<Vec<ObjectNode>> {
        match path.kind.as_str() {
            "databases" => {
                let names = match self.client.list_database_names().await {
                    Ok(n) => n,
                    // Usuário sem listDatabases: mostra só o banco da conexão.
                    Err(_) => vec![self.db.clone()],
                };
                Ok(names
                    .into_iter()
                    .map(|n| ObjectNode { kind: "database".into(), flag: n == self.db, name: n, ..Default::default() })
                    .collect())
            }
            "collections" => {
                let mut list: Vec<ObjectNode> = self
                    .collections()
                    .await?
                    .into_iter()
                    .filter_map(|d| {
                        let name = d.get_str("name").ok()?.to_string();
                        if name.starts_with("system.") {
                            return None;
                        }
                        let kind = if d.get_str("type").unwrap_or("collection") == "view" { "view" } else { "collection" };
                        Some(ObjectNode { kind: kind.into(), name, ..Default::default() })
                    })
                    .collect();
                list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                Ok(list)
            }
            "collection" | "view" => {
                let mut out: Vec<ObjectNode> = self
                    .sample_fields(&path.name)
                    .await?
                    .into_iter()
                    .map(|(name, types)| ObjectNode { kind: "field".into(), flag: name == "_id", detail: types.join(" | "), name, ..Default::default() })
                    .collect();
                if path.kind == "collection" {
                    for ix in self.indexes(&path.name).await.unwrap_or_default() {
                        let key = ix.get_document("key").map(|k| Bson::Document(k.clone()).into_relaxed_extjson().to_string()).unwrap_or_default();
                        out.push(ObjectNode {
                            kind: "index".into(),
                            name: ix.get_str("name").unwrap_or("").to_string(),
                            detail: key,
                            flag: ix.get_bool("unique").unwrap_or(false),
                            ..Default::default()
                        });
                    }
                }
                Ok(out)
            }
            other => Err(format!("Nó desconhecido no MongoDB: {other}")),
        }
    }

    async fn table_info(&mut self, _schema: &str, name: &str) -> DbResult<TableInfo> {
        let fields = self.sample_fields(name).await?;
        let estimate = self.coll(name).estimated_document_count().await.ok().map(|n| n as i64);
        Ok(TableInfo {
            schema: self.db.clone(),
            name: name.to_string(),
            kind: "collection".into(),
            columns: fields
                .into_iter()
                .map(|(n, types)| TableColumn {
                    is_pk: n == "_id",
                    nullable: n != "_id",
                    full_type: types.join(" | "),
                    type_name: kind_of(&types).to_string(),
                    name: n,
                    ..Default::default()
                })
                .collect(),
            row_estimate: estimate,
        })
    }

    async fn ddl(&mut self, path: &ObjectPath) -> DbResult<String> {
        let name = &path.name;
        let spec = self.collections().await?.into_iter().find(|d| d.get_str("name").ok() == Some(name.as_str()));
        let mut out = String::new();
        let options = spec.as_ref().and_then(|d| d.get_document("options").ok()).cloned().unwrap_or_default();
        let opts = Bson::Document(options).into_relaxed_extjson();
        if opts.as_object().is_some_and(|o| !o.is_empty()) {
            out.push_str(&format!("db.createCollection({}, {});\n", json!(name), serde_json::to_string_pretty(&opts).unwrap_or_default()));
        } else {
            out.push_str(&format!("db.createCollection({});\n", json!(name)));
        }
        for ix in self.indexes(name).await.unwrap_or_default() {
            if ix.get_str("name").ok() == Some("_id_") {
                continue;
            }
            let key = ix.get_document("key").cloned().unwrap_or_default();
            let mut o = ix.clone();
            for k in ["key", "v", "ns"] {
                o.remove(k);
            }
            out.push_str(&format!(
                "db.getCollection({}).createIndex({}, {});\n",
                json!(name),
                doc_json(key),
                doc_json(o)
            ));
        }
        Ok(out)
    }

    async fn begin(&mut self) -> DbResult<u32> {
        Err("Transações manuais não são suportadas na aba MongoDB".into())
    }

    async fn commit(&mut self) -> DbResult<u32> {
        Ok(0)
    }

    async fn rollback(&mut self) -> DbResult<u32> {
        Ok(0)
    }

    async fn close(self: Box<Self>) {
        // O Client é compartilhado pela conexão (cache em `clients()`).
    }
}

/// Esquece o Client em cache (conexão editada, removida ou "Desconectar").
pub fn forget(conn_id: &str) {
    clients().lock().unwrap().remove(conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ops_with_extended_json() {
        let op = parse_op(r#"{"op":"find","collection":"users","filter":{"_id":{"$oid":"65f1a2b3c4d5e6f708192a3b"},"born":{"$gte":{"$date":"2020-01-01T00:00:00Z"}}},"sort":{"name":1},"limit":5}"#).unwrap();
        match op {
            Op::Find { filter, limit, .. } => {
                let d = to_doc(filter).unwrap();
                assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
                assert!(matches!(d.get_document("born").unwrap().get("$gte"), Some(Bson::DateTime(_))));
                assert_eq!(limit, Some(5));
            }
            other => panic!("{other:?}"),
        }
        assert!(parse_op(r#"{"op":"insertOne","collection":"c","document":{"n":{"$numberLong":"9007199254740993"}}}"#).is_ok());
        assert!(parse_op(r#"{"op":"listCollections"}"#).is_ok());
    }

    #[test]
    fn relaxed_json_keeps_types() {
        let d = doc! { "_id": bson::oid::ObjectId::parse_str("65f1a2b3c4d5e6f708192a3b").unwrap(), "n": 9_007_199_254_740_993i64, "d": bson::Decimal128::from_bytes([0; 16]) };
        let v = doc_json(d);
        assert_eq!(v["_id"], json!({ "$oid": "65f1a2b3c4d5e6f708192a3b" }));
        assert_eq!(v["n"], json!({ "$numberLong": "9007199254740993" }));
        assert!(v["d"].get("$numberDecimal").is_some());
    }

    #[test]
    fn doubles_and_longs_keep_type() {
        let v = doc_json(doc! { "a": 5.0f64, "b": 2.5f64, "c": 7i32, "d": 7i64 });
        assert_eq!(v, json!({ "a": { "$numberDouble": "5.0" }, "b": 2.5, "c": 7, "d": { "$numberLong": "7" } }));
        let back = to_doc(v).unwrap();
        assert!(matches!(back.get("a"), Some(Bson::Double(_))));
        assert!(matches!(back.get("d"), Some(Bson::Int64(7))));
    }

    #[test]
    fn kinds_from_types() {
        assert_eq!(kind_of(&["objectId"]), "oid");
        assert_eq!(kind_of(&["int", "null"]), "int");
        assert_eq!(kind_of(&["int", "double"]), "num");
        assert_eq!(kind_of(&["string", "int"]), "other");
    }
}

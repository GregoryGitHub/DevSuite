//! App "Redis": cliente para acessar, editar e depurar Redis (standalone, Cluster, Sentinel;
//! TLS e túnel SSH opcionais).
//!
//!  - `conn.rs`: montagem das conexões e sessões (uma conexão multiplexada por sessão/banco);
//!  - `value.rs`: valores RESP2/RESP3 ↔ JSON sem perder bytes (`{ t, v }`, Base64 para binário);
//!  - `ssh.rs`: túnel SSH (encaminhamento local por nó, resolvedor de nomes do driver);
//!  - `live.rs`: MONITOR e Pub/Sub em conexões dedicadas, eventos por Channel;
//!  - `analyze.rs`: análise de memória por SCAN (prefixos, tipos, TTL, maiores chaves).
//!
//! O Rust só transporta comandos: a lógica de cada tipo (ler um hash paginado, editar um
//! zset…) fica no JS (`redisModel.js`). Dados em `redis.json` (sem segredos); senhas no cofre
//! do sistema (`db:redis:<id>:<tipo>`), com cache em memória.

mod analyze;
mod conn;
mod live;
mod ssh;
mod value;

#[cfg(test)]
mod it_tests;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use tauri::ipc::Channel;
use tauri::Manager;

use crate::db::secrets;
pub use conn::{RedisConn, Secrets, ServerInfo};
use conn::{Handle, NodeInfo};
use value::{as_text, build_cmd, to_json, Arg};

type Slot = Arc<tokio::sync::Mutex<Option<Arc<Handle>>>>;

/// Conexões abertas (conn_id → handle, criado no primeiro uso).
#[derive(Default)]
pub struct RedisClients(Mutex<HashMap<String, Slot>>);

/// Segredos já lidos do cofre.
#[derive(Default)]
pub struct RedisSecrets(Mutex<HashMap<String, Secrets>>);

struct LiveCtl {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    conn_id: String,
}

/// Monitor, assinaturas e análises em andamento (id → controle).
#[derive(Default)]
pub struct RedisLive(Mutex<HashMap<u64, LiveCtl>>);

static NEXT_LIVE: AtomicU64 = AtomicU64::new(1);

const SECRET_KINDS: [&str; 4] = ["password", "sentinel_password", "ssh_password", "ssh_passphrase"];

fn secret_id(conn_id: &str) -> String {
    format!("redis:{conn_id}")
}

fn data_file(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("failed to resolve app data dir");
    let _ = fs::create_dir_all(&dir);
    if ssh::KNOWN_HOSTS.get().is_none() {
        let _ = ssh::KNOWN_HOSTS.set(dir.join("ssh_known_hosts"));
    }
    dir.join("redis.json")
}

// ---------- redis.json ----------

/// Conexões (sem segredos), interface e histórico; formato em `src/js/utils/redisModel.js`.
#[tauri::command]
pub fn load_redis_data(app: tauri::AppHandle) -> Json {
    let path = data_file(&app);
    let Ok(raw) = fs::read_to_string(&path) else {
        return Json::Null;
    };
    match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("redis.json inválido ({e}); salvando cópia em redis.json.bak");
            let _ = fs::copy(&path, path.with_extension("json.bak"));
            Json::Null
        }
    }
}

#[tauri::command]
pub fn save_redis_data(app: tauri::AppHandle, data: Json) -> Result<(), String> {
    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    crate::persist::write(data_file(&app), json);
    Ok(())
}

// ---------- Segredos ----------

fn check_kind(kind: &str) -> Result<(), String> {
    if SECRET_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err("Tipo de segredo inválido".into())
    }
}

#[tauri::command]
pub async fn redis_set_secret(app: tauri::AppHandle, conn_id: String, kind: String, value: String) -> Result<(), String> {
    check_kind(&kind)?;
    let (id, k, v) = (conn_id.clone(), kind.clone(), value.clone());
    tauri::async_runtime::spawn_blocking(move || if v.is_empty() { secrets::delete(&secret_id(&id), &k) } else { secrets::set(&secret_id(&id), &k, &v) })
        .await
        .map_err(|e| e.to_string())??;
    // A próxima conexão relê os segredos.
    app.state::<RedisSecrets>().0.lock().unwrap().remove(&conn_id);
    Ok(())
}

/// Quais segredos existem no cofre (para o diálogo mostrar "••••").
#[tauri::command]
pub async fn redis_has_secrets(conn_id: String) -> HashMap<String, bool> {
    tauri::async_runtime::spawn_blocking(move || SECRET_KINDS.iter().map(|k| (k.to_string(), matches!(secrets::get(&secret_id(&conn_id), k), Ok(Some(_))))).collect())
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn redis_forget_secrets(app: tauri::AppHandle, conn_id: String) -> Result<(), String> {
    app.state::<RedisSecrets>().0.lock().unwrap().remove(&conn_id);
    tauri::async_runtime::spawn_blocking(move || {
        for k in SECRET_KINDS {
            secrets::delete(&secret_id(&conn_id), k)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn load_secrets(app: &tauri::AppHandle, conn_id: &str) -> Result<Secrets, String> {
    if let Some(s) = app.state::<RedisSecrets>().0.lock().unwrap().get(conn_id) {
        return Ok(s.clone());
    }
    let id = conn_id.to_string();
    let s = tauri::async_runtime::spawn_blocking(move || -> Result<Secrets, String> {
        let get = |k: &str| secrets::get(&secret_id(&id), k);
        Ok(Secrets { password: get("password")?, sentinel_password: get("sentinel_password")?, ssh_password: get("ssh_password")?, ssh_passphrase: get("ssh_passphrase")? })
    })
    .await
    .map_err(|e| e.to_string())??;
    app.state::<RedisSecrets>().0.lock().unwrap().insert(conn_id.to_string(), s.clone());
    Ok(s)
}

// ---------- Conexões ----------

/// Handle da conexão: reaproveita o aberto se a configuração não mudou.
async fn handle(app: &tauri::AppHandle, conn: &RedisConn) -> Result<Arc<Handle>, String> {
    let _ = data_file(app);
    let slot = app.state::<RedisClients>().0.lock().unwrap().entry(conn.id.clone()).or_default().clone();
    let mut guard = slot.lock().await;
    if let Some(h) = guard.as_ref() {
        if h.conn == *conn {
            return Ok(h.clone());
        }
    }
    let secrets = load_secrets(app, &conn.id).await?;
    let h = Arc::new(conn::build(conn, &secrets).await?);
    *guard = Some(h.clone());
    Ok(h)
}

/// Testa a configuração do diálogo (segredos digitados valem mais que os do cofre).
#[tauri::command]
pub async fn redis_test(app: tauri::AppHandle, conn: RedisConn, secrets: Option<Secrets>) -> Result<ServerInfo, String> {
    let _ = data_file(&app);
    let saved = load_secrets(&app, &conn.id).await.unwrap_or_default();
    let given = secrets.unwrap_or_default();
    let merged = Secrets {
        password: given.password.or(saved.password),
        sentinel_password: given.sentinel_password.or(saved.sentinel_password),
        ssh_password: given.ssh_password.or(saved.ssh_password),
        ssh_passphrase: given.ssh_passphrase.or(saved.ssh_passphrase),
    };
    let h = conn::build(&conn, &merged).await?;
    let info = h.info.lock().unwrap().clone();
    Ok(info)
}

#[tauri::command]
pub async fn redis_connect(app: tauri::AppHandle, conn: RedisConn) -> Result<ServerInfo, String> {
    let h = handle(&app, &conn).await?;
    let info = h.info.lock().unwrap().clone();
    Ok(info)
}

/// Fecha a conexão inteira (sessões, túnel, monitor/assinaturas dela).
#[tauri::command]
pub async fn redis_disconnect(app: tauri::AppHandle, conn_id: String) {
    let slot = app.state::<RedisClients>().0.lock().unwrap().remove(&conn_id);
    if let Some(slot) = slot {
        if let Some(h) = slot.lock().await.take() {
            h.close_session(None).await;
        }
    }
    let state = app.state::<RedisLive>();
    let mut live = state.0.lock().unwrap();
    for ctl in live.values_mut().filter(|c| c.conn_id == conn_id) {
        if let Some(tx) = ctl.stop.take() {
            let _ = tx.send(());
        }
    }
}

/// Fecha uma sessão (console fechado ou cancelado: derruba um BLPOP pendente).
#[tauri::command]
pub async fn redis_close_session(app: tauri::AppHandle, conn_id: String, session: String) {
    let slot = app.state::<RedisClients>().0.lock().unwrap().get(&conn_id).cloned();
    if let Some(slot) = slot {
        if let Some(h) = slot.lock().await.as_ref() {
            h.close_session(Some(&session)).await;
        }
    }
}

#[tauri::command]
pub async fn redis_nodes(app: tauri::AppHandle, conn: RedisConn) -> Result<Vec<NodeInfo>, String> {
    let h = handle(&app, &conn).await?;
    conn::nodes(&h).await
}

// ---------- Comandos ----------

/// Comandos que mudam o estado da conexão compartilhada: têm tela própria.
const BLOCKED: &[(&str, &str)] = &[
    ("SUBSCRIBE", "Use a aba Pub/Sub para assinar canais."),
    ("PSUBSCRIBE", "Use a aba Pub/Sub para assinar padrões."),
    ("SSUBSCRIBE", "Use a aba Pub/Sub para assinar canais."),
    ("UNSUBSCRIBE", "Use a aba Pub/Sub."),
    ("PUNSUBSCRIBE", "Use a aba Pub/Sub."),
    ("SUNSUBSCRIBE", "Use a aba Pub/Sub."),
    ("MONITOR", "Use a aba Monitor."),
    ("SELECT", "Troque o banco no seletor do console (ou digite `use <n>`)."),
    ("QUIT", "Feche a aba ou desconecte pela barra lateral."),
    ("RESET", "Não suportado no console."),
    ("HELLO", "Não suportado no console."),
    ("SYNC", "Não suportado no console."),
    ("PSYNC", "Não suportado no console."),
];

/// Comandos com subcomando: a flag `write` é do subcomando (CONFIG SET, CLIENT KILL…).
const CONTAINERS: &[&str] = &["CONFIG", "CLIENT", "SLOWLOG", "LATENCY", "DEBUG", "CLUSTER", "ACL", "FUNCTION", "SCRIPT", "MODULE", "MEMORY", "OBJECT", "XINFO", "XGROUP", "COMMAND", "PUBSUB"];

async fn check_cmd(h: &Handle, args: &[Arg]) -> Result<(), String> {
    let name = args.first().map(|a| a.upper()).unwrap_or_default();
    if let Some((_, why)) = BLOCKED.iter().find(|(n, _)| *n == name) {
        return Err(format!("{name}: {why}"));
    }
    if name == "CLIENT" && args.get(1).map(|a| a.upper()).as_deref() == Some("REPLY") {
        return Err("CLIENT REPLY não é suportado no console.".into());
    }
    if h.conn.read_only {
        let sub = if CONTAINERS.contains(&name.as_str()) { args.get(1).map(|a| a.upper()) } else { None };
        if h.is_write(&name, sub.as_deref()).await {
            return Err(format!("{name}: conexão somente leitura (o comando altera dados ou o servidor)"));
        }
    }
    Ok(())
}

/// Um comando cru (console e operações da interface). `node`: endereço no Cluster.
#[tauri::command]
pub async fn redis_exec(app: tauri::AppHandle, conn: RedisConn, db: i64, session: String, args: Vec<Arg>, node: Option<String>) -> Result<Json, String> {
    let h = handle(&app, &conn).await?;
    check_cmd(&h, &args).await?;
    let cmd = build_cmd(&args)?;
    // Erro de resposta do servidor é um resultado (mostrado como "(error) …"); só falha de
    // conexão vira erro do comando.
    let v = h
        .with_session(&session, db, move |s| {
            Box::pin(async move {
                match s.query(cmd, &node).await {
                    Ok(v) => Ok(to_json(v)),
                    Err(e) => match value::server_error(&e) {
                        Some(text) => Ok(serde_json::json!({ "t": "err", "v": text })),
                        None => Err(e),
                    },
                }
            })
        })
        .await?;
    Ok(v)
}

/// Vários comandos de uma vez (metadados de chaves, leituras paginadas). Erro de um comando
/// vem como `{ t: "err" }` na posição dele.
#[tauri::command]
pub async fn redis_pipeline(app: tauri::AppHandle, conn: RedisConn, db: i64, session: String, cmds: Vec<Vec<Arg>>, node: Option<String>) -> Result<Vec<Json>, String> {
    let h = handle(&app, &conn).await?;
    for args in &cmds {
        check_cmd(&h, args).await?;
    }
    let built = cmds.iter().map(|a| build_cmd(a)).collect::<Result<Vec<_>, _>>()?;
    let res = h.with_session(&session, db, move |s| Box::pin(async move { s.pipeline(built, &node).await })).await?;
    Ok(res
        .into_iter()
        .map(|r| match r {
            Ok(v) => to_json(v),
            Err(e) => serde_json::json!({ "t": "err", "v": value::err_text(&e) }),
        })
        .collect())
}

#[derive(Deserialize, Debug)]
pub struct ScanSpec {
    /// Cursor opaco devolvido pela página anterior ("<nó>:<cursor>"); vazio = início.
    #[serde(default)]
    pub cursor: String,
    #[serde(default)]
    pub pattern: String,
    /// Filtro TYPE (string, hash…); vazio = todos.
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub count: u32,
    /// Quantas chaves trazer nesta página (aproximado).
    #[serde(default)]
    pub limit: u32,
}

#[derive(Serialize)]
pub struct ScanPage {
    /// null = terminou.
    cursor: Option<String>,
    /// [{ k: { t, v }, type }]
    keys: Vec<Json>,
}

/// SCAN incremental (todos os masters no Cluster) + TYPE de cada chave num pipeline.
#[tauri::command]
pub async fn redis_scan(app: tauri::AppHandle, conn: RedisConn, db: i64, spec: ScanSpec) -> Result<ScanPage, String> {
    let h = handle(&app, &conn).await?;
    let nodes = conn::masters(&h).await?;
    let (mut node_i, mut cursor) = match spec.cursor.split_once(':') {
        Some((i, c)) => (i.parse::<usize>().unwrap_or(0), c.to_string()),
        None => (0, "0".to_string()),
    };
    let count = if spec.count > 0 { spec.count } else { 1000 };
    let limit = if spec.limit > 0 { spec.limit as usize } else { 1000 };
    let mut raw: Vec<Vec<u8>> = Vec::new();
    let mut iterations = 0;
    while node_i < nodes.len() && raw.len() < limit && iterations < 200 {
        iterations += 1;
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(&cursor).arg("COUNT").arg(count);
        if !spec.pattern.is_empty() && spec.pattern != "*" {
            cmd.arg("MATCH").arg(&spec.pattern);
        }
        if !spec.kind.is_empty() {
            cmd.arg("TYPE").arg(&spec.kind);
        }
        let node = nodes[node_i].clone();
        let page = h.with_session("meta", db, move |s| Box::pin(async move { s.query(cmd, &node).await })).await?;
        let redis::Value::Array(mut parts) = page else { return Err("Resposta inesperada do SCAN".into()) };
        if let Some(redis::Value::Array(keys)) = parts.pop() {
            for k in keys {
                if let redis::Value::BulkString(b) = k {
                    raw.push(b);
                }
            }
        }
        cursor = parts.pop().and_then(|c| as_text(&c)).unwrap_or_else(|| "0".into());
        if cursor == "0" {
            node_i += 1;
        }
    }
    let next = if node_i >= nodes.len() { None } else { Some(format!("{node_i}:{cursor}")) };
    let types: Vec<Json> = if raw.is_empty() {
        vec![]
    } else if !spec.kind.is_empty() {
        raw.iter().map(|_| Json::String(spec.kind.clone())).collect()
    } else {
        let cmds = raw.iter().map(|k| redis::cmd("TYPE").arg(k.as_slice()).clone()).collect::<Vec<_>>();
        h.with_session("meta", db, move |s| Box::pin(async move { s.pipeline(cmds, &None).await }))
            .await?
            .into_iter()
            .map(|r| Json::String(r.ok().and_then(|v| as_text(&v)).unwrap_or_else(|| "?".into())))
            .collect()
    };
    let keys = raw.into_iter().zip(types).map(|(k, t)| serde_json::json!({ "k": value::bulk(k), "type": t })).collect();
    Ok(ScanPage { cursor: next, keys })
}

// ---------- Ao vivo (Monitor, Pub/Sub) e análise ----------

fn register_live(app: &tauri::AppHandle, conn_id: &str) -> (u64, tokio::sync::oneshot::Receiver<()>) {
    let id = NEXT_LIVE.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.state::<RedisLive>().0.lock().unwrap().insert(id, LiveCtl { stop: Some(tx), conn_id: conn_id.to_string() });
    (id, rx)
}

#[tauri::command]
pub async fn redis_live_start(app: tauri::AppHandle, conn: RedisConn, spec: live::LiveSpec, on_event: Channel<live::LiveEvent>) -> Result<u64, String> {
    let h = handle(&app, &conn).await?;
    let (id, rx) = register_live(&app, &conn.id);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        live::run(h, spec, on_event, rx).await;
        app2.state::<RedisLive>().0.lock().unwrap().remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub async fn redis_analyze_start(app: tauri::AppHandle, conn: RedisConn, spec: analyze::AnalyzeSpec, on_event: Channel<Json>) -> Result<u64, String> {
    let h = handle(&app, &conn).await?;
    let (id, rx) = register_live(&app, &conn.id);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        analyze::run(h, spec, on_event, rx).await;
        app2.state::<RedisLive>().0.lock().unwrap().remove(&id);
    });
    Ok(id)
}

/// Para um Monitor, assinatura ou análise (o evento final chega pelo Channel dele).
#[tauri::command]
pub fn redis_live_stop(app: tauri::AppHandle, id: u64) -> bool {
    let state = app.state::<RedisLive>();
    let mut live = state.0.lock().unwrap();
    match live.get_mut(&id).and_then(|c| c.stop.take()) {
        Some(tx) => tx.send(()).is_ok(),
        None => false,
    }
}

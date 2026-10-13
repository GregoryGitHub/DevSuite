//! Aba "RabbitMQ": monitoramento das filas, operações de depuração e gravação das mensagens.
//!
//!  - `mgmt.rs`: API HTTP do plugin de management (listas, purge, delete, publish, get...);
//!  - `amqp.rs`: AMQP para capturar as mensagens trafegadas e mover/copiar entre filas;
//!  - `store.rs`: rabbit.db (SQLite): conexões, estado da interface, gravações e mensagens.
//!
//! As senhas ficam no cofre do sistema (mesmo módulo do Banco), com cache em memória para
//! não consultar o cofre a cada atualização automática.

mod amqp;
mod mgmt;
mod store;

#[cfg(test)]
mod it_tests;

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::Manager;

use crate::db::secrets;
use amqp::{CaptureEvent, CaptureSpec, MoveResult, MoveSpec, TapBinding};
pub use mgmt::MgmtClients;
use store::{Capture, MsgFilter, MsgFull, MsgIn, MsgPage};

/// Configuração de um host (o resto do JSON salvo é só da interface).
#[derive(Deserialize, Clone, Debug, Default)]
pub struct RmqConn {
    pub id: String,
    /// URL do management: `http://localhost:15672`.
    #[serde(default)]
    pub mgmt_url: String,
    #[serde(default)]
    pub user: String,
    /// Vazio = mesmo host da URL de management.
    #[serde(default)]
    pub amqp_host: String,
    #[serde(default)]
    pub amqp_port: Option<u16>,
    #[serde(default)]
    pub amqp_tls: bool,
    /// Aceita certificado inválido no management (HTTPS).
    #[serde(default)]
    pub tls_insecure: bool,
    #[serde(default)]
    pub timeout_s: Option<u64>,
}

/// rabbit.db, aberto no primeiro uso.
#[derive(Default)]
pub struct RabbitDb(Mutex<Option<Connection>>);

/// Senhas já lidas do cofre (conn_id -> senha).
#[derive(Default)]
pub struct RmqPasswords(Mutex<HashMap<String, String>>);

struct CaptureCtl {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    sink: Arc<Mutex<Option<Channel<CaptureEvent>>>>,
    info: Capture,
    count: Arc<AtomicI64>,
}

/// Gravações em andamento (capture_id -> controle).
#[derive(Default)]
pub struct RmqCaptures(Mutex<HashMap<i64, CaptureCtl>>);

const SECRET_KIND: &str = "password";

fn secret_id(conn_id: &str) -> String {
    format!("rmq:{conn_id}")
}

// ---------- Banco local ----------

async fn with_db<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RabbitDb>();
        let mut guard = state.0.lock().map_err(|_| "rabbit.db indisponível".to_string())?;
        if guard.is_none() {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let conn = store::open(&dir.join("rabbit.db")).map_err(|e| format!("Falha ao abrir rabbit.db: {e}"))?;
            // Gravações que estavam ativas quando o app fechou.
            let _ = store::close_dangling(&conn, amqp::now_ms());
            *guard = Some(conn);
        }
        f(guard.as_mut().unwrap()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct RmqData {
    connections: Vec<Value>,
    ui: Value,
    settings: Value,
}

#[tauri::command]
pub async fn rmq_load(app: tauri::AppHandle) -> Result<RmqData, String> {
    with_db(&app, |c| {
        Ok(RmqData { connections: store::connections(c)?, ui: store::get_meta(c, "ui")?, settings: store::get_meta(c, "settings")? })
    })
    .await
}

#[tauri::command]
pub async fn rmq_save_connections(app: tauri::AppHandle, connections: Vec<Value>) -> Result<(), String> {
    with_db(&app, move |c| store::save_connections(c, &connections)).await
}

/// `ui` (estado da interface) ou `settings` (preferências).
#[tauri::command]
pub async fn rmq_save_meta(app: tauri::AppHandle, key: String, value: Value) -> Result<(), String> {
    if key != "ui" && key != "settings" {
        return Err("Chave inválida".into());
    }
    with_db(&app, move |c| store::set_meta(c, &key, &value)).await
}

// ---------- Senhas ----------

#[tauri::command]
pub async fn rmq_set_password(app: tauri::AppHandle, conn_id: String, password: String) -> Result<(), String> {
    let id = conn_id.clone();
    let pw = password.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if pw.is_empty() {
            secrets::delete(&secret_id(&id), SECRET_KIND)
        } else {
            secrets::set(&secret_id(&id), SECRET_KIND, &pw)
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    app.state::<RmqPasswords>().0.lock().unwrap().insert(conn_id, password);
    Ok(())
}

#[tauri::command]
pub async fn rmq_has_password(conn_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || matches!(secrets::get(&secret_id(&conn_id), SECRET_KIND), Ok(Some(_))))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn rmq_forget_password(app: tauri::AppHandle, conn_id: String) -> Result<(), String> {
    app.state::<RmqPasswords>().0.lock().unwrap().remove(&conn_id);
    tauri::async_runtime::spawn_blocking(move || secrets::delete(&secret_id(&conn_id), SECRET_KIND))
        .await
        .map_err(|e| e.to_string())?
}

async fn password(app: &tauri::AppHandle, conn_id: &str, given: Option<String>) -> Result<String, String> {
    if let Some(pw) = given {
        return Ok(pw);
    }
    if let Some(pw) = app.state::<RmqPasswords>().0.lock().unwrap().get(conn_id) {
        return Ok(pw.clone());
    }
    let id = conn_id.to_string();
    let pw = tauri::async_runtime::spawn_blocking(move || secrets::get(&secret_id(&id), SECRET_KIND))
        .await
        .map_err(|e| e.to_string())??
        .unwrap_or_default();
    app.state::<RmqPasswords>().0.lock().unwrap().insert(conn_id.to_string(), pw.clone());
    Ok(pw)
}

// ---------- API de management ----------

/// Chamada genérica à API HTTP (`path` sem o `/api`, segmentos já codificados pelo JS).
#[tauri::command]
pub async fn rmq_http(app: tauri::AppHandle, conn: RmqConn, method: String, path: String, body: Option<Value>, password: Option<String>) -> Result<Value, String> {
    let pw = self::password(&app, &conn.id, password).await?;
    mgmt::call(&app.state::<MgmtClients>(), &conn, &pw, &method, &path, body.as_ref()).await
}

#[derive(Serialize)]
pub struct TestResult {
    overview: Value,
    /// Erro do teste AMQP (a gestão funciona sem ele; a captura e o "mover" precisam).
    amqp_error: Option<String>,
}

/// Testa o management e a porta AMQP com a configuração do diálogo.
#[tauri::command]
pub async fn rmq_test(app: tauri::AppHandle, conn: RmqConn, password: Option<String>, vhost: Option<String>) -> Result<TestResult, String> {
    let pw = self::password(&app, &conn.id, password).await?;
    let overview = mgmt::call(&app.state::<MgmtClients>(), &conn, &pw, "GET", "/overview", None).await?;
    let vhost = vhost.filter(|v| !v.is_empty()).unwrap_or_else(|| "/".into());
    let amqp_error = match amqp::connect(&conn, &pw, &vhost, "teste").await {
        Ok(c) => {
            let _ = c.close().await;
            None
        }
        Err(e) => Some(e),
    };
    Ok(TestResult { overview, amqp_error })
}

/// Abre a interface web do management no navegador (só a URL da própria conexão).
#[tauri::command]
pub fn rmq_open_mgmt(app: tauri::AppHandle, conn: RmqConn) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = mgmt::base_url(&conn.mgmt_url);
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL inválida".into());
    }
    app.opener().open_url(format!("{url}/"), None::<&str>).map_err(|e| e.to_string())
}

// ---------- Mover / copiar ----------

#[tauri::command]
pub async fn rmq_move(app: tauri::AppHandle, conn: RmqConn, spec: MoveSpec) -> Result<MoveResult, String> {
    let pw = self::password(&app, &conn.id, None).await?;
    amqp::move_messages(&conn, &pw, &spec).await
}

// ---------- Gravações ----------

#[derive(Serialize)]
pub struct CaptureView {
    #[serde(flatten)]
    capture: Capture,
    active: bool,
}

/// Liga/desliga o tracing (firehose) do vhost preservando descrição, tags e tipo de fila padrão.
/// Devolve true se mudou algo.
async fn set_tracing(clients: &MgmtClients, conn: &RmqConn, pw: &str, vhost: &str, on: bool) -> Result<bool, String> {
    let path = format!("/vhosts/{}", mgmt::seg(vhost));
    let cur = mgmt::call(clients, conn, pw, "GET", &path, None).await?;
    if cur.get("tracing").and_then(Value::as_bool).unwrap_or(false) == on {
        return Ok(false);
    }
    let mut body = json!({ "tracing": on });
    if let Some(d) = cur.get("description").and_then(Value::as_str) {
        body["description"] = json!(d);
    }
    match cur.get("tags") {
        Some(Value::Array(a)) => body["tags"] = json!(a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")),
        Some(Value::String(s)) => body["tags"] = json!(s),
        _ => {}
    }
    let dqt = cur.get("default_queue_type").or_else(|| cur.pointer("/metadata/default_queue_type")).and_then(Value::as_str);
    if let Some(t) = dqt.filter(|t| *t != "undefined" && !t.is_empty()) {
        body["default_queue_type"] = json!(t);
    }
    mgmt::call(clients, conn, pw, "PUT", &path, Some(&body)).await?;
    Ok(true)
}

fn emit(sink: &Arc<Mutex<Option<Channel<CaptureEvent>>>>, ev: CaptureEvent) {
    if let Some(ch) = sink.lock().unwrap().as_ref() {
        let _ = ch.send(ev); // interface recarregada: a gravação continua
    }
}

#[tauri::command]
pub async fn rmq_capture_start(app: tauri::AppHandle, conn: RmqConn, spec: CaptureSpec, on_event: Channel<CaptureEvent>) -> Result<CaptureView, String> {
    let pw = self::password(&app, &conn.id, None).await?;
    let clients = app.state::<MgmtClients>();
    let mut warnings = Vec::new();
    let (bindings, source) = match spec.mode.as_str() {
        "tap" => {
            if spec.queues.is_empty() {
                return Err("Escolha ao menos uma fila.".into());
            }
            let mut per_queue = Vec::new();
            for q in &spec.queues {
                let path = format!("/queues/{}/{}/bindings", mgmt::seg(&spec.vhost), mgmt::seg(q));
                per_queue.push((q.clone(), mgmt::call(&clients, &conn, &pw, "GET", &path, None).await?));
            }
            let (bindings, only_default) = amqp::group_bindings(&per_queue);
            if bindings.is_empty() {
                return Err(format!(
                    "{} só recebe(m) mensagens pela exchange padrão (publicação direta na fila). Use o modo Firehose para gravar essas mensagens.",
                    only_default.join(", ")
                ));
            }
            if !only_default.is_empty() {
                warnings.push(format!("Sem ligações além da exchange padrão: {}. Publicações diretas nessas filas só aparecem no modo Firehose.", only_default.join(", ")));
            }
            warnings.push("Publicações direto na fila (exchange padrão) não passam pelo tap; use Firehose se precisar delas.".to_string());
            (bindings, spec.queues.join(", "))
        }
        "exchange" => {
            if spec.exchange.is_empty() {
                return Err("Informe a exchange.".into());
            }
            let b = TapBinding { exchange: spec.exchange.clone(), routing_key: spec.routing_key.clone(), arguments: Value::Null, queues: vec![] };
            (vec![b], format!("{} [{}]", spec.exchange, if spec.routing_key.is_empty() { "—" } else { &spec.routing_key }))
        }
        "firehose" => {
            let trace = |rk: &str| TapBinding { exchange: "amq.rabbitmq.trace".into(), routing_key: rk.into(), arguments: Value::Null, queues: vec![] };
            let want = |e: &str| spec.events.is_empty() || spec.events.iter().any(|x| x == e);
            let mut b = Vec::new();
            if want("publish") {
                b.push(trace("publish.#"));
            }
            if want("deliver") {
                b.push(trace("deliver.#"));
            }
            let src = if spec.queues.is_empty() { format!("vhost {}", spec.vhost) } else { spec.queues.join(", ") };
            (b, src)
        }
        m => return Err(format!("Modo de captura desconhecido: {m}")),
    };

    let tracing_changed = if spec.mode == "firehose" { set_tracing(&clients, &conn, &pw, &spec.vhost, true).await? } else { false };
    let listener = match amqp::open_listener(&conn, &pw, &spec, &bindings).await {
        Ok(l) => l,
        Err(e) => {
            if tracing_changed {
                let _ = set_tracing(&clients, &conn, &pw, &spec.vhost, false).await;
            }
            return Err(e);
        }
    };

    let mut info = Capture {
        conn_id: conn.id.clone(),
        vhost: spec.vhost.clone(),
        mode: spec.mode.clone(),
        name: if spec.name.trim().is_empty() { source.clone() } else { spec.name.trim().to_string() },
        source,
        started_at: amqp::now_ms(),
        ..Default::default()
    };
    let rec = info.clone();
    info.id = match with_db(&app, move |c| store::insert_capture(c, &rec)).await {
        Ok(id) => id,
        Err(e) => {
            listener.close().await;
            return Err(e);
        }
    };
    let id = info.id;
    let sink = Arc::new(Mutex::new(Some(on_event)));
    let count = Arc::new(AtomicI64::new(0));
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    app.state::<RmqCaptures>().0.lock().unwrap().insert(id, CaptureCtl { stop: Some(stop_tx), sink: sink.clone(), info: info.clone(), count: count.clone() });
    for w in warnings {
        emit(&sink, CaptureEvent::Warning { capture_id: id, message: w });
    }

    let task = CaptureTask { app: app.clone(), conn, pw, spec, bindings, id, sink, count, tracing_changed };
    tauri::async_runtime::spawn(task.run(listener, stop_rx));
    Ok(CaptureView { capture: info, active: true })
}

struct CaptureTask {
    app: tauri::AppHandle,
    conn: RmqConn,
    pw: String,
    spec: CaptureSpec,
    bindings: Vec<TapBinding>,
    id: i64,
    sink: Arc<Mutex<Option<Channel<CaptureEvent>>>>,
    count: Arc<AtomicI64>,
    tracing_changed: bool,
}

const FLUSH_EVERY: Duration = Duration::from_millis(300);
const FLUSH_SIZE: usize = 500;

impl CaptureTask {
    async fn flush(&self, batch: &mut Vec<MsgIn>, flushes: &mut u32) -> Result<(), String> {
        if batch.is_empty() {
            return Ok(());
        }
        let msgs = std::mem::take(batch);
        let max_body = self.spec.max_body_kb.unwrap_or(512).clamp(1, 16 * 1024) as usize * 1024;
        let max_msgs = self.spec.max_messages.unwrap_or(200_000).max(1000);
        *flushes += 1;
        let trim = *flushes % 50 == 0;
        let n = with_db(&self.app, move |c| {
            let n = store::insert_messages(c, &msgs, max_body)?;
            if trim {
                store::enforce_limit(c, max_msgs)?;
            }
            Ok(n)
        })
        .await?;
        let total = self.count.fetch_add(n as i64, Ordering::SeqCst) + n as i64;
        emit(&self.sink, CaptureEvent::Progress { capture_id: self.id, count: total });
        Ok(())
    }

    async fn run(self, listener: amqp::Listener, mut stop_rx: tokio::sync::oneshot::Receiver<()>) {
        let amqp::Listener { connection, channel, mut rx, .. } = listener;
        let mut batch: Vec<MsgIn> = Vec::new();
        let mut flushes = 0u32;
        let mut tick = tokio::time::interval(FLUSH_EVERY);
        let mut error: Option<String> = None;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                msg = rx.recv() => match msg {
                    Some(m) => {
                        let (ex, rk) = m.deliver.as_ref().map(|d| (d.exchange().clone(), d.routing_key().clone())).unwrap_or_default();
                        let content = m.content.unwrap_or_default();
                        if let Some(mut rec) = amqp::to_record(&self.spec, &self.bindings, &ex, &rk, m.basic_properties.as_ref(), content) {
                            rec.conn_id = self.conn.id.clone();
                            rec.capture_id = Some(self.id);
                            batch.push(rec);
                        }
                        if batch.len() >= FLUSH_SIZE {
                            if let Err(e) = self.flush(&mut batch, &mut flushes).await {
                                error = Some(e);
                                break;
                            }
                        }
                    }
                    None => {
                        error = Some("A conexão AMQP foi encerrada (fila temporária removida ou servidor indisponível).".into());
                        break;
                    }
                },
                _ = tick.tick() => {
                    if let Err(e) = self.flush(&mut batch, &mut flushes).await {
                        error = Some(e);
                        break;
                    }
                    if !connection.is_open() {
                        error = Some("A conexão AMQP caiu.".into());
                        break;
                    }
                }
            }
        }
        if let Err(e) = self.flush(&mut batch, &mut flushes).await {
            error.get_or_insert(e);
        }
        let _ = channel.close().await;
        let _ = connection.close().await;

        let id = self.id;
        let ctl = self.app.state::<RmqCaptures>().0.lock().unwrap().remove(&id);
        if self.tracing_changed {
            // Só desliga o tracing se nenhuma outra gravação firehose do mesmo vhost continua.
            let others = self
                .app
                .state::<RmqCaptures>()
                .0
                .lock()
                .unwrap()
                .values()
                .any(|c| c.info.mode == "firehose" && c.info.conn_id == self.conn.id && c.info.vhost == self.spec.vhost);
            if !others {
                if let Err(e) = set_tracing(&self.app.state::<MgmtClients>(), &self.conn, &self.pw, &self.spec.vhost, false).await {
                    error.get_or_insert(format!("Não foi possível desligar o tracing do vhost: {e}"));
                }
            }
        }
        let err = error.clone();
        let _ = with_db(&self.app, move |c| store::finish_capture(c, id, amqp::now_ms(), err.as_deref())).await;
        let sink = ctl.map(|c| c.sink).unwrap_or(self.sink.clone());
        emit(&sink, CaptureEvent::Stopped { capture_id: id, count: self.count.load(Ordering::SeqCst), error });
    }
}

#[tauri::command]
pub fn rmq_capture_stop(app: tauri::AppHandle, capture_id: i64) -> bool {
    let state = app.state::<RmqCaptures>();
    let mut map = state.0.lock().unwrap();
    match map.get_mut(&capture_id).and_then(|c| c.stop.take()) {
        Some(tx) => tx.send(()).is_ok(),
        None => false,
    }
}

/// Reconecta os eventos de uma gravação ativa a um novo Channel (ex.: interface recarregada).
#[tauri::command]
pub fn rmq_capture_attach(app: tauri::AppHandle, capture_id: i64, on_event: Channel<CaptureEvent>) -> bool {
    let state = app.state::<RmqCaptures>();
    let map = state.0.lock().unwrap();
    match map.get(&capture_id) {
        Some(c) => {
            *c.sink.lock().unwrap() = Some(on_event);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub async fn rmq_captures(app: tauri::AppHandle, conn_id: Option<String>) -> Result<Vec<CaptureView>, String> {
    let list = with_db(&app, move |c| store::captures(c, conn_id.as_deref())).await?;
    let map = app.state::<RmqCaptures>();
    let map = map.0.lock().unwrap();
    Ok(list
        .into_iter()
        .map(|mut c| {
            let active = map.get(&c.id);
            if let Some(a) = active {
                c.count = c.count.max(a.count.load(Ordering::SeqCst));
            }
            CaptureView { active: active.is_some(), capture: c }
        })
        .collect())
}

#[tauri::command]
pub async fn rmq_capture_rename(app: tauri::AppHandle, capture_id: i64, name: String) -> Result<(), String> {
    with_db(&app, move |c| store::rename_capture(c, capture_id, &name)).await
}

#[tauri::command]
pub async fn rmq_capture_delete(app: tauri::AppHandle, capture_id: i64) -> Result<usize, String> {
    if rmq_capture_stop(app.clone(), capture_id) {
        // Espera a gravação terminar de gravar o último lote.
        for _ in 0..50 {
            if !app.state::<RmqCaptures>().0.lock().unwrap().contains_key(&capture_id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    with_db(&app, move |c| store::delete_capture(c, capture_id)).await
}

// ---------- Mensagens gravadas ----------

#[tauri::command]
pub async fn rmq_messages_query(app: tauri::AppHandle, filter: MsgFilter) -> Result<MsgPage, String> {
    with_db(&app, move |c| store::query_messages(c, &filter)).await
}

#[tauri::command]
pub async fn rmq_message_get(app: tauri::AppHandle, id: i64) -> Result<Option<MsgFull>, String> {
    with_db(&app, move |c| store::get_message(c, id)).await
}

#[tauri::command]
pub async fn rmq_messages_get(app: tauri::AppHandle, ids: Vec<i64>) -> Result<Vec<MsgFull>, String> {
    with_db(&app, move |c| store::get_messages(c, &ids)).await
}

#[tauri::command]
pub async fn rmq_messages_delete(app: tauri::AppHandle, ids: Vec<i64>) -> Result<usize, String> {
    with_db(&app, move |c| store::delete_messages(c, &ids)).await
}

#[tauri::command]
pub async fn rmq_messages_delete_matching(app: tauri::AppHandle, filter: MsgFilter) -> Result<usize, String> {
    with_db(&app, move |c| store::delete_matching(c, &filter)).await
}

/// Salva mensagens vistas numa fila (peek) no histórico local.
#[tauri::command]
pub async fn rmq_messages_save(app: tauri::AppHandle, messages: Vec<MsgIn>, max_body_kb: Option<u32>) -> Result<usize, String> {
    let max_body = max_body_kb.unwrap_or(512).clamp(1, 16 * 1024) as usize * 1024;
    let msgs: Vec<MsgIn> = messages
        .into_iter()
        .map(|mut m| {
            m.decode_js_payload();
            if m.at == 0 {
                m.at = amqp::now_ms();
            }
            m
        })
        .collect();
    with_db(&app, move |c| store::insert_messages(c, &msgs, max_body)).await
}

#[tauri::command]
pub async fn rmq_store_stats(app: tauri::AppHandle) -> Result<Value, String> {
    with_db(&app, |c| store::stats(c)).await
}

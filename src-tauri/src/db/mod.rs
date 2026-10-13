//! Aba "Banco" (cliente estilo DataGrip): comandos Tauri e sessões abertas.
//!
//! Cada aba/console do frontend usa uma sessão própria (`session_id`), aberta sob demanda
//! no primeiro uso e reaberta sozinha se a conexão cair. O Database Explorer usa sessões
//! `meta:*` separadas para não esperar consultas longas das abas. Todos os comandos são
//! `async`: nada de rede roda na thread da interface.

mod driver;
mod entra;
mod mongo;
mod mssql;
mod mssql_meta;
pub(crate) mod secrets;

#[cfg(test)]
mod it_tests;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::Manager;

use driver::*;
pub use entra::EntraTokens;

type Slot = Arc<tokio::sync::Mutex<Option<Box<dyn Session>>>>;

/// Sessões abertas (session_id -> conexão). O Mutex do tokio serializa as requisições de cada sessão.
#[derive(Default)]
pub struct DbSessions(Mutex<HashMap<String, Slot>>);

/// Execuções em andamento (query_id -> sinal de cancelamento).
#[derive(Default)]
pub struct DbInflight(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

/// Onde um comando roda: sessão + conexão (para abrir/reabrir) + banco.
#[derive(Deserialize)]
pub struct Target {
    session_id: String,
    conn: ConnConfig,
    /// Banco da sessão; vazio = o padrão da conexão.
    #[serde(default)]
    database: String,
}

struct ChannelSink(Channel<ExecEvent>);

impl EventSink for ChannelSink {
    fn send(&mut self, event: ExecEvent) -> DbResult<()> {
        self.0.send(event).map_err(|e| format!("Resultado descartado pela interface: {e}"))
    }
}

async fn resolve_secret(app: &tauri::AppHandle, conn: &ConnConfig, password: Option<String>, interactive: bool) -> DbResult<Secret> {
    match conn.auth.kind.as_str() {
        "entra" => {
            let tokens = app.state::<EntraTokens>();
            Ok(Secret::AccessToken(entra::access_token(app, &tokens, &conn.id, &conn.auth, interactive).await?))
        }
        _ => {
            let pw = match password {
                Some(pw) => pw,
                None => secrets::get(&conn.id, "password")?.unwrap_or_default(),
            };
            Ok(Secret::Password(pw))
        }
    }
}

async fn open(app: &tauri::AppHandle, target: &Target, interactive: bool) -> DbResult<Box<dyn Session>> {
    let secret = resolve_secret(app, &target.conn, None, interactive).await?;
    driver_for(&target.conn.driver)?.connect(&target.conn, &target.database, secret).await
}

fn slot(app: &tauri::AppHandle, session_id: &str) -> Slot {
    app.state::<DbSessions>()
        .0
        .lock()
        .unwrap()
        .entry(session_id.to_string())
        .or_default()
        .clone()
}

/// Sessão pronta para uso: descarta a quebrada e abre se necessário.
async fn ready<'a>(app: &tauri::AppHandle, target: &Target, guard: &'a mut Option<Box<dyn Session>>, interactive: bool) -> DbResult<&'a mut Box<dyn Session>> {
    if guard.as_ref().is_some_and(|s| s.is_broken()) {
        if let Some(old) = guard.take() {
            old.close().await;
        }
    }
    if guard.is_none() {
        *guard = Some(open(app, target, interactive).await?);
    }
    Ok(guard.as_mut().expect("sessão aberta"))
}

// ---------- Persistência (databases.json) ----------

fn data_file(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app.path().app_data_dir().expect("failed to resolve app data dir");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push("databases.json");
    dir
}

/// Conexões (sem segredos), consoles e histórico; o formato é definido em `src/js/utils/dbModel.js`.
#[tauri::command]
pub fn load_db_data(app: tauri::AppHandle) -> serde_json::Value {
    let path = data_file(&app);
    let Ok(raw) = fs::read_to_string(&path) else {
        return serde_json::Value::Null;
    };
    match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("databases.json inválido ({e}); salvando cópia em databases.json.bak");
            let _ = fs::copy(&path, path.with_extension("json.bak"));
            serde_json::Value::Null
        }
    }
}

#[tauri::command]
pub fn save_db_data(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    crate::persist::write(data_file(&app), json);
    Ok(())
}

// ---------- Segredos ----------

#[tauri::command]
pub async fn db_set_password(conn_id: String, password: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if password.is_empty() {
            secrets::delete(&conn_id, "password")
        } else {
            secrets::set(&conn_id, "password", &password)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn db_has_password(conn_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || secrets::get(&conn_id, "password").map(|p| p.is_some_and(|p| !p.is_empty())))
        .await
        .map_err(|e| e.to_string())?
}

/// Apaga senha e tokens (conexão removida ou "sair da conta").
#[tauri::command]
pub async fn db_forget_secrets(app: tauri::AppHandle, conn_id: String) -> Result<(), String> {
    entra::forget(&app.state::<EntraTokens>(), &conn_id);
    tauri::async_runtime::spawn_blocking(move || secrets::delete(&conn_id, "password"))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- Conexão ----------

/// Testa a configuração do diálogo (com a senha digitada, se houver) sem guardar a sessão.
#[tauri::command]
pub async fn db_test_connection(app: tauri::AppHandle, conn: ConnConfig, password: Option<String>) -> Result<ServerInfo, String> {
    let secret = resolve_secret(&app, &conn, password, true).await?;
    let mut session = driver_for(&conn.driver)?.connect(&conn, "", secret).await?;
    let info = session.server_info().await;
    session.close().await;
    info
}

/// Abre (ou reaproveita) a sessão. Pode abrir o navegador para o login do Entra.
#[tauri::command]
pub async fn db_connect(app: tauri::AppHandle, target: Target) -> Result<ServerInfo, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    ready(&app, &target, &mut guard, true).await?.server_info().await
}

/// Fecha as sessões com esse id ou prefixo (ex.: "meta:<conn>:" ou "<conn>:").
#[tauri::command]
pub async fn db_disconnect(app: tauri::AppHandle, prefix: String) -> Result<(), String> {
    // "meta:<conn>:" = desconectar a conexão inteira: descarta também o pool do MongoDB.
    if let Some(conn_id) = prefix.strip_prefix("meta:").and_then(|r| r.split(':').next()) {
        mongo::forget(conn_id);
    }
    let sessions = app.state::<DbSessions>();
    let slots: Vec<Slot> = {
        let mut map = sessions.0.lock().unwrap();
        let keys: Vec<String> = map.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        keys.iter().filter_map(|k| map.remove(k)).collect()
    };
    for slot in slots {
        if let Some(session) = slot.lock().await.take() {
            session.close().await;
        }
    }
    Ok(())
}

// ---------- Explorer ----------

#[tauri::command]
pub async fn db_introspect(app: tauri::AppHandle, target: Target, path: ObjectPath) -> Result<Vec<ObjectNode>, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    ready(&app, &target, &mut guard, false).await?.introspect(&path).await
}

#[tauri::command]
pub async fn db_table_info(app: tauri::AppHandle, target: Target, schema: String, name: String) -> Result<TableInfo, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    ready(&app, &target, &mut guard, false).await?.table_info(&schema, &name).await
}

#[tauri::command]
pub async fn db_ddl(app: tauri::AppHandle, target: Target, path: ObjectPath) -> Result<String, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    ready(&app, &target, &mut guard, false).await?.ddl(&path).await
}

/// Estrutura editável de uma tabela (diálogo "Modificar tabela"; o DDL é gerado no frontend).
#[tauri::command]
pub async fn db_table_schema(app: tauri::AppHandle, target: Target, schema: String, name: String) -> Result<TableSchema, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    ready(&app, &target, &mut guard, false).await?.table_schema(&schema, &name).await
}

// ---------- Execução ----------

/// Executa SQL e envia os result sets em lotes pelo `on_event`.
/// `max_rows` limita cada result set; as linhas excedentes são descartadas.
#[tauri::command]
pub async fn db_execute(
    app: tauri::AppHandle,
    target: Target,
    query_id: String,
    sql: String,
    max_rows: Option<u64>,
    on_event: Channel<ExecEvent>,
) -> Result<ExecSummary, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    let session = ready(&app, &target, &mut guard, false).await?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    app.state::<DbInflight>().0.lock().unwrap().insert(query_id.clone(), cancel_tx);
    let mut sink = ChannelSink(on_event);
    let outcome = tokio::select! {
        r = session.execute(&sql, &mut sink, max_rows) => Some(r),
        _ = cancel_rx => None,
    };
    app.state::<DbInflight>().0.lock().unwrap().remove(&query_id);

    match outcome {
        Some(result) => result,
        None => {
            session.cancel().await;
            if session.is_broken() {
                // Fechar o socket faz o servidor abortar o lote (e desfazer a transação aberta).
                drop(guard.take());
                return Err("Consulta cancelada (a sessão foi reaberta; transação aberta, se havia, foi desfeita)".into());
            }
            Err("Consulta cancelada".into())
        }
    }
}

#[tauri::command]
pub fn db_cancel(app: tauri::AppHandle, query_id: String) {
    if let Some(tx) = app.state::<DbInflight>().0.lock().unwrap().remove(&query_id) {
        let _ = tx.send(());
    }
}

/// "begin" | "commit" | "rollback"; devolve @@TRANCOUNT depois da ação.
#[tauri::command]
pub async fn db_tx(app: tauri::AppHandle, target: Target, action: String) -> Result<u32, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    let session = ready(&app, &target, &mut guard, false).await?;
    match action.as_str() {
        "begin" => session.begin().await,
        "commit" => session.commit().await,
        "rollback" => session.rollback().await,
        other => Err(format!("Ação de transação inválida: {other}")),
    }
}

/// Aplica as alterações do grid (UPDATE/INSERT/DELETE gerados no frontend).
/// `atomic`: transação própria, tudo ou nada (ignorado se já houver transação aberta).
#[tauri::command]
pub async fn db_apply(app: tauri::AppHandle, target: Target, statements: Vec<String>, atomic: bool) -> Result<Vec<u64>, String> {
    let slot = slot(&app, &target.session_id);
    let mut guard = slot.lock().await;
    ready(&app, &target, &mut guard, false).await?.apply(&statements, atomic).await
}

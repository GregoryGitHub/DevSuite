//! Servidor da CLI `devsuite` (crate `src-tauri/cli`): expõe as funcionalidades do app para
//! scripts e agentes de IA.
//!
//! - Transporte: named pipe `\\.\pipe\devsuite-cli-<usuário>` (Windows) ou `<app_data>/cli.sock`
//!   (Linux/macOS, 0600). Frames NDJSON: o cliente manda `{ hello, token }` e depois
//!   `{ id, method, params }`; recebe `{ id, event }`* e por fim `{ id, result }` | `{ id, error }`.
//! - O token aleatório fica em `<app_data>/cli.json` (regravado a cada início): só quem lê a pasta
//!   de dados do usuário conversa com o app.
//! - Quase toda a lógica (Markdown das notas, scripts do HTTP, parser mongosh, travas de escrita)
//!   vive no JS: `method = "<app>.<comando>"` vira o evento `cli-call` para a janela dona do app
//!   (`app-<id>` se desatachado, senão `main`), que responde com `cli_reply`/`cli_event`
//!   (`src/js/cli/bridge.js`). Assim cada documento continua com um único escritor e a interface
//!   atualiza na hora.

pub mod vaults;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// Apps atendidos pela ponte JS (grupo de comandos = app).
const JS_APPS: &[&str] = &["notes", "tasks", "http", "db", "rabbit", "redis"];
/// Espera máxima pela janela dona carregar o JS (app recém-iniciado pela CLI).
const READY_WAIT: Duration = Duration::from_secs(40);

enum Frame {
    Event(Value),
    Done(Result<Value, Value>),
}

#[derive(Default)]
pub struct CliState {
    next_id: AtomicU64,
    /// callId -> (janela que atende, canal da conexão que aguarda a resposta).
    pending: Mutex<HashMap<u64, (String, mpsc::UnboundedSender<Frame>)>>,
    /// Janelas cujo JS já registrou os handlers da CLI.
    ready: Mutex<HashSet<String>>,
    ready_changed: tokio::sync::Notify,
    token: Mutex<String>,
}

fn err(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

// ---------- Endpoint ----------

#[cfg(windows)]
fn pipe_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    let user: String = user.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    format!(r"\\.\pipe\devsuite-cli-{}", user.to_lowercase())
}

/// Inicia o servidor (chamado no `setup`). Falhas só vão para o log: o app funciona sem a CLI.
pub fn start(app: &AppHandle) {
    let token: String = (0..32).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    *app.state::<CliState>().token.lock().unwrap() = token.clone();
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(windows)]
    let endpoint = pipe_name();
    #[cfg(not(windows))]
    let endpoint = dir.join("cli.sock").to_string_lossy().into_owned();
    let info = json!({
        "token": token,
        "endpoint": endpoint,
        "pid": std::process::id(),
        "version": app.package_info().version.to_string(),
        "exe": std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()),
    });
    let path = dir.join("cli.json");
    if let Err(e) = write_private(&path, &info.to_string()) {
        eprintln!("cli: falha ao gravar {}: {e}", path.display());
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app, endpoint).await {
            eprintln!("cli: servidor parou: {e}");
        }
    });
}

fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        f.write_all(text.as_bytes())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, text)
    }
}

#[cfg(windows)]
async fn serve(app: AppHandle, name: String) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&name)?;
    loop {
        server.connect().await?;
        let conn = server;
        server = ServerOptions::new().reject_remote_clients(true).create(&name)?;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let (r, w) = tokio::io::split(conn);
            client(app, r, w).await;
        });
    }
}

#[cfg(not(windows))]
async fn serve(app: AppHandle, path: String) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    loop {
        let (conn, _) = listener.accept().await?;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let (r, w) = tokio::io::split(conn);
            client(app, r, w).await;
        });
    }
}

// ---------- Conexão ----------

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn client<R, W>(app: AppHandle, reader: R, mut writer: W)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer_task = tauri::async_runtime::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err() || writer.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    let mut lines = BufReader::new(reader).lines();
    let mut authed = false;
    // Chamadas em andamento desta conexão (canceladas se o cliente sair, ex.: Ctrl+C).
    let calls: std::sync::Arc<Mutex<HashSet<u64>>> = Default::default();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            let _ = out_tx.send(json!({ "id": null, "error": err("protocol", "JSON inválido") }).to_string());
            continue;
        };
        if !authed {
            let token = app.state::<CliState>().token.lock().unwrap().clone();
            if msg.get("token").and_then(Value::as_str) == Some(token.as_str()) {
                authed = true;
                let _ = out_tx.send(json!({ "hello": true, "version": app.package_info().version.to_string() }).to_string());
                continue;
            }
            let _ = out_tx.send(json!({ "id": null, "error": err("auth", "Token inválido: rode a CLI com o mesmo usuário do Dev Suite") }).to_string());
            break;
        }
        let Ok(req) = serde_json::from_value::<Request>(msg) else {
            let _ = out_tx.send(json!({ "id": null, "error": err("protocol", "Esperado { id, method, params }") }).to_string());
            continue;
        };
        let app = app.clone();
        let out = out_tx.clone();
        let calls = calls.clone();
        tauri::async_runtime::spawn(async move {
            let id = req.id.clone();
            let send_event = {
                let out = out.clone();
                let id = id.clone();
                move |event: Value| {
                    let _ = out.send(json!({ "id": id, "event": event }).to_string());
                }
            };
            let result = dispatch(&app, &req.method, req.params, send_event, &calls).await;
            let frame = match result {
                Ok(v) => json!({ "id": id, "result": v }),
                Err(e) => json!({ "id": id, "error": e }),
            };
            let _ = out.send(frame.to_string());
        });
    }
    // Cliente saiu: avisa o JS para cancelar o que ainda roda (consulta, watch...).
    let left: Vec<u64> = calls.lock().unwrap().drain().collect();
    for call_id in left {
        app.state::<CliState>().pending.lock().unwrap().remove(&call_id);
        let _ = app.emit("cli-cancel", json!({ "callId": call_id }));
    }
    drop(out_tx);
    let _ = writer_task.await;
}

async fn dispatch(
    app: &AppHandle,
    method: &str,
    params: Value,
    send_event: impl Fn(Value) + Send,
    calls: &std::sync::Arc<Mutex<HashSet<u64>>>,
) -> Result<Value, Value> {
    match method {
        "sys.ping" => return Ok(json!("pong")),
        "sys.status" => return Ok(status(app)),
        "sys.wait_ready" => {
            wait_ready(app, "main").await?;
            return Ok(status(app));
        }
        "sys.show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            return Ok(Value::Null);
        }
        _ => {}
    }
    let Some((group, _)) = method.split_once('.') else {
        return Err(err("usage", format!("Método inválido: {method}")));
    };
    if !JS_APPS.contains(&group) {
        return Err(err("usage", format!("Grupo desconhecido: {group}")));
    }
    // Durante um desatachar/reatachar a janela antiga responde "moved": tenta de novo.
    for _ in 0..20 {
        match js_call(app, group, method, &params, &send_event, calls).await {
            Err(e) if e.get("code").and_then(Value::as_str) == Some("moved") => tokio::time::sleep(Duration::from_millis(300)).await,
            other => return other,
        }
    }
    Err(err("unavailable", format!("O app {group} está mudando de janela; tente de novo")))
}

fn status(app: &AppHandle) -> Value {
    let ready: Vec<String> = app.state::<CliState>().ready.lock().unwrap().iter().cloned().collect();
    let detached: Vec<&str> = JS_APPS
        .iter()
        .chain(["json"].iter())
        .copied()
        .filter(|id| app.get_webview_window(&format!("app-{id}")).is_some())
        .collect();
    json!({
        "version": app.package_info().version.to_string(),
        "pid": std::process::id(),
        "ready": ready,
        "detached": detached,
        "data_dir": app.path().app_data_dir().ok().map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Janela que hoje é dona do app.
fn owner(app: &AppHandle, view: &str) -> String {
    let label = format!("app-{view}");
    if app.get_webview_window(&label).is_some() {
        label
    } else {
        "main".into()
    }
}

async fn wait_ready(app: &AppHandle, label: &str) -> Result<(), Value> {
    let state = app.state::<CliState>();
    let deadline = tokio::time::Instant::now() + READY_WAIT;
    loop {
        let notified = state.ready_changed.notified();
        if state.ready.lock().unwrap().contains(label) {
            return Ok(());
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return Err(err("unavailable", format!("A janela {label} do Dev Suite não respondeu (ainda carregando?)")));
        }
    }
}

async fn js_call(
    app: &AppHandle,
    view: &str,
    method: &str,
    params: &Value,
    send_event: &(impl Fn(Value) + Send),
    calls: &std::sync::Arc<Mutex<HashSet<u64>>>,
) -> Result<Value, Value> {
    let label = owner(app, view);
    wait_ready(app, &label).await?;
    let state = app.state::<CliState>();
    let call_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel();
    state.pending.lock().unwrap().insert(call_id, (label.clone(), tx));
    calls.lock().unwrap().insert(call_id);
    let payload = json!({ "callId": call_id, "label": label, "view": view, "method": method, "params": params });
    if let Err(e) = app.emit_to(label.as_str(), "cli-call", payload) {
        state.pending.lock().unwrap().remove(&call_id);
        calls.lock().unwrap().remove(&call_id);
        return Err(err("unavailable", e.to_string()));
    }
    let result = loop {
        match rx.recv().await {
            Some(Frame::Event(ev)) => send_event(ev),
            Some(Frame::Done(r)) => break r,
            // Janela fechou/recarregou sem responder.
            None => break Err(err("moved", "A janela foi fechada durante a chamada")),
        }
    };
    calls.lock().unwrap().remove(&call_id);
    result
}

/// A janela foi destruída: deixa de receber chamadas (e as pendentes falham com "moved").
pub fn window_gone(app: &AppHandle, label: &str) {
    let state = app.state::<CliState>();
    state.ready.lock().unwrap().remove(label);
    state.pending.lock().unwrap().retain(|_, (owner, _)| owner != label);
}

// ---------- Comandos chamados pelo JS (bridge.js) ----------

#[tauri::command]
pub fn cli_ready(app: AppHandle, window: tauri::WebviewWindow) {
    let state = app.state::<CliState>();
    let label = window.label().to_string();
    // Página recarregada: o que foi emitido para a página antiga se perdeu; "moved" = reenviar.
    state.pending.lock().unwrap().retain(|_, (owner, _)| *owner != label);
    state.ready.lock().unwrap().insert(label);
    state.ready_changed.notify_waiters();
}

#[tauri::command]
pub fn cli_reply(app: AppHandle, call_id: u64, result: Option<Value>, error: Option<Value>) {
    let tx = app.state::<CliState>().pending.lock().unwrap().remove(&call_id);
    if let Some((_, tx)) = tx {
        let r = match error {
            Some(e) => Err(e),
            None => Ok(result.unwrap_or(Value::Null)),
        };
        let _ = tx.send(Frame::Done(r));
    }
}

/// Evento intermediário (linhas de uma consulta, ciclo de um `watch`). `false` = cliente saiu.
#[tauri::command]
pub fn cli_event(app: AppHandle, call_id: u64, event: Value) -> bool {
    let state = app.state::<CliState>();
    let pending = state.pending.lock().unwrap();
    match pending.get(&call_id) {
        Some((_, tx)) => tx.send(Frame::Event(event)).is_ok(),
        None => false,
    }
}

// ---------- Configurações → CLI ----------

/// `devsuite(.exe)` instalada ao lado do app (externalBin), se existir.
fn cli_exe() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let exe = dir.join(format!("devsuite{}", std::env::consts::EXE_SUFFIX));
    exe.is_file().then_some(exe)
}

/// Alguma pasta do PATH (do processo e, no Windows, a do usuário gravada no registro) tem a CLI?
fn on_path(dir: &std::path::Path) -> bool {
    let same = |p: &std::path::Path| p.canonicalize().ok() == dir.canonicalize().ok();
    let mut found = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| same(&d)));
    #[cfg(windows)]
    if !found {
        found = user_path().is_some_and(|p| std::env::split_paths(&p).any(|d| same(&d)));
    }
    #[cfg(unix)]
    if !found {
        found = std::env::var_os("HOME").is_some_and(|h| std::path::Path::new(&h).join(".local/bin/devsuite").exists());
    }
    found
}

#[cfg(windows)]
fn powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(windows)]
fn user_path() -> Option<String> {
    powershell("[Environment]::GetEnvironmentVariable('Path','User')").ok()
}

#[tauri::command]
pub async fn cli_info() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = cli_exe();
        let in_path = exe.as_ref().and_then(|e| e.parent()).is_some_and(on_path);
        json!({ "exe": exe.map(|p| p.to_string_lossy().into_owned()), "on_path": in_path })
    })
    .await
    .unwrap_or(Value::Null)
}

/// "path": coloca a pasta da CLI no PATH do usuário (Linux/macOS: link em ~/.local/bin).
/// "skills": instala as skills para agentes (`devsuite skills install`). Devolve uma mensagem.
#[tauri::command]
pub async fn cli_setup(action: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = cli_exe().ok_or("A CLI devsuite não está ao lado do app (instale pelo instalador do Dev Suite).")?;
        match action.as_str() {
            "path" => {
                let dir = exe.parent().ok_or("pasta inválida")?.to_path_buf();
                #[cfg(windows)]
                {
                    // Valor cru do registro: SetEnvironmentVariable gravaria o PATH com as
                    // %VARIÁVEIS% já expandidas e como REG_SZ (mesma lógica do installer-hooks.nsh).
                    let d = dir.to_string_lossy().trim_end_matches('\\').replace('\'', "''");
                    powershell(&format!(
                        "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); \
                         $p=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); \
                         $t='ExpandString'; if($k.GetValueNames() -contains 'Path'){{$t=$k.GetValueKind('Path')}}; \
                         $a=@($p -split ';' | Where-Object {{$_}}); \
                         if(-not ($a | Where-Object {{$_.TrimEnd([char]92) -ieq '{d}'}})){{ \
                           $k.SetValue('Path', (($a + '{d}') -join ';'), $t); \
                           [Environment]::SetEnvironmentVariable('DEVSUITE_PATH_REFRESH', $null, 'User') }}"
                    ))?;
                    Ok(format!("{} adicionada ao PATH do usuário. Abra um terminal novo e rode: devsuite status", dir.display()))
                }
                #[cfg(unix)]
                {
                    let home = std::env::var_os("HOME").ok_or("HOME indefinido")?;
                    let bin = std::path::Path::new(&home).join(".local/bin");
                    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
                    let link = bin.join("devsuite");
                    let _ = std::fs::remove_file(&link);
                    std::os::unix::fs::symlink(&exe, &link).map_err(|e| e.to_string())?;
                    let _ = dir;
                    Ok(format!("Link criado em {} (confira se ~/.local/bin está no PATH)", link.display()))
                }
            }
            "skills" => {
                let mut cmd = std::process::Command::new(&exe);
                cmd.args(["skills", "install", "--json"]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x0800_0000);
                }
                let out = cmd.output().map_err(|e| e.to_string())?;
                let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| String::from_utf8_lossy(&out.stderr).into_owned())?;
                match v["data"]["installed"].as_array() {
                    Some(list) => Ok(format!("{} skill(s) instalada(s) em {}", list.len(), list.first().and_then(Value::as_str).map(|p| p.rsplit_once(['\\', '/']).map(|x| x.0).unwrap_or(p)).unwrap_or(""))),
                    None => Err(v["error"]["message"].as_str().unwrap_or("falha ao instalar as skills").to_string()),
                }
            }
            other => Err(format!("Ação desconhecida: {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

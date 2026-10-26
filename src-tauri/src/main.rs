#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_windows;
mod cli;
mod db;
mod http;
mod md_files;
mod note_images;
mod note_pdf;
mod notes_db;
mod notes_git;
mod notes_vault;
mod persist;
#[cfg(windows)]
mod quicklook;
mod rabbit;
mod redis_app;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

/// true enquanto a janela está no modo desktop (notas em janela grande).
#[derive(Default)]
struct DesktopMode(AtomicBool);

const TRAY_SIZE: (f64, f64) = (370.0, 530.0);
// Largura em que a barra das Notas (pastas + lista + editor com busca) cabe inteira.
const DESKTOP_SIZE: (f64, f64) = (1280.0, 760.0);
const DESKTOP_MIN_SIZE: (f64, f64) = (720.0, 460.0);

#[derive(Serialize, Deserialize, Clone, Default)]
struct AppSettings {
    #[serde(default)]
    autostart: bool,
    #[serde(default)]
    start_minimized: bool,
    /// "system" | "light" | "dark"
    #[serde(default = "default_theme")]
    theme: String,
    /// Notas: propriedades (front-matter), filtros relacionais e grafo.
    #[serde(default)]
    zettelkasten: bool,
    /// Notas: "sqlite" (notes.db, padrão) | "vault" (pasta de Markdown em `vault_path`).
    #[serde(default = "default_notes_storage")]
    notes_storage: String,
    #[serde(default)]
    vault_path: String,
    /// Cofres já usados (troca rápida na barra lateral das Notas).
    #[serde(default)]
    vaults: Vec<String>,
    /// Windows: Espaço sobre um .md no Explorer abre a prévia (quicklook.rs).
    #[serde(default = "default_true")]
    md_quicklook: bool,
}

fn default_true() -> bool {
    true
}

fn default_notes_storage() -> String {
    "sqlite".into()
}

fn default_theme() -> String {
    "system".into()
}

fn app_file(app: &tauri::AppHandle, name: &str) -> PathBuf {
    let mut dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push(name);
    dir
}

fn settings_file(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push("settings.json");
    dir
}

/// Board kanban das Tarefas (formato em `src/js/utils/kanbanModel.js`). `null` = ainda não existe
/// (o JS migra o `todos.json` antigo).
#[tauri::command]
fn load_kanban_data(app: tauri::AppHandle) -> serde_json::Value {
    let path = app_file(&app, "kanban.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return serde_json::Value::Null;
    };
    match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("kanban.json inválido ({e}); salvando cópia em kanban.json.bak");
            let _ = fs::copy(&path, path.with_extension("json.bak"));
            serde_json::Value::Null
        }
    }
}

#[tauri::command]
fn save_kanban_data(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    persist::write(app_file(&app, "kanban.json"), json);
    Ok(())
}

/// Lista de tarefas antiga (`todos.json`), só para a migração para o board.
/// `None` = não existe; erro = ilegível (o arquivo não é tocado).
#[tauri::command]
fn load_todos(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app_file(&app, "todos.json");
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("todos.json ilegível: {e}"))
}

/// Depois de gravar o `kanban.json` migrado: `todos.json` → `todos.json.migrated`.
#[tauri::command]
fn kanban_migrated(app: tauri::AppHandle) -> Result<(), String> {
    let path = app_file(&app, "todos.json");
    if !path.exists() {
        return Ok(());
    }
    persist::flush();
    fs::rename(&path, path.with_extension("json.migrated")).map_err(|e| e.to_string())
}

/// Último valor de autostart aplicado no sistema (evita rodar `reg.exe` a cada save).
static AUTOSTART_APPLIED: Mutex<Option<bool>> = Mutex::new(None);

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> AppSettings {
    let path = settings_file(&app);
    let settings: AppSettings = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<AppSettings>(&s).ok())
        .unwrap_or_default();
    AUTOSTART_APPLIED.lock().unwrap().get_or_insert(settings.autostart);
    settings
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_file(&app);
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    persist::write(path, json);
    // As outras janelas (apps desatachados) acompanham tema, Zettelkasten, cofre etc.
    let _ = app.emit("settings-changed", &settings);
    #[cfg(windows)]
    quicklook::set_enabled(&app, settings.md_quicklook);

    // Só mexe no autostart quando ele muda (o tema, por exemplo, também salva settings).
    {
        let mut applied = AUTOSTART_APPLIED.lock().unwrap();
        if *applied == Some(settings.autostart) {
            return Ok(());
        }
        *applied = Some(settings.autostart);
    }
    // `reg.exe` / arquivos de autostart fora da thread principal.
    std::thread::spawn(move || apply_autostart(&app, settings.autostart));
    Ok(())
}

fn apply_autostart(app: &tauri::AppHandle, autostart: bool) {
    #[cfg(not(target_os = "linux"))]
    let _ = app;

    #[cfg(target_os = "windows")]
    {
        const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let delete = |name: &str| {
            let _ = std::process::Command::new("reg").args(["delete", RUN_KEY, "/v", name, "/f"]).output();
        };
        // Entrada do nome antigo (TodoRS): sai sempre, para não abrir duas vezes.
        delete("TodoRS");
        if let Ok(exe_path) = std::env::current_exe() {
            if autostart {
                let _ = std::process::Command::new("reg")
                    .args([
                        "add",
                        RUN_KEY,
                        "/v",
                        "DevSuite",
                        "/t",
                        "REG_SZ",
                        "/d",
                        &format!("\"{}\"", exe_path.to_string_lossy()),
                        "/f",
                    ])
                    .output();
            } else {
                delete("DevSuite");
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Ok(config_dir) = app.path().config_dir() {
                let autostart_dir = config_dir.join("autostart");
                let _ = fs::remove_file(autostart_dir.join("todo-rs.desktop")); // nome antigo
                let desktop_file = autostart_dir.join("dev-suite.desktop");
                if autostart {
                    let _ = fs::create_dir_all(&autostart_dir);
                    let content = format!(
                        "[Desktop Entry]\nType=Application\nName=Dev Suite\nExec=env GDK_BACKEND=x11 \"{}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
                        exe_path.display()
                    );
                    let _ = fs::write(desktop_file, content);
                } else if desktop_file.exists() {
                    let _ = fs::remove_file(desktop_file);
                }
            }
        }
    }
}

/// Instalações antigas registraram o autostart como "TodoRS" (apontando para o exe antigo):
/// regrava com o nome e o caminho atuais. Roda fora da thread principal.
fn migrate_autostart(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    let old = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "TodoRS"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    #[cfg(target_os = "linux")]
    let old = app.path().config_dir().map(|d| d.join("autostart").join("todo-rs.desktop").exists()).unwrap_or(false);
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let old = false;
    if old {
        apply_autostart(app, true);
    }
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Alterna entre o modo bandeja (janela compacta presa à tray) e o modo desktop
/// (janela grande, redimensionável e na barra de tarefas) usado pelas notas.
#[tauri::command]
fn set_desktop_mode(
    app: tauri::AppHandle,
    mode: tauri::State<DesktopMode>,
    enabled: bool,
    visible: bool,
) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    mode.0.store(enabled, Ordering::SeqCst);

    if enabled {
        let _ = w.set_always_on_top(false);
        let _ = w.set_skip_taskbar(false);
        let _ = w.set_resizable(true);
        let _ = w.set_maximizable(true);
        let _ = w.set_min_size(Some(tauri::LogicalSize::new(DESKTOP_MIN_SIZE.0, DESKTOP_MIN_SIZE.1)));
        // Em telas pequenas, no máximo 92% da área do monitor.
        let (mut width, mut height) = DESKTOP_SIZE;
        if let Ok(Some(m)) = w.current_monitor() {
            let screen = m.size().to_logical::<f64>(m.scale_factor());
            width = width.min(screen.width * 0.92).max(DESKTOP_MIN_SIZE.0);
            height = height.min(screen.height * 0.92).max(DESKTOP_MIN_SIZE.1);
        }
        let _ = w.set_size(tauri::LogicalSize::new(width, height));
        let _ = w.set_shadow(true);
        let _ = w.center();
    } else {
        let _ = w.unmaximize();
        let _ = w.set_min_size(None::<tauri::LogicalSize<f64>>);
        let _ = w.set_size(tauri::LogicalSize::new(TRAY_SIZE.0, TRAY_SIZE.1));
        let _ = w.set_resizable(false);
        let _ = w.set_maximizable(false);
        let _ = w.set_shadow(false);
        let _ = w.set_skip_taskbar(true);
        let _ = w.set_always_on_top(true);
        position_near_tray(&w, None);
    }

    if visible {
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        let _ = w.hide();
    }
}

/// Minimiza a janela que chamou (a principal ou uma desatachada).
#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn toggle_maximize(window: tauri::WebviewWindow) -> bool {
    let w = window;
    if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
        false
    } else {
        let _ = w.maximize();
        true
    }
}

fn position_near_tray(window: &tauri::WebviewWindow, tray_rect: Option<tauri::Rect>) {
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.available_monitors().ok().and_then(|ms| ms.into_iter().next()));

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let win_size = match window.outer_size() {
        Ok(s) if s.width > 0 && s.height > 0 => s,
        _ => tauri::PhysicalSize::new(
            (TRAY_SIZE.0 * scale_factor) as u32,
            (TRAY_SIZE.1 * scale_factor) as u32,
        ),
    };

    if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        let margin = (12.0 * scale_factor) as i32;

        let (rx, ry, rw, rh) = if let Some(rect) = tray_rect {
            let pos = match rect.position {
                tauri::Position::Physical(p) => (p.x, p.y),
                tauri::Position::Logical(l) => ((l.x * scale_factor) as i32, (l.y * scale_factor) as i32),
            };
            let s = match rect.size {
                tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
                tauri::Size::Logical(l) => ((l.width * scale_factor) as i32, (l.height * scale_factor) as i32),
            };
            (pos.0, pos.1, s.0, s.1)
        } else {
            (0, 0, 0, 0)
        };

        let (target_x, target_y) = if rw > 0 && rh > 0 {
            let tx = rx + (rw / 2) - (win_size.width as i32 / 2);
            let ty = if ry < (work_area.position.y + work_area.size.height as i32 / 2) {
                ry + rh + margin
            } else {
                ry - (win_size.height as i32) - margin
            };
            (tx, ty)
        } else {
            let tx = work_area.position.x + (work_area.size.width as i32) - (win_size.width as i32) - margin;
            let ty = work_area.position.y + (work_area.size.height as i32) - (win_size.height as i32) - margin;
            (tx, ty)
        };

        let max_x = work_area.position.x + (work_area.size.width as i32) - (win_size.width as i32) - margin;
        let max_y = work_area.position.y + (work_area.size.height as i32) - (win_size.height as i32) - margin;
        let min_x = work_area.position.x + margin;
        let min_y = work_area.position.y + margin;

        let final_x = target_x.clamp(min_x, max_x);
        let final_y = target_y.clamp(min_y, max_y);

        let _ = window.set_position(tauri::PhysicalPosition::new(final_x, final_y));
    }
}

#[allow(dead_code)]
fn toggle_window(app: &tauri::AppHandle, tray_rect: Option<tauri::Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                position_near_tray(&window, tray_rect);

                let window_clone = window.clone();
                tauri::async_runtime::spawn(async move {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    position_near_tray(&window_clone, tray_rect);
                });
            }
        }
    }
}

fn show_window(app: &tauri::AppHandle, tray_rect: Option<tauri::Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();

        // No modo desktop a janela fica onde o usuário a deixou.
        if app.state::<DesktopMode>().0.load(Ordering::SeqCst) {
            return;
        }
        position_near_tray(&window, tray_rect);

        let window_clone = window.clone();
        tauri::async_runtime::spawn(async move {
            std::thread::sleep(std::time::Duration::from_millis(50));
            position_near_tray(&window_clone, tray_rect);
        });
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }
    tauri::Builder::default()
        // Primeiro plugin: uma 2ª execução (ex.: atalho fixado "--app=http") só avisa esta.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // A CLI (`devsuite`) iniciando o app que já está aberto: nada a mostrar.
            if argv.iter().any(|a| a == "--background") {
                return;
            }
            // Dois cliques num .md (associação de arquivo): abre a janela daquele arquivo.
            if let Some(path) = md_files::md_arg(&argv, std::path::Path::new(&cwd)) {
                md_files::open_file_later(app, path);
                return;
            }
            match app_windows::app_arg(&argv) {
                Some(id) => {
                    let app = app.clone();
                    // Criar janela fora da thread do loop de eventos.
                    tauri::async_runtime::spawn(async move {
                        let _ = app_windows::open(&app, id, true);
                    });
                }
                None => show_window(app, None),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopMode::default())
        .manage(app_windows::AppWindows::default())
        .manage(notes_db::NotesDb::default())
        .manage(notes_git::GitState::default())
        .manage(db::DbSessions::default())
        .manage(db::DbInflight::default())
        .manage(db::EntraTokens::default())
        .manage(http::HttpInflight::default())
        .manage(http::HttpCookies::default())
        .manage(rabbit::RabbitDb::default())
        .manage(rabbit::MgmtClients::default())
        .manage(rabbit::RmqPasswords::default())
        .manage(rabbit::RmqCaptures::default())
        .manage(redis_app::RedisClients::default())
        .manage(redis_app::RedisSecrets::default())
        .manage(redis_app::RedisLive::default())
        .manage(cli::CliState::default())
        .invoke_handler(tauri::generate_handler![
            load_kanban_data,
            save_kanban_data,
            load_todos,
            kanban_migrated,
            notes_db::notes_list,
            note_pdf::notes_print_pdf,
            notes_db::notes_get,
            notes_db::notes_save,
            notes_db::notes_save_many,
            notes_db::notes_scan_dir,
            notes_db::notes_set_meta,
            notes_db::notes_delete,
            notes_db::notes_search,
            notes_db::notes_folders,
            notes_db::notes_save_folders,
            notes_db::notes_legacy,
            notes_db::notes_import,
            notes_db::notes_gc_images,
            notes_db::notes_set_storage,
            notes_db::notes_vault_refresh,
            notes_db::notes_vault_files,
            notes_git::notes_vault_create,
            notes_git::git_info,
            notes_git::git_status,
            notes_git::git_init,
            notes_git::git_file_pair,
            notes_git::git_write_file,
            notes_git::git_commit,
            notes_git::git_rollback,
            notes_git::git_ignore,
            notes_git::git_log,
            notes_git::git_commit_files,
            notes_git::git_remote_set,
            notes_git::git_remote_test,
            notes_git::git_fetch,
            notes_git::git_pull,
            notes_git::git_push,
            notes_git::git_cancel,
            notes_git::git_conflict,
            notes_git::git_resolve,
            notes_git::git_merge_abort,
            notes_git::git_set_identity,
            load_settings,
            save_settings,
            hide_window,
            app_windows::exit_app,
            app_windows::app_window_open,
            app_windows::app_window_close,
            app_windows::app_window_focus,
            app_windows::app_windows_list,
            app_windows::app_flushed,
            set_desktop_mode,
            minimize_window,
            toggle_maximize,
            http::send_http_request,
            http::cancel_http_request,
            http::clear_http_cookies,
            http::load_http_data,
            http::save_http_data,
            http::read_text_file,
            http::write_file,
            note_images::save_note_image,
            note_images::import_note_image,
            note_images::export_note_images,
            md_files::md_file_read,
            md_files::md_file_write,
            md_files::md_file_save_image,
            md_files::md_file_import_image,
            md_files::md_open,
            md_files::md_reveal,
            md_files::md_window_close,
            md_files::md_preview_ready,
            md_files::md_preview_hide,
            db::load_db_data,
            db::save_db_data,
            db::db_set_password,
            db::db_has_password,
            db::db_get_password,
            db::db_forget_secrets,
            db::db_test_connection,
            db::db_connect,
            db::db_disconnect,
            db::db_introspect,
            db::db_table_info,
            db::db_ddl,
            db::db_database_script,
            db::db_table_schema,
            db::db_execute,
            db::db_cancel,
            db::db_tx,
            db::db_apply,
            rabbit::rmq_load,
            rabbit::rmq_save_connections,
            rabbit::rmq_save_meta,
            rabbit::rmq_set_password,
            rabbit::rmq_has_password,
            rabbit::rmq_forget_password,
            rabbit::rmq_http,
            rabbit::rmq_test,
            rabbit::rmq_open_mgmt,
            rabbit::rmq_move,
            rabbit::rmq_capture_start,
            rabbit::rmq_capture_stop,
            rabbit::rmq_capture_attach,
            rabbit::rmq_captures,
            rabbit::rmq_capture_rename,
            rabbit::rmq_capture_delete,
            rabbit::rmq_messages_query,
            rabbit::rmq_message_get,
            rabbit::rmq_messages_get,
            rabbit::rmq_messages_delete,
            rabbit::rmq_messages_delete_matching,
            rabbit::rmq_messages_save,
            rabbit::rmq_store_stats,
            redis_app::load_redis_data,
            redis_app::save_redis_data,
            redis_app::redis_set_secret,
            redis_app::redis_has_secrets,
            redis_app::redis_forget_secrets,
            redis_app::redis_test,
            redis_app::redis_connect,
            redis_app::redis_disconnect,
            redis_app::redis_close_session,
            redis_app::redis_nodes,
            redis_app::redis_exec,
            redis_app::redis_pipeline,
            redis_app::redis_scan,
            redis_app::redis_live_start,
            redis_app::redis_analyze_start,
            redis_app::redis_live_stop,
            cli::cli_ready,
            cli::cli_reply,
            cli::cli_event,
            cli::cli_info,
            cli::cli_setup,
            cli::vaults::cli_store_read,
            cli::vaults::cli_vault_create
        ])
        .register_asynchronous_uri_scheme_protocol(note_images::SCHEME, |ctx, request, responder| {
            // Leitura do arquivo fora da thread da UI.
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(note_images::serve(&app, &request));
            });
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                cli::window_gone(window.app_handle(), window.label());
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // Desatachada: grava e volta para a principal. Arquivo .md: grava e fecha.
                // Principal: só se esconde.
                if !md_files::close_requested(window.app_handle(), window) && !app_windows::close_requested(window.app_handle(), window) {
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let detached = app_windows::load(app.handle());
            let menu = app_windows::tray_menu(app.handle())?;

            let tray_white = tauri::image::Image::from_bytes(include_bytes!("../icons/tray_white.png"))?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_white)
                .icon_as_template(true)
                .tooltip("Dev Suite")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_window(app, None);
                    }
                    "hide" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                    "quit" => {
                        tauri::async_runtime::spawn(app_windows::exit_all(app.clone()));
                    }
                    other => {
                        if let Some(id) = other.strip_prefix("focus:") {
                            app_windows::focus_app(app, id);
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle(), Some(rect));
                    }
                })
                .build(app)?;

            // Check if start_minimized is false, then show window on launch
            let settings = load_settings(app.handle().clone());
            // Atalho fixado de um app ("--app=http"): abre só ele; a principal fica na bandeja.
            let args: Vec<String> = std::env::args().collect();
            let launch_app = app_windows::app_arg(&args);
            // Aberto por dois cliques num .md: só a janela do arquivo (a principal fica na bandeja).
            let launch_md = md_files::md_arg(&args, &std::env::current_dir().unwrap_or_default());
            // Iniciado pela CLI (`devsuite`): fica na bandeja.
            let background = args.iter().any(|a| a == "--background");
            if !settings.start_minimized && !background && launch_app.is_none() && launch_md.is_none() {
                show_window(app.handle(), None);
            }
            // Apps que estavam soltos ao sair reabrem nas suas janelas.
            for id in &detached {
                let show = (!settings.start_minimized && !background) || launch_app == Some(id.as_str());
                if let Err(e) = app_windows::open(app.handle(), id, show) {
                    eprintln!("falha ao reabrir {id}: {e}");
                }
            }
            if let Some(id) = launch_app {
                app_windows::open(app.handle(), id, true)?;
            }
            if let Some(path) = launch_md {
                md_files::open_file(app.handle(), &path)?;
            }
            cli::start(app.handle());
            #[cfg(windows)]
            quicklook::set_enabled(app.handle(), settings.md_quicklook);
            if settings.autostart {
                let handle = app.handle().clone();
                std::thread::spawn(move || migrate_autostart(&handle));
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            // Garante que as gravações em fila terminem antes do processo sair.
            if let tauri::RunEvent::Exit = event {
                persist::flush();
            }
        });
}

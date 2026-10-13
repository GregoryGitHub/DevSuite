#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod http;
mod note_images;
mod note_pdf;
mod notes_db;
mod persist;
mod rabbit;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[derive(Serialize, Deserialize, Clone)]
struct Todo {
    id: u64,
    text: String,
    done: bool,
    #[serde(default)]
    date: String,
    #[serde(default)]
    is_my_day: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completed_date: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    note: String,
}

/// true enquanto a janela está no modo desktop (notas em janela grande).
#[derive(Default)]
struct DesktopMode(AtomicBool);

const TRAY_SIZE: (f64, f64) = (370.0, 530.0);
const DESKTOP_SIZE: (f64, f64) = (1100.0, 720.0);
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
}

fn default_theme() -> String {
    "system".into()
}

fn data_file(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push("todos.json");
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

#[tauri::command]
fn load_todos(app: tauri::AppHandle) -> Vec<Todo> {
    let path = data_file(&app);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Todo>>(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_todos(app: tauri::AppHandle, todos: Vec<Todo>) -> Result<(), String> {
    let path = data_file(&app);
    let json = serde_json::to_string_pretty(&todos).map_err(|e| e.to_string())?;
    persist::write(path, json);
    Ok(())
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
        if let Ok(exe_path) = std::env::current_exe() {
            let exe_str = exe_path.to_string_lossy();
            if autostart {
                let _ = std::process::Command::new("reg")
                    .args(&[
                        "add",
                        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                        "/v",
                        "TodoRS",
                        "/t",
                        "REG_SZ",
                        "/d",
                        &format!("\"{}\"", exe_str),
                        "/f",
                    ])
                    .output();
            } else {
                let _ = std::process::Command::new("reg")
                    .args(&[
                        "delete",
                        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                        "/v",
                        "TodoRS",
                        "/f",
                    ])
                    .output();
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Ok(config_dir) = app.path().config_dir() {
                let autostart_dir = config_dir.join("autostart");
                let desktop_file = autostart_dir.join("todo-rs.desktop");
                if autostart {
                    let _ = fs::create_dir_all(&autostart_dir);
                    let content = format!(
                        "[Desktop Entry]\nType=Application\nName=TodoRS\nExec=env GDK_BACKEND=x11 \"{}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
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

#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
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
        let _ = w.set_size(tauri::LogicalSize::new(DESKTOP_SIZE.0, DESKTOP_SIZE.1));
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

#[tauri::command]
fn minimize_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
fn toggle_maximize(app: tauri::AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else {
        return false;
    };
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DesktopMode::default())
        .manage(notes_db::NotesDb::default())
        .manage(db::DbSessions::default())
        .manage(db::DbInflight::default())
        .manage(db::EntraTokens::default())
        .manage(http::HttpInflight::default())
        .manage(http::HttpCookies::default())
        .manage(rabbit::RabbitDb::default())
        .manage(rabbit::MgmtClients::default())
        .manage(rabbit::RmqPasswords::default())
        .manage(rabbit::RmqCaptures::default())
        .invoke_handler(tauri::generate_handler![
            load_todos,
            save_todos,
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
            load_settings,
            save_settings,
            hide_window,
            exit_app,
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
            db::load_db_data,
            db::save_db_data,
            db::db_set_password,
            db::db_has_password,
            db::db_forget_secrets,
            db::db_test_connection,
            db::db_connect,
            db::db_disconnect,
            db::db_introspect,
            db::db_table_info,
            db::db_ddl,
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
            rabbit::rmq_store_stats
        ])
        .register_asynchronous_uri_scheme_protocol(note_images::SCHEME, |ctx, request, responder| {
            // Leitura do arquivo fora da thread da UI.
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(note_images::serve(&app, &request));
            });
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Ocultar", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            let tray_white = tauri::image::Image::new(include_bytes!("../icons/tray_white.rgba"), 64, 64);

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_white)
                .icon_as_template(true)
                .tooltip("Todo")
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
                        app.exit(0);
                    }
                    _ => {}
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
            if !settings.start_minimized {
                show_window(app.handle(), None);
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

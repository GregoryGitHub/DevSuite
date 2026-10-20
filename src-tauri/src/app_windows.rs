//! Janelas desatachadas: cada app da suíte (Tarefas, Notas, HTTP, JSON, Banco, RabbitMQ) pode
//! sair da janela principal para uma janela própria, `app-<id>`, que carrega o mesmo
//! `index.html` só com aquele app (`window.__DEVSUITE_APP__`).
//!
//! - Um app vive em uma janela por vez: a principal não grava os dados de um app solto, então
//!   `todos.json`/`http.json`/`databases.json` continuam com um único escritor.
//! - No Windows cada janela ganha um AppUserModelID próprio (botão e ícone separados na barra)
//!   e as propriedades de relançamento (`dev-suite.exe --app=<id>`), para fixar na barra.
//! - Os apps soltos e a posição/tamanho de cada janela ficam em `windows.json` e são
//!   restaurados ao iniciar.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

use crate::persist;

pub struct AppDef {
    pub id: &'static str,
    pub name: &'static str,
    png: &'static [u8],
    ico: &'static [u8],
}

macro_rules! app_def {
    ($id:literal, $name:literal) => {
        AppDef {
            id: $id,
            name: $name,
            png: include_bytes!(concat!("../icons/apps/", $id, ".png")),
            ico: include_bytes!(concat!("../icons/apps/", $id, ".ico")),
        }
    };
}

/// Apps que podem ser desatachados (na ordem do seletor).
pub const APPS: &[AppDef] = &[
    app_def!("tasks", "Tarefas"),
    app_def!("notes", "Notas"),
    app_def!("http", "HTTP"),
    app_def!("json", "Formatter JSON"),
    app_def!("db", "Banco de dados"),
    app_def!("rabbit", "RabbitMQ"),
];

const LABEL_PREFIX: &str = "app-";
/// Sem resposta do JS (gravar pendências), a janela fecha mesmo assim depois disso.
const CLOSE_FALLBACK: Duration = Duration::from_secs(3);
/// Espera máxima pelas janelas gravarem o que falta antes de sair do app.
const EXIT_WAIT: Duration = Duration::from_millis(1500);

fn find(id: &str) -> Option<&'static AppDef> {
    APPS.iter().find(|a| a.id == id)
}

fn label_of(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

/// Id do app de uma janela desatachada (`None` para a principal).
pub fn app_of_label(label: &str) -> Option<&'static str> {
    label.strip_prefix(LABEL_PREFIX).and_then(find).map(|a| a.id)
}

fn title_of(def: &AppDef) -> String {
    format!("Dev Suite — {}", def.name)
}

/// `--app=<id>` na linha de comando (atalho fixado na barra de tarefas).
pub fn app_arg<S: AsRef<str>>(args: &[S]) -> Option<&'static str> {
    args.iter()
        .find_map(|a| a.as_ref().strip_prefix("--app="))
        .and_then(find)
        .map(|a| a.id)
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
}

/// `windows.json`: apps soltos (reabertos ao iniciar) e geometria (física) de cada janela.
#[derive(Serialize, Deserialize, Default)]
struct WindowsDoc {
    #[serde(default)]
    open: Vec<String>,
    #[serde(default)]
    geometry: HashMap<String, Geometry>,
}

#[derive(Default)]
pub struct AppWindows {
    doc: Mutex<WindowsDoc>,
    /// Janelas que pediram para fechar e ainda estão gravando (fallback de fechamento).
    closing: Mutex<HashSet<String>>,
    /// Janelas que ainda não confirmaram a gravação antes de sair do app.
    flushing: Mutex<HashSet<String>>,
}

fn doc_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("windows.json"))
}

fn save_doc(app: &AppHandle, doc: &WindowsDoc) {
    if let (Some(path), Ok(json)) = (doc_path(app), serde_json::to_string_pretty(doc)) {
        persist::write(path, json);
    }
}

/// Lê `windows.json`; devolve os apps que estavam soltos ao sair.
pub fn load(app: &AppHandle) -> Vec<String> {
    let doc: WindowsDoc = doc_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let open = doc.open.iter().filter(|id| find(id).is_some()).cloned().collect();
    *app.state::<AppWindows>().doc.lock().unwrap() = doc;
    open
}

/// O `.ico` do app gravado em disco: o Windows lê o ícone de relançamento de um arquivo.
/// O nome leva um hash do conteúdo: o cache de ícones do Windows é por caminho, então um
/// ícone novo no mesmo arquivo continuaria aparecendo com o desenho antigo na barra.
fn ico_file(app: &AppHandle, def: &AppDef) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(def.ico).iter().take(4).map(|b| format!("{b:02x}")).collect();
    let dir = app.path().app_data_dir().ok()?.join("app-icons");
    let path = dir.join(format!("{}-{hash}.ico", def.id));
    if !path.exists() {
        std::fs::create_dir_all(&dir).ok()?;
        persist::write_atomic(&path, def.ico).ok()?;
        // Versões anteriores do ícone deste app.
        let prefix = def.id;
        for entry in std::fs::read_dir(&dir).ok()?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".ico").unwrap_or("");
            let old = stem == prefix || stem.strip_prefix(&format!("{prefix}-")).is_some_and(|h| h.len() == 8);
            if old && entry.path() != path {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Some(path)
}

fn focus(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn on_screen(app: &AppHandle, g: &Geometry) -> bool {
    let monitors = app.available_monitors().unwrap_or_default();
    let (px, py) = (g.x + 60, g.y + 20); // um pedaço da barra de título
    monitors.iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        px >= p.x && py >= p.y && px < p.x + s.width as i32 && py < p.y + s.height as i32
    })
}

/// Abre (ou só foca) a janela do app. `show = false` cria minimizada (início minimizado).
/// Não chamar de dentro de um comando síncrono: criar janela ali trava no Windows.
pub fn open(app: &AppHandle, id: &str, show: bool) -> Result<(), String> {
    let def = find(id).ok_or_else(|| format!("App desconhecido: {id}"))?;
    let label = label_of(def.id);
    if let Some(w) = app.get_webview_window(&label) {
        if show {
            focus(&w);
        }
        return Ok(());
    }
    let state = app.state::<AppWindows>();
    state.closing.lock().unwrap().remove(&label);
    let geometry = state.doc.lock().unwrap().geometry.get(def.id).copied().filter(|g| on_screen(app, g));

    let (w, h) = crate::DESKTOP_SIZE;
    let (min_w, min_h) = crate::DESKTOP_MIN_SIZE;
    let init = format!("window.__DEVSUITE_APP__ = {};", serde_json::to_string(def.id).unwrap_or_default());
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title_of(def))
        .initialization_script(&init)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(true)
        .maximizable(true)
        .min_inner_size(min_w, min_h)
        .inner_size(w, h)
        // Igual à principal (dragDropEnabled: false): o WebView2 engoliria o drag & drop HTML5.
        .disable_drag_drop_handler()
        .visible(false);
    if geometry.is_none() {
        builder = builder.center();
    }
    if let Ok(icon) = Image::from_bytes(def.png) {
        builder = builder.icon(icon).map_err(|e| e.to_string())?;
    }
    let window = builder.build().map_err(|e| e.to_string())?;

    if let Some(g) = geometry {
        let _ = window.set_position(tauri::PhysicalPosition::new(g.x, g.y));
        let _ = window.set_size(tauri::PhysicalSize::new(g.width, g.height));
    }
    let maximized = geometry.is_some_and(|g| g.maximized);
    let ico = ico_file(app, def);
    let title = title_of(def);
    let win = window.clone();
    // Propriedades da barra de tarefas (COM) e show na thread principal, antes de aparecer.
    let _ = app.run_on_main_thread(move || {
        #[cfg(windows)]
        taskbar::set(&win, Some((def.id, &title, ico.as_deref())));
        #[cfg(not(windows))]
        let _ = (&title, &ico);
        if maximized {
            let _ = win.maximize();
        }
        if show {
            focus(&win);
        } else {
            let _ = win.show();
            let _ = win.minimize();
        }
    });

    {
        let mut doc = state.doc.lock().unwrap();
        if !doc.open.iter().any(|o| o == def.id) {
            doc.open.push(def.id.to_string());
        }
        save_doc(app, &doc);
    }
    refresh_tray_menu(app);
    let _ = app.emit_to("main", "app-detached", def.id);
    Ok(())
}

fn remember_geometry(app: &AppHandle, id: &str, w: &WebviewWindow) {
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let state = app.state::<AppWindows>();
    let mut doc = state.doc.lock().unwrap();
    if w.is_maximized().unwrap_or(false) {
        // Mantém o tamanho "restaurado" anterior; só marca maximizada.
        if let Some(g) = doc.geometry.get_mut(id) {
            g.maximized = true;
            return;
        }
    }
    if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
        let maximized = w.is_maximized().unwrap_or(false);
        doc.geometry.insert(id.to_string(), Geometry { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized });
    }
}

/// Fecha a janela do app (as pendências já foram gravadas) e devolve o app à principal.
pub fn close(app: &AppHandle, id: &str) {
    let label = label_of(id);
    app.state::<AppWindows>().closing.lock().unwrap().remove(&label);
    if let Some(w) = app.get_webview_window(&label) {
        remember_geometry(app, id, &w);
        // Limpa as propriedades da barra (COM) e destrói na thread principal.
        let _ = app.run_on_main_thread(move || {
            #[cfg(windows)]
            taskbar::set(&w, None);
            let _ = w.destroy();
        });
    }
    {
        let state = app.state::<AppWindows>();
        let mut doc = state.doc.lock().unwrap();
        doc.open.retain(|o| o != id);
        save_doc(app, &doc);
    }
    refresh_tray_menu(app);
    let _ = app.emit_to("main", "app-attached", id);
}

/// X / Alt+F4 numa janela desatachada: pede ao JS para gravar e reatachar; se ele não
/// responder a tempo, fecha mesmo assim.
pub fn close_requested(app: &AppHandle, window: &tauri::Window) -> bool {
    let Some(id) = app_of_label(window.label()) else {
        return false;
    };
    let label = window.label().to_string();
    app.state::<AppWindows>().closing.lock().unwrap().insert(label.clone());
    let _ = app.emit_to(label.as_str(), "app-close-requested", ());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLOSE_FALLBACK).await;
        let pending = app.state::<AppWindows>().closing.lock().unwrap().contains(&label);
        if pending {
            close(&app, id);
        }
    });
    true
}

/// Sair do app: cada janela grava o que falta (`app_flushed`), com tempo limite; depois a
/// geometria das janelas soltas vai para o windows.json (elas reabrem no próximo início).
pub async fn exit_all(app: AppHandle) {
    let labels: HashSet<String> = app.webview_windows().into_keys().collect();
    *app.state::<AppWindows>().flushing.lock().unwrap() = labels;
    let _ = app.emit("app-exit", ());
    let deadline = tokio::time::Instant::now() + EXIT_WAIT;
    while tokio::time::Instant::now() < deadline {
        if app.state::<AppWindows>().flushing.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    for (label, w) in app.webview_windows() {
        if let Some(id) = app_of_label(&label) {
            remember_geometry(&app, id, &w);
        }
    }
    {
        let state = app.state::<AppWindows>();
        let doc = state.doc.lock().unwrap();
        save_doc(&app, &doc);
    }
    app.exit(0);
}

// ---------- Bandeja ----------

/// Menu da bandeja: "Mostrar", um item por app solto, "Ocultar" e "Sair".
pub fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?)?;
    let open = app.state::<AppWindows>().doc.lock().unwrap().open.clone();
    let detached: Vec<&AppDef> = APPS.iter().filter(|a| open.iter().any(|o| o == a.id)).collect();
    if !detached.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for def in detached {
            let text = format!("Mostrar {}", def.name);
            menu.append(&MenuItem::with_id(app, format!("focus:{}", def.id), text, true, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "hide", "Ocultar", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?)?;
    Ok(menu)
}

fn refresh_tray_menu(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main-tray"), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Item "focus:<id>" do menu da bandeja.
pub fn focus_app(app: &AppHandle, id: &str) {
    if let Some(w) = app.get_webview_window(&label_of(id)) {
        focus(&w);
    }
}

// ---------- Comandos ----------

#[tauri::command]
pub async fn app_window_open(app: AppHandle, view: String) -> Result<(), String> {
    if find(&view).is_none() {
        return Err(format!("App desconhecido: {view}"));
    }
    // A janela nova lê os arquivos do disco: as gravações em fila da principal vão antes.
    let _ = tauri::async_runtime::spawn_blocking(persist::flush).await;
    open(&app, &view, true)
}

/// Chamado pela janela desatachada depois de gravar o que estava pendente.
#[tauri::command]
pub async fn app_window_close(app: AppHandle, window: WebviewWindow) {
    if let Some(id) = app_of_label(window.label()) {
        close(&app, id);
    }
}

#[tauri::command]
pub fn app_window_focus(app: AppHandle, view: String) {
    focus_app(&app, &view);
}

/// Apps desatachados agora (a principal usa ao carregar).
#[tauri::command]
pub fn app_windows_list(app: AppHandle) -> Vec<String> {
    APPS.iter()
        .filter(|a| app.get_webview_window(&label_of(a.id)).is_some())
        .map(|a| a.id.to_string())
        .collect()
}

/// Resposta ao evento "app-exit": esta janela já gravou o que tinha pendente.
#[tauri::command]
pub fn app_flushed(app: AppHandle, window: WebviewWindow) {
    app.state::<AppWindows>().flushing.lock().unwrap().remove(window.label());
}

#[tauri::command]
pub async fn exit_app(app: AppHandle) {
    exit_all(app).await;
}

// ---------- Windows: botão próprio na barra de tarefas + relançamento ----------

#[cfg(windows)]
mod taskbar {
    use std::path::Path;

    use tauri::WebviewWindow;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{HWND, PROPERTYKEY};
    use windows::Win32::Storage::EnhancedStorage::{
        PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand, PKEY_AppUserModel_RelaunchDisplayNameResource,
        PKEY_AppUserModel_RelaunchIconResource,
    };
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
    use windows::Win32::UI::Shell::SHStrDupW;

    /// PROPVARIANT VT_LPWSTR (o tipo que o shell espera); a memória é liberada no Drop.
    fn wide(s: &str) -> windows::core::Result<PROPVARIANT> {
        let mut pv = PROPVARIANT::default();
        unsafe {
            let text = SHStrDupW(&HSTRING::from(s))?;
            let inner = &mut *pv.Anonymous.Anonymous;
            inner.vt = VT_LPWSTR;
            inner.Anonymous.pwszVal = text;
        }
        Ok(pv)
    }

    /// `Some((id, título, ícone))` aplica; `None` limpa (a Microsoft pede isso antes de destruir a janela).
    pub fn set(window: &WebviewWindow, app: Option<(&str, &str, Option<&Path>)>) {
        if let Err(e) = try_set(window, app) {
            eprintln!("AppUserModelID da janela {}: {e}", window.label());
        }
    }

    fn try_set(window: &WebviewWindow, app: Option<(&str, &str, Option<&Path>)>) -> windows::core::Result<()> {
        let Ok(hwnd) = window.hwnd() else {
            return Ok(());
        };
        let store: IPropertyStore = unsafe { SHGetPropertyStoreForWindow(HWND(hwnd.0 as _))? };
        let mut props: Vec<(PROPERTYKEY, PROPVARIANT)> = Vec::new();
        match app {
            Some((id, title, ico)) => {
                let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
                // As de relançamento só valem com o ID definido; o ID vai por último.
                props.push((PKEY_AppUserModel_RelaunchCommand, wide(&format!("\"{exe}\" --app={id}"))?));
                props.push((PKEY_AppUserModel_RelaunchDisplayNameResource, wide(title)?));
                if let Some(ico) = ico {
                    props.push((PKEY_AppUserModel_RelaunchIconResource, wide(&format!("{},0", ico.display()))?));
                }
                props.push((PKEY_AppUserModel_ID, wide(&format!("DevSuite.{id}"))?));
            }
            None => {
                for key in [
                    PKEY_AppUserModel_RelaunchCommand,
                    PKEY_AppUserModel_RelaunchDisplayNameResource,
                    PKEY_AppUserModel_RelaunchIconResource,
                    PKEY_AppUserModel_ID,
                ] {
                    props.push((key, PROPVARIANT::default()));
                }
            }
        }
        unsafe {
            for (key, value) in &props {
                store.SetValue(key, value)?;
            }
            store.Commit()
        }
    }
}

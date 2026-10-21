//! Arquivos .md de fora das Notas (dois cliques no Explorer, "Abrir arquivo Markdown…"):
//! cada arquivo abre numa janela `md-<hash>` só com o editor, que grava direto no arquivo
//! (conflito por mtime, como o cofre). Também guarda a janela de prévia `md-preview`
//! (somente leitura, aberta pelo Espaço no Explorer; ver quicklook.rs).
//!
//! Imagens ao lado do arquivo são servidas por `noteimg://localhost/f/<token>/<caminho>`:
//! o token identifica a pasta do arquivo (registrada ao ler) e `note_images::vault_file`
//! impede sair dela.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const PREVIEW_LABEL: &str = "md-preview";
const LABEL_PREFIX: &str = "md-";
const CLOSE_FALLBACK: Duration = Duration::from_secs(3);
const MAX_MD_BYTES: u64 = 20 * 1024 * 1024;

/// token -> pasta do arquivo (para as imagens).
static DIRS: LazyLock<RwLock<HashMap<String, PathBuf>>> = LazyLock::new(Default::default);
/// Janelas de arquivo que pediram para fechar e ainda estão gravando.
static CLOSING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// Arquivo mostrado na prévia (None = oculta).
static PREVIEWING: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn is_md(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// 1º argumento (depois do executável) que é um arquivo .md existente. Relativo = a `cwd`.
pub fn md_arg<S: AsRef<str>>(args: &[S], cwd: &Path) -> Option<PathBuf> {
    args.iter().skip(1).map(|a| a.as_ref()).filter(|a| !a.starts_with("--")).find_map(|a| {
        let p = Path::new(a.trim_matches('"'));
        let p = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        (p.is_file() && is_md(&p)).then_some(p)
    })
}

fn short_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Caminho comparável (canônico quando dá; no Windows sem diferença de maiúsculas).
fn key_of(path: &Path) -> String {
    let p = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let s = p.to_string_lossy().to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn label_of(path: &Path) -> String {
    format!("{LABEL_PREFIX}{}", short_hash(&key_of(path)))
}

/// Registra a pasta do arquivo e devolve o token das imagens.
fn register_dir(path: &Path) -> String {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let token = short_hash(&key_of(&dir));
    DIRS.write().unwrap().insert(token.clone(), dir);
    token
}

pub fn dir_of_token(token: &str) -> Option<PathBuf> {
    DIRS.read().ok()?.get(token).cloned()
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

// ---------- Janelas ----------

fn focus(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Abre (ou foca) a janela de edição do arquivo. Não chamar de um comando síncrono.
pub fn open_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("Arquivo não encontrado: {}", path.display()));
    }
    let label = label_of(path);
    if let Some(w) = app.get_webview_window(&label) {
        focus(&w);
        return Ok(());
    }
    CLOSING.lock().unwrap().remove(&label);
    let path_str = path.to_string_lossy().to_string();
    let init = format!("window.__DEVSUITE_MD__ = {};", serde_json::json!({ "path": path_str }));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("{} — Dev Suite", file_name(path)))
        .initialization_script(&init)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(true)
        .maximizable(true)
        .min_inner_size(480.0, 360.0)
        .inner_size(920.0, 760.0)
        .center()
        // Igual à principal (dragDropEnabled: false): o WebView2 engoliria o drag & drop HTML5.
        .disable_drag_drop_handler();
    // Ícone do Notas na barra de tarefas (o editor é o do Notas, não a suíte inteira).
    if let Some(icon) = crate::app_windows::app_png("notes").and_then(|png| tauri::image::Image::from_bytes(png).ok()) {
        builder = builder.icon(icon).map_err(|e| e.to_string())?;
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    focus(&window);
    Ok(())
}

/// Abre a partir de outra thread (single instance, prévia, comandos).
pub fn open_file_later(app: &AppHandle, path: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = open_file(&app, &path) {
            eprintln!("md: {e}");
        }
    });
}

/// X / Alt+F4 numa janela de arquivo: a página grava e chama `md_window_close` (prévia: só
/// esconde). Devolve false se a janela não é deste módulo.
pub fn close_requested(app: &AppHandle, window: &tauri::Window) -> bool {
    let label = window.label().to_string();
    if label == PREVIEW_LABEL {
        hide_preview(app);
        return true;
    }
    if !label.starts_with(LABEL_PREFIX) {
        return false;
    }
    CLOSING.lock().unwrap().insert(label.clone());
    let _ = app.emit_to(label.as_str(), "md-close-requested", ());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLOSE_FALLBACK).await;
        if CLOSING.lock().unwrap().remove(&label) {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        }
    });
    true
}

// ---------- Prévia ----------

/// Cria a janela de prévia oculta (pré-aquecida: abrir depois é instantâneo).
pub fn ensure_preview(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(PREVIEW_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, PREVIEW_LABEL, WebviewUrl::App("index.html".into()))
        .title("Pré-visualização — Dev Suite")
        .initialization_script("window.__DEVSUITE_PREVIEW__ = true;")
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(860.0, 720.0)
        .min_inner_size(360.0, 260.0)
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Espaço sobre um .md: mostra a prévia (ou esconde, se já mostra o mesmo arquivo).
pub fn toggle_preview(app: &AppHandle, path: PathBuf) {
    let Some(w) = app.get_webview_window(PREVIEW_LABEL) else {
        let app2 = app.clone();
        // Desligada/fechada: cria agora (fora da thread do hook) e tenta de novo.
        tauri::async_runtime::spawn(async move {
            if ensure_preview(&app2).is_ok() {
                tokio::time::sleep(Duration::from_millis(600)).await;
                toggle_preview(&app2, path);
            }
        });
        return;
    };
    let same = PREVIEWING.lock().unwrap().as_ref().is_some_and(|p| key_of(p) == key_of(&path));
    if same && w.is_visible().unwrap_or(false) {
        hide_preview(app);
        return;
    }
    *PREVIEWING.lock().unwrap() = Some(path.clone());
    let _ = w.emit_to(PREVIEW_LABEL, "md-preview-show", path.to_string_lossy().to_string());
}

fn hide_preview(app: &AppHandle) {
    *PREVIEWING.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        let _ = w.hide();
    }
}

/// Centraliza no monitor do cursor (onde está o Explorer) e mostra.
fn present_preview(app: &AppHandle, w: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| w.current_monitor().ok().flatten());
    if let (Some(m), Ok(size)) = (monitor, w.outer_size()) {
        let area = m.work_area();
        let width = size.width.min(area.size.width);
        let height = size.height.min(area.size.height);
        let x = area.position.x + (area.size.width as i32 - width as i32) / 2;
        let y = area.position.y + (area.size.height as i32 - height as i32) / 2;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

// ---------- Comandos ----------

#[derive(Serialize)]
pub struct MdText {
    text: String,
    mtime: u64,
    token: String,
    name: String,
}

#[tauri::command]
pub async fn md_file_read(path: String) -> Result<MdText, String> {
    let path = PathBuf::from(path);
    let meta = fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.len() > MAX_MD_BYTES {
        return Err("Arquivo grande demais para abrir (máx. 20 MB).".into());
    }
    let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(MdText {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        mtime: mtime_ms(&meta),
        token: register_dir(&path),
        name: file_name(&path),
    })
}

#[derive(Serialize)]
pub struct MdWrite {
    mtime: u64,
    conflict: bool,
}

/// Grava o arquivo (temporário oculto + rename). `expected_mtime` = versão que a janela leu:
/// se o arquivo mudou no disco desde então, nada é gravado e volta `conflict: true`.
#[tauri::command]
pub async fn md_file_write(path: String, text: String, expected_mtime: Option<u64>) -> Result<MdWrite, String> {
    let path = PathBuf::from(path);
    write_checked(&path, &text, expected_mtime)
}

fn write_checked(path: &Path, text: &str, expected_mtime: Option<u64>) -> Result<MdWrite, String> {
    if let (Some(expected), Ok(meta)) = (expected_mtime, fs::metadata(path)) {
        let current = mtime_ms(&meta);
        if current != expected {
            return Ok(MdWrite { mtime: current, conflict: true });
        }
    }
    let dir = path.parent().ok_or("Caminho inválido.")?;
    let tmp = dir.join(format!(".{}.devsuite-tmp", file_name(path)));
    fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {e}", path.display()));
    }
    let mtime = fs::metadata(path).map(|m| mtime_ms(&m)).unwrap_or(0);
    Ok(MdWrite { mtime, conflict: false })
}

fn attachments_of(token: &str) -> Result<PathBuf, String> {
    let dir = dir_of_token(token).ok_or("Arquivo não está aberto.")?;
    Ok(dir.join(crate::notes_vault::ATTACHMENTS_DIR))
}

/// Imagem colada: bytes crus no corpo, headers `x-token` e `x-ext`. Devolve o caminho
/// relativo ao arquivo (`attachments/<hash>.<ext>`).
#[tauri::command]
pub async fn md_file_save_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Corpo inválido.".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let name = crate::note_images::store_in(&attachments_of(&header("x-token"))?, bytes, &header("x-ext"))?;
    Ok(format!("{}/{name}", crate::notes_vault::ATTACHMENTS_DIR))
}

/// Copia uma imagem do disco para `attachments/` ao lado do arquivo (Markdown colado).
#[tauri::command]
pub async fn md_file_import_image(token: String, path: String) -> Result<String, String> {
    let src = PathBuf::from(path);
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    let name = crate::note_images::store_in(&attachments_of(&token)?, &bytes, ext)?;
    Ok(format!("{}/{name}", crate::notes_vault::ATTACHMENTS_DIR))
}

/// Abre o arquivo para edição (botão "Editar" da prévia, "Abrir arquivo Markdown…").
#[tauri::command]
pub async fn md_open(app: AppHandle, path: String) -> Result<(), String> {
    open_file(&app, Path::new(&path))
}

#[tauri::command]
pub fn md_reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// A janela de arquivo já gravou: fecha de vez.
#[tauri::command]
pub fn md_window_close(window: WebviewWindow) {
    CLOSING.lock().unwrap().remove(window.label());
    let _ = window.destroy();
}

/// A prévia terminou de montar o arquivo: posiciona e mostra.
#[tauri::command]
pub fn md_preview_ready(app: AppHandle) {
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        present_preview(&app, &w);
    }
}

#[tauri::command]
pub fn md_preview_hide(app: AppHandle) {
    hide_preview(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("devsuite-md-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn md_arg_finds_markdown_files() {
        let dir = temp_dir("arg");
        fs::write(dir.join("a.md"), "# a").unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        let exe = "dev-suite.exe";
        assert_eq!(md_arg(&[exe, "--app=notes", "a.md"], &dir), Some(dir.join("a.md")));
        assert_eq!(md_arg(&[exe, "b.txt"], &dir), None);
        assert_eq!(md_arg(&[exe, "falta.md"], &dir), None);
        let abs = dir.join("a.md").to_string_lossy().to_string();
        assert_eq!(md_arg(&[exe, &abs], Path::new("/")), Some(dir.join("a.md")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_detects_conflicts_by_mtime() {
        let dir = temp_dir("write");
        let file = dir.join("n.md");
        fs::write(&file, "v1").unwrap();
        let read = mtime_ms(&fs::metadata(&file).unwrap());
        let ok = write_checked(&file, "v2", Some(read)).unwrap();
        assert!(!ok.conflict);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
        // A versão lida (read) ficou velha: não sobrescreve.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "de fora").unwrap();
        let stale = write_checked(&file, "v3", Some(ok.mtime.saturating_sub(1))).unwrap();
        assert!(stale.conflict);
        assert_eq!(fs::read_to_string(&file).unwrap(), "de fora");
        assert!(!dir.join(".n.md.devsuite-tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tokens_resolve_the_file_folder() {
        let dir = temp_dir("token");
        let file = dir.join("x.md");
        fs::write(&file, "").unwrap();
        let token = register_dir(&file);
        assert_eq!(dir_of_token(&token), Some(dir.clone()));
        fs::create_dir_all(dir.join("img")).unwrap();
        fs::write(dir.join("img").join("a.png"), b"x").unwrap();
        let root = dir_of_token(&token).unwrap();
        assert!(crate::note_images::vault_file(&root, "img/a.png").is_some());
        // O JS manda o caminho num segmento só (fileImageUrl): "/" chega como %2F.
        assert!(crate::note_images::vault_file(&root, "img%2Fa.png").is_some());
        assert!(crate::note_images::vault_file(&root, "..%2Fx.md").is_none());
        assert!(crate::note_images::vault_file(&root, "../x.md").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}

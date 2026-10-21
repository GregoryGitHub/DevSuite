//! Imagens das notas.
//!
//! Cada imagem vira um arquivo em `<app_data>/note-images/` (nome = hash do conteúdo) e o
//! HTML da nota guarda só a URL do protocolo `noteimg`. Assim o notes.db continua
//! pequeno: salvar uma nota não regrava nem reserializa as imagens.
//!
//! No modo cofre (notes_vault.rs) as imagens coladas vão para `<cofre>/attachments/` e o
//! protocolo também serve qualquer arquivo do cofre por `noteimg://localhost/v/<caminho>`
//! (imagens que já estavam no cofre, referenciadas pelo Markdown).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, SystemTime};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::Manager;

pub const SCHEME: &str = "noteimg";
const MAX_BYTES: usize = 50 * 1024 * 1024;
/// Arquivos órfãos mais novos que isso não são apagados (ex.: colados e ainda não salvos).
const GC_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

/// Raiz do cofre aberto (None = notas no notes.db).
static VAULT_ROOT: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn set_vault_root(root: Option<PathBuf>) {
    if let Ok(mut r) = VAULT_ROOT.write() {
        *r = root;
    }
}

fn vault_root() -> Option<PathBuf> {
    VAULT_ROOT.read().ok().and_then(|r| r.clone())
}

fn images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = match vault_root() {
        Some(root) => root.join(crate::notes_vault::ATTACHMENTS_DIR),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?.join("note-images"),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Pasta das imagens do banco local (a cópia das notas para um cofre lê daqui).
fn local_images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("note-images"))
}

fn normalize_ext(ext: &str) -> Option<&'static str> {
    match ext.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" | "jfif" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "bmp" => Some("bmp"),
        "avif" => Some("avif"),
        _ => None,
    }
}

/// Detecta o formato pelos primeiros bytes (não confia na extensão nem no MIME do clipboard).
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") {
        Some("png")
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("jpg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"BM") {
        Some("bmp")
    } else if bytes.len() > 12 && &bytes[4..12] == b"ftypavif" {
        Some("avif")
    } else {
        None
    }
}

fn mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Nome gerado por `store`: só [a-z0-9] + extensão conhecida (sem barras nem `..`).
fn valid_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric()) && normalize_ext(ext) == Some(ext)
        }
        None => false,
    }
}

fn store(app: &tauri::AppHandle, bytes: &[u8], hint_ext: &str) -> Result<String, String> {
    store_in(&images_dir(app)?, bytes, hint_ext)
}

/// Grava a imagem em `dir` com o nome do hash do conteúdo (reaproveita se já existe).
pub fn store_in(dir: &Path, bytes: &[u8], hint_ext: &str) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Imagem vazia.".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err("Imagem muito grande (máx. 50 MB).".into());
    }
    let ext = sniff(bytes)
        .or_else(|| normalize_ext(hint_ext))
        .ok_or("Formato de imagem não suportado.")?;
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    let name = format!("{:016x}{:x}.{ext}", h.finish(), bytes.len());

    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    if !path.exists() {
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    Ok(name)
}

/// Salva uma imagem colada. O corpo da chamada são os bytes crus (sem base64);
/// o header `x-ext` é só uma dica de formato.
/// `async`: roda fora da thread da UI, então pode gravar direto no disco.
#[tauri::command]
pub async fn save_note_image(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Corpo inválido.".into());
    };
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    store(&app, bytes, ext)
}

/// Copia um arquivo de imagem do disco para as imagens das notas (importação de Markdown).
#[tauri::command]
pub async fn import_note_image(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    store(&app, &bytes, ext)
}

/// Copia as imagens indicadas para `dir` (exportação de Markdown). `local` = lê das imagens
/// do banco local mesmo com um cofre aberto (cópia das notas para o cofre).
#[tauri::command]
pub async fn export_note_images(app: tauri::AppHandle, names: Vec<String>, dir: String, local: Option<bool>) -> Result<(), String> {
    let src = if local.unwrap_or(false) { local_images_dir(&app)? } else { images_dir(&app)? };
    let dest = Path::new(&dir);
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for name in names.iter().filter(|n| valid_name(n)) {
        fs::copy(src.join(name), dest.join(name)).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(())
}

/// Apaga imagens que nenhuma nota (nem na lixeira) usa mais (`keep` vem do notes.db).
pub fn gc_note_images(app: &tauri::AppHandle, keep: &HashSet<String>) -> Result<u32, String> {
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in fs::read_dir(local_images_dir(app)?).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > GC_GRACE);
        if old && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Decodifica `%XX` (caminhos do cofre na URL).
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Arquivo do cofre para `v/<caminho>`: só caminhos relativos, sem `..`, e que continuem
/// dentro do cofre depois de resolver links simbólicos.
pub fn vault_file(root: &Path, encoded: &str) -> Option<PathBuf> {
    let rel = percent_decode(encoded)?;
    let rel = Path::new(&rel);
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let path = root.join(rel).canonicalize().ok()?;
    (path.starts_with(&root) && path.is_file()).then_some(path)
}

/// Responde `noteimg://localhost/<nome>` (ou `http://noteimg.localhost/<nome>` no Windows).
pub fn serve(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let name = request.uri().path().trim_start_matches('/');
    // `v/<caminho>` = arquivo do cofre; `f/<token>/<caminho>` = ao lado de um .md aberto fora das
    // Notas (md_files.rs). Os dois só servem arquivos dentro da pasta de origem.
    let local = if let Some(encoded) = name.strip_prefix("v/") {
        Some(vault_root().and_then(|root| vault_file(&root, encoded)))
    } else if let Some((token, encoded)) = name.strip_prefix("f/").and_then(|r| r.split_once('/')) {
        Some(crate::md_files::dir_of_token(token).and_then(|root| vault_file(&root, encoded)))
    } else {
        None
    };
    if let Some(path) = local {
        let ext = path
            .as_ref()
            .and_then(|p| p.extension())
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        return match path.and_then(|p| fs::read(p).ok()) {
            Some(bytes) => Response::builder()
                .header(header::CONTENT_TYPE, mime(normalize_ext(&ext).unwrap_or(&ext)))
                // O arquivo pode ser trocado por outra pessoa no cofre.
                .header(header::CACHE_CONTROL, "no-cache")
                .body(bytes)
                .unwrap(),
            None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
        };
    }
    let file = valid_name(name)
        .then(|| images_dir(app).ok())
        .flatten()
        .and_then(|dir| fs::read(dir.join(name)).ok());
    match file {
        Some(bytes) => {
            let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            Response::builder()
                .header(header::CONTENT_TYPE, mime(ext))
                // O nome é o hash do conteúdo: o arquivo nunca muda.
                .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                .body(bytes)
                .unwrap()
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_file_rejects_paths_outside_the_vault() {
        let dir = std::env::temp_dir().join(format!("todors-img-{}", std::process::id()));
        fs::create_dir_all(dir.join("cofre/img")).unwrap();
        fs::write(dir.join("cofre/img/a b.png"), "x").unwrap();
        fs::write(dir.join("fora.png"), "x").unwrap();
        let root = dir.join("cofre");
        assert!(vault_file(&root, "img/a%20b.png").is_some());
        assert!(vault_file(&root, "../fora.png").is_none());
        assert!(vault_file(&root, "img/../../fora.png").is_none());
        assert!(vault_file(&root, "%2E%2E/fora.png").is_none());
        assert!(vault_file(&root, "").is_none());
        let abs = dir.join("fora.png").to_string_lossy().replace('\\', "/");
        assert!(vault_file(&root, &abs).is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}

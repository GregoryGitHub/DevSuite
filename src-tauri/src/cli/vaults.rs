//! CLI: leitura de um armazenamento de notas que não é o ativo (o banco local quando as Notas
//! estão num cofre, ou outro cofre da lista), para `notes list/search/get --vault` e
//! `--all-vaults`. O ativo continua passando pelos comandos `notes_*` normais.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

use crate::notes_db;
use crate::notes_vault::{index_path, safe_name, Vault};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Store {
    Sqlite,
    Vault { path: String },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum StoreOp {
    /// { notes: [NoteMeta], folders: [Folder] }
    List,
    /// [id]
    Search { query: String },
    /// SQLite: HTML (string); cofre: { markdown, rel, mtime }; null = não existe.
    Get { id: u64 },
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn run(dir: &Path, store: Store, op: StoreOp) -> Result<Value, String> {
    let ser = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    match store {
        Store::Sqlite => {
            let conn = notes_db::open(&dir.join("notes.db")).map_err(|e| format!("Falha ao abrir notes.db: {e}"))?;
            let db = |e: rusqlite::Error| e.to_string();
            match op {
                StoreOp::List => Ok(json!({
                    "notes": notes_db::list(&conn, now_ms()).map_err(db)?,
                    "folders": notes_db::folders(&conn).map_err(db)?,
                })),
                StoreOp::Search { query } => ser(serde_json::to_value(notes_db::search(&conn, &query).map_err(db)?)),
                StoreOp::Get { id } => ser(serde_json::to_value(notes_db::get_content(&conn, id).map_err(db)?)),
            }
        }
        Store::Vault { path } => {
            let root = PathBuf::from(&path);
            let mut vault = Vault::open(&root, &index_path(dir, &root))?;
            match op {
                StoreOp::List => Ok(json!({ "notes": vault.list(now_ms())?, "folders": vault.folders()? })),
                StoreOp::Search { query } => ser(serde_json::to_value(vault.search(&query)?)),
                StoreOp::Get { id } => ser(serde_json::to_value(vault.get(id)?)),
            }
        }
    }
}

#[tauri::command]
pub async fn cli_store_read(app: tauri::AppHandle, store: Store, op: StoreOp) -> Result<Value, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || run(&dir, store, op)).await.map_err(|e| e.to_string())?
}

/// Cria uma nota num cofre que não é o ativo: `<cofre>/<dir>/<título>.md` (nunca sobrescreve;
/// com o nome ocupado vira "Título 2.md"). O índice do cofre a encontra no próximo scan.
/// Devolve o caminho relativo.
#[tauri::command]
pub async fn cli_vault_create(vault: String, dir: String, title: String, markdown: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&vault);
        if !root.is_dir() {
            return Err(format!("Cofre indisponível: {vault}"));
        }
        let dir = dir.trim_matches('/');
        if dir.split('/').any(|s| s == ".." || s == "." || s.contains('\\') || s.contains(':')) {
            return Err(format!("Pasta inválida: {dir}"));
        }
        let folder = if dir.is_empty() { root.clone() } else { root.join(dir) };
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let stem = safe_name(&title, "Nota");
        let mut n = 1;
        loop {
            let name = if n == 1 { format!("{stem}.md") } else { format!("{stem} {n}.md") };
            let path = folder.join(&name);
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    use std::io::Write;
                    f.write_all(markdown.as_bytes()).map_err(|e| e.to_string())?;
                    return Ok(if dir.is_empty() { name } else { format!("{dir}/{name}") });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

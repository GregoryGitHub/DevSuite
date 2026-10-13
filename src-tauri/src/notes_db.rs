//! Notas e pastas em SQLite (`<app_data>/notes.db`).
//!
//! Antes tudo ficava num único notes.json: abrir o app lia (e o JS fazia parse de) todas as
//! notas com o HTML inteiro, e cada edição regravava o arquivo todo. Aqui:
//!  - a lista carrega só metadados (título, prévia, datas, pasta) — o HTML vem com `notes_get`
//!    quando a nota é aberta;
//!  - salvar grava só a nota alterada (UPSERT), em transação (WAL), sem regravar o resto;
//!  - a busca usa FTS5 com tokenizador trigram: "contém o trecho", sem diferenciar
//!    maiúsculas nem acentos (consultas com menos de 3 caracteres caem num LIKE).
//!
//! Título, prévia, texto puro (busca) e imagens usadas são calculados pelo JS (que já
//! interpreta o HTML) e chegam prontos em `notes_save`. Na primeira execução o JS importa
//! o notes.json/folders.json antigos (`notes_legacy` + `notes_import`).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Notas em "Apagadas Recentemente" são removidas depois de 30 dias.
const TRASH_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_CHARS: usize = 240;

/// Conexão aberta no primeiro uso (comandos rodam fora da thread da UI).
#[derive(Default)]
pub struct NotesDb(Mutex<Option<Connection>>);

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct NoteMeta {
    pub id: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub created_at: String,
    /// Timestamp em milissegundos da última edição.
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub pinned: bool,
    /// 0 = pasta padrão "Notas".
    #[serde(default)]
    pub folder_id: u64,
    /// Preenchido quando a nota está em "Apagadas Recentemente".
    #[serde(default)]
    pub deleted_at: Option<u64>,
    /// Propriedades do modo Zettelkasten (front-matter): objeto JSON definido em zettel.js.
    #[serde(default)]
    pub props: serde_json::Value,
    /// Links `[[ ]]` da nota: ids (número) ou títulos ainda sem nota (texto).
    #[serde(default)]
    pub links: Vec<serde_json::Value>,
}

/// Nota completa enviada pelo JS ao salvar/importar.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct NoteSave {
    #[serde(flatten)]
    pub meta: NoteMeta,
    /// HTML do editor rico.
    pub content: String,
    /// Texto puro (linhas da nota) para a busca.
    #[serde(default)]
    pub plain: String,
    /// Nomes dos arquivos em note-images/ usados pela nota (limpeza de órfãos).
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Folder {
    pub id: u64,
    pub name: String,
    /// Pasta-mãe (0 = nível superior). Subpastas podem ter qualquer profundidade.
    #[serde(default)]
    pub parent_id: u64,
}

/// Conteúdo dos JSON antigos, devolvido ao JS para normalizar e importar.
#[derive(Serialize)]
pub struct Legacy {
    notes: Vec<serde_json::Value>,
    folders: Vec<Folder>,
}

// ---------- Banco (funções puras sobre a conexão; testadas abaixo) ----------

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    plain TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    folder_id INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    plain, content='notes', content_rowid='id', tokenize='trigram remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, plain) VALUES (new.id, new.plain);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF plain ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
    INSERT INTO notes_fts(rowid, plain) VALUES (new.id, new.plain);
END;
";

/// Migrações por `PRAGMA user_version` (cada índice = versão alcançada após rodar).
const MIGRATIONS: &[&str] = &[
    // v1: propriedades (front-matter) e links entre notas.
    "ALTER TABLE notes ADD COLUMN props TEXT NOT NULL DEFAULT '';
     ALTER TABLE notes ADD COLUMN links TEXT NOT NULL DEFAULT '';",
    // v2: subpastas.
    "ALTER TABLE folders ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0;",
];

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    // WAL: gravação rápida e sem bloquear leituras; NORMAL é seguro com WAL (só a última
    // transação pode se perder numa queda de energia, nunca o arquivo).
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(SCHEMA)?;
    let version: usize = conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        conn.execute_batch(&format!("BEGIN; {sql} PRAGMA user_version = {}; COMMIT;", i + 1))?;
    }
    Ok(())
}

fn json_text(v: &serde_json::Value) -> String {
    if v.is_null() { String::new() } else { v.to_string() }
}

fn parse_json(s: &str) -> serde_json::Value {
    if s.is_empty() { serde_json::Value::Null } else { serde_json::from_str(s).unwrap_or(serde_json::Value::Null) }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn i(v: u64) -> i64 {
    v as i64
}

fn preview_of(text: &str) -> String {
    let mut s: String = text.chars().take(PREVIEW_CHARS).collect();
    if text.chars().nth(PREVIEW_CHARS).is_some() {
        s.push('…');
    }
    s
}

fn meta_row(r: &rusqlite::Row) -> rusqlite::Result<NoteMeta> {
    Ok(NoteMeta {
        id: r.get::<_, i64>(0)? as u64,
        title: r.get(1)?,
        preview: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get::<_, i64>(4)? as u64,
        pinned: r.get(5)?,
        folder_id: r.get::<_, i64>(6)? as u64,
        deleted_at: r.get::<_, Option<i64>>(7)?.map(|v| v as u64),
        props: parse_json(&r.get::<_, String>(8)?),
        links: match parse_json(&r.get::<_, String>(9)?) {
            serde_json::Value::Array(a) => a,
            _ => Vec::new(),
        },
    })
}

/// Lista sem o HTML; antes, remove da lixeira o que passou de 30 dias.
pub fn list(conn: &Connection, now: u64) -> rusqlite::Result<Vec<NoteMeta>> {
    conn.execute(
        "DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        params![i(now.saturating_sub(TRASH_RETENTION_MS))],
    )?;
    let mut st = conn.prepare(
        "SELECT id, title, preview, created_at, updated_at, pinned, folder_id, deleted_at, props, links FROM notes ORDER BY updated_at DESC",
    )?;
    let rows = st.query_map([], meta_row)?;
    rows.collect()
}

pub fn get_content(conn: &Connection, id: u64) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT content FROM notes WHERE id = ?1", params![i(id)], |r| r.get(0)).optional()
}

fn upsert(conn: &Connection, n: &NoteSave, replace: bool) -> rusqlite::Result<usize> {
    let m = &n.meta;
    let sql = if replace {
        "INSERT INTO notes (id, title, preview, content, plain, images, created_at, updated_at, pinned, folder_id, deleted_at, props, links)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, preview = excluded.preview, content = excluded.content,
           plain = excluded.plain, images = excluded.images, created_at = excluded.created_at, updated_at = excluded.updated_at,
           pinned = excluded.pinned, folder_id = excluded.folder_id, deleted_at = excluded.deleted_at,
           props = excluded.props, links = excluded.links"
    } else {
        "INSERT OR IGNORE INTO notes (id, title, preview, content, plain, images, created_at, updated_at, pinned, folder_id, deleted_at, props, links)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
    };
    conn.execute(
        sql,
        params![
            i(m.id),
            m.title,
            preview_of(&m.preview),
            n.content,
            n.plain,
            n.images.join(" "),
            m.created_at,
            i(m.updated_at),
            m.pinned,
            i(m.folder_id),
            m.deleted_at.map(i),
            json_text(&m.props),
            if m.links.is_empty() { String::new() } else { serde_json::Value::Array(m.links.clone()).to_string() },
        ],
    )
}

pub fn save(conn: &Connection, n: &NoteSave) -> rusqlite::Result<()> {
    upsert(conn, n, true).map(|_| ())
}

/// Grava várias notas numa transação só (importação de uma pasta de Markdown).
pub fn save_many(conn: &mut Connection, notes: &[NoteSave]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for n in notes {
        upsert(&tx, n, true)?;
    }
    tx.commit()
}

/// Atualiza só fixada/pasta/lixeira/data (fixar, mover, apagar, restaurar) sem tocar no HTML.
pub fn set_meta(conn: &mut Connection, notes: &[NoteMeta]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare("UPDATE notes SET pinned = ?2, folder_id = ?3, deleted_at = ?4, updated_at = ?5 WHERE id = ?1")?;
        for m in notes {
            st.execute(params![i(m.id), m.pinned, i(m.folder_id), m.deleted_at.map(i), i(m.updated_at)])?;
        }
    }
    tx.commit()
}

pub fn delete(conn: &mut Connection, ids: &[u64]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare("DELETE FROM notes WHERE id = ?1")?;
        for id in ids {
            st.execute(params![i(*id)])?;
        }
    }
    tx.commit()
}

/// Ids das notas cujo texto contém `query` (sem diferenciar maiúsculas/acentos).
pub fn search(conn: &Connection, query: &str) -> rusqlite::Result<Vec<u64>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let map = |r: &rusqlite::Row| r.get::<_, i64>(0).map(|v| v as u64);
    if q.chars().count() >= 3 {
        // Frase entre aspas: os trigramas precisam aparecer em sequência = "contém o trecho".
        let phrase = format!("\"{}\"", q.replace('"', "\"\""));
        let mut st = conn.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1")?;
        let rows = st.query_map(params![phrase], map)?;
        rows.collect()
    } else {
        // O trigram não indexa trechos menores que 3 caracteres.
        let like = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut st = conn.prepare("SELECT id FROM notes WHERE plain LIKE ?1 ESCAPE '\\'")?;
        let rows = st.query_map(params![like], map)?;
        rows.collect()
    }
}

pub fn folders(conn: &Connection) -> rusqlite::Result<Vec<Folder>> {
    let mut st = conn.prepare("SELECT id, name, parent_id FROM folders ORDER BY position, id")?;
    let rows = st.query_map([], |r| {
        Ok(Folder { id: r.get::<_, i64>(0)? as u64, name: r.get(1)?, parent_id: r.get::<_, i64>(2)? as u64 })
    })?;
    rows.collect()
}

/// Substitui a lista de pastas (é pequena; a ordem do array vira `position`).
pub fn save_folders(conn: &mut Connection, folders: &[Folder]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM folders", [])?;
    {
        let mut st = tx.prepare("INSERT INTO folders (id, name, position, parent_id) VALUES (?1, ?2, ?3, ?4)")?;
        for (pos, f) in folders.iter().enumerate() {
            st.execute(params![i(f.id), f.name, pos as i64, i(f.parent_id)])?;
        }
    }
    tx.commit()
}

fn meta_value(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0)).optional()
}

pub fn is_migrated(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(meta_value(conn, "legacy_json")?.is_some())
}

pub fn mark_migrated(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_json', ?1)", params![now_ms().to_string()])?;
    Ok(())
}

/// Importa as notas/pastas do JSON antigo. Não sobrescreve notas que já existam no banco
/// (uma importação que falhou antes pode ser repetida sem perder edições feitas depois).
pub fn import(conn: &mut Connection, notes: &[NoteSave], folders: &[Folder]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut added = 0;
    for n in notes {
        added += upsert(&tx, n, false)?;
    }
    if !folders.is_empty() {
        let mut st = tx.prepare("INSERT OR IGNORE INTO folders (id, name, position, parent_id) VALUES (?1, ?2, ?3, ?4)")?;
        for (pos, f) in folders.iter().enumerate() {
            st.execute(params![i(f.id), f.name, pos as i64, i(f.parent_id)])?;
        }
    }
    mark_migrated(&tx)?;
    tx.commit()?;
    Ok(added)
}

/// Imagens referenciadas por alguma nota (inclusive na lixeira) e o total de notas.
pub fn image_names(conn: &Connection) -> rusqlite::Result<(usize, HashSet<String>)> {
    let mut st = conn.prepare("SELECT images FROM notes")?;
    let mut count = 0;
    let mut keep = HashSet::new();
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        count += 1;
        let s: String = r.get(0)?;
        keep.extend(s.split_whitespace().map(str::to_string));
    }
    Ok((count, keep))
}

// ---------- Comandos Tauri ----------

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Roda `f` com a conexão numa thread de bloqueio (nunca na thread da interface).
async fn with_db<T, F>(app: tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<NotesDb>();
        let mut guard = state.0.lock().map_err(|_| "banco de notas indisponível".to_string())?;
        if guard.is_none() {
            let path = data_dir(&app)?.join("notes.db");
            *guard = Some(open(&path).map_err(|e| format!("Falha ao abrir notes.db: {e}"))?);
        }
        f(guard.as_mut().unwrap()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notes_list(app: tauri::AppHandle) -> Result<Vec<NoteMeta>, String> {
    with_db(app, |c| list(c, now_ms())).await
}

#[tauri::command]
pub async fn notes_get(app: tauri::AppHandle, id: u64) -> Result<Option<String>, String> {
    with_db(app, move |c| get_content(c, id)).await
}

#[tauri::command]
pub async fn notes_save(app: tauri::AppHandle, note: NoteSave) -> Result<(), String> {
    with_db(app, move |c| save(c, &note)).await
}

#[tauri::command]
pub async fn notes_save_many(app: tauri::AppHandle, notes: Vec<NoteSave>) -> Result<(), String> {
    with_db(app, move |c| save_many(c, &notes)).await
}

#[tauri::command]
pub async fn notes_set_meta(app: tauri::AppHandle, notes: Vec<NoteMeta>) -> Result<(), String> {
    with_db(app, move |c| set_meta(c, &notes)).await
}

#[tauri::command]
pub async fn notes_delete(app: tauri::AppHandle, ids: Vec<u64>) -> Result<(), String> {
    with_db(app, move |c| delete(c, &ids)).await
}

#[tauri::command]
pub async fn notes_search(app: tauri::AppHandle, query: String) -> Result<Vec<u64>, String> {
    with_db(app, move |c| search(c, &query)).await
}

#[tauri::command]
pub async fn notes_folders(app: tauri::AppHandle) -> Result<Vec<Folder>, String> {
    with_db(app, |c| folders(c)).await
}

#[tauri::command]
pub async fn notes_save_folders(app: tauri::AppHandle, folders: Vec<Folder>) -> Result<(), String> {
    with_db(app, move |c| save_folders(c, &folders)).await
}

/// JSON antigos ainda não importados (None se já importados ou se não existem).
/// Erro = notes.json ilegível: nada é marcado e o arquivo fica intacto.
#[tauri::command]
pub async fn notes_legacy(app: tauri::AppHandle) -> Result<Option<Legacy>, String> {
    let dir = data_dir(&app)?;
    with_db(app, move |c| {
        if is_migrated(c)? {
            return Ok(Ok(None));
        }
        let notes_path = dir.join("notes.json");
        let folders_path = dir.join("folders.json");
        if !notes_path.exists() && !folders_path.exists() {
            mark_migrated(c)?;
            return Ok(Ok(None));
        }
        let notes = match fs::read_to_string(&notes_path) {
            Ok(raw) => match serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
                Ok(v) => v,
                Err(e) => return Ok(Err(format!("notes.json ilegível ({e}); o arquivo foi mantido sem alterações"))),
            },
            Err(_) => Vec::new(),
        };
        let folders = fs::read_to_string(&folders_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Folder>>(&s).ok())
            .unwrap_or_default();
        Ok(Ok(Some(Legacy { notes, folders })))
    })
    .await?
}

/// Grava as notas/pastas importadas e renomeia os JSON antigos para *.migrated (backup).
#[tauri::command]
pub async fn notes_import(app: tauri::AppHandle, notes: Vec<NoteSave>, folders: Vec<Folder>) -> Result<usize, String> {
    let dir = data_dir(&app)?;
    let added = with_db(app, move |c| import(c, &notes, &folders)).await?;
    for name in ["notes.json", "folders.json"] {
        let path = dir.join(name);
        if path.exists() {
            let _ = fs::rename(&path, dir.join(format!("{name}.migrated")));
        }
    }
    Ok(added)
}

// ---------- Importar uma pasta de Markdown ----------

const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd"];
const MAX_MD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SCAN_FILES: usize = 50_000;

/// Arquivo encontrado; `rel` usa "/" e é relativo à pasta escolhida.
#[derive(Serialize, Debug)]
pub struct ScannedFile {
    pub rel: String,
    pub path: String,
}

#[derive(Serialize, Debug)]
pub struct ScannedNote {
    pub rel: String,
    pub path: String,
    pub text: String,
    /// Data de modificação do arquivo (ms), usada como data da nota.
    pub modified: u64,
}

/// Conteúdo de uma pasta: notas (.md com o texto) e os demais arquivos (imagens/anexos,
/// para resolver `![](../anexos/x.png)` e `![[x.png]]` do Obsidian).
#[derive(Serialize, Debug, Default)]
pub struct DirScan {
    pub name: String,
    pub notes: Vec<ScannedNote>,
    pub files: Vec<ScannedFile>,
    /// Arquivos .md ignorados (grandes demais ou ilegíveis).
    pub skipped: Vec<String>,
}

/// Percorre `root` recursivamente, sem seguir links e pulando pastas ocultas
/// (.obsidian, .git, .trash...) e node_modules.
pub fn scan_markdown_dir(root: &Path) -> std::io::Result<DirScan> {
    let mut scan = DirScan {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        ..Default::default()
    };
    let mut stack = vec![(root.to_path_buf(), String::new())];
    let mut seen = 0usize;
    while let Some((dir, prefix)) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir)?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if ft.is_dir() {
                if name != "node_modules" {
                    stack.push((entry.path(), rel));
                }
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            seen += 1;
            if seen > MAX_SCAN_FILES {
                return Err(std::io::Error::other(format!("a pasta tem mais de {MAX_SCAN_FILES} arquivos")));
            }
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let path_str = path.to_string_lossy().into_owned();
            if MD_EXTS.contains(&ext.as_str()) {
                let too_big = entry.metadata().map(|m| m.len() > MAX_MD_BYTES).unwrap_or(true);
                match (too_big, fs::read(&path)) {
                    (false, Ok(bytes)) => {
                        let text = String::from_utf8_lossy(&bytes);
                        let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
                        let modified = entry
                            .metadata()
                            .and_then(|m| m.modified())
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        scan.notes.push(ScannedNote { rel, path: path_str, text, modified });
                    }
                    _ => scan.skipped.push(rel),
                }
            } else {
                scan.files.push(ScannedFile { rel, path: path_str });
            }
        }
    }
    scan.notes.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(scan)
}

/// Lê uma pasta de Markdown escolhida pelo usuário (fora da thread da interface).
#[tauri::command]
pub async fn notes_scan_dir(dir: String) -> Result<DirScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan_markdown_dir(Path::new(&dir)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Apaga imagens que nenhuma nota usa (lista de nomes vem do banco).
#[tauri::command]
pub async fn notes_gc_images(app: tauri::AppHandle) -> Result<u32, String> {
    let (count, keep) = with_db(app.clone(), |c| image_names(c)).await?;
    if count == 0 {
        return Ok(0); // banco vazio (importação pendente?): não arrisca apagar nada
    }
    tauri::async_runtime::spawn_blocking(move || crate::note_images::gc_note_images(&app, &keep))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    fn note(id: u64, plain: &str) -> NoteSave {
        NoteSave {
            meta: NoteMeta { id, title: plain.lines().next().unwrap_or("").into(), preview: plain.into(), updated_at: id, ..Default::default() },
            content: format!("<p>{plain}</p>"),
            plain: plain.into(),
            images: vec![],
        }
    }

    #[test]
    fn sqlite_supports_trigram_without_diacritics() {
        let c = db();
        let v: String = c.query_row("SELECT sqlite_version()", [], |r| r.get(0)).unwrap();
        let parts: Vec<u32> = v.split('.').map(|p| p.parse().unwrap()).collect();
        assert!(parts[0] > 3 || (parts[0] == 3 && parts[1] >= 45), "SQLite {v} < 3.45");
    }

    #[test]
    fn save_list_get_update() {
        let mut c = db();
        save(&c, &note(1, "Primeira\nlinha dois")).unwrap();
        save(&c, &note(2, "Segunda")).unwrap();
        let l = list(&c, now_ms()).unwrap();
        assert_eq!(l.iter().map(|n| n.id).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(get_content(&c, 1).unwrap().as_deref(), Some("<p>Primeira\nlinha dois</p>"));
        assert_eq!(get_content(&c, 9).unwrap(), None);

        let mut n = note(1, "Editada");
        n.meta.updated_at = 5;
        save(&c, &n).unwrap();
        assert_eq!(get_content(&c, 1).unwrap().as_deref(), Some("<p>Editada</p>"));
        assert_eq!(search(&c, "Primeira").unwrap(), Vec::<u64>::new());
        assert_eq!(search(&c, "editad").unwrap(), vec![1]);

        set_meta(&mut c, &[NoteMeta { id: 2, pinned: true, folder_id: 7, deleted_at: Some(9), updated_at: 10, ..Default::default() }]).unwrap();
        let two = list(&c, 10).unwrap().into_iter().find(|n| n.id == 2).unwrap();
        assert!(two.pinned && two.folder_id == 7 && two.deleted_at == Some(9) && two.title == "Segunda");
        // HTML não é tocado por set_meta.
        assert_eq!(get_content(&c, 2).unwrap().as_deref(), Some("<p>Segunda</p>"));

        delete(&mut c, &[1, 2]).unwrap();
        assert!(list(&c, now_ms()).unwrap().is_empty());
        assert!(search(&c, "Segunda").unwrap().is_empty());
    }

    #[test]
    fn search_is_substring_case_and_accent_insensitive() {
        let c = db();
        save(&c, &note(1, "Reunião de Planejamento")).unwrap();
        save(&c, &note(2, "lista de compras: AÇÚCAR, café")).unwrap();
        save(&c, &note(3, "id 128a6764-598b \"aspas\" 50% off")).unwrap();
        assert_eq!(search(&c, "planej").unwrap(), vec![1]);
        assert_eq!(search(&c, "nejam").unwrap(), vec![1]); // meio da palavra
        assert_eq!(search(&c, "reuniao").unwrap(), vec![1]); // sem acento
        assert_eq!(search(&c, "acucar").unwrap(), vec![2]);
        assert_eq!(search(&c, "de ").unwrap().len(), 2);
        assert_eq!(search(&c, "6764-598").unwrap(), vec![3]);
        assert_eq!(search(&c, "\"aspas\"").unwrap(), vec![3]);
        // Curtas (< 3) usam LIKE.
        assert_eq!(search(&c, "50").unwrap(), vec![3]);
        assert_eq!(search(&c, "%").unwrap(), vec![3]);
        assert_eq!(search(&c, "_").unwrap(), Vec::<u64>::new());
        assert!(search(&c, "   ").unwrap().is_empty());
        assert!(search(&c, "inexistente").unwrap().is_empty());
    }

    #[test]
    fn trash_older_than_30_days_is_purged_on_list() {
        let c = db();
        let mut old = note(1, "velha");
        old.meta.deleted_at = Some(1_000);
        let mut recent = note(2, "recente");
        let now = 40 * 24 * 60 * 60 * 1000;
        recent.meta.deleted_at = Some(now - 1_000);
        save(&c, &old).unwrap();
        save(&c, &recent).unwrap();
        save(&c, &note(3, "ativa")).unwrap();
        let ids: Vec<u64> = list(&c, now).unwrap().iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![3, 2]);
    }

    #[test]
    fn preview_is_truncated() {
        let c = db();
        let mut n = note(1, "x");
        n.meta.preview = "a".repeat(1000);
        save(&c, &n).unwrap();
        let p = &list(&c, now_ms()).unwrap()[0].preview;
        assert_eq!(p.chars().count(), PREVIEW_CHARS + 1);
        assert!(p.ends_with('…'));
    }

    #[test]
    fn folders_replace_in_order() {
        let mut c = db();
        save_folders(&mut c, &[Folder { id: 5, name: "B".into(), parent_id: 0 }, Folder { id: 3, name: "A".into(), parent_id: 5 }]).unwrap();
        let got = folders(&c).unwrap();
        assert_eq!(got.iter().map(|f| f.id).collect::<Vec<_>>(), vec![5, 3]);
        assert_eq!(got[1].parent_id, 5);
        save_folders(&mut c, &[Folder { id: 3, name: "A2".into(), parent_id: 0 }]).unwrap();
        assert_eq!(folders(&c).unwrap(), vec![Folder { id: 3, name: "A2".into(), parent_id: 0 }]);
    }

    #[test]
    fn import_keeps_existing_notes_and_marks_migrated() {
        let mut c = db();
        assert!(!is_migrated(&c).unwrap());
        save(&c, &note(1, "editada depois")).unwrap();
        let added = import(&mut c, &[note(1, "versão antiga"), note(2, "nova")], &[Folder { id: 9, name: "P".into(), parent_id: 0 }]).unwrap();
        assert_eq!(added, 1);
        assert_eq!(get_content(&c, 1).unwrap().as_deref(), Some("<p>editada depois</p>"));
        assert_eq!(folders(&c).unwrap().len(), 1);
        assert!(is_migrated(&c).unwrap());
        assert_eq!(search(&c, "nova").unwrap(), vec![2]);
    }

    #[test]
    fn image_names_cover_all_notes() {
        let c = db();
        let mut a = note(1, "a");
        a.images = vec!["x.png".into(), "y.jpg".into()];
        let mut b = note(2, "b");
        b.images = vec!["y.jpg".into(), "z.gif".into()];
        b.meta.deleted_at = Some(now_ms()); // lixeira também conta
        save(&c, &a).unwrap();
        save(&c, &b).unwrap();
        let (count, keep) = image_names(&c).unwrap();
        assert_eq!(count, 2);
        assert_eq!(keep, ["x.png", "y.jpg", "z.gif"].into_iter().map(String::from).collect());
    }

    #[test]
    fn old_database_is_migrated() {
        let c = Connection::open_in_memory().unwrap();
        // Esquema anterior às propriedades (user_version 0, sem props/links).
        c.execute_batch(SCHEMA).unwrap();
        c.execute("INSERT INTO notes (id, title, content, plain) VALUES (1, 'T', '<h1>T</h1>', 'T')", []).unwrap();
        init(&c).unwrap();
        init(&c).unwrap(); // idempotente
        let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        let n = &list(&c, now_ms()).unwrap()[0];
        assert!(n.props.is_null() && n.links.is_empty());
        // Pastas antigas ficam no nível superior.
        c.execute("INSERT INTO folders (id, name) VALUES (4, 'Velha')", []).unwrap();
        assert_eq!(folders(&c).unwrap()[0].parent_id, 0);
    }

    #[test]
    fn save_many_writes_all_in_one_transaction() {
        let mut c = db();
        save_many(&mut c, &[note(1, "um"), note(2, "dois"), note(3, "três")]).unwrap();
        assert_eq!(list(&c, now_ms()).unwrap().len(), 3);
        assert_eq!(search(&c, "tres").unwrap(), vec![3]);
    }

    #[test]
    fn scan_markdown_dir_walks_subfolders() {
        let root = std::env::temp_dir().join(format!("todors-scan-{}", now_ms()));
        fs::create_dir_all(root.join("Projetos/Rust")).unwrap();
        fs::create_dir_all(root.join("Vazia")).unwrap();
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::create_dir_all(root.join("anexos")).unwrap();
        fs::write(root.join("Inicio.md"), "\u{feff}# Início").unwrap();
        fs::write(root.join("Projetos/Rust/Tauri.markdown"), "# Tauri").unwrap();
        fs::write(root.join(".obsidian/config.md"), "x").unwrap();
        fs::write(root.join("anexos/a.png"), [0u8; 4]).unwrap();
        let scan = scan_markdown_dir(&root).unwrap();
        fs::remove_dir_all(&root).unwrap();
        let rels: Vec<_> = scan.notes.iter().map(|n| n.rel.as_str()).collect();
        assert_eq!(rels, vec!["Inicio.md", "Projetos/Rust/Tauri.markdown"]);
        assert_eq!(scan.notes[0].text, "# Início"); // sem BOM
        assert_eq!(scan.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), vec!["anexos/a.png"]);
        assert!(scan.name.starts_with("todors-scan-"));
    }

    #[test]
    fn props_and_links_round_trip_and_survive_set_meta() {
        let mut c = db();
        let mut n = note(1, "Zettel");
        n.meta.props = serde_json::json!({ "zid": "202610081530", "tags": ["rust", "sqlite"] });
        n.meta.links = vec![serde_json::json!(2), serde_json::json!("Sem nota")];
        save(&c, &n).unwrap();
        let got = list(&c, now_ms()).unwrap().remove(0);
        assert_eq!(got.props, n.meta.props);
        assert_eq!(got.links, n.meta.links);
        set_meta(&mut c, &[NoteMeta { id: 1, pinned: true, updated_at: 3, ..Default::default() }]).unwrap();
        let got = list(&c, now_ms()).unwrap().remove(0);
        assert!(got.pinned);
        assert_eq!(got.props, n.meta.props);
        assert_eq!(got.links, n.meta.links);
    }

    #[test]
    fn note_save_accepts_js_payload() {
        let n: NoteSave = serde_json::from_str(
            r#"{"id":1,"title":"T","preview":"p","created_at":"2026-01-01","updated_at":2,"pinned":false,"folder_id":0,"deleted_at":null,"content":"<h1>T</h1>","plain":"T","images":["a.png"]}"#,
        )
        .unwrap();
        assert_eq!(n.meta.id, 1);
        assert_eq!(n.images, vec!["a.png"]);
    }
}

//! Notas num "cofre": uma pasta de arquivos Markdown (como o Obsidian), que pode estar numa
//! pasta de rede compartilhada.
//!
//! Os arquivos são a fonte da verdade: `<cofre>/a/b/Título.md` é a nota "Título" na pasta
//! `a/b`; diretórios são pastas; a lixeira é `<cofre>/.trash/`; imagens coladas vão para
//! `<cofre>/attachments/`. A conversão Markdown <-> HTML fica no JS (a mesma da importação).
//!
//! Para a lista e a busca continuarem rápidas numa pasta de rede, há um índice local
//! (`<app_data>/vaults/<hash do caminho>.db`, nunca no cofre): caminho <-> id estável, mtime,
//! título, prévia, front-matter, links e texto da busca (FTS5 trigram). Ele é só um cache:
//! `scan` compara mtime/tamanho com o disco e relê o que mudou (renomeação externa = arquivo
//! sumido + arquivo novo com o mesmo conteúdo, mantém o id). "Fixada" fica só no índice
//! (preferência de cada usuário, não suja a pasta compartilhada).
//!
//! Gravação: temporário oculto no mesmo diretório + rename (atômico também em SMB). Se o
//! arquivo mudou no disco desde a última leitura, nada é sobrescrito: a versão do app vai
//! para "Título (conflito <máquina> <data>).md".

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::notes_db::{Folder, NoteMeta, NoteSave};

pub const TRASH_DIR: &str = ".trash";
pub const ATTACHMENTS_DIR: &str = "attachments";
const TRASH_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_CHARS: usize = 240;
const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd"];
const MAX_MD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 100_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    rel TEXT NOT NULL UNIQUE,
    mtime INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    hash TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    plain TEXT NOT NULL DEFAULT '',
    front_matter TEXT NOT NULL DEFAULT '',
    links TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    folder_id INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    rel TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    plain, content='files', content_rowid='id', tokenize='trigram remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, plain) VALUES (new.id, new.plain);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE OF plain ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
    INSERT INTO files_fts(rowid, plain) VALUES (new.id, new.plain);
END;
";

type Res<T> = Result<T, String>;

fn sql<T>(r: rusqlite::Result<T>) -> Res<T> {
    r.map_err(|e| e.to_string())
}

fn io<T>(r: std::io::Result<T>, what: &Path) -> Res<T> {
    r.map_err(|e| format!("{}: {e}", what.display()))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn content_hash(bytes: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}{:x}", h.finish(), bytes.len())
}

fn is_md(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, e)| MD_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Pai de um caminho relativo ("a/b/c.md" -> "a/b"; "c.md" -> "").
fn parent_rel(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

fn file_name(rel: &str) -> &str {
    rel.rsplit_once('/').map(|(_, n)| n).unwrap_or(rel)
}

fn stem_of(rel: &str) -> &str {
    let name = file_name(rel);
    name.rsplit_once('.').map(|(s, _)| s).filter(|s| !s.is_empty()).unwrap_or(name)
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

fn in_trash(rel: &str) -> bool {
    rel == TRASH_DIR || rel.starts_with(".trash/")
}

/// Nome de arquivo/pasta seguro em qualquer SO (como `safeFileName` do JS, mais as regras do
/// Windows: sem ponto/espaço no fim e sem nomes reservados).
pub fn safe_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let mut s: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    let s = s.trim_start_matches('.').to_string();
    if s.is_empty() {
        return fallback.to_string();
    }
    let upper = s.to_ascii_uppercase();
    let base = upper.split('.').next().unwrap_or("");
    let reserved = matches!(base, "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && base.as_bytes()[3].is_ascii_digit());
    if reserved { format!("{s}_") } else { s }
}

/// Separa o front-matter (`---\n...\n---`) do corpo.
pub fn split_front_matter(text: &str) -> (Option<&str>, &str) {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = t.strip_prefix("---\n").or_else(|| t.strip_prefix("---\r\n")) else {
        return (None, t);
    };
    let mut pos = 0;
    for line in rest.split_inclusive('\n') {
        let l = line.trim_end_matches(['\r', '\n']);
        if l == "---" || l == "..." {
            return (Some(rest[..pos].trim_end_matches(['\r', '\n'])), &rest[pos + line.len()..]);
        }
        pos += line.len();
    }
    (None, t)
}

/// Linhas de texto do Markdown, sem marcadores de bloco (prévia e busca).
fn text_lines(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in body.lines() {
        let mut l = line.trim();
        if l.starts_with("```") || l.starts_with("~~~") || l.chars().all(|c| matches!(c, '-' | '*' | '_' | '|' | ':' | ' ')) {
            continue;
        }
        l = l.trim_start_matches(|c| matches!(c, '#' | '>' | ' '));
        for marker in ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ "] {
            if let Some(r) = l.strip_prefix(marker) {
                l = r;
                break;
            }
        }
        let l = l.replace(['*', '`', '~'], "").replace("[[", "").replace("]]", "");
        let l = l.trim();
        if !l.is_empty() {
            out.push(l.to_string());
        }
    }
    out
}

/// Alvos dos links `[[Título]]` / `[[Título|texto]]` / `[[pasta/Título#seção]]` (sem repetição).
fn md_links(body: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut pos = 0;
    while let Some(found) = body[pos..].find("[[") {
        let start = pos + found;
        let Some(end) = body[start + 2..].find("]]") else { break };
        let inner = &body[start + 2..start + 2 + end];
        pos = start + 2 + end + 2;
        // `![[x]]` é imagem/embed, não link.
        if inner.contains('\n') || inner.contains('[') || body[..start].ends_with('!') {
            continue;
        }
        let target = inner.split('|').next().unwrap_or("");
        let target = target.split('#').next().unwrap_or("").trim();
        let target = target.rsplit('/').next().unwrap_or(target);
        let target = target.strip_suffix(".md").unwrap_or(target).trim();
        if !target.is_empty() && seen.insert(target.to_lowercase()) {
            out.push(serde_json::Value::String(target.to_string()));
        }
    }
    out
}

fn preview_of(text: &str) -> String {
    let mut s: String = text.chars().take(PREVIEW_CHARS).collect();
    if text.chars().nth(PREVIEW_CHARS).is_some() {
        s.push('…');
    }
    s
}

/// Metadados derivados de um arquivo lido do disco (alterado fora do app).
struct Derived {
    title: String,
    preview: String,
    plain: String,
    front_matter: String,
    links: String,
}

fn derive(rel: &str, text: &str) -> Derived {
    let title = stem_of(rel).to_string();
    let (fm, body) = split_front_matter(text);
    let mut lines = text_lines(body);
    // O 1º título igual ao nome do arquivo não entra na prévia.
    if lines.first().is_some_and(|l| l.to_lowercase() == title.to_lowercase()) {
        lines.remove(0);
    }
    let links = md_links(body);
    let mut plain = format!("{title}\n{}", lines.join("\n"));
    if let Some(fm) = fm {
        plain.push('\n');
        plain.push_str(fm);
    }
    Derived {
        title,
        preview: preview_of(&lines.join(" ")),
        plain,
        front_matter: fm.unwrap_or("").to_string(),
        links: if links.is_empty() { String::new() } else { serde_json::Value::Array(links).to_string() },
    }
}

fn iso_date(meta: &fs::Metadata) -> String {
    let t = meta.created().or_else(|_| meta.modified()).unwrap_or_else(|_| SystemTime::now());
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|h| safe_name(&h, "outro"))
        .unwrap_or_else(|| "outro".into())
}

pub(crate) fn write_atomic(path: &Path, text: &str) -> Res<()> {
    let dir = path.parent().ok_or("caminho inválido")?;
    io(fs::create_dir_all(dir), dir)?;
    let tmp = dir.join(format!(".{}.todors-tmp", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
    io(fs::write(&tmp, text.as_bytes()), &tmp)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {e}", path.display()));
    }
    Ok(())
}

/// Resultado de `save`: mtime gravado (base para detectar conflito na próxima gravação),
/// caminho final e, em conflito, o nome do arquivo com a versão do app.
#[derive(Serialize, Default, Debug)]
pub struct SaveResult {
    pub disk_mtime: Option<u64>,
    pub rel: Option<String>,
    pub conflict: Option<String>,
}

/// Conteúdo de uma nota do cofre (o JS converte o Markdown em HTML).
#[derive(Serialize, Debug)]
pub struct VaultContent {
    pub markdown: String,
    pub rel: String,
    pub mtime: u64,
}

/// O que mudou no disco desde o último scan.
#[derive(Serialize, Default, Debug)]
pub struct ScanDiff {
    pub changed: Vec<NoteMeta>,
    pub removed: Vec<u64>,
    /// Pastas atuais, quando alguma foi criada/removida fora do app.
    pub folders: Option<Vec<Folder>>,
}

struct Row {
    id: u64,
    rel: String,
    mtime: u64,
    size: u64,
    hash: String,
    folder_id: u64,
}

struct DiskFile {
    rel: String,
    mtime: u64,
    size: u64,
}

pub struct Vault {
    pub root: PathBuf,
    idx: Connection,
}

impl Vault {
    /// Abre o cofre (a pasta precisa existir) e o índice local, e sincroniza com o disco.
    pub fn open(root: &Path, index_path: &Path) -> Res<Vault> {
        let meta = fs::metadata(root).map_err(|e| format!("Cofre indisponível ({}): {e}", root.display()))?;
        if !meta.is_dir() {
            return Err(format!("O cofre não é uma pasta: {}", root.display()));
        }
        if let Some(dir) = index_path.parent() {
            io(fs::create_dir_all(dir), dir)?;
        }
        let idx = sql(Connection::open(index_path))?;
        Self::with_index(root, idx)
    }

    pub fn with_index(root: &Path, idx: Connection) -> Res<Vault> {
        sql(idx.pragma_update(None, "journal_mode", "WAL"))?;
        sql(idx.pragma_update(None, "synchronous", "NORMAL"))?;
        sql(idx.execute_batch(SCHEMA))?;
        let mut v = Vault { root: root.to_path_buf(), idx };
        v.scan()?;
        Ok(v)
    }

    fn abs(&self, rel: &str) -> PathBuf {
        rel.split('/').filter(|p| !p.is_empty()).fold(self.root.clone(), |p, s| p.join(s))
    }

    // ---------- Caminhada no disco ----------

    fn walk(&self) -> Res<(Vec<String>, Vec<DiskFile>, Vec<String>)> {
        let mut dirs = Vec::new();
        let mut notes = Vec::new();
        let mut others = Vec::new();
        let mut stack = vec![String::new()];
        let mut seen = 0usize;
        while let Some(rel_dir) = stack.pop() {
            let dir = self.abs(&rel_dir);
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) if rel_dir.is_empty() => return Err(format!("Cofre indisponível ({}): {e}", self.root.display())),
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = join_rel(&rel_dir, &name);
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_dir() {
                    // Pastas ocultas (.obsidian, .git...) ficam de fora, menos a lixeira.
                    let hidden = name.starts_with('.') && !(rel_dir.is_empty() && name == TRASH_DIR);
                    if hidden || name == "node_modules" {
                        continue;
                    }
                    if !in_trash(&rel) && !(rel_dir.is_empty() && name == ATTACHMENTS_DIR) {
                        dirs.push(rel.clone());
                    }
                    stack.push(rel);
                    continue;
                }
                if !ft.is_file() || name.starts_with('.') {
                    continue;
                }
                seen += 1;
                if seen > MAX_FILES {
                    return Err(format!("O cofre tem mais de {MAX_FILES} arquivos"));
                }
                if is_md(&name) {
                    let Ok(meta) = entry.metadata() else { continue };
                    if meta.len() <= MAX_MD_BYTES {
                        notes.push(DiskFile { rel, mtime: mtime_ms(&meta), size: meta.len() });
                    }
                } else if !in_trash(&rel) {
                    others.push(rel);
                }
            }
        }
        dirs.sort();
        Ok((dirs, notes, others))
    }

    /// Arquivos que não são notas (imagens/anexos), para resolver `![[x.png]]` ao abrir.
    pub fn files(&self) -> Res<Vec<String>> {
        let (_, _, mut others) = self.walk()?;
        others.sort();
        Ok(others)
    }

    // ---------- Índice ----------

    fn rows(&self) -> Res<Vec<Row>> {
        let mut st = sql(self.idx.prepare("SELECT id, rel, mtime, size, hash, folder_id FROM files"))?;
        let rows = sql(st.query_map([], |r| {
            Ok(Row {
                id: r.get::<_, i64>(0)? as u64,
                rel: r.get(1)?,
                mtime: r.get::<_, i64>(2)? as u64,
                size: r.get::<_, i64>(3)? as u64,
                hash: r.get(4)?,
                folder_id: r.get::<_, i64>(5)? as u64,
            })
        }))?;
        sql(rows.collect())
    }

    fn row(&self, id: u64) -> Res<Option<Row>> {
        sql(self
            .idx
            .query_row("SELECT id, rel, mtime, size, hash, folder_id FROM files WHERE id = ?1", params![id as i64], |r| {
                Ok(Row {
                    id: r.get::<_, i64>(0)? as u64,
                    rel: r.get(1)?,
                    mtime: r.get::<_, i64>(2)? as u64,
                    size: r.get::<_, i64>(3)? as u64,
                    hash: r.get(4)?,
                    folder_id: r.get::<_, i64>(5)? as u64,
                })
            })
            .optional())
    }

    fn folder_map(&self) -> Res<HashMap<u64, String>> {
        let mut st = sql(self.idx.prepare("SELECT id, rel FROM folders"))?;
        let rows = sql(st.query_map([], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?))))?;
        sql(rows.collect())
    }

    fn folder_id_of(&self, dir: &str) -> Res<u64> {
        if dir.is_empty() {
            return Ok(0);
        }
        Ok(sql(self.idx.query_row("SELECT id FROM folders WHERE rel = ?1", params![dir], |r| r.get::<_, i64>(0)).optional())?
            .map(|v| v as u64)
            .unwrap_or(0))
    }

    fn folder_rel(&self, id: u64) -> Res<String> {
        if id == 0 {
            return Ok(String::new());
        }
        Ok(sql(self.idx.query_row("SELECT rel FROM folders WHERE id = ?1", params![id as i64], |r| r.get::<_, String>(0)).optional())?
            .unwrap_or_default())
    }

    fn next_id(&self, table: &str) -> Res<u64> {
        let max: i64 = sql(self.idx.query_row(&format!("SELECT COALESCE(MAX(id), 0) FROM {table}"), [], |r| r.get(0)))?;
        Ok(max as u64 + 1)
    }

    fn rel_taken(&self, rel: &str, except_id: Option<u64>) -> Res<bool> {
        let id: Option<i64> =
            sql(self.idx.query_row("SELECT id FROM files WHERE rel = ?1 COLLATE NOCASE", params![rel], |r| r.get(0)).optional())?;
        if id.is_some_and(|id| Some(id as u64) != except_id) {
            return Ok(true);
        }
        // Arquivo no disco que o índice ainda não viu (ou de outra máquina).
        let path = self.abs(rel);
        if !path.exists() {
            return Ok(false);
        }
        match except_id.map(|id| self.row(id)).transpose()?.flatten() {
            Some(row) => Ok(!row.rel.eq_ignore_ascii_case(rel)),
            None => Ok(true),
        }
    }

    /// `dir/stem.md`, com " 2", " 3"... se o nome já existe (sem diferenciar maiúsculas).
    fn unique_rel(&self, dir: &str, stem: &str, except_id: Option<u64>) -> Res<String> {
        for n in 1.. {
            let name = if n == 1 { format!("{stem}.md") } else { format!("{stem} {n}.md") };
            let rel = join_rel(dir, &name);
            if !self.rel_taken(&rel, except_id)? {
                return Ok(rel);
            }
        }
        unreachable!()
    }

    // ---------- Sincronização com o disco ----------

    /// Compara o disco com o índice e relê só o que mudou.
    pub fn scan(&mut self) -> Res<ScanDiff> {
        let (dirs, disk, _) = self.walk()?;
        let mut diff = ScanDiff::default();

        // Pastas: as novas ganham id; as que sumiram saem do índice.
        let known = self.folder_map()?;
        let known_rels: HashMap<&str, u64> = known.iter().map(|(id, rel)| (rel.as_str(), *id)).collect();
        let disk_dirs: HashSet<&str> = dirs.iter().map(String::as_str).collect();
        let mut folders_changed = false;
        let tx = sql(self.idx.unchecked_transaction())?;
        let mut next_folder = self.next_id("folders")?;
        let max_pos: i64 = sql(tx.query_row("SELECT COALESCE(MAX(position), 0) FROM folders", [], |r| r.get(0)))?;
        for (i, rel) in dirs.iter().enumerate() {
            if !known_rels.contains_key(rel.as_str()) {
                sql(tx.execute(
                    "INSERT INTO folders (id, rel, position) VALUES (?1, ?2, ?3)",
                    params![next_folder as i64, rel, max_pos + 1 + i as i64],
                ))?;
                next_folder += 1;
                folders_changed = true;
            }
        }
        for (rel, id) in &known_rels {
            if !disk_dirs.contains(rel) {
                sql(tx.execute("DELETE FROM folders WHERE id = ?1", params![*id as i64]))?;
                folders_changed = true;
            }
        }
        sql(tx.commit())?;

        // Arquivos.
        let rows = self.rows()?;
        let by_rel: HashMap<&str, &Row> = rows.iter().map(|r| (r.rel.as_str(), r)).collect();
        let disk_rels: HashSet<&str> = disk.iter().map(|f| f.rel.as_str()).collect();
        let mut missing: HashMap<String, &Row> = HashMap::new(); // hash -> linha cujo arquivo sumiu
        let mut missing_ids: Vec<u64> = Vec::new();
        for r in &rows {
            if !disk_rels.contains(r.rel.as_str()) {
                missing.entry(r.hash.clone()).or_insert(r);
                missing_ids.push(r.id);
            }
        }
        let mut changed_ids: Vec<u64> = Vec::new();
        let mut reused: HashSet<u64> = HashSet::new();
        let mut next_file = self.next_id("files")?;
        let now = now_ms();
        let tx = sql(self.idx.unchecked_transaction())?;
        for f in &disk {
            let trash = in_trash(&f.rel);
            let folder_id = if trash { None } else { Some(self.folder_id_of(parent_rel(&f.rel))?) };
            if let Some(row) = by_rel.get(f.rel.as_str()) {
                if row.mtime == f.mtime && row.size == f.size {
                    // Conteúdo igual; a pasta pode ter ganhado outro id (renomeada fora do app).
                    if let Some(fid) = folder_id.filter(|fid| *fid != row.folder_id) {
                        sql(tx.execute("UPDATE files SET folder_id = ?2 WHERE id = ?1", params![row.id as i64, fid as i64]))?;
                        changed_ids.push(row.id);
                    }
                    continue;
                }
            }
            let path = self.abs(&f.rel);
            let Ok(bytes) = fs::read(&path) else { continue };
            let hash = content_hash(&bytes);
            let text = String::from_utf8_lossy(&bytes);
            let d = derive(&f.rel, &text);
            let meta = fs::metadata(&path).ok();
            let created = meta.as_ref().map(iso_date).unwrap_or_default();
            let deleted_at = trash.then_some(f.mtime.min(now) as i64);
            if let Some(row) = by_rel.get(f.rel.as_str()) {
                sql(tx.execute(
                    "UPDATE files SET mtime = ?2, size = ?3, hash = ?4, title = ?5, preview = ?6, plain = ?7, front_matter = ?8,
                       links = ?9, updated_at = ?10, folder_id = COALESCE(?11, folder_id),
                       deleted_at = CASE WHEN ?12 IS NULL THEN NULL ELSE COALESCE(deleted_at, ?12) END
                     WHERE id = ?1",
                    params![
                        row.id as i64, f.mtime as i64, f.size as i64, hash, d.title, d.preview, d.plain, d.front_matter, d.links,
                        f.mtime as i64, folder_id.map(|v| v as i64), deleted_at
                    ],
                ))?;
                changed_ids.push(row.id);
                continue;
            }
            // Arquivo novo: se o conteúdo é o de um arquivo que sumiu, é uma renomeação.
            let id = match missing.remove(&hash) {
                Some(old) if !reused.contains(&old.id) => {
                    reused.insert(old.id);
                    sql(tx.execute("DELETE FROM files WHERE id = ?1", params![old.id as i64]))?;
                    old.id
                }
                _ => {
                    next_file += 1;
                    next_file - 1
                }
            };
            sql(tx.execute(
                "INSERT INTO files (id, rel, mtime, size, hash, title, preview, plain, front_matter, links, created_at, updated_at, folder_id, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    id as i64, f.rel, f.mtime as i64, f.size as i64, hash, d.title, d.preview, d.plain, d.front_matter, d.links, created,
                    f.mtime as i64, folder_id.unwrap_or(0) as i64, deleted_at
                ],
            ))?;
            changed_ids.push(id);
        }
        for id in missing_ids {
            if !reused.contains(&id) {
                sql(tx.execute("DELETE FROM files WHERE id = ?1", params![id as i64]))?;
                diff.removed.push(id);
            }
        }
        sql(tx.commit())?;

        if !changed_ids.is_empty() {
            let all = self.metas()?;
            let set: HashSet<u64> = changed_ids.into_iter().collect();
            diff.changed = all.into_iter().filter(|m| set.contains(&m.id)).collect();
        }
        if folders_changed {
            diff.folders = Some(self.folders()?);
        }
        Ok(diff)
    }

    // ---------- Leitura ----------

    fn metas(&self) -> Res<Vec<NoteMeta>> {
        let mut st = sql(self.idx.prepare(
            "SELECT id, title, preview, created_at, updated_at, pinned, folder_id, deleted_at, links, front_matter, mtime, rel
             FROM files ORDER BY updated_at DESC",
        ))?;
        let rows = sql(st.query_map([], |r| {
            let links: String = r.get(8)?;
            let fm: String = r.get(9)?;
            Ok(NoteMeta {
                id: r.get::<_, i64>(0)? as u64,
                title: r.get(1)?,
                preview: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get::<_, i64>(4)? as u64,
                pinned: r.get(5)?,
                folder_id: r.get::<_, i64>(6)? as u64,
                deleted_at: r.get::<_, Option<i64>>(7)?.map(|v| v as u64),
                props: serde_json::Value::Null,
                links: match serde_json::from_str(&links) {
                    Ok(serde_json::Value::Array(a)) => a,
                    _ => Vec::new(),
                },
                front_matter: Some(fm),
                disk_mtime: Some(r.get::<_, i64>(10)? as u64),
                rel: Some(r.get(11)?),
            })
        }))?;
        sql(rows.collect())
    }

    /// Metadados de todas as notas; antes apaga da lixeira o que passou de 30 dias.
    pub fn list(&mut self, now: u64) -> Res<Vec<NoteMeta>> {
        let limit = now.saturating_sub(TRASH_RETENTION_MS);
        let old: Vec<(u64, String)> = {
            let mut st = sql(self.idx.prepare("SELECT id, rel FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?1"))?;
            let rows = sql(st.query_map(params![limit as i64], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?))))?;
            sql(rows.collect())?
        };
        let ids: Vec<u64> = old.into_iter().filter(|(_, rel)| in_trash(rel)).map(|(id, _)| id).collect();
        if !ids.is_empty() {
            self.delete(&ids)?;
        }
        self.metas()
    }

    pub fn get(&self, id: u64) -> Res<Option<VaultContent>> {
        let Some(row) = self.row(id)? else { return Ok(None) };
        let path = self.abs(&row.rel);
        let bytes = io(fs::read(&path), &path)?;
        let mtime = fs::metadata(&path).map(|m| mtime_ms(&m)).unwrap_or(row.mtime);
        let text = String::from_utf8_lossy(&bytes);
        Ok(Some(VaultContent { markdown: text.strip_prefix('\u{feff}').unwrap_or(&text).to_string(), rel: row.rel, mtime }))
    }

    pub fn search(&self, query: &str) -> Res<Vec<u64>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let map = |r: &rusqlite::Row| r.get::<_, i64>(0).map(|v| v as u64);
        if q.chars().count() >= 3 {
            let phrase = format!("\"{}\"", q.replace('"', "\"\""));
            let mut st = sql(self.idx.prepare("SELECT rowid FROM files_fts WHERE files_fts MATCH ?1"))?;
            let rows = sql(st.query_map(params![phrase], map))?;
            sql(rows.collect())
        } else {
            let like = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            let mut st = sql(self.idx.prepare("SELECT id FROM files WHERE plain LIKE ?1 ESCAPE '\\'"))?;
            let rows = sql(st.query_map(params![like], map))?;
            sql(rows.collect())
        }
    }

    pub fn folders(&self) -> Res<Vec<Folder>> {
        let mut st = sql(self.idx.prepare("SELECT id, rel FROM folders ORDER BY position, rel"))?;
        let rows: Vec<(u64, String)> =
            sql(sql(st.query_map([], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?))))?.collect())?;
        let ids: HashMap<&str, u64> = rows.iter().map(|(id, rel)| (rel.as_str(), *id)).collect();
        Ok(rows
            .iter()
            .map(|(id, rel)| Folder {
                id: *id,
                name: file_name(rel).to_string(),
                parent_id: ids.get(parent_rel(rel)).copied().unwrap_or(0),
            })
            .collect())
    }

    // ---------- Escrita ----------

    /// Grava uma nota (o Markdown vem pronto do JS). Renomeia o arquivo quando o título muda.
    pub fn save(&mut self, n: &NoteSave) -> Res<SaveResult> {
        let m = &n.meta;
        let md = n.markdown.as_deref().ok_or("nota sem Markdown")?;
        let row = self.row(m.id)?;
        let dir = match &row {
            _ if m.deleted_at.is_none() => self.folder_rel(m.folder_id)?,
            Some(r) if in_trash(&r.rel) => parent_rel(&r.rel).to_string(),
            _ => TRASH_DIR.to_string(),
        };
        let stem = safe_name(&m.title, "Nova Nota");

        // Conflito: o arquivo mudou no disco desde a última leitura (por outra pessoa ou app).
        if let Some(r) = &row {
            let path = self.abs(&r.rel);
            if let Ok(meta) = fs::metadata(&path) {
                let disk = mtime_ms(&meta);
                let base_ok = m.disk_mtime.is_none_or(|b| b == r.mtime);
                if disk != r.mtime || !base_ok {
                    let when = chrono::Local::now().format("%Y-%m-%d %H%M");
                    let rel = self.unique_rel(parent_rel(&r.rel), &format!("{stem} (conflito {} {when})", host_name()), None)?;
                    write_atomic(&self.abs(&rel), md)?;
                    return Ok(SaveResult { disk_mtime: None, rel: None, conflict: Some(file_name(&rel).to_string()) });
                }
            }
        }

        let rel = match &row {
            Some(r) if parent_rel(&r.rel) == dir && stem_of(&r.rel) == stem => r.rel.clone(),
            _ => self.unique_rel(&dir, &stem, row.as_ref().map(|r| r.id))?,
        };
        let path = self.abs(&rel);
        write_atomic(&path, md)?;
        if let Some(r) = &row {
            if r.rel != rel {
                let old = self.abs(&r.rel);
                // Renomear só a caixa ("nota" -> "Nota") já trocou o arquivo no Windows.
                if !r.rel.eq_ignore_ascii_case(&rel) {
                    let _ = fs::remove_file(old);
                }
            }
        }
        let meta = io(fs::metadata(&path), &path)?;
        let mtime = mtime_ms(&meta);
        let (fm, _) = split_front_matter(md);
        let links = if m.links.is_empty() { String::new() } else { serde_json::Value::Array(m.links.clone()).to_string() };
        sql(self.idx.execute(
            "INSERT INTO files (id, rel, mtime, size, hash, title, preview, plain, front_matter, links, created_at, updated_at, folder_id, pinned, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET rel = excluded.rel, mtime = excluded.mtime, size = excluded.size, hash = excluded.hash,
               title = excluded.title, preview = excluded.preview, plain = excluded.plain, front_matter = excluded.front_matter,
               links = excluded.links, created_at = excluded.created_at, updated_at = excluded.updated_at,
               folder_id = excluded.folder_id, pinned = excluded.pinned, deleted_at = excluded.deleted_at",
            params![
                m.id as i64,
                rel,
                mtime as i64,
                meta.len() as i64,
                content_hash(md.as_bytes()),
                m.title,
                preview_of(&m.preview),
                n.plain,
                fm.unwrap_or(""),
                links,
                m.created_at,
                m.updated_at as i64,
                m.folder_id as i64,
                m.pinned,
                m.deleted_at.map(|v| v as i64),
            ],
        ))?;
        Ok(SaveResult { disk_mtime: Some(mtime), rel: Some(rel), conflict: None })
    }

    /// Move um arquivo de nota para `dir` (mantém o nome; " 2" se já existir).
    fn move_note(&self, row: &Row, dir: &str) -> Res<(String, u64)> {
        if parent_rel(&row.rel) == dir {
            return Ok((row.rel.clone(), row.mtime));
        }
        let rel = self.unique_rel(dir, stem_of(&row.rel), Some(row.id))?;
        let from = self.abs(&row.rel);
        let to = self.abs(&rel);
        if let Some(parent) = to.parent() {
            io(fs::create_dir_all(parent), parent)?;
        }
        io(fs::rename(&from, &to), &from)?;
        let mtime = fs::metadata(&to).map(|m| mtime_ms(&m)).unwrap_or(row.mtime);
        Ok((rel, mtime))
    }

    /// Fixar (só no índice), mover de pasta, mandar para a lixeira e restaurar.
    pub fn set_meta(&mut self, metas: &[NoteMeta]) -> Res<()> {
        for m in metas {
            let Some(row) = self.row(m.id)? else { continue };
            let target = if m.deleted_at.is_some() {
                if in_trash(&row.rel) { parent_rel(&row.rel).to_string() } else { TRASH_DIR.to_string() }
            } else {
                self.folder_rel(m.folder_id)?
            };
            let (rel, mtime) = if self.abs(&row.rel).exists() { self.move_note(&row, &target)? } else { (row.rel.clone(), row.mtime) };
            sql(self.idx.execute(
                "UPDATE files SET rel = ?2, mtime = ?3, pinned = ?4, folder_id = ?5, deleted_at = ?6, updated_at = ?7 WHERE id = ?1",
                params![m.id as i64, rel, mtime as i64, m.pinned, m.folder_id as i64, m.deleted_at.map(|v| v as i64), m.updated_at as i64],
            ))?;
        }
        Ok(())
    }

    /// Apaga de vez (arquivo e índice).
    pub fn delete(&mut self, ids: &[u64]) -> Res<()> {
        for id in ids {
            if let Some(row) = self.row(*id)? {
                let path = self.abs(&row.rel);
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("{}: {e}", path.display())),
                }
                sql(self.idx.execute("DELETE FROM files WHERE id = ?1", params![*id as i64]))?;
            }
        }
        Ok(())
    }

    /// Troca o prefixo `from/` por `to/` nos caminhos do índice (pasta renomeada/movida).
    fn rebase(&self, from: &str, to: &str) -> Res<()> {
        // substr do SQLite conta caracteres, não bytes.
        let n = from.chars().count() as i64;
        for table in ["files", "folders"] {
            sql(self.idx.execute(
                &format!("UPDATE {table} SET rel = ?2 || substr(rel, ?3) WHERE rel = ?1 OR substr(rel, 1, ?3) = ?1 || '/'"),
                params![from, to, n + 1],
            ))?;
        }
        Ok(())
    }

    /// Aplica a lista de pastas do app: cria, renomeia/move diretórios e remove os que saíram
    /// (o que sobrar dentro deles vai para a lixeira do cofre, nada é apagado).
    pub fn save_folders(&mut self, folders: &[Folder]) -> Res<()> {
        let by_id: HashMap<u64, &Folder> = folders.iter().map(|f| (f.id, f)).collect();
        let depth = |f: &Folder| {
            let (mut d, mut parent) = (0usize, f.parent_id);
            while let Some(p) = by_id.get(&parent).filter(|_| parent != 0 && d < 64) {
                parent = p.parent_id;
                d += 1;
            }
            d
        };
        let mut order: Vec<(usize, usize, &Folder)> = folders.iter().enumerate().map(|(pos, f)| (depth(f), pos, f)).collect();
        order.sort_by_key(|(d, pos, _)| (*d, *pos));

        // Removidas primeiro (só as de cima: as filhas vão junto).
        let current = self.folder_map()?;
        let mut gone: Vec<(u64, String)> = current.iter().filter(|(id, _)| !by_id.contains_key(id)).map(|(i, r)| (*i, r.clone())).collect();
        gone.sort_by(|a, b| a.1.cmp(&b.1));
        let mut removed_roots: Vec<String> = Vec::new();
        for (id, rel) in gone {
            sql(self.idx.execute("DELETE FROM folders WHERE id = ?1", params![id as i64]))?;
            if removed_roots.iter().any(|r| rel.starts_with(&format!("{r}/"))) {
                continue;
            }
            removed_roots.push(rel.clone());
            let path = self.abs(&rel);
            if !path.exists() {
                continue;
            }
            if dir_has_files(&path) {
                let name = safe_name(file_name(&rel), "Pasta");
                let mut dest = join_rel(TRASH_DIR, &name);
                let mut n = 2;
                while self.abs(&dest).exists() {
                    dest = join_rel(TRASH_DIR, &format!("{name} {n}"));
                    n += 1;
                }
                io(fs::create_dir_all(self.abs(TRASH_DIR)), &self.abs(TRASH_DIR))?;
                io(fs::rename(&path, self.abs(&dest)), &path)?;
                self.rebase(&rel, &dest)?;
                let now = now_ms() as i64;
                sql(self.idx.execute(
                    "UPDATE files SET deleted_at = COALESCE(deleted_at, ?2) WHERE substr(rel, 1, ?3) = ?1 || '/'",
                    params![dest, now, dest.chars().count() as i64 + 1],
                ))?;
            } else {
                io(fs::remove_dir_all(&path), &path)?;
            }
        }

        // Criadas, renomeadas e movidas: as mães antes das filhas.
        let mut rels: HashMap<u64, String> = HashMap::new();
        for (_, pos, f) in order {
            let parent = if f.parent_id == 0 { String::new() } else { rels.get(&f.parent_id).cloned().unwrap_or_default() };
            let cur = self.folder_rel(f.id).ok().filter(|r| !r.is_empty());
            let base = safe_name(&f.name, "Pasta");
            let mut want = join_rel(&parent, &base);
            let mut n = 2;
            loop {
                let same = cur.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(&want));
                let taken_in_index = rels.values().any(|r| r.eq_ignore_ascii_case(&want));
                if same || (!taken_in_index && !self.abs(&want).exists()) {
                    break;
                }
                want = join_rel(&parent, &format!("{base} {n}"));
                n += 1;
            }
            match cur {
                None => {
                    io(fs::create_dir_all(self.abs(&want)), &self.abs(&want))?;
                    sql(self.idx.execute(
                        "INSERT INTO folders (id, rel, position) VALUES (?1, ?2, ?3)
                         ON CONFLICT(id) DO UPDATE SET rel = excluded.rel, position = excluded.position",
                        params![f.id as i64, want, pos as i64],
                    ))?;
                }
                Some(cur) => {
                    if cur != want {
                        let from = self.abs(&cur);
                        if from.exists() {
                            if let Some(p) = self.abs(&want).parent() {
                                io(fs::create_dir_all(p), p)?;
                            }
                            io(fs::rename(&from, self.abs(&want)), &from)?;
                        } else {
                            io(fs::create_dir_all(self.abs(&want)), &self.abs(&want))?;
                        }
                        self.rebase(&cur, &want)?;
                    }
                    sql(self.idx.execute("UPDATE folders SET position = ?2 WHERE id = ?1", params![f.id as i64, pos as i64]))?;
                }
            }
            rels.insert(f.id, want);
        }
        Ok(())
    }
}

pub(crate) fn dir_has_files(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| match e.file_type() {
        Ok(ft) if ft.is_dir() => dir_has_files(&e.path()),
        Ok(_) => true,
        Err(_) => false,
    })
}

/// Índice local de um cofre: `<app_data>/vaults/<hash do caminho>.db`.
pub fn index_path(app_data: &Path, root: &Path) -> PathBuf {
    let mut h = DefaultHasher::new();
    root.to_string_lossy().to_lowercase().hash(&mut h);
    app_data.join("vaults").join(format!("{:016x}.db", h.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("todors-vault-{name}-{}-{}", std::process::id(), now_ms()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn vault(dir: &Path) -> Vault {
        Vault::with_index(dir, Connection::open_in_memory().unwrap()).unwrap()
    }

    fn note(id: u64, title: &str, md: &str, folder_id: u64) -> NoteSave {
        NoteSave {
            meta: NoteMeta { id, title: title.into(), folder_id, updated_at: now_ms(), ..Default::default() },
            plain: md.into(),
            markdown: Some(md.into()),
            ..Default::default()
        }
    }

    fn bump_mtime(path: &Path) {
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("a/b: c?", "x"), "ab c");
        assert_eq!(safe_name("  ...  ", "Nova Nota"), "Nova Nota");
        assert_eq!(safe_name("con", "x"), "con_");
        assert_eq!(safe_name("fim.", "x"), "fim");
        assert_eq!(safe_name("Reunião   de\tquinta", "x"), "Reunião de quinta");
    }

    #[test]
    fn front_matter_and_links() {
        let (fm, body) = split_front_matter("---\ntags:\n  - a\n---\n# T\n[[Outra|x]] e [[p/Nota.md#s]] ![[img.png]]");
        assert_eq!(fm, Some("tags:\n  - a"));
        assert!(body.starts_with("# T"));
        assert_eq!(md_links(body), vec![serde_json::json!("Outra"), serde_json::json!("Nota")]);
        assert_eq!(split_front_matter("sem").0, None);
    }

    #[test]
    fn scan_reads_folders_notes_and_trash() {
        let dir = tmp_dir("scan");
        fs::create_dir_all(dir.join("Projetos/Sub")).unwrap();
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::create_dir_all(dir.join(".trash")).unwrap();
        fs::create_dir_all(dir.join("attachments")).unwrap();
        fs::write(dir.join("Raiz.md"), "---\ntags: [x]\n---\n# Raiz\nprimeira linha").unwrap();
        fs::write(dir.join("Projetos/Sub/Plano.md"), "texto do plano").unwrap();
        fs::write(dir.join(".obsidian/x.md"), "oculto").unwrap();
        fs::write(dir.join(".trash/Velha.md"), "apagada").unwrap();
        fs::write(dir.join("attachments/a.png"), "png").unwrap();
        let mut v = vault(&dir);
        let folders = v.folders().unwrap();
        assert_eq!(folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["Projetos", "Sub"]);
        let sub = folders.iter().find(|f| f.name == "Sub").unwrap();
        assert_eq!(sub.parent_id, folders.iter().find(|f| f.name == "Projetos").unwrap().id);
        let list = v.list(now_ms()).unwrap();
        assert_eq!(list.len(), 3);
        let raiz = list.iter().find(|n| n.title == "Raiz").unwrap();
        assert_eq!(raiz.preview, "primeira linha");
        assert_eq!(raiz.front_matter.as_deref(), Some("tags: [x]"));
        assert_eq!(list.iter().find(|n| n.title == "Plano").unwrap().folder_id, sub.id);
        assert!(list.iter().find(|n| n.title == "Velha").unwrap().deleted_at.is_some());
        assert_eq!(v.search("plano").unwrap().len(), 1);
        assert_eq!(v.files().unwrap(), vec!["attachments/a.png".to_string()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_renames_detects_conflict_and_external_changes() {
        let dir = tmp_dir("save");
        let mut v = vault(&dir);
        let r = v.save(&note(10, "Ideia", "corpo\n", 0)).unwrap();
        assert_eq!(r.rel.as_deref(), Some("Ideia.md"));
        assert_eq!(fs::read_to_string(dir.join("Ideia.md")).unwrap(), "corpo\n");

        // Título novo renomeia o arquivo.
        let mut n = note(10, "Ideia boa", "corpo 2\n", 0);
        n.meta.disk_mtime = r.disk_mtime;
        let r2 = v.save(&n).unwrap();
        assert_eq!(r2.rel.as_deref(), Some("Ideia boa.md"));
        assert!(!dir.join("Ideia.md").exists());

        // Nada mudou no disco: o scan não acusa nada.
        let d = v.scan().unwrap();
        assert!(d.changed.is_empty() && d.removed.is_empty());

        // Outra pessoa editou: a gravação vira cópia de conflito, o original fica intacto.
        fs::write(dir.join("Ideia boa.md"), "versão dela\n").unwrap();
        bump_mtime(&dir.join("Ideia boa.md"));
        let mut n = note(10, "Ideia boa", "minha versão\n", 0);
        n.meta.disk_mtime = r2.disk_mtime;
        let c = v.save(&n).unwrap();
        let name = c.conflict.expect("conflito");
        assert!(name.starts_with("Ideia boa (conflito "));
        assert_eq!(fs::read_to_string(dir.join("Ideia boa.md")).unwrap(), "versão dela\n");
        assert_eq!(fs::read_to_string(dir.join(&name)).unwrap(), "minha versão\n");

        // O scan pega a edição externa e a cópia de conflito.
        let d = v.scan().unwrap();
        assert_eq!(d.changed.len(), 2);
        let get = v.get(10).unwrap().unwrap();
        assert_eq!(get.markdown, "versão dela\n");

        // Mesmo depois do scan, uma edição baseada na versão antiga é conflito.
        let mut n = note(10, "Ideia boa", "outra\n", 0);
        n.meta.disk_mtime = r2.disk_mtime;
        assert!(v.save(&n).unwrap().conflict.is_some());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn external_rename_keeps_id() {
        let dir = tmp_dir("rename");
        let mut v = vault(&dir);
        v.save(&note(7, "Antes", "conteúdo único\n", 0)).unwrap();
        fs::rename(dir.join("Antes.md"), dir.join("Depois.md")).unwrap();
        let d = v.scan().unwrap();
        assert!(d.removed.is_empty());
        assert_eq!(d.changed.len(), 1);
        assert_eq!(d.changed[0].id, 7);
        assert_eq!(d.changed[0].title, "Depois");
        fs::remove_file(dir.join("Depois.md")).unwrap();
        assert_eq!(v.scan().unwrap().removed, vec![7]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn folders_trash_restore_and_delete() {
        let dir = tmp_dir("folders");
        let mut v = vault(&dir);
        v.save_folders(&[Folder { id: 100, name: "Trabalho".into(), parent_id: 0 }]).unwrap();
        assert!(dir.join("Trabalho").is_dir());
        v.save(&note(1, "Tarefa", "x\n", 100)).unwrap();
        assert!(dir.join("Trabalho/Tarefa.md").exists());

        // Renomear e aninhar pastas move os arquivos junto.
        v.save_folders(&[
            Folder { id: 200, name: "Arquivo".into(), parent_id: 0 },
            Folder { id: 100, name: "Trabalho 2026".into(), parent_id: 200 },
        ])
        .unwrap();
        assert!(dir.join("Arquivo/Trabalho 2026/Tarefa.md").exists());
        assert_eq!(v.get(1).unwrap().unwrap().rel, "Arquivo/Trabalho 2026/Tarefa.md");

        // Lixeira e restauração.
        let meta = |deleted: Option<u64>, folder: u64| NoteMeta { id: 1, folder_id: folder, deleted_at: deleted, ..Default::default() };
        v.set_meta(&[meta(Some(now_ms()), 100)]).unwrap();
        assert!(dir.join(".trash/Tarefa.md").exists());
        v.set_meta(&[meta(None, 0)]).unwrap();
        assert!(dir.join("Tarefa.md").exists());

        // Pasta removida com um anexo dentro vai para a lixeira do cofre.
        fs::write(dir.join("Arquivo/anexo.pdf"), "pdf").unwrap();
        v.save_folders(&[]).unwrap();
        assert!(!dir.join("Arquivo").exists());
        assert!(dir.join(".trash/Arquivo/anexo.pdf").exists());
        assert!(v.folders().unwrap().is_empty());

        v.delete(&[1]).unwrap();
        assert!(!dir.join("Tarefa.md").exists());
        assert!(v.list(now_ms()).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}

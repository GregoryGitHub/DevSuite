//! Controle de versão (git) dos cofres das Notas.
//!
//! Usa o executável `git` do sistema: push/pull aproveitam as credenciais que o usuário já
//! tem (Git Credential Manager, chaves SSH, ~/.gitconfig). Sem git instalado, `git_info`
//! devolve `available: false` e o cofre segue funcionando sem versionamento.
//!
//! O cofre pode ser a raiz do repositório ou uma subpasta dele: os caminhos trocados com o JS
//! são relativos à raiz do repositório (`path`), com `rel` = relativo ao cofre quando o
//! arquivo está dentro dele. Status, histórico e commits ficam restritos à pasta do cofre.
//!
//! Commits são só manuais (`git_commit` com os arquivos marcados). Comandos do mesmo
//! repositório rodam um de cada vez (evita `index.lock`); fetch/pull/push podem ser
//! cancelados (`git_cancel`). Pull = merge (`--no-rebase`): conflitos ficam no índice e são
//! resolvidos pela visão de 3 vias (`git_conflict` / `git_resolve`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::notes_vault::{dir_has_files, safe_name, write_atomic, TRASH_DIR};

type Res<T> = Result<T, String>;

const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const GITIGNORE: &[&str] = &[".trash/", ".*.todors-tmp", ".obsidian/workspace*", ".DS_Store", "Thumbs.db"];

/// Trava por repositório e processos remotos em andamento (para cancelar).
#[derive(Default)]
pub struct GitState {
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    inflight: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    cancelled: Mutex<HashSet<String>>,
}

// ---------- Execução do git ----------

fn base(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.arg("-C")
        .arg(dir)
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "core.pager=cat", "-c", "advice.detachedHead=false"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn err_text(stderr: &[u8], stdout: &[u8]) -> String {
    let e = String::from_utf8_lossy(stderr);
    let e = e.trim();
    let text = if e.is_empty() { String::from_utf8_lossy(stdout).trim().to_string() } else { e.to_string() };
    // "hint:" são dicas longas do git; a primeira linha útil basta para o aviso.
    let lines: Vec<&str> = text.lines().filter(|l| !l.starts_with("hint:")).collect();
    if lines.is_empty() { "o git falhou".into() } else { lines.join("\n") }
}

/// Roda o git e devolve o stdout; erro = stderr legível.
fn run(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Res<Vec<u8>> {
    let mut cmd = base(dir);
    cmd.args(args);
    let out = if let Some(data) = input {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(spawn_error)?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(data).map_err(|e| e.to_string())?;
        }
        child.wait_with_output().map_err(|e| e.to_string())?
    } else {
        cmd.output().map_err(spawn_error)?
    };
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(err_text(&out.stderr, &out.stdout))
    }
}

fn spawn_error(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "O git não foi encontrado. Instale o Git (git-scm.com) e reabra o app.".into()
    } else {
        e.to_string()
    }
}

fn run_str(dir: &Path, args: &[&str]) -> Res<String> {
    run(dir, args, None).map(|o| String::from_utf8_lossy(&o).trim_end_matches(['\n', '\r']).to_string())
}

fn try_str(dir: &Path, args: &[&str]) -> Option<String> {
    run_str(dir, args).ok().filter(|s| !s.is_empty())
}

fn nul_list(paths: &[String]) -> Vec<u8> {
    let mut v = Vec::new();
    for p in paths {
        v.extend_from_slice(p.as_bytes());
        v.push(0);
    }
    v
}

fn git_version() -> Option<String> {
    let dir = std::env::temp_dir();
    try_str(&dir, &["--version"]).map(|v| v.trim_start_matches("git version ").to_string())
}

// ---------- Repositório do cofre ----------

struct Repo {
    root: PathBuf,
    top: PathBuf,
    /// Pasta do cofre relativa à raiz do repositório ("" ou "a/b/").
    prefix: String,
}

impl Repo {
    fn open(root: &Path) -> Res<Option<Repo>> {
        if !root.is_dir() {
            return Err(format!("Cofre indisponível: {}", root.display()));
        }
        match run_str(root, &["rev-parse", "--show-toplevel", "--show-prefix"]) {
            Ok(s) => {
                let mut lines = s.lines();
                let top = PathBuf::from(lines.next().unwrap_or_default());
                let prefix = lines.next().unwrap_or("").to_string();
                Ok(Some(Repo { root: root.to_path_buf(), top, prefix }))
            }
            Err(e) if e.contains("not a git repository") || e.contains("não é um repositório") => Ok(None),
            Err(e) if e.contains("O git não foi encontrado") => Err(e),
            Err(_) => Ok(None),
        }
    }

    /// Pathspec da pasta do cofre (literal).
    fn scope(&self) -> String {
        if self.prefix.is_empty() { ".".into() } else { self.prefix.trim_end_matches('/').to_string() }
    }

    fn rel(&self, path: &str) -> Option<String> {
        path.strip_prefix(&self.prefix).map(str::to_string)
    }

    fn has_head(&self) -> bool {
        run(&self.top, &["rev-parse", "-q", "--verify", "HEAD"], None).is_ok()
    }

    fn merging(&self) -> bool {
        run(&self.top, &["rev-parse", "-q", "--verify", "MERGE_HEAD"], None).is_ok()
    }

    fn abs(&self, path: &str) -> PathBuf {
        self.top.join(path)
    }

    fn branch(&self) -> Option<String> {
        try_str(&self.top, &["symbolic-ref", "--short", "-q", "HEAD"])
    }

    fn upstream(&self) -> Option<String> {
        try_str(&self.top, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    }

    fn has_origin(&self) -> bool {
        try_str(&self.top, &["remote"]).is_some_and(|r| r.lines().any(|l| l == "origin"))
    }
}

/// Caminho relativo ao repositório vindo do JS: sem `..`, sem absoluto, dentro do cofre.
fn check_path(repo: &Repo, path: &str) -> Res<()> {
    let bad = path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains(':')
        || path.split(['/', '\\']).any(|s| s == "..")
        || !path.starts_with(&repo.prefix);
    if bad { Err(format!("Caminho inválido: {path}")) } else { Ok(()) }
}

fn check_rev(rev: &str) -> Res<()> {
    let ok = !rev.is_empty() && !rev.starts_with('-') && rev.chars().all(|c| c.is_ascii_alphanumeric() || "_./^~-".contains(c));
    if ok { Ok(()) } else { Err(format!("Revisão inválida: {rev}")) }
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn lock_for(app: &tauri::AppHandle, top: &Path) -> Arc<Mutex<()>> {
    let st = app.state::<GitState>();
    let mut map = st.locks.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(top.to_path_buf()).or_default().clone()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Repositório do cofre ativo (erro se não houver) e a trava dele, numa thread de bloqueio.
async fn with_repo<T: Send + 'static>(app: tauri::AppHandle, f: impl FnOnce(&Repo) -> Res<T> + Send + 'static) -> Res<T> {
    let root = crate::notes_db::active_vault_root(app.clone()).await?;
    blocking(move || {
        let repo = Repo::open(&root)?.ok_or("O cofre ainda não tem controle de versão.")?;
        let lock = lock_for(&app, &repo.top);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        f(&repo)
    })
    .await
}

// ---------- Status ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileChange {
    pub path: String,
    #[serde(default)]
    pub orig_path: Option<String>,
    #[serde(default)]
    pub rel: Option<String>,
    /// modified | added | deleted | renamed | untracked | conflicted
    pub status: String,
}

#[derive(Serialize, Default, Debug)]
pub struct GitStatus {
    pub files: Vec<FileChange>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub merging: bool,
}

fn parse_status(raw: &[u8], prefix: &str) -> GitStatus {
    let text = String::from_utf8_lossy(raw);
    let mut st = GitStatus::default();
    let mut it = text.split('\0');
    let push = |path: &str, orig: Option<&str>, status: &str, st: &mut GitStatus| {
        st.files.push(FileChange {
            path: path.to_string(),
            orig_path: orig.map(str::to_string),
            rel: path.strip_prefix(prefix).map(str::to_string),
            status: status.to_string(),
        });
    };
    while let Some(entry) = it.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(h) = entry.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" if v != "(initial)" => st.head = Some(v.chars().take(7).collect()),
                "branch.head" if v != "(detached)" => st.branch = Some(v.to_string()),
                "branch.upstream" => st.upstream = Some(v.to_string()),
                "branch.ab" => {
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        match entry.as_bytes()[0] {
            b'1' => {
                let f: Vec<&str> = entry.splitn(9, ' ').collect();
                if f.len() < 9 {
                    continue;
                }
                let xy = f[1].as_bytes();
                let (x, y) = (xy[0], xy[1]);
                let status = if x == b'A' && y == b'D' {
                    continue;
                } else if x == b'D' || y == b'D' {
                    "deleted"
                } else if x == b'A' {
                    "added"
                } else {
                    "modified"
                };
                push(f[8], None, status, &mut st);
            }
            b'2' => {
                let f: Vec<&str> = entry.splitn(10, ' ').collect();
                let orig = it.next();
                if f.len() < 10 {
                    continue;
                }
                let status = if f[8].starts_with('C') { "added" } else { "renamed" };
                push(f[9], if status == "renamed" { orig } else { None }, status, &mut st);
            }
            b'u' => {
                let f: Vec<&str> = entry.splitn(11, ' ').collect();
                if f.len() == 11 {
                    push(f[10], None, "conflicted", &mut st);
                }
            }
            b'?' => push(&entry[2..], None, "untracked", &mut st),
            _ => {}
        }
    }
    st
}

fn status_of(repo: &Repo) -> Res<GitStatus> {
    let scope = repo.scope();
    let raw = run(&repo.top, &["status", "--porcelain=v2", "-z", "--branch", "-uall", "--", &scope], None)?;
    let mut st = parse_status(&raw, &repo.prefix);
    st.merging = repo.merging();
    st.files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(st)
}

#[derive(Serialize, Default, Debug)]
pub struct GitInfo {
    pub available: bool,
    pub version: String,
    pub repo: bool,
    pub root: String,
    pub top: String,
    pub prefix: String,
    pub remote_url: Option<String>,
    pub user_name: String,
    pub user_email: String,
}

/// Git instalado? O cofre é um repositório? Remoto e identidade configurados?
#[tauri::command]
pub async fn git_info(app: tauri::AppHandle) -> Res<GitInfo> {
    let root = crate::notes_db::active_vault_root(app).await?;
    blocking(move || {
        let mut info = GitInfo { root: root.to_string_lossy().into_owned(), ..Default::default() };
        let Some(version) = git_version() else { return Ok(info) };
        info.available = true;
        info.version = version;
        if let Some(repo) = Repo::open(&root)? {
            info.repo = true;
            info.top = repo.top.to_string_lossy().into_owned();
            info.prefix = repo.prefix.clone();
            info.remote_url = try_str(&repo.top, &["remote", "get-url", "origin"]);
            info.user_name = try_str(&repo.top, &["config", "user.name"]).unwrap_or_default();
            info.user_email = try_str(&repo.top, &["config", "user.email"]).unwrap_or_default();
        }
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn git_status(app: tauri::AppHandle) -> Res<GitStatus> {
    with_repo(app, status_of).await
}

// ---------- Criar repositório / cofre ----------

/// Acrescenta ao .gitignore da pasta as linhas que faltam.
fn ensure_gitignore(dir: &Path, lines: &[&str]) -> Res<()> {
    let path = dir.join(".gitignore");
    let cur = fs::read_to_string(&path).unwrap_or_default();
    let have: HashSet<&str> = cur.lines().map(str::trim).collect();
    let missing: Vec<&str> = lines.iter().copied().filter(|l| !have.contains(l)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut text = cur.clone();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for l in missing {
        text.push_str(l);
        text.push('\n');
    }
    write_atomic(&path, &text)
}

/// `git init` na pasta (branch main, sem conversão de fim de linha) + .gitignore. Com
/// `message`, faz o commit inicial se a identidade estiver configurada. Devolve se commitou.
fn init_repo(root: &Path, message: Option<&str>) -> Res<bool> {
    run(root, &["-c", "init.defaultBranch=main", "init", "-q"], None)?;
    if run(root, &["rev-parse", "-q", "--verify", "HEAD"], None).is_err() {
        let _ = run(root, &["symbolic-ref", "HEAD", "refs/heads/main"], None);
    }
    run(root, &["config", "core.autocrlf", "false"], None)?;
    run(root, &["config", "core.quotepath", "false"], None)?;
    ensure_gitignore(root, GITIGNORE)?;
    let Some(message) = message else { return Ok(false) };
    if try_str(root, &["config", "user.email"]).is_none() {
        return Ok(false);
    }
    run(root, &["add", "-A", "--", "."], None)?;
    run(root, &["commit", "-q", "-m", message], None)?;
    Ok(true)
}

/// Ativa o controle de versão no cofre aberto (sem commit: os arquivos aparecem como não
/// versionados e o usuário escolhe o que commitar).
#[tauri::command]
pub async fn git_init(app: tauri::AppHandle) -> Res<()> {
    let root = crate::notes_db::active_vault_root(app).await?;
    blocking(move || {
        if Repo::open(&root)?.is_some_and(|r| r.prefix.is_empty()) {
            return Ok(());
        }
        init_repo(&root, None).map(|_| ())
    })
    .await
}

#[derive(Serialize, Debug)]
pub struct VaultCreated {
    pub path: String,
    pub git: bool,
    pub committed: bool,
    pub git_error: Option<String>,
}

/// Cria a pasta de um cofre novo (`<parent>/<name>`) já com repositório git e commit
/// inicial. Sem git, cria só a pasta (`git: false`). Pasta existente com arquivos = erro.
#[tauri::command]
pub async fn notes_vault_create(parent: String, name: String) -> Res<VaultCreated> {
    blocking(move || {
        let name = safe_name(&name, "");
        if name.is_empty() {
            return Err("Dê um nome ao cofre.".into());
        }
        let parent = PathBuf::from(parent.trim());
        if !parent.is_dir() {
            return Err(format!("Pasta inexistente: {}", parent.display()));
        }
        let dir = parent.join(&name);
        if dir.exists() && (!dir.is_dir() || dir_has_files(&dir)) {
            return Err(format!("Já existe uma pasta \"{name}\" com arquivos em {}.", parent.display()));
        }
        fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = dir.to_string_lossy().into_owned();
        if git_version().is_none() {
            return Ok(VaultCreated { path, git: false, committed: false, git_error: None });
        }
        match init_repo(&dir, Some("Cofre criado pelo Dev Suite")) {
            Ok(committed) => Ok(VaultCreated { path, git: true, committed, git_error: None }),
            Err(e) => Ok(VaultCreated { path, git: false, committed: false, git_error: Some(e) }),
        }
    })
    .await
}

// ---------- Diff ----------

fn blob(repo: &Repo, rev: &str, path: &str) -> Option<Vec<u8>> {
    run(&repo.top, &["cat-file", "blob", &format!("{rev}:{path}")], None).ok()
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.len() > MAX_TEXT_BYTES || bytes[..bytes.len().min(8000)].contains(&0)
}

#[derive(Serialize, Default, Debug)]
pub struct FilePair {
    pub left: Option<String>,
    pub right: Option<String>,
    pub left_label: String,
    pub right_label: String,
    pub binary: bool,
    /// Lado direito = cópia de trabalho (os trechos podem ser revertidos).
    pub editable: bool,
    pub mtime: Option<u64>,
}

/// Os dois lados de um diff: HEAD x cópia de trabalho, ou (com `rev`) pai x commit.
#[tauri::command]
pub async fn git_file_pair(app: tauri::AppHandle, path: String, orig_path: Option<String>, rev: Option<String>) -> Res<FilePair> {
    with_repo(app, move |repo| {
        check_path(repo, &path)?;
        let old = orig_path.as_deref().filter(|p| !p.is_empty()).unwrap_or(&path).to_string();
        check_path(repo, &old)?;
        let (left, right, mut pair) = match rev.as_deref() {
            None => {
                let left = if repo.has_head() { blob(repo, "HEAD", &old) } else { None };
                let abs = repo.abs(&path);
                let right = fs::read(&abs).ok();
                let pair = FilePair {
                    left_label: "HEAD".into(),
                    right_label: "Cópia de trabalho".into(),
                    editable: right.is_some(),
                    mtime: mtime_ms(&abs),
                    ..Default::default()
                };
                (left, right, pair)
            }
            Some(rev) => {
                check_rev(rev)?;
                let parent = format!("{rev}^");
                let has_parent = run(&repo.top, &["rev-parse", "-q", "--verify", &parent], None).is_ok();
                let left = if has_parent { blob(repo, &parent, &old) } else { None };
                let right = blob(repo, rev, &path);
                let short: String = rev.chars().take(7).collect();
                let pair = FilePair { left_label: format!("{short}^"), right_label: short, ..Default::default() };
                (left, right, pair)
            }
        };
        pair.binary = left.as_deref().is_some_and(is_binary) || right.as_deref().is_some_and(is_binary);
        if pair.binary {
            pair.editable = false;
            pair.left = left.map(|_| String::new());
            pair.right = right.map(|_| String::new());
        } else {
            pair.left = left.map(|b| String::from_utf8_lossy(&b).into_owned());
            pair.right = right.map(|b| String::from_utf8_lossy(&b).into_owned());
        }
        Ok(pair)
    })
    .await
}

/// Grava a cópia de trabalho com trechos revertidos no diff. `expected_mtime` = versão que o
/// diff mostrou: se o arquivo mudou desde então, nada é gravado.
#[tauri::command]
pub async fn git_write_file(app: tauri::AppHandle, path: String, text: String, expected_mtime: Option<u64>) -> Res<Option<u64>> {
    with_repo(app, move |repo| {
        check_path(repo, &path)?;
        let abs = repo.abs(&path);
        if expected_mtime.is_some() && mtime_ms(&abs) != expected_mtime {
            return Err("O arquivo mudou no disco desde que o diff foi aberto. Atualize o diff.".into());
        }
        write_atomic(&abs, &text)?;
        Ok(mtime_ms(&abs))
    })
    .await
}

// ---------- Commit / reverter ----------

/// Commita só os arquivos marcados (`paths`, incluindo o caminho antigo das renomeações).
/// `amend` = corrige o último commit. Durante um merge, commita o merge inteiro.
#[tauri::command]
pub async fn git_commit(app: tauri::AppHandle, paths: Vec<String>, message: String, amend: bool) -> Res<String> {
    with_repo(app, move |repo| {
        let message = message.trim().to_string();
        if message.is_empty() {
            return Err("Escreva a mensagem do commit.".into());
        }
        for p in &paths {
            check_path(repo, p)?;
        }
        // Só o que existe no disco ou no índice (um arquivo novo apagado depois do status
        // faria o `add` falhar).
        let scope = repo.scope();
        let indexed: HashSet<String> = String::from_utf8_lossy(&run(&repo.top, &["ls-files", "-z", "--", &scope], None)?)
            .split('\0')
            .map(str::to_string)
            .collect();
        let paths: Vec<String> = paths.into_iter().filter(|p| indexed.contains(p) || repo.abs(p).exists()).collect();
        if !paths.is_empty() {
            run(&repo.top, &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&nul_list(&paths)))?;
        }
        if repo.merging() {
            if amend {
                return Err("Não dá para corrigir o último commit durante um merge.".into());
            }
            run(&repo.top, &["commit", "-q", "-F", "-"], Some(message.as_bytes()))?;
        } else {
            if paths.is_empty() && !amend {
                return Err("Marque ao menos um arquivo para commitar.".into());
            }
            let mut args = vec!["commit", "-q", "-m", &message, "--only"];
            if amend {
                args.push("--amend");
            }
            if paths.is_empty() {
                run(&repo.top, &args, None)?;
            } else {
                args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
                run(&repo.top, &args, Some(&nul_list(&paths)))?;
            }
        }
        run_str(&repo.top, &["rev-parse", "--short", "HEAD"])
    })
    .await
}

/// Leva um arquivo do cofre para a lixeira dele (`.trash/`, restaurável no app).
fn to_trash(repo: &Repo, path: &str) -> Res<()> {
    let abs = repo.abs(path);
    if !abs.exists() {
        return Ok(());
    }
    let rel = repo.rel(path).unwrap_or_else(|| path.to_string());
    let mut dest = repo.root.join(TRASH_DIR).join(&rel);
    if dest.exists() {
        let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = dest.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        let stamp = chrono::Local::now().format("%Y-%m-%d %H%M%S");
        dest.set_file_name(format!("{stem} ({stamp}){ext}"));
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::rename(&abs, &dest).map_err(|e| format!("{}: {e}", abs.display()))
}

/// Desfaz as alterações: rastreados voltam à versão do HEAD; novos (e o destino de uma
/// renomeação) saem do índice e vão para a lixeira do cofre.
#[tauri::command]
pub async fn git_rollback(app: tauri::AppHandle, files: Vec<FileChange>) -> Res<()> {
    with_repo(app, move |repo| {
        let head = repo.has_head();
        let mut restore = Vec::new();
        let mut drop = Vec::new();
        for f in &files {
            check_path(repo, &f.path)?;
            match f.status.as_str() {
                "conflicted" => return Err("Resolva o conflito (ou aborte o merge) antes de reverter.".into()),
                "untracked" | "added" => drop.push(f.path.clone()),
                "renamed" => {
                    drop.push(f.path.clone());
                    if let Some(o) = &f.orig_path {
                        check_path(repo, o)?;
                        if head { restore.push(o.clone()) } else { drop.push(o.clone()) }
                    }
                }
                _ if head => restore.push(f.path.clone()),
                _ => drop.push(f.path.clone()),
            }
        }
        if !drop.is_empty() {
            run(&repo.top, &["rm", "-q", "--cached", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&nul_list(&drop)))?;
            for p in &drop {
                to_trash(repo, p)?;
            }
        }
        if !restore.is_empty() {
            run(&repo.top, &["restore", "--source=HEAD", "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&nul_list(&restore)))?;
        }
        Ok(())
    })
    .await
}

/// Ignora um arquivo/pasta do cofre (linha no .gitignore da raiz do cofre).
#[tauri::command]
pub async fn git_ignore(app: tauri::AppHandle, path: String) -> Res<()> {
    with_repo(app, move |repo| {
        check_path(repo, &path)?;
        let rel = repo.rel(&path).unwrap_or_default();
        ensure_gitignore(&repo.root, &[&format!("/{rel}")])?;
        let _ = run(&repo.top, &["rm", "-q", "--cached", "--ignore-unmatch", "--", &path], None);
        Ok(())
    })
    .await
}

// ---------- Histórico ----------

#[derive(Serialize, Debug, PartialEq)]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Segundos desde 1970.
    pub date: i64,
    pub refs: String,
    pub subject: String,
    pub body: String,
}

fn parse_log(raw: &[u8]) -> Vec<Commit> {
    String::from_utf8_lossy(raw)
        .split('\0')
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            let f: Vec<&str> = rec.splitn(9, '\x1f').collect();
            if f.len() < 9 {
                return None;
            }
            Some(Commit {
                hash: f[0].into(),
                short: f[1].into(),
                parents: f[2].split_whitespace().map(str::to_string).collect(),
                author: f[3].into(),
                email: f[4].into(),
                date: f[5].parse().unwrap_or(0),
                refs: f[6].into(),
                subject: f[7].into(),
                body: f[8].trim().into(),
            })
        })
        .collect()
}

/// Commits que tocam o cofre (ou só `path`, seguindo renomeações), do mais novo ao mais velho.
#[tauri::command]
pub async fn git_log(app: tauri::AppHandle, path: Option<String>, skip: u32, limit: u32) -> Res<Vec<Commit>> {
    with_repo(app, move |repo| {
        if !repo.has_head() {
            return Ok(Vec::new());
        }
        let skip = format!("--skip={skip}");
        let limit = format!("-n{}", limit.clamp(1, 1000));
        let mut args = vec!["log", "-z", "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%b", &skip, &limit];
        // Com pathspec o git simplifica o histórico e some com um dos lados dos merges: cofre na
        // raiz do repositório = sem pathspec; numa subpasta = --full-history.
        let target = match &path {
            Some(p) => {
                check_path(repo, p)?;
                args.push("--follow");
                Some(p.clone())
            }
            None if repo.prefix.is_empty() => None,
            None => {
                args.push("--full-history");
                Some(repo.scope())
            }
        };
        if let Some(t) = &target {
            args.extend(["--", t]);
        }
        Ok(parse_log(&run(&repo.top, &args, None)?))
    })
    .await
}

fn parse_name_status(raw: &[u8], prefix: &str) -> Vec<FileChange> {
    let text = String::from_utf8_lossy(raw);
    let mut it = text.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(code) = it.next() {
        let kind = code.chars().next().unwrap_or('M');
        let (path, orig, status) = match kind {
            'R' | 'C' => {
                let src = it.next().unwrap_or_default();
                let dst = it.next().unwrap_or_default();
                (dst, if kind == 'R' { Some(src) } else { None }, if kind == 'R' { "renamed" } else { "added" })
            }
            'A' => (it.next().unwrap_or_default(), None, "added"),
            'D' => (it.next().unwrap_or_default(), None, "deleted"),
            _ => (it.next().unwrap_or_default(), None, "modified"),
        };
        if path.is_empty() || !(path.starts_with(prefix) || orig.is_some_and(|o| o.starts_with(prefix))) {
            continue;
        }
        out.push(FileChange {
            path: path.to_string(),
            orig_path: orig.map(str::to_string),
            rel: path.strip_prefix(prefix).map(str::to_string),
            status: status.to_string(),
        });
    }
    out
}

/// Arquivos alterados num commit (em relação ao 1º pai), restritos ao cofre.
#[tauri::command]
pub async fn git_commit_files(app: tauri::AppHandle, hash: String) -> Res<Vec<FileChange>> {
    with_repo(app, move |repo| {
        check_rev(&hash)?;
        let parent = format!("{hash}^");
        let raw = if run(&repo.top, &["rev-parse", "-q", "--verify", &parent], None).is_ok() {
            run(&repo.top, &["diff-tree", "-r", "-M", "-z", "--name-status", &parent, &hash], None)?
        } else {
            run(&repo.top, &["diff-tree", "-r", "-z", "--name-status", "--root", "--no-commit-id", &hash], None)?
        };
        Ok(parse_name_status(&raw, &repo.prefix))
    })
    .await
}

// ---------- Remoto ----------

/// Define (`url`) ou remove (vazio) o remoto `origin`.
#[tauri::command]
pub async fn git_remote_set(app: tauri::AppHandle, url: Option<String>) -> Res<()> {
    with_repo(app, move |repo| {
        let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
        match url {
            Some(u) if u.starts_with('-') => Err("URL inválida.".into()),
            Some(u) if repo.has_origin() => run(&repo.top, &["remote", "set-url", "origin", &u], None).map(|_| ()),
            Some(u) => run(&repo.top, &["remote", "add", "origin", &u], None).map(|_| ()),
            None if repo.has_origin() => run(&repo.top, &["remote", "remove", "origin"], None).map(|_| ()),
            None => Ok(()),
        }
    })
    .await
}

/// Roda um comando que fala com o remoto, cancelável por `op_id`.
fn run_remote(app: &tauri::AppHandle, repo: &Repo, op_id: &str, args: &[&str]) -> Res<String> {
    let mut cmd = base(&repo.top);
    // Sem terminal, o ssh não tem onde pedir senha: falha logo em vez de esperar para sempre.
    if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() && try_str(&repo.top, &["config", "core.sshCommand"]).is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(spawn_error)?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = stdout.as_mut() {
            let _ = s.read_to_end(&mut b);
        }
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_end(&mut b);
        }
        b
    });
    let child = Arc::new(Mutex::new(child));
    let st = app.state::<GitState>();
    st.inflight.lock().unwrap_or_else(|e| e.into_inner()).insert(op_id.to_string(), child.clone());
    let status = loop {
        let done = child.lock().unwrap_or_else(|e| e.into_inner()).try_wait();
        match done {
            Ok(Some(s)) => break Ok(s),
            Ok(None) => std::thread::sleep(Duration::from_millis(60)),
            Err(e) => break Err(e.to_string()),
        }
    };
    st.inflight.lock().unwrap_or_else(|e| e.into_inner()).remove(op_id);
    let cancelled = st.cancelled.lock().unwrap_or_else(|e| e.into_inner()).remove(op_id);
    let out = out_t.join().unwrap_or_default();
    let err = err_t.join().unwrap_or_default();
    if cancelled {
        return Err("Cancelado.".into());
    }
    if status?.success() {
        let text = String::from_utf8_lossy(&err).trim().to_string();
        Ok(if text.is_empty() { String::from_utf8_lossy(&out).trim().to_string() } else { text })
    } else {
        Err(err_text(&err, &out))
    }
}

#[tauri::command]
pub fn git_cancel(app: tauri::AppHandle, op_id: String) {
    let st = app.state::<GitState>();
    let child = st.inflight.lock().unwrap_or_else(|e| e.into_inner()).get(&op_id).cloned();
    if let Some(child) = child {
        st.cancelled.lock().unwrap_or_else(|e| e.into_inner()).insert(op_id);
        let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

/// Testa uma URL de remoto (`ls-remote`): devolve quantos branches ela tem.
#[tauri::command]
pub async fn git_remote_test(app: tauri::AppHandle, url: String, op_id: String) -> Res<usize> {
    let a = app.clone();
    with_repo(app, move |repo| {
        let url = url.trim();
        if url.is_empty() || url.starts_with('-') {
            return Err("URL inválida.".into());
        }
        let out = run_remote(&a, repo, &op_id, &["ls-remote", "--heads", url])?;
        Ok(out.lines().filter(|l| l.contains("refs/heads/")).count())
    })
    .await
}

fn need_origin(repo: &Repo) -> Res<()> {
    if repo.has_origin() { Ok(()) } else { Err("Configure o remoto (origin) primeiro.".into()) }
}

#[tauri::command]
pub async fn git_fetch(app: tauri::AppHandle, op_id: String) -> Res<String> {
    let a = app.clone();
    with_repo(app, move |repo| {
        need_origin(repo)?;
        run_remote(&a, repo, &op_id, &["fetch", "--prune", "origin"])
    })
    .await
}

#[derive(Serialize, Debug)]
pub struct PullResult {
    pub message: String,
    pub conflicts: bool,
}

/// Traz o remoto com merge. Sem upstream, usa `origin/<branch atual>` e passa a segui-lo.
/// Conflito não é erro: o merge fica em andamento para ser resolvido no app.
#[tauri::command]
pub async fn git_pull(app: tauri::AppHandle, op_id: String) -> Res<PullResult> {
    let a = app.clone();
    with_repo(app, move |repo| {
        need_origin(repo)?;
        if repo.merging() {
            return Err("Há um merge em andamento: resolva os conflitos e commite (ou aborte o merge).".into());
        }
        let base_args = ["pull", "--no-rebase", "--no-edit", "--allow-unrelated-histories"];
        let result = if repo.upstream().is_some() {
            run_remote(&a, repo, &op_id, &base_args)
        } else {
            let branch = repo.branch().ok_or("O cofre não está num branch.")?;
            let heads = run_remote(&a, repo, &op_id, &["ls-remote", "--heads", "origin", &branch])?;
            if !heads.contains("refs/heads/") {
                return Ok(PullResult { message: format!("O remoto ainda não tem o branch {branch}: nada para trazer."), conflicts: false });
            }
            let mut args = base_args.to_vec();
            args.extend(["origin", &branch]);
            let r = run_remote(&a, repo, &op_id, &args);
            if r.is_ok() || repo.merging() {
                let _ = run(&repo.top, &["branch", &format!("--set-upstream-to=origin/{branch}")], None);
            }
            r
        };
        match result {
            Ok(message) => Ok(PullResult { message, conflicts: false }),
            Err(e) if repo.merging() => Ok(PullResult { message: e, conflicts: true }),
            Err(e) => Err(e),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_push(app: tauri::AppHandle, op_id: String) -> Res<String> {
    let a = app.clone();
    with_repo(app, move |repo| {
        need_origin(repo)?;
        if !repo.has_head() {
            return Err("Nada para enviar: faça o primeiro commit.".into());
        }
        if repo.upstream().is_some() {
            run_remote(&a, repo, &op_id, &["push"])
        } else {
            run_remote(&a, repo, &op_id, &["push", "-u", "origin", "HEAD"])
        }
    })
    .await
}

// ---------- Conflitos de merge ----------

#[derive(Serialize, Default, Debug)]
pub struct Conflict {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub binary: bool,
}

/// As três versões de um arquivo em conflito: base comum, a minha (HEAD) e a do remoto.
#[tauri::command]
pub async fn git_conflict(app: tauri::AppHandle, path: String) -> Res<Conflict> {
    with_repo(app, move |repo| {
        check_path(repo, &path)?;
        let get = |stage: u8| blob(repo, &format!(":{stage}"), &path);
        let (base, ours, theirs) = (get(1), get(2), get(3));
        let binary = [&base, &ours, &theirs].iter().any(|b| b.as_deref().is_some_and(is_binary));
        let text = |b: Option<Vec<u8>>| if binary { b.map(|_| String::new()) } else { b.map(|b| String::from_utf8_lossy(&b).into_owned()) };
        Ok(Conflict { base: text(base), ours: text(ours), theirs: text(theirs), binary })
    })
    .await
}

/// Marca o conflito como resolvido: grava `text` (ou apaga o arquivo, se None) e põe no índice.
#[tauri::command]
pub async fn git_resolve(app: tauri::AppHandle, path: String, text: Option<String>) -> Res<()> {
    with_repo(app, move |repo| {
        check_path(repo, &path)?;
        match text {
            Some(t) => {
                write_atomic(&repo.abs(&path), &t)?;
                run(&repo.top, &["add", "--", &path], None)?;
            }
            None => {
                run(&repo.top, &["rm", "-q", "--cached", "--ignore-unmatch", "--", &path], None)?;
                let _ = fs::remove_file(repo.abs(&path));
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_merge_abort(app: tauri::AppHandle) -> Res<()> {
    with_repo(app, |repo| run(&repo.top, &["merge", "--abort"], None).map(|_| ())).await
}

/// Nome/e-mail dos commits (neste repositório ou para todos, `global`).
#[tauri::command]
pub async fn git_set_identity(app: tauri::AppHandle, name: String, email: String, global: bool) -> Res<()> {
    with_repo(app, move |repo| {
        let (name, email) = (name.trim(), email.trim());
        if name.is_empty() || email.is_empty() {
            return Err("Preencha nome e e-mail.".into());
        }
        let scope: &[&str] = if global { &["config", "--global"] } else { &["config"] };
        for (k, v) in [("user.name", name), ("user.email", email)] {
            let mut args = scope.to_vec();
            args.extend([k, v]);
            run(&repo.top, &args, None)?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("todors-git-{name}-{}-{}", std::process::id(), chrono::Utc::now().timestamp_millis()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn identity(dir: &Path) {
        run(dir, &["config", "user.name", "Teste"], None).unwrap();
        run(dir, &["config", "user.email", "teste@example.com"], None).unwrap();
    }

    #[test]
    fn parses_porcelain_v2() {
        let raw = b"# branch.oid abcdef1234567\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb notas/Reuni\xc3\xa3o de quinta.md\0\
1 D. N... 100644 000000 000000 aaa 000 notas/Velha.md\0\
2 R. N... 100644 100644 100644 aaa aaa R100 notas/Nova.md\0notas/Antiga.md\0\
u UU N... 100644 100644 100644 100644 a b c notas/C.md\0\
? notas/Nova nota.md\0? fora.md\0";
        let st = parse_status(raw, "notas/");
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.head.as_deref(), Some("abcdef1"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        let kinds: Vec<(&str, &str)> = st.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                ("notas/Reunião de quinta.md", "modified"),
                ("notas/Velha.md", "deleted"),
                ("notas/Nova.md", "renamed"),
                ("notas/C.md", "conflicted"),
                ("notas/Nova nota.md", "untracked"),
                ("fora.md", "untracked"),
            ]
        );
        assert_eq!(st.files[2].orig_path.as_deref(), Some("notas/Antiga.md"));
        assert_eq!(st.files[0].rel.as_deref(), Some("Reunião de quinta.md"));
        assert_eq!(st.files[5].rel, None);
    }

    #[test]
    fn parses_log_and_name_status() {
        let raw = b"h1\x1fs1\x1fp1 p2\x1fAna\x1fa@x\x1f100\x1fHEAD -> main\x1fAssunto\x1fCorpo\n\0\nh2\x1fs2\x1f\x1fBia\x1fb@x\x1f50\x1f\x1fInicial\x1f\0";
        let log = parse_log(raw);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].parents, vec!["p1", "p2"]);
        assert_eq!(log[0].body, "Corpo");
        assert_eq!(log[1].subject, "Inicial");
        let ns = parse_name_status(b"M\0v/a.md\0R087\0v/b.md\0v/c.md\0A\0x.md\0", "v/");
        assert_eq!(ns.len(), 2);
        assert_eq!(ns[1].status, "renamed");
        assert_eq!(ns[1].path, "v/c.md");
        assert_eq!(ns[1].orig_path.as_deref(), Some("v/b.md"));
    }

    #[test]
    fn init_status_commit_rollback_log() {
        if git_version().is_none() {
            eprintln!("git ausente: teste pulado");
            return;
        }
        let dir = tmp_dir("flow");
        init_repo(&dir, None).unwrap();
        identity(&dir);
        assert!(fs::read_to_string(dir.join(".gitignore")).unwrap().contains(".trash/"));
        let repo = Repo::open(&dir).unwrap().unwrap();
        assert_eq!(repo.prefix, "");
        fs::write(dir.join("Reunião de quinta.md"), "# Reunião\nlinha 1\n").unwrap();
        fs::create_dir_all(dir.join(".trash")).unwrap();
        fs::write(dir.join(".trash/x.md"), "lixo").unwrap();
        let st = status_of(&repo).unwrap();
        let paths: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".gitignore", "Reunião de quinta.md"]);
        assert!(st.files.iter().all(|f| f.status == "untracked"));

        // Commit parcial no repositório ainda sem HEAD.
        run(&repo.top, &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&nul_list(&["Reunião de quinta.md".into()]))).unwrap();
        run(&repo.top, &["commit", "-q", "-m", "primeiro", "--only", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&nul_list(&["Reunião de quinta.md".into()]))).unwrap();
        let st = status_of(&repo).unwrap();
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].path, ".gitignore");

        fs::write(dir.join("Reunião de quinta.md"), "# Reunião\nlinha 2\n").unwrap();
        let st = status_of(&repo).unwrap();
        assert!(st.files.iter().any(|f| f.path == "Reunião de quinta.md" && f.status == "modified"));
        run(&repo.top, &["restore", "--source=HEAD", "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(&nul_list(&["Reunião de quinta.md".into()]))).unwrap();
        assert_eq!(fs::read_to_string(dir.join("Reunião de quinta.md")).unwrap(), "# Reunião\nlinha 1\n");

        to_trash(&repo, ".gitignore").unwrap();
        assert!(dir.join(".trash/.gitignore").exists());

        let raw = run(&repo.top, &["log", "-z", "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%b", "--", "."], None).unwrap();
        let log = parse_log(&raw);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "primeiro");
        assert_eq!(blob(&repo, "HEAD", "Reunião de quinta.md").unwrap(), "# Reunião\nlinha 1\n".as_bytes());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_inside_bigger_repo_uses_prefix() {
        if git_version().is_none() {
            return;
        }
        let dir = tmp_dir("prefix");
        init_repo(&dir, None).unwrap();
        fs::create_dir_all(dir.join("docs/notas")).unwrap();
        fs::write(dir.join("docs/notas/A.md"), "a").unwrap();
        fs::write(dir.join("fora.md"), "b").unwrap();
        let repo = Repo::open(&dir.join("docs/notas")).unwrap().unwrap();
        assert_eq!(repo.prefix, "docs/notas/");
        let st = status_of(&repo).unwrap();
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].rel.as_deref(), Some("A.md"));
        assert!(check_path(&repo, "fora.md").is_err());
        assert!(check_path(&repo, "docs/notas/../x").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

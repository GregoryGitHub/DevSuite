//! Conexão com o Dev Suite: lê `<app_data>/cli.json` (endpoint + token), abre o named pipe
//! (Windows) ou o socket unix e, se o app não estiver rodando, inicia-o na bandeja.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Identificador do app (`tauri.conf.json → identifier`): define a pasta de dados.
const IDENTIFIER: &str = "com.todors.app";
const START_WAIT: Duration = Duration::from_secs(45);

pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Failure { code: code.into(), message: message.into() }
    }
}

pub fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DEVSUITE_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join(IDENTIFIER))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support").join(IDENTIFIER))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .map(|d| d.join(IDENTIFIER))
    }
}

fn read_info() -> Option<Value> {
    let text = std::fs::read_to_string(data_dir()?.join("cli.json")).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(windows)]
type Stream = std::fs::File;
#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;

fn open_stream(endpoint: &str) -> std::io::Result<Stream> {
    #[cfg(windows)]
    {
        // ERROR_PIPE_BUSY (231): todas as instâncias ocupadas por um instante.
        let mut tries = 0;
        loop {
            match std::fs::OpenOptions::new().read(true).write(true).open(endpoint) {
                Err(e) if e.raw_os_error() == Some(231) && tries < 50 => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(40));
                }
                other => return other,
            }
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(endpoint)
    }
}

pub struct Conn {
    writer: Stream,
    reader: BufReader<Stream>,
    next_id: u64,
}

impl Conn {
    fn handshake(info: &Value) -> Result<Conn, Failure> {
        let endpoint = info["endpoint"].as_str().ok_or_else(|| Failure::new("unavailable", "cli.json sem endpoint"))?;
        let stream = open_stream(endpoint).map_err(|e| Failure::new("unavailable", format!("Dev Suite não está ouvindo ({e})")))?;
        let reader = BufReader::new(stream.try_clone().map_err(|e| Failure::new("unavailable", e.to_string()))?);
        let mut conn = Conn { writer: stream, reader, next_id: 0 };
        conn.send(&json!({ "hello": "devsuite-cli", "token": info["token"] }))?;
        let reply = conn.read()?;
        if reply.get("hello").is_some() {
            Ok(conn)
        } else {
            Err(failure_of(&reply["error"]))
        }
    }

    fn send(&mut self, v: &Value) -> Result<(), Failure> {
        let mut line = v.to_string();
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .and_then(|_| self.writer.flush())
            .map_err(|e| Failure::new("unavailable", format!("Conexão com o Dev Suite caiu ({e})")))
    }

    fn read(&mut self) -> Result<Value, Failure> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => Err(Failure::new("unavailable", "O Dev Suite fechou a conexão")),
            Ok(_) => serde_json::from_str(&line).map_err(|e| Failure::new("protocol", format!("Resposta inválida: {e}"))),
            Err(e) => Err(Failure::new("unavailable", format!("Conexão com o Dev Suite caiu ({e})"))),
        }
    }

    /// Chama um método; `on_event` recebe os eventos intermediários (linhas de `watch` etc.).
    pub fn call(&mut self, method: &str, params: Value, mut on_event: impl FnMut(&Value)) -> Result<Value, Failure> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "id": id, "method": method, "params": params }))?;
        loop {
            let frame = self.read()?;
            if frame["id"].as_u64() != Some(id) {
                if !frame["error"].is_null() {
                    return Err(failure_of(&frame["error"]));
                }
                continue;
            }
            if let Some(ev) = frame.get("event") {
                on_event(ev);
            } else if let Some(err) = frame.get("error") {
                return Err(failure_of(err));
            } else {
                return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }
}

fn failure_of(err: &Value) -> Failure {
    Failure::new(
        err["code"].as_str().unwrap_or("failed"),
        err["message"].as_str().map(str::to_string).unwrap_or_else(|| err.to_string()),
    )
}

/// Conecta; sem app rodando (e `autostart`), inicia `dev-suite --background` e espera.
pub fn connect(autostart: bool) -> Result<Conn, Failure> {
    let first = match read_info() {
        Some(info) => Conn::handshake(&info),
        None => Err(Failure::new("unavailable", "Dev Suite não está rodando")),
    };
    match first {
        Ok(c) => return Ok(c),
        Err(e) if e.code == "auth" => return Err(e),
        Err(e) if !autostart => return Err(e),
        Err(_) => {}
    }
    let previous = read_info();
    start_app(previous.as_ref())?;
    let deadline = Instant::now() + START_WAIT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        let Some(info) = read_info() else { continue };
        // Espera o app novo regravar o cli.json (o antigo aponta para um processo morto).
        if previous.as_ref().is_some_and(|p| p["token"] == info["token"]) {
            continue;
        }
        if let Ok(c) = Conn::handshake(&info) {
            return Ok(c);
        }
    }
    Err(Failure::new("unavailable", "O Dev Suite não respondeu depois de iniciado"))
}

fn app_candidates(previous: Option<&Value>) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(p) = std::env::var_os("DEVSUITE_APP") {
        list.push(PathBuf::from(p));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        for name in ["dev-suite", "todo-rs"] {
            list.push(dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)));
        }
    }
    if let Some(exe) = previous.and_then(|p| p["exe"].as_str()) {
        list.push(PathBuf::from(exe));
    }
    list
}

fn start_app(previous: Option<&Value>) -> Result<(), Failure> {
    let exe = app_candidates(previous).into_iter().find(|p| p.is_file());
    #[cfg(unix)]
    let exe = exe.or_else(|| Some(PathBuf::from("dev-suite")));
    let exe = exe.ok_or_else(|| Failure::new("unavailable", "Dev Suite não está rodando e o executável não foi encontrado (defina DEVSUITE_APP)"))?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--background").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| Failure::new("unavailable", format!("Falha ao iniciar {}: {e}", exe.display())))
}

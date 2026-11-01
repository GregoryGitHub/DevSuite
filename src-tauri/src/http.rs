//! Cliente HTTP da aba "HTTP" (estilo Postman).
//!
//! As requisições saem do Rust e não do webview, então não há CORS, dá para
//! enviar qualquer cabeçalho (Host, Cookie, User-Agent...) e ler qualquer resposta.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::cookie::Jar;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Requisições em andamento (id -> sinal de cancelamento).
#[derive(Default)]
pub struct HttpInflight(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

/// Cookies da sessão, compartilhados entre requisições como num navegador.
pub struct HttpCookies(Mutex<Arc<Jar>>);

impl Default for HttpCookies {
    fn default() -> Self {
        Self(Mutex::new(Arc::new(Jar::default())))
    }
}

#[derive(Deserialize)]
pub struct KeyValue {
    key: String,
    value: String,
}

#[derive(Deserialize)]
pub struct FormField {
    key: String,
    #[serde(default)]
    value: String,
    /// Quando preenchido, o campo é enviado como arquivo.
    #[serde(default)]
    file_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HttpBody {
    None,
    Text { text: String },
    Multipart { fields: Vec<FormField> },
    File { path: String },
}

#[derive(Deserialize)]
pub struct HttpRequest {
    id: String,
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<KeyValue>,
    body: HttpBody,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_true")]
    follow_redirects: bool,
    #[serde(default = "default_true")]
    verify_ssl: bool,
    #[serde(default = "default_true")]
    use_cookies: bool,
}

fn default_timeout() -> u64 {
    30_000
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    status_text: String,
    http_version: String,
    url: String,
    headers: Vec<(String, String)>,
    /// Corpo decodificado como UTF-8 (com substituição de bytes inválidos).
    body: String,
    /// Corpo original em base64, só quando não é texto (imagens, PDFs...).
    body_base64: Option<String>,
    body_size: usize,
    headers_size: usize,
    time_ms: u64,
}

const TEXT_SNIFF_LIMIT: usize = 8 * 1024;

fn looks_like_text(content_type: &str, bytes: &[u8]) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("text/")
        || ct.contains("json")
        || ct.contains("xml")
        || ct.contains("javascript")
        || ct.contains("x-www-form-urlencoded")
        || ct.contains("graphql")
    {
        return true;
    }
    if ct.starts_with("image/") || ct.starts_with("audio/") || ct.starts_with("video/") || ct.contains("pdf") || ct.contains("octet-stream") || ct.contains("zip") {
        return false;
    }
    let sample = &bytes[..bytes.len().min(TEXT_SNIFF_LIMIT)];
    !sample.contains(&0) && std::str::from_utf8(sample).is_ok()
}

fn guess_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" | "log" | "md" | "csv" => "text/plain",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn read_file(path: &str) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Não foi possível ler o arquivo \"{path}\": {e}"))
}

fn build_headers(list: &[KeyValue]) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for kv in list {
        let key = kv.key.trim();
        if key.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("Nome de cabeçalho inválido: \"{key}\""))?;
        let value = HeaderValue::from_str(&kv.value)
            .map_err(|_| format!("Valor inválido no cabeçalho \"{key}\""))?;
        map.append(name, value);
    }
    Ok(map)
}

fn describe_error(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = if e.is_timeout() {
        "Tempo limite esgotado".to_string()
    } else if e.is_connect() {
        "Falha ao conectar".to_string()
    } else if e.is_redirect() {
        "Redirecionamentos demais".to_string()
    } else if e.is_builder() {
        "Requisição inválida".to_string()
    } else {
        "Erro na requisição".to_string()
    };
    // As causas internas (DNS, TLS, recusa de conexão) são as mensagens úteis.
    let mut source = e.source();
    while let Some(s) = source {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    msg
}

async fn execute(req: HttpRequest, jar: Arc<Jar>) -> Result<HttpResponse, String> {
    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("Método inválido: {}", req.method))?;

    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.max(1)))
        .danger_accept_invalid_certs(!req.verify_ssl)
        .redirect(if req.follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        });
    if req.use_cookies {
        builder = builder.cookie_provider(jar);
    }
    let client = builder.build().map_err(|e| describe_error(&e))?;

    let mut request = client.request(method, req.url.trim()).headers(build_headers(&req.headers)?);

    request = match req.body {
        HttpBody::None => request,
        HttpBody::Text { text } => request.body(text),
        HttpBody::File { path } => request.body(read_file(&path)?),
        HttpBody::Multipart { fields } => {
            let mut form = reqwest::multipart::Form::new();
            for f in fields {
                form = match f.file_path.filter(|p| !p.is_empty()) {
                    Some(path) => {
                        let p = PathBuf::from(&path);
                        let name = p
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "arquivo".into());
                        let part = reqwest::multipart::Part::bytes(read_file(&path)?)
                            .file_name(name)
                            .mime_str(guess_mime(&p))
                            .map_err(|e| e.to_string())?;
                        form.part(f.key, part)
                    }
                    None => form.text(f.key, f.value),
                };
            }
            request.multipart(form)
        }
    };

    let started = Instant::now();
    let response = request.send().await.map_err(|e| describe_error(&e))?;

    let status = response.status();
    let http_version = format!("{:?}", response.version());
    let url = response.url().to_string();
    let mut headers_size = 0;
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| {
            let value = String::from_utf8_lossy(v.as_bytes()).into_owned();
            headers_size += k.as_str().len() + value.len() + 4;
            (k.as_str().to_string(), value)
        })
        .collect();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = response.bytes().await.map_err(|e| describe_error(&e))?;
    let time_ms = started.elapsed().as_millis() as u64;

    let is_text = looks_like_text(&content_type, &bytes);
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        http_version,
        url,
        headers,
        body: if is_text { String::from_utf8_lossy(&bytes).into_owned() } else { String::new() },
        body_base64: if is_text { None } else { Some(B64.encode(&bytes)) },
        body_size: bytes.len(),
        headers_size,
        time_ms,
    })
}

#[tauri::command]
pub async fn send_http_request(app: tauri::AppHandle, request: HttpRequest) -> Result<HttpResponse, String> {
    let id = request.id.clone();
    let jar = app.state::<HttpCookies>().0.lock().unwrap().clone();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    app.state::<HttpInflight>().0.lock().unwrap().insert(id.clone(), cancel_tx);

    // Descartar o future de `execute` aborta a conexão em andamento.
    let result = tokio::select! {
        r = execute(request, jar) => r,
        _ = cancel_rx => Err("Requisição cancelada".into()),
    };
    app.state::<HttpInflight>().0.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
pub fn cancel_http_request(app: tauri::AppHandle, id: String) {
    if let Some(tx) = app.state::<HttpInflight>().0.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

#[tauri::command]
pub fn clear_http_cookies(app: tauri::AppHandle) {
    *app.state::<HttpCookies>().0.lock().unwrap() = Arc::new(Jar::default());
}

// ---------- Persistência e arquivos ----------

fn http_file(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push("http.json");
    dir
}

/// Coleções, ambientes e histórico são guardados como um único documento JSON;
/// o formato é definido e migrado pelo frontend (`src/js/utils/httpModel.js`).
#[tauri::command]
pub fn load_http_data(app: tauri::AppHandle) -> serde_json::Value {
    let path = http_file(&app);
    let Ok(raw) = fs::read_to_string(&path) else {
        return serde_json::Value::Null;
    };
    match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("http.json inválido ({e}); salvando cópia em http.json.bak");
            let _ = fs::copy(&path, path.with_extension("json.bak"));
            serde_json::Value::Null
        }
    }
}

#[tauri::command]
pub fn save_http_data(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = http_file(&app);
    let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    // Gravação atômica numa thread própria (ver persist.rs): não trava a interface.
    crate::persist::write(path, json);
    Ok(())
}

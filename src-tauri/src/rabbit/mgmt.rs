//! Cliente da API HTTP do plugin de management do RabbitMQ (`/api/...`).
//!
//! Monitoramento (overview, filas, exchanges, conexões, canais, consumidores) e operações
//! administrativas (purge, delete, publish, get, bindings) passam por aqui. O JS monta o
//! caminho (`/queues/%2F/fila`) e o corpo; aqui só entram URL base, autenticação e erros legíveis.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::{Client, Method};
use serde_json::Value;

use super::RmqConn;

/// Clientes reaproveitados por (verificar TLS?, timeout) — mantêm o keep-alive entre os refreshes.
#[derive(Default)]
pub struct MgmtClients(Mutex<HashMap<(bool, u64), Client>>);

impl MgmtClients {
    fn get(&self, insecure: bool, timeout_s: u64) -> Result<Client, String> {
        let mut map = self.0.lock().unwrap();
        if let Some(c) = map.get(&(insecure, timeout_s)) {
            return Ok(c.clone());
        }
        let client = Client::builder()
            .danger_accept_invalid_certs(insecure)
            .timeout(Duration::from_secs(timeout_s.max(1)))
            .connect_timeout(Duration::from_secs(timeout_s.clamp(1, 15)))
            .user_agent(concat!("TodoRS/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        map.insert((insecure, timeout_s), client.clone());
        Ok(client)
    }
}

/// `localhost:15672` → `http://localhost:15672`; tira a barra final e um `/api` digitado.
pub fn base_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if !s.contains("://") {
        s = format!("http://{s}");
    }
    if let Some(stripped) = s.strip_suffix("/api") {
        s = stripped.to_string();
    }
    s
}

pub async fn call(clients: &MgmtClients, conn: &RmqConn, password: &str, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let base = base_url(&conn.mgmt_url);
    let url = format!("{base}/api{}", if path.starts_with('/') { path.to_string() } else { format!("/{path}") });
    let method = Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|_| format!("Método inválido: {method}"))?;
    let client = clients.get(conn.tls_insecure, conn.timeout_s.unwrap_or(20))?;
    let mut req = client.request(method, &url).basic_auth(&conn.user, Some(password));
    if let Some(b) = body {
        req = req.header("content-type", "application/json").body(b.to_string());
    }
    let resp = req.send().await.map_err(|e| describe_send_error(&base, &e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status.is_success() {
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        return serde_json::from_str(&text).map_err(|e| format!("Resposta inválida da API ({e})"));
    }
    let detail = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("reason").or_else(|| v.get("error")).and_then(|r| r.as_str().map(str::to_string)))
        .unwrap_or_else(|| text.chars().take(300).collect());
    Err(match status.as_u16() {
        401 => "Usuário ou senha inválidos (401).".to_string(),
        403 => format!("Sem permissão (403): {detail}"),
        404 => format!("Não encontrado (404): {detail}"),
        code => format!("Erro {code}: {detail}"),
    })
}

fn describe_send_error(base: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("Tempo esgotado ao acessar {base}.")
    } else if e.is_connect() {
        format!("Não foi possível conectar em {base}. O plugin de management (porta 15672) está habilitado?")
    } else {
        format!("Falha ao acessar {base}: {e}")
    }
}

/// `/` → `%2F` (vhosts e nomes de filas vão como segmentos de caminho).
pub fn seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(base_url("localhost:15672/"), "http://localhost:15672");
        assert_eq!(base_url("https://mq.example.com/rabbit/api/"), "https://mq.example.com/rabbit");
        assert_eq!(seg("/"), "%2F");
        assert_eq!(seg("fila.pedidos v2"), "fila.pedidos%20v2");
        assert_eq!(seg("ação"), "a%C3%A7%C3%A3o");
    }
}

//! Login Microsoft Entra (Azure AD) interativo, com MFA, para o Azure SQL.
//!
//! OAuth 2.0 Authorization Code + PKCE com redirect para um servidor HTTP temporário em
//! 127.0.0.1 (aplicativo público, sem client secret). O navegador padrão faz o login (inclusive
//! MFA); o refresh token fica no cofre do sistema e renova o access token sem abrir o navegador.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::driver::{AuthConfig, DbResult};
use super::secrets;

/// Cliente público da Azure CLI: aceita redirect para http://localhost em qualquer porta
/// e já tem consentimento para o Azure SQL na maioria dos tenants.
const DEFAULT_CLIENT_ID: &str = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
/// O recurso do Azure SQL termina em "/", daí a barra dupla antes de ".default".
const SCOPE: &str = "https://database.windows.net//.default offline_access openid profile";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Access tokens em memória por conexão (expiram em ~1 h).
#[derive(Default)]
pub struct EntraTokens(Mutex<HashMap<String, (String, Instant)>>);

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct TokenError {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: String,
}

fn tenant(auth: &AuthConfig) -> &str {
    let t = auth.tenant.trim();
    if t.is_empty() {
        "organizations"
    } else {
        t
    }
}

fn client_id(auth: &AuthConfig) -> &str {
    let c = auth.client_id.trim();
    if c.is_empty() {
        DEFAULT_CLIENT_ID
    } else {
        c
    }
}

fn endpoint(auth: &AuthConfig, path: &str) -> String {
    format!("https://login.microsoftonline.com/{}/oauth2/v2.0/{path}", tenant(auth))
}

/// Access token válido: cache em memória → refresh token do cofre → (se `interactive`) navegador.
pub async fn access_token(app: &tauri::AppHandle, tokens: &EntraTokens, conn_id: &str, auth: &AuthConfig, interactive: bool) -> DbResult<String> {
    if let Some((token, until)) = tokens.0.lock().unwrap().get(conn_id) {
        if Instant::now() + Duration::from_secs(120) < *until {
            return Ok(token.clone());
        }
    }
    if let Some(refresh) = secrets::get(conn_id, "entra")? {
        match redeem(auth, &[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await {
            Ok(res) => return Ok(store(tokens, conn_id, res)),
            Err(e) => eprintln!("refresh do Entra falhou ({e}); novo login necessário"),
        }
    }
    if !interactive {
        return Err("ENTRA_LOGIN_REQUIRED: faça login com a conta Microsoft para conectar.".into());
    }
    let res = interactive_login(app, auth).await?;
    Ok(store(tokens, conn_id, res))
}

pub fn forget(tokens: &EntraTokens, conn_id: &str) {
    tokens.0.lock().unwrap().remove(conn_id);
    let _ = secrets::delete(conn_id, "entra");
}

fn store(tokens: &EntraTokens, conn_id: &str, res: TokenResponse) -> String {
    if let Some(refresh) = &res.refresh_token {
        if let Err(e) = secrets::set(conn_id, "entra", refresh) {
            eprintln!("{e}");
        }
    }
    let until = Instant::now() + Duration::from_secs(res.expires_in.unwrap_or(3600));
    tokens.0.lock().unwrap().insert(conn_id.to_string(), (res.access_token.clone(), until));
    res.access_token
}

async fn redeem(auth: &AuthConfig, grant: &[(&str, &str)]) -> DbResult<TokenResponse> {
    let mut form: Vec<(&str, &str)> = vec![("client_id", client_id(auth)), ("scope", SCOPE)];
    form.extend_from_slice(grant);
    let res = reqwest::Client::new()
        .post(endpoint(auth, "token"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Falha ao falar com o Microsoft Entra: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let err: TokenError = serde_json::from_str(&body).unwrap_or(TokenError { error: status.to_string(), error_description: body });
        let first_line = err.error_description.lines().next().unwrap_or("").to_string();
        return Err(format!("Microsoft Entra recusou o login ({}): {first_line}", err.error));
    }
    serde_json::from_str(&body).map_err(|e| format!("Resposta inválida do Microsoft Entra: {e}"))
}

fn random_b64(len: usize) -> String {
    let bytes: Vec<u8> = (0..len).map(|_| rand::random::<u8>()).collect();
    B64URL.encode(bytes)
}

/// Desafio PKCE (S256) para um verifier.
pub fn challenge(verifier: &str) -> String {
    B64URL.encode(Sha256::digest(verifier.as_bytes()))
}

async fn interactive_login(app: &tauri::AppHandle, auth: &AuthConfig) -> DbResult<TokenResponse> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Não foi possível abrir a porta local do login: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://localhost:{port}");
    let verifier = random_b64(48);
    let state = random_b64(16);

    let mut url = reqwest::Url::parse(&endpoint(auth, "authorize")).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", client_id(auth))
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_mode", "query")
            .append_pair("scope", SCOPE)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("prompt", "select_account");
        if !auth.user.trim().is_empty() {
            q.append_pair("login_hint", auth.user.trim());
        }
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| format!("Não foi possível abrir o navegador: {e}"))?;

    let code = tokio::time::timeout(LOGIN_TIMEOUT, wait_for_code(&listener, &state))
        .await
        .map_err(|_| "Tempo esgotado esperando o login no navegador".to_string())??;
    redeem(
        auth,
        &[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", &redirect), ("code_verifier", &verifier)],
    )
    .await
}

/// Espera o navegador voltar para `http://localhost:<porta>/?code=...&state=...`.
async fn wait_for_code(listener: &TcpListener, state: &str) -> DbResult<String> {
    loop {
        let (mut socket, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 16 * 1024];
        let n = socket.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let Ok(url) = reqwest::Url::parse(&format!("http://localhost{target}")) else { continue };
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        if params.is_empty() {
            // favicon e afins
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }

        let result = if let Some(err) = params.get("error") {
            Err(format!("Login cancelado ou recusado: {}", params.get("error_description").unwrap_or(err)))
        } else if params.get("state").map(String::as_str) != Some(state) {
            Err("Resposta de login inválida (state)".to_string())
        } else {
            params.get("code").cloned().ok_or_else(|| "Resposta de login sem código".to_string())
        };
        let (title, text) = match &result {
            Ok(_) => ("Login concluído", "Pode fechar esta aba e voltar ao Dev Suite."),
            Err(_) => ("Falha no login", "Volte ao Dev Suite para ver o erro."),
        };
        let html = format!(
            "<!doctype html><meta charset=utf-8><title>{title}</title>\
             <body style=\"font-family:system-ui;display:grid;place-items:center;height:90vh;background:#1e1e1f;color:#eee\">\
             <div style=\"text-align:center\"><h2>{title}</h2><p>{text}</p></div>"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
            html.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
        return result;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636() {
        // Exemplo do apêndice B da RFC 7636.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}

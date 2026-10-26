//! Túnel SSH (bastion) para conexões Redis: uma sessão SSH por conexão e um encaminhamento
//! local (127.0.0.1:porta efêmera → host:porta remoto) por nó acessado.
//!
//! O driver do Redis usa `TunnelResolver` como resolvedor de nomes: o host continua o real
//! (SNI/certificado do TLS corretos) e só o endereço vira o encaminhamento local. Assim o
//! Cluster também funciona: cada nó anunciado ganha o seu encaminhamento na hora.
//!
//! Chave do host: confere o `~/.ssh/known_hosts` do usuário; host desconhecido é aceito e
//! guardado em `<app_data>/ssh_known_hosts` (TOFU); chave diferente da registrada = recusa.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use russh::client;
use russh::keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// Arquivo de hosts conhecidos do app (definido no primeiro uso, ver `mod.rs`).
pub static KNOWN_HOSTS: OnceLock<PathBuf> = OnceLock::new();

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
pub struct SshConf {
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// password | key
    #[serde(default)]
    pub auth: String,
    /// Chave privada (OpenSSH/PEM); a senha da chave fica no cofre.
    #[serde(default)]
    pub key_path: String,
}

struct Client {
    host: String,
    port: u16,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let pk = key.public_key();
        // known_hosts do usuário: chave diferente = recusa; igual = aceita.
        match keys::check_known_hosts(&self.host, self.port, &pk) {
            Ok(true) => return Ok(true),
            Err(keys::Error::KeyChanged { .. }) => return Ok(false),
            _ => {}
        }
        let Some(path) = KNOWN_HOSTS.get() else { return Ok(true) };
        match keys::check_known_hosts_path(&self.host, self.port, &pk, path) {
            Ok(true) => Ok(true),
            Err(keys::Error::KeyChanged { .. }) => Ok(false),
            _ => {
                let _ = keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &pk, path);
                Ok(true)
            }
        }
    }
}

pub struct Tunnels {
    conf: SshConf,
    password: Option<String>,
    passphrase: Option<String>,
    session: Mutex<Arc<client::Handle<Client>>>,
    forwards: Mutex<HashMap<(String, u16), SocketAddr>>,
    tasks: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Drop for Tunnels {
    fn drop(&mut self) {
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
    }
}

async fn connect(conf: &SshConf, password: Option<&str>, passphrase: Option<&str>) -> Result<client::Handle<Client>, String> {
    let port = if conf.port > 0 { conf.port } else { 22 };
    let host = conf.host.trim().to_string();
    let config = Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });
    let mut session = tokio::time::timeout(std::time::Duration::from_secs(15), client::connect(config, (host.as_str(), port), Client { host: host.clone(), port }))
        .await
        .map_err(|_| format!("SSH: tempo esgotado conectando em {host}:{port}"))?
        .map_err(|e| match e {
            russh::Error::UnknownKey => format!("SSH: a chave do host {host} mudou desde a última conexão (known_hosts). Confira o servidor antes de continuar."),
            e => format!("SSH: {e}"),
        })?;
    let user = if conf.user.trim().is_empty() { "root".to_string() } else { conf.user.trim().to_string() };
    let ok = if conf.auth == "key" {
        let path = expand_home(conf.key_path.trim());
        let key = keys::load_secret_key(&path, passphrase.filter(|p| !p.is_empty())).map_err(|e| format!("SSH: não foi possível ler a chave {}: {e}", path.display()))?;
        let hash = session.best_supported_rsa_hash().await.map_err(|e| format!("SSH: {e}"))?.flatten();
        session
            .authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| format!("SSH: {e}"))?
            .success()
    } else {
        session
            .authenticate_password(user.clone(), password.unwrap_or_default())
            .await
            .map_err(|e| format!("SSH: {e}"))?
            .success()
    };
    if !ok {
        return Err(format!("SSH: autenticação recusada para {user}@{host}"));
    }
    Ok(session)
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

impl Tunnels {
    pub async fn open(conf: SshConf, password: Option<String>, passphrase: Option<String>) -> Result<Tunnels, String> {
        let session = connect(&conf, password.as_deref(), passphrase.as_deref()).await?;
        Ok(Tunnels {
            conf,
            password,
            passphrase,
            session: Mutex::new(Arc::new(session)),
            forwards: Mutex::new(HashMap::new()),
            tasks: std::sync::Mutex::new(Vec::new()),
        })
    }

    /// Sessão SSH ativa (reconecta se caiu).
    async fn session(&self) -> Result<Arc<client::Handle<Client>>, String> {
        let mut s = self.session.lock().await;
        if s.is_closed() {
            *s = Arc::new(connect(&self.conf, self.password.as_deref(), self.passphrase.as_deref()).await?);
        }
        Ok(s.clone())
    }

    /// Endereço local que leva a `host:port` pelo túnel (criado no primeiro pedido).
    pub async fn local_for(self: &Arc<Self>, host: &str, port: u16) -> Result<SocketAddr, String> {
        let key = (host.to_string(), port);
        let mut map = self.forwards.lock().await;
        if let Some(a) = map.get(&key) {
            return Ok(*a);
        }
        // Valida a sessão antes de anunciar o encaminhamento.
        self.session().await?;
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let local = listener.local_addr().map_err(|e| e.to_string())?;
        let weak = Arc::downgrade(self);
        let (rhost, rport) = key.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, peer)) = listener.accept().await else { break };
                let Some(tunnels) = weak.upgrade() else { break };
                let rhost = rhost.clone();
                tokio::spawn(async move {
                    let Ok(session) = tunnels.session().await else { return };
                    drop(tunnels);
                    let Ok(channel) = session.channel_open_direct_tcpip(rhost, rport as u32, peer.ip().to_string(), peer.port() as u32).await else { return };
                    let mut remote = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
                });
            }
        });
        self.tasks.lock().unwrap().push(task);
        map.insert(key, local);
        Ok(local)
    }

    pub fn resolver(self: &Arc<Self>) -> TunnelResolver {
        TunnelResolver(self.clone())
    }
}

/// Resolvedor de nomes do driver do Redis: todo host:porta passa pelo túnel.
pub struct TunnelResolver(Arc<Tunnels>);

impl redis::io::AsyncDNSResolver for TunnelResolver {
    fn resolve<'a, 'b: 'a>(&'a self, host: &'b str, port: u16) -> redis::RedisFuture<'a, Box<dyn Iterator<Item = SocketAddr> + Send + 'a>> {
        Box::pin(async move {
            let addr = self.0.local_for(host, port).await.map_err(|e| redis::RedisError::from(std::io::Error::other(e)))?;
            Ok(Box::new(std::iter::once(addr)) as Box<dyn Iterator<Item = SocketAddr> + Send + 'a>)
        })
    }
}

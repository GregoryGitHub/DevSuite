//! Conexões com o Redis: standalone, Cluster e Sentinel, com TLS e túnel SSH opcionais.
//!
//! Cada conexão salva vira um `Handle` (criado no primeiro uso, refeito se a configuração
//! mudar). Os comandos rodam em *sessões*: uma conexão multiplexada por (sessão, banco) —
//! `meta` para a árvore/abas, `console:<id>` para cada console (comandos bloqueantes como
//! BLPOP não travam o resto). No Cluster cada sessão é uma `ClusterConnection` (só db 0).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use redis::aio::MultiplexedConnection;
use redis::cluster::ClusterClientBuilder;
use redis::cluster_async::ClusterConnection;
use redis::cluster_routing::{RoutingInfo, SingleNodeRoutingInfo};
use redis::sentinel::{SentinelClientBuilder, SentinelServerType};
use redis::{AsyncConnectionConfig, Client, ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, RedisResult, TlsCertificates, TlsMode, Value};
use serde::{Deserialize, Serialize};

use super::ssh::{SshConf, Tunnels};
use super::value::{as_text, err_text};

/// Configuração de uma conexão (o resto do JSON salvo é só da interface).
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
pub struct RedisConn {
    pub id: String,
    /// standalone | cluster | sentinel
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// Cluster: nós iniciais; Sentinel: os sentinels ("host:porta").
    #[serde(default)]
    pub nodes: Vec<String>,
    /// Sentinel: nome do master monitorado.
    #[serde(default)]
    pub master_name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub sentinel_username: String,
    #[serde(default)]
    pub tls: bool,
    /// Não verifica o certificado do servidor.
    #[serde(default)]
    pub tls_insecure: bool,
    /// CA própria (arquivo PEM); vazio = certificados do sistema.
    #[serde(default)]
    pub ca_path: String,
    #[serde(default)]
    pub timeout_s: u64,
    /// Recusa comandos com a flag `write` (COMMAND INFO).
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub ssh: Option<SshConf>,
}

/// Segredos da conexão (do cofre do sistema ou digitados no diálogo ao testar).
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Secrets {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub sentinel_password: Option<String>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_passphrase: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ServerInfo {
    pub version: String,
    /// standalone | cluster | sentinel (como o servidor informa)
    pub mode: String,
    pub role: String,
    pub os: String,
    /// Quantos bancos (db0..dbN-1); 1 no Cluster.
    pub databases: i64,
    /// Endereço efetivo (master do Sentinel, nó do Cluster).
    pub address: String,
    pub modules: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct NodeInfo {
    pub id: String,
    pub address: String,
    pub role: String,
    pub flags: String,
    pub slots: String,
    pub master_id: String,
}

/// Como abrir uma conexão com um nó (auth, TLS, túnel).
pub struct Dial {
    tls: bool,
    insecure: bool,
    ca: Option<Vec<u8>>,
    redis: RedisConnectionInfo,
    timeout: Duration,
    tunnels: Option<Arc<Tunnels>>,
}

impl Dial {
    fn addr(&self, host: &str, port: u16) -> ConnectionAddr {
        if self.tls {
            ConnectionAddr::TcpTls { host: host.to_string(), port, insecure: self.insecure, tls_params: None }
        } else {
            ConnectionAddr::Tcp(host.to_string(), port)
        }
    }

    pub fn client(&self, host: &str, port: u16, db: i64) -> Result<Client, String> {
        let info = self
            .addr(host, port)
            .into_connection_info()
            .map_err(|e| err_text(&e))?
            .set_redis_settings(self.redis.clone().set_db(db));
        let client = match &self.ca {
            Some(pem) => Client::build_with_tls(info, TlsCertificates { client_tls: None, root_cert: Some(pem.clone()) }),
            None => Client::open(info),
        };
        client.map_err(|e| err_text(&e))
    }

    /// Cliente para conexões dedicadas (Monitor, Pub/Sub): com túnel, aponta direto para a
    /// porta local (essas conexões não usam o resolvedor de nomes do driver).
    pub async fn live_client(&self, host: &str, port: u16, db: i64) -> Result<Client, String> {
        match &self.tunnels {
            Some(t) => {
                let local = t.local_for(host, port).await?;
                let mut d = self.redis_clone();
                // O certificado é do host real: pelo túnel, só a cadeia pode ser conferida.
                d.insecure = true;
                d.client("127.0.0.1", local.port(), db)
            }
            None => self.client(host, port, db),
        }
    }

    fn redis_clone(&self) -> Dial {
        Dial { tls: self.tls, insecure: self.insecure, ca: self.ca.clone(), redis: self.redis.clone(), timeout: self.timeout, tunnels: self.tunnels.clone() }
    }

    fn config(&self, blocking: bool) -> AsyncConnectionConfig {
        let mut cfg = AsyncConnectionConfig::new()
            .set_connection_timeout(Some(self.timeout))
            .set_response_timeout(if blocking { None } else { Some(Duration::from_secs(60)) });
        if let Some(t) = &self.tunnels {
            cfg = cfg.set_dns_resolver(t.resolver());
        }
        cfg
    }
}

pub enum Session {
    Single(MultiplexedConnection),
    Cluster(ClusterConnection),
}

/// `host:porta` → (host, porta), aceitando IPv6 entre colchetes.
pub fn split_addr(s: &str, default_port: u16) -> (String, u16) {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        if let Some((h, p)) = rest.split_once(']') {
            return (h.to_string(), p.trim_start_matches(':').parse().unwrap_or(default_port));
        }
    }
    match s.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h.to_string(), p.parse().unwrap_or(default_port)),
        _ => (s.to_string(), default_port),
    }
}

fn routing(node: &Option<String>) -> Option<RoutingInfo> {
    node.as_ref().filter(|n| !n.is_empty()).map(|n| {
        let (host, port) = split_addr(n, 6379);
        RoutingInfo::SingleNode(SingleNodeRoutingInfo::ByAddress { host, port })
    })
}

impl Session {
    pub async fn query(&mut self, cmd: redis::Cmd, node: &Option<String>) -> RedisResult<Value> {
        match self {
            Session::Single(c) => cmd.query_async(c).await,
            Session::Cluster(c) => match routing(node) {
                Some(r) => c.route_command(cmd, r).await,
                None => cmd.query_async(c).await,
            },
        }
    }

    /// Vários comandos de uma vez; o erro de um não derruba os outros.
    pub async fn pipeline(&mut self, cmds: Vec<redis::Cmd>, node: &Option<String>) -> RedisResult<Vec<RedisResult<Value>>> {
        match self {
            Session::Single(c) => {
                let mut p = redis::pipe();
                for cmd in cmds {
                    p.add_command(cmd);
                }
                p.ignore_errors();
                p.query_async(c).await
            }
            // Chaves em slots diferentes: um comando por vez, roteado pelo driver.
            Session::Cluster(c) => {
                let r = routing(node);
                let mut futs = Vec::with_capacity(cmds.len());
                for cmd in cmds {
                    let mut c = c.clone();
                    let r = r.clone();
                    futs.push(async move {
                        match r {
                            Some(r) => c.route_command(cmd, r).await,
                            None => cmd.query_async(&mut c).await,
                        }
                    });
                }
                Ok(futures_util::future::join_all(futs).await)
            }
        }
    }
}

enum Backend {
    /// Standalone ou master do Sentinel (já resolvido).
    Single { host: String, port: u16 },
    Cluster { client: redis::cluster::ClusterClient },
}

pub struct Handle {
    pub conn: RedisConn,
    pub dial: Dial,
    backend: Backend,
    pub info: Mutex<ServerInfo>,
    sessions: tokio::sync::Mutex<HashMap<(String, i64), Session>>,
    /// COMMAND INFO: comando → tem a flag `write` (conexão somente leitura).
    write_flags: Mutex<HashMap<String, bool>>,
}

impl Handle {
    pub fn is_cluster(&self) -> bool {
        matches!(self.backend, Backend::Cluster { .. })
    }

    /// Endereço do servidor (master no Sentinel).
    pub fn address(&self) -> Option<(String, u16)> {
        match &self.backend {
            Backend::Single { host, port } => Some((host.clone(), *port)),
            Backend::Cluster { .. } => None,
        }
    }

    async fn open_session(&self, session: &str, db: i64) -> Result<Session, String> {
        let blocking = session.starts_with("console");
        match &self.backend {
            Backend::Single { host, port } => {
                let client = self.dial.client(host, *port, db)?;
                let c = client.get_multiplexed_async_connection_with_config(&self.dial.config(blocking)).await.map_err(|e| err_text(&e))?;
                Ok(Session::Single(c))
            }
            Backend::Cluster { client } => {
                let c = client.get_async_connection().await.map_err(|e| err_text(&e))?;
                Ok(Session::Cluster(c))
            }
        }
    }

    /// Roda `f` na sessão (aberta na hora se preciso). Erro de rede descarta a sessão: a
    /// próxima chamada reconecta.
    pub async fn with_session<T, F>(&self, session: &str, db: i64, f: F) -> Result<T, String>
    where
        F: for<'a> FnOnce(&'a mut Session) -> futures_util::future::BoxFuture<'a, RedisResult<T>>,
    {
        let db = if self.is_cluster() { 0 } else { db };
        let key = (session.to_string(), db);
        let mut s = {
            let mut map = self.sessions.lock().await;
            match map.remove(&key) {
                Some(s) => s,
                None => {
                    drop(map);
                    self.open_session(session, db).await?
                }
            }
        };
        let res = f(&mut s).await;
        let broken = matches!(&res, Err(e) if e.is_io_error() || e.is_connection_dropped() || e.is_unrecoverable_error());
        if !broken {
            self.sessions.lock().await.insert(key, s);
        }
        res.map_err(|e| err_text(&e))
    }

    pub async fn close_session(&self, session: Option<&str>) {
        let mut map = self.sessions.lock().await;
        match session {
            Some(s) => map.retain(|(k, _), _| k != s),
            None => map.clear(),
        }
    }

    /// Conexão somente leitura: o comando tem a flag `write`? (COMMAND INFO, com cache).
    pub async fn is_write(&self, name: &str, sub: Option<&str>) -> bool {
        let mut key = name.to_ascii_lowercase();
        if let Some(sub) = sub {
            // Subcomandos (CONFIG SET, CLIENT KILL…) têm flags próprias: "config|set".
            key = format!("{key}|{}", sub.to_ascii_lowercase());
        }
        if let Some(w) = self.write_flags.lock().unwrap().get(&key) {
            return *w;
        }
        let mut cmd = redis::cmd("COMMAND");
        cmd.arg("INFO").arg(&key);
        let k2 = key.clone();
        let res = self.with_session("meta", 0, move |s| Box::pin(async move { s.query(cmd, &None).await })).await;
        let write = match res {
            Ok(Value::Array(items)) => items.first().map(|v| command_has_write(v)).unwrap_or(false),
            _ => false,
        };
        // Subcomando desconhecido: vale o comando principal.
        let write = if !write && sub.is_some() && k2.contains('|') { DANGEROUS_SUBS.iter().any(|d| *d == k2) } else { write };
        self.write_flags.lock().unwrap().insert(key, write);
        write
    }
}

/// Subcomandos administrativos tratados como escrita mesmo sem a flag.
const DANGEROUS_SUBS: &[&str] = &["config|set", "config|rewrite", "config|resetstat", "client|kill", "client|pause", "slowlog|reset", "latency|reset", "debug|sleep", "cluster|reset", "cluster|failover", "acl|setuser", "acl|deluser", "function|delete", "function|flush", "script|flush", "module|load", "module|unload"];

/// Resposta do COMMAND INFO: [nome, aridade, [flags], …] (RESP2) ou mapa (RESP3).
fn command_has_write(v: &Value) -> bool {
    let flags = match v {
        Value::Array(parts) => parts.get(2),
        _ => None,
    };
    let has = |items: &Vec<Value>| items.iter().any(|f| as_text(f).map(|t| t.eq_ignore_ascii_case("write")).unwrap_or(false));
    match flags {
        Some(Value::Array(items)) | Some(Value::Set(items)) => has(items),
        _ => false,
    }
}

// ---------- Montagem ----------

fn read_ca(path: &str) -> Result<Option<Vec<u8>>, String> {
    if path.trim().is_empty() {
        return Ok(None);
    }
    std::fs::read(path.trim()).map(Some).map_err(|e| format!("Não foi possível ler a CA ({path}): {e}"))
}

fn auth_info(user: &str, password: Option<&str>) -> RedisConnectionInfo {
    let mut r = RedisConnectionInfo::default().set_lib_name("devsuite", env!("CARGO_PKG_VERSION"));
    if !user.trim().is_empty() {
        r = r.set_username(user.trim());
    }
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        r = r.set_password(pw);
    }
    r
}

pub async fn build(conn: &RedisConn, secrets: &Secrets) -> Result<Handle, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let timeout = Duration::from_secs(if conn.timeout_s > 0 { conn.timeout_s } else { 10 });
    let tunnels = match &conn.ssh {
        Some(ssh) if !ssh.host.trim().is_empty() => Some(Arc::new(Tunnels::open(ssh.clone(), secrets.ssh_password.clone(), secrets.ssh_passphrase.clone()).await?)),
        _ => None,
    };
    let dial = Dial {
        tls: conn.tls,
        insecure: conn.tls_insecure,
        ca: read_ca(&conn.ca_path)?,
        redis: auth_info(&conn.username, secrets.password.as_deref()),
        timeout,
        tunnels: tunnels.clone(),
    };
    let backend = match conn.mode.as_str() {
        "cluster" => {
            let seeds: Vec<String> = if conn.nodes.iter().any(|n| !n.trim().is_empty()) {
                conn.nodes.iter().filter(|n| !n.trim().is_empty()).cloned().collect()
            } else {
                vec![format!("{}:{}", conn.host.trim(), conn.port)]
            };
            let infos = seeds
                .iter()
                .map(|s| {
                    let (h, p) = split_addr(s, 6379);
                    dial.addr(&h, p).into_connection_info().map_err(|e| err_text(&e))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut b = ClusterClientBuilder::new(infos).connection_timeout(timeout).response_timeout(Duration::from_secs(60));
            if !conn.username.trim().is_empty() {
                b = b.username(conn.username.trim());
            }
            if let Some(pw) = secrets.password.as_deref().filter(|p| !p.is_empty()) {
                b = b.password(pw);
            }
            if conn.tls {
                b = b.tls(if conn.tls_insecure { TlsMode::Insecure } else { TlsMode::Secure });
                if let Some(pem) = &dial.ca {
                    b = b.certs(TlsCertificates { client_tls: None, root_cert: Some(pem.clone()) });
                }
            }
            if let Some(t) = &tunnels {
                b = b.async_dns_resolver(t.resolver());
            }
            Backend::Cluster { client: b.build().map_err(|e| err_text(&e))? }
        }
        "sentinel" => {
            let addrs = conn
                .nodes
                .iter()
                .filter(|n| !n.trim().is_empty())
                .map(|s| {
                    let (h, p) = split_addr(s, 26379);
                    ConnectionAddr::Tcp(h, p)
                })
                .collect::<Vec<_>>();
            if addrs.is_empty() {
                return Err("Informe ao menos um Sentinel (host:porta).".into());
            }
            if conn.master_name.trim().is_empty() {
                return Err("Informe o nome do master monitorado pelo Sentinel.".into());
            }
            let mut b = SentinelClientBuilder::new(addrs, conn.master_name.trim().to_string(), SentinelServerType::Master).map_err(|e| err_text(&e))?;
            if !conn.sentinel_username.trim().is_empty() {
                b = b.set_client_to_sentinel_username(conn.sentinel_username.trim());
            }
            if let Some(pw) = secrets.sentinel_password.as_deref().filter(|p| !p.is_empty()) {
                b = b.set_client_to_sentinel_password(pw);
            }
            if conn.tls {
                let mode = if conn.tls_insecure { TlsMode::Insecure } else { TlsMode::Secure };
                b = b.set_client_to_sentinel_tls_mode(mode).set_client_to_redis_tls_mode(mode);
            }
            let mut sentinel = b.build().map_err(|e| err_text(&e))?;
            let master = tokio::time::timeout(timeout, sentinel.async_get_client())
                .await
                .map_err(|_| "Tempo esgotado consultando o Sentinel".to_string())?
                .map_err(|e| format!("Sentinel: {}", err_text(&e)))?;
            let (host, port) = match master.get_connection_info().addr() {
                ConnectionAddr::Tcp(h, p) => (h.clone(), *p),
                ConnectionAddr::TcpTls { host, port, .. } => (host.clone(), *port),
                _ => return Err("Endereço do master não suportado".into()),
            };
            Backend::Single { host, port }
        }
        _ => {
            if conn.host.trim().is_empty() {
                return Err("Informe o host.".into());
            }
            Backend::Single { host: conn.host.trim().to_string(), port: if conn.port > 0 { conn.port } else { 6379 } }
        }
    };
    let handle = Handle {
        conn: conn.clone(),
        dial,
        backend,
        info: Mutex::new(ServerInfo::default()),
        sessions: tokio::sync::Mutex::new(HashMap::new()),
        write_flags: Mutex::new(HashMap::new()),
    };
    let info = server_info(&handle).await?;
    *handle.info.lock().unwrap() = info;
    Ok(handle)
}

/// Seções do INFO em pares chave → valor.
pub fn parse_info(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

async fn server_info(h: &Handle) -> Result<ServerInfo, String> {
    let q = |args: &'static [&'static str]| {
        let mut cmd = redis::Cmd::new();
        for a in args {
            cmd.arg(*a);
        }
        cmd
    };
    let info = h.with_session("meta", 0, move |s| Box::pin(async move { s.query(q(&["INFO", "server"]), &None).await })).await?;
    // No Cluster o INFO sem rota vem de todos os nós (mapa): pega o primeiro.
    let text = match &info {
        Value::Map(pairs) => pairs.first().and_then(|(_, v)| as_text(v)).unwrap_or_default(),
        v => as_text(v).unwrap_or_default(),
    };
    let server = parse_info(&text);
    let repl = h
        .with_session("meta", 0, move |s| Box::pin(async move { s.query(q(&["INFO", "replication"]), &None).await }))
        .await
        .ok()
        .map(|v| match &v {
            Value::Map(pairs) => pairs.first().and_then(|(_, v)| as_text(v)).unwrap_or_default(),
            v => as_text(v).unwrap_or_default(),
        })
        .map(|t| parse_info(&t))
        .unwrap_or_default();
    let databases = if h.is_cluster() {
        1
    } else {
        // CONFIG GET pode estar bloqueado em serviços gerenciados: 16 é o padrão.
        h.with_session("meta", 0, move |s| Box::pin(async move { s.query(q(&["CONFIG", "GET", "databases"]), &None).await }))
            .await
            .ok()
            .and_then(|v| match v {
                Value::Array(items) => items.get(1).and_then(as_text),
                Value::Map(pairs) => pairs.first().and_then(|(_, v)| as_text(v)),
                _ => None,
            })
            .and_then(|t| t.parse().ok())
            .unwrap_or(16)
    };
    let modules = h
        .with_session("meta", 0, move |s| Box::pin(async move { s.query(q(&["MODULE", "LIST"]), &None).await }))
        .await
        .ok()
        .map(|v| module_names(&v))
        .unwrap_or_default();
    Ok(ServerInfo {
        version: server.get("redis_version").or_else(|| server.get("valkey_version")).cloned().unwrap_or_default(),
        mode: if h.is_cluster() { "cluster".into() } else { server.get("redis_mode").cloned().unwrap_or_else(|| "standalone".into()) },
        role: repl.get("role").cloned().unwrap_or_default(),
        os: server.get("os").cloned().unwrap_or_default(),
        databases,
        address: h.address().map(|(host, port)| format!("{host}:{port}")).unwrap_or_default(),
        modules,
    })
}

/// MODULE LIST: [[name, x, ver, y], …] (RESP2) ou mapas (RESP3).
fn module_names(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Value::Array(items) = v {
        for m in items {
            match m {
                Value::Array(kv) => {
                    for pair in kv.chunks(2) {
                        if pair.len() == 2 && as_text(&pair[0]).as_deref() == Some("name") {
                            if let Some(n) = as_text(&pair[1]) {
                                out.push(n);
                            }
                        }
                    }
                }
                Value::Map(pairs) => {
                    for (k, v) in pairs {
                        if as_text(k).as_deref() == Some("name") {
                            if let Some(n) = as_text(v) {
                                out.push(n);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// Nós do Cluster (CLUSTER NODES); fora do Cluster, o próprio servidor.
pub async fn nodes(h: &Handle) -> Result<Vec<NodeInfo>, String> {
    if !h.is_cluster() {
        let info = h.info.lock().unwrap().clone();
        return Ok(vec![NodeInfo { id: String::new(), address: info.address, role: info.role, flags: String::new(), slots: String::new(), master_id: String::new() }]);
    }
    let v = h
        .with_session("meta", 0, |s| {
            Box::pin(async move {
                let mut cmd = redis::cmd("CLUSTER");
                cmd.arg("NODES");
                s.query(cmd, &Some(String::new())).await
            })
        })
        .await?;
    Ok(parse_cluster_nodes(&as_text(&v).unwrap_or_default()))
}

/// Linhas: `<id> <ip:porta@cport[,host]> <flags> <master> <ping> <pong> <epoch> <estado> <slots…>`.
pub fn parse_cluster_nodes(text: &str) -> Vec<NodeInfo> {
    text.lines()
        .filter_map(|l| {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() < 8 {
                return None;
            }
            let addr = parts[1].split('@').next().unwrap_or("").to_string();
            let flags = parts[2].to_string();
            let role = if flags.contains("master") { "master" } else if flags.contains("slave") || flags.contains("replica") { "replica" } else { "?" };
            Some(NodeInfo {
                id: parts[0].to_string(),
                address: addr,
                role: role.into(),
                flags,
                slots: parts[8..].join(" "),
                master_id: if parts[3] == "-" { String::new() } else { parts[3].to_string() },
            })
        })
        .collect()
}

/// Masters ativos do Cluster ("host:porta"), para SCAN/INFO/análise nó a nó.
pub async fn masters(h: &Handle) -> Result<Vec<Option<String>>, String> {
    if !h.is_cluster() {
        return Ok(vec![None]);
    }
    let list = nodes(h).await?;
    Ok(list
        .into_iter()
        .filter(|n| n.role == "master" && !n.flags.contains("fail") && !n.flags.contains("noaddr") && !n.address.starts_with(':'))
        .map(|n| Some(n.address))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_split_addr() {
        assert_eq!(split_addr("h:7000", 6379), ("h".into(), 7000));
        assert_eq!(split_addr("h", 6379), ("h".into(), 6379));
        assert_eq!(split_addr("[::1]:7001", 6379), ("::1".into(), 7001));
    }

    #[test]
    fn redis_cluster_nodes_parse() {
        let text = "07c3 127.0.0.1:30004@31004,host-a slave e7d1 0 1426238317239 4 connected\n\
                    e7d1 127.0.0.1:30001@31001 myself,master - 0 0 1 connected 0-5460\n";
        let n = parse_cluster_nodes(text);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].role, "replica");
        assert_eq!(n[0].master_id, "e7d1");
        assert_eq!(n[1].address, "127.0.0.1:30001");
        assert_eq!(n[1].slots, "0-5460");
    }

    #[test]
    fn redis_info_parse() {
        let m = parse_info("# Server\r\nredis_version:7.2.4\r\nos:Linux\r\n");
        assert_eq!(m.get("redis_version").map(String::as_str), Some("7.2.4"));
    }
}

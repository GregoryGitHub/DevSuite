//! Testes de integração com um Redis de verdade. Só rodam com TODORS_REDIS_TEST definido:
//!
//!   docker run -d -p 6380:6379 redis/redis-stack-server:latest
//!   TODORS_REDIS_TEST="localhost|6380|" cargo test it_redis -- --test-threads=1
//!
//! Formato: "host|porta|senha" (senha vazia = sem autenticação).

use super::conn::{build, masters, RedisConn, Secrets};
use super::value::{build_cmd, to_json, Arg};
use serde_json::json;

fn target() -> Option<(RedisConn, Secrets)> {
    let raw = std::env::var("TODORS_REDIS_TEST").ok()?;
    let mut p = raw.split('|');
    let host = p.next()?.to_string();
    let port = p.next()?.parse().ok()?;
    let password = p.next().filter(|s| !s.is_empty()).map(String::from);
    Some((RedisConn { id: "it".into(), mode: "standalone".into(), host, port, ..Default::default() }, Secrets { password, ..Default::default() }))
}

fn args(list: &[&str]) -> Vec<Arg> {
    list.iter().map(|s| Arg::Text(s.to_string())).collect()
}

#[tokio::test]
async fn it_redis_roundtrip() {
    let Some((conn, secrets)) = target() else { return };
    let h = build(&conn, &secrets).await.expect("conectar");
    assert!(!h.info.lock().unwrap().version.is_empty());
    let run = |a: Vec<Arg>, db: i64| {
        let h = &h;
        async move {
            let cmd = build_cmd(&a).unwrap();
            h.with_session("meta", db, move |s| Box::pin(async move { s.query(cmd, &None).await })).await
        }
    };
    run(args(&["DEL", "it:str", "it:bin", "it:h"]), 15).await.unwrap();
    run(args(&["SET", "it:str", "olá"]), 15).await.unwrap();
    assert_eq!(to_json(run(args(&["GET", "it:str"]), 15).await.unwrap()), json!({ "t": "str", "v": "olá" }));
    // Valor binário volta em Base64; chave binária vai como { b64 }.
    let bin = vec![Arg::Text("SET".into()), Arg::Text("it:bin".into()), Arg::Bytes { b64: "/wA=".into() }];
    run(bin, 15).await.unwrap();
    assert_eq!(to_json(run(args(&["GET", "it:bin"]), 15).await.unwrap()), json!({ "t": "bin", "v": "/wA=" }));
    // Banco 15 não vaza para o 0.
    assert_eq!(to_json(run(args(&["EXISTS", "it:str"]), 0).await.unwrap())["v"], json!(0));
    // Pipeline com erro no meio.
    run(args(&["HSET", "it:h", "a", "1"]), 15).await.unwrap();
    let cmds = vec![build_cmd(&args(&["HGETALL", "it:h"])).unwrap(), build_cmd(&args(&["LPUSH", "it:h", "x"])).unwrap(), build_cmd(&args(&["TTL", "it:h"])).unwrap()];
    let res = h.with_session("meta", 15, move |s| Box::pin(async move { s.pipeline(cmds, &None).await })).await.unwrap();
    assert!(res[0].is_ok());
    assert!(res[1].is_err());
    assert_eq!(to_json(res[2].as_ref().unwrap().clone()), json!({ "t": "int", "v": -1 }));
    assert_eq!(masters(&h).await.unwrap(), vec![None]);
    run(args(&["DEL", "it:str", "it:bin", "it:h"]), 15).await.unwrap();
}

#[tokio::test]
async fn it_redis_read_only() {
    let Some((mut conn, secrets)) = target() else { return };
    conn.read_only = true;
    let h = build(&conn, &secrets).await.expect("conectar");
    assert!(h.is_write("set", None).await);
    assert!(!h.is_write("get", None).await);
    assert!(h.is_write("config", Some("SET")).await);
    assert!(!h.is_write("config", Some("GET")).await);
}

/// Cluster: TODORS_REDIS_CLUSTER_TEST="127.0.0.1:7100"
///   docker run -d -e IP=0.0.0.0 -e INITIAL_PORT=7100 -p 7100-7105:7100-7105 grokzen/redis-cluster:7.0.10
#[tokio::test]
async fn it_redis_cluster() {
    let Ok(seed) = std::env::var("TODORS_REDIS_CLUSTER_TEST") else { return };
    let conn = RedisConn { id: "itc".into(), mode: "cluster".into(), nodes: vec![seed], ..Default::default() };
    let h = build(&conn, &Secrets::default()).await.expect("conectar no cluster");
    assert_eq!(h.info.lock().unwrap().mode, "cluster");
    let ms = masters(&h).await.unwrap();
    assert_eq!(ms.len(), 3, "3 masters");
    // Chaves em slots diferentes num "pipeline" (no Cluster vira um comando por vez).
    let keys: Vec<String> = (0..30).map(|i| format!("itc:{i}")).collect();
    let cmds = keys.iter().map(|k| build_cmd(&args(&["SET", k, "v"])).unwrap()).collect::<Vec<_>>();
    let res = h.with_session("meta", 0, move |s| Box::pin(async move { s.pipeline(cmds, &None).await })).await.unwrap();
    assert!(res.iter().all(|r| r.is_ok()));
    // SCAN nó a nó encontra todas.
    let mut found = 0;
    for node in &ms {
        let mut cursor = "0".to_string();
        loop {
            let mut cmd = redis::cmd("SCAN");
            cmd.arg(&cursor).arg("MATCH").arg("itc:*").arg("COUNT").arg(1000);
            let n = node.clone();
            let v = h.with_session("meta", 0, move |s| Box::pin(async move { s.query(cmd, &n).await })).await.unwrap();
            let redis::Value::Array(mut parts) = v else { panic!("scan") };
            if let Some(redis::Value::Array(k)) = parts.pop() {
                found += k.len();
            }
            cursor = super::value::as_text(&parts.pop().unwrap()).unwrap();
            if cursor == "0" {
                break;
            }
        }
    }
    assert_eq!(found, 30);
    let cmds = keys.iter().map(|k| build_cmd(&args(&["DEL", k])).unwrap()).collect::<Vec<_>>();
    h.with_session("meta", 0, move |s| Box::pin(async move { s.pipeline(cmds, &None).await })).await.unwrap();
}

/// Sentinel: TODORS_REDIS_SENTINEL_TEST="127.0.0.1:26390|mymaster" (master anunciado em endereço
/// acessível daqui; ver o comando no AGENTS.md).
#[tokio::test]
async fn it_redis_sentinel() {
    let Ok(raw) = std::env::var("TODORS_REDIS_SENTINEL_TEST") else { return };
    let (addr, master) = raw.split_once('|').unwrap();
    let conn = RedisConn { id: "its".into(), mode: "sentinel".into(), nodes: vec![addr.into()], master_name: master.into(), ..Default::default() };
    let h = build(&conn, &Secrets::default()).await.expect("conectar pelo sentinel");
    assert!(h.address().is_some());
    let cmd = build_cmd(&args(&["PING"])).unwrap();
    let v = h.with_session("meta", 0, move |s| Box::pin(async move { s.query(cmd, &None).await })).await.unwrap();
    assert_eq!(to_json(v), json!({ "t": "status", "v": "PONG" }));
}

/// Túnel SSH: TODORS_REDIS_SSH_TEST="host:porta-ssh|usuário|senha|host-redis-visto-do-bastion:porta"
#[tokio::test]
async fn it_redis_ssh() {
    let Ok(raw) = std::env::var("TODORS_REDIS_SSH_TEST") else { return };
    let p: Vec<&str> = raw.split('|').collect();
    let (ssh_host, ssh_port) = super::conn::split_addr(p[0], 22);
    let (host, port) = super::conn::split_addr(p[3], 6379);
    let conn = RedisConn {
        id: "itssh".into(),
        mode: "standalone".into(),
        host,
        port,
        ssh: Some(super::ssh::SshConf { host: ssh_host, port: ssh_port, user: p[1].into(), auth: "password".into(), key_path: String::new() }),
        ..Default::default()
    };
    let h = build(&conn, &Secrets { ssh_password: Some(p[2].into()), ..Default::default() }).await.expect("conectar pelo túnel");
    let cmd = build_cmd(&args(&["ECHO", "pelo túnel"])).unwrap();
    let v = h.with_session("meta", 0, move |s| Box::pin(async move { s.query(cmd, &None).await })).await.unwrap();
    assert_eq!(to_json(v), json!({ "t": "str", "v": "pelo túnel" }));
    // Conexão dedicada (Monitor/Pub/Sub) também passa pelo túnel.
    let (h2, p2) = h.address().unwrap();
    let client = h.dial.live_client(&h2, p2, 0).await.unwrap();
    let mut pubsub = client.get_async_pubsub().await.expect("pubsub pelo túnel");
    pubsub.subscribe("x").await.unwrap();
}

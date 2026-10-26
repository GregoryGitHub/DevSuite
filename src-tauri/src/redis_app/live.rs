//! Conexões dedicadas que ficam abertas: MONITOR e Pub/Sub (SUBSCRIBE/PSUBSCRIBE).
//! Os eventos vão em lotes pelo Channel (no máximo ~10 por segundo) para não afogar a UI.

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use super::conn::{split_addr, Handle};
use super::value::{as_text, bulk, err_text};

#[derive(Deserialize, Clone, Debug)]
pub struct LiveSpec {
    /// monitor | subscribe
    pub kind: String,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub patterns: Vec<String>,
    /// Cluster: nó ("host:porta"); vazio = o primeiro master.
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub db: i64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveEvent {
    /// MONITOR: linhas cruas (`1700000000.123456 [0 127.0.0.1:5000] "GET" "k"`).
    Monitor { lines: Vec<String> },
    /// Pub/Sub: mensagens com o corpo no formato `{ t, v }` (texto ou Base64).
    Messages { items: Vec<serde_json::Value> },
    Stopped { error: Option<String> },
}

/// Endereço do nó para a conexão dedicada.
async fn target(h: &Handle, node: &str) -> Result<(String, u16), String> {
    if !node.trim().is_empty() {
        return Ok(split_addr(node, 6379));
    }
    if let Some(a) = h.address() {
        return Ok(a);
    }
    let masters = super::conn::masters(h).await?;
    masters.into_iter().flatten().next().map(|a| split_addr(&a, 6379)).ok_or_else(|| "Nenhum master disponível no Cluster".to_string())
}

/// Roda até `stop` disparar ou a conexão cair.
pub async fn run(h: std::sync::Arc<Handle>, spec: LiveSpec, sink: Channel<LiveEvent>, mut stop: tokio::sync::oneshot::Receiver<()>) {
    let error = match run_inner(&h, &spec, &sink, &mut stop).await {
        Ok(()) => None,
        Err(e) => Some(e),
    };
    let _ = sink.send(LiveEvent::Stopped { error });
}

async fn run_inner(h: &Handle, spec: &LiveSpec, sink: &Channel<LiveEvent>, stop: &mut tokio::sync::oneshot::Receiver<()>) -> Result<(), String> {
    let (host, port) = target(h, &spec.node).await?;
    let client = h.dial.live_client(&host, port, spec.db).await?;
    let flush_every = Duration::from_millis(100);
    if spec.kind == "monitor" {
        let monitor = client.get_async_monitor().await.map_err(|e| err_text(&e))?;
        let mut stream = monitor.into_on_message::<redis::Value>();
        let mut buf: Vec<String> = Vec::new();
        let mut last = Instant::now();
        loop {
            tokio::select! {
                _ = &mut *stop => break,
                item = stream.next() => match item {
                    Some(v) => buf.push(as_text(&v).unwrap_or_default()),
                    None => {
                        if !buf.is_empty() { let _ = sink.send(LiveEvent::Monitor { lines: std::mem::take(&mut buf) }); }
                        return Err("A conexão do MONITOR foi encerrada pelo servidor".into());
                    }
                },
                _ = tokio::time::sleep(flush_every) => {}
            }
            if !buf.is_empty() && (last.elapsed() >= flush_every || buf.len() >= 500) {
                if sink.send(LiveEvent::Monitor { lines: std::mem::take(&mut buf) }).is_err() {
                    break;
                }
                last = Instant::now();
            }
        }
        return Ok(());
    }
    let mut pubsub = client.get_async_pubsub().await.map_err(|e| err_text(&e))?;
    for c in spec.channels.iter().filter(|c| !c.is_empty()) {
        pubsub.subscribe(c).await.map_err(|e| err_text(&e))?;
    }
    for p in spec.patterns.iter().filter(|p| !p.is_empty()) {
        pubsub.psubscribe(p).await.map_err(|e| err_text(&e))?;
    }
    let mut stream = pubsub.into_on_message();
    let mut buf: Vec<serde_json::Value> = Vec::new();
    let mut last = Instant::now();
    loop {
        tokio::select! {
            _ = &mut *stop => break,
            item = stream.next() => match item {
                Some(msg) => {
                    let pattern = if msg.from_pattern() { msg.get_pattern::<String>().ok() } else { None };
                    buf.push(serde_json::json!({
                        "at": chrono::Utc::now().timestamp_millis(),
                        "channel": msg.get_channel_name(),
                        "pattern": pattern,
                        "payload": bulk(msg.get_payload_bytes().to_vec()),
                    }));
                }
                None => {
                    if !buf.is_empty() { let _ = sink.send(LiveEvent::Messages { items: std::mem::take(&mut buf) }); }
                    return Err("A assinatura foi encerrada pelo servidor".into());
                }
            },
            _ = tokio::time::sleep(flush_every) => {}
        }
        if !buf.is_empty() && (last.elapsed() >= flush_every || buf.len() >= 500) {
            if sink.send(LiveEvent::Messages { items: std::mem::take(&mut buf) }).is_err() {
                break;
            }
            last = Instant::now();
        }
    }
    Ok(())
}

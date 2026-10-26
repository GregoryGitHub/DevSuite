//! Análise de memória: percorre as chaves com SCAN (nó a nó no Cluster) e, para cada lote,
//! pergunta TYPE, MEMORY USAGE e PTTL num pipeline. Agrega por tipo, por prefixo (até
//! `depth` níveis do separador), por faixa de TTL e guarda as N maiores chaves. Manda o
//! parcial a cada ~0,5 s; parar mantém o que já foi contado.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use redis::Value;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use tauri::ipc::Channel;

use super::conn::{masters, Handle};
use super::value::{as_text, bulk};

#[derive(Deserialize, Clone, Debug)]
pub struct AnalyzeSpec {
    #[serde(default)]
    pub db: i64,
    #[serde(default)]
    pub pattern: String,
    /// COUNT do SCAN.
    #[serde(default)]
    pub count: u32,
    /// Para depois de N chaves (0 = todas).
    #[serde(default)]
    pub limit: u64,
    #[serde(default)]
    pub separator: String,
    #[serde(default)]
    pub depth: usize,
    #[serde(default)]
    pub top: usize,
    /// Pausa entre lotes (não pesar no servidor).
    #[serde(default)]
    pub pause_ms: u64,
}

#[derive(Default, Serialize, Clone, Copy)]
struct Agg {
    keys: u64,
    bytes: u64,
}

impl Agg {
    fn add(&mut self, bytes: u64) {
        self.keys += 1;
        self.bytes += bytes;
    }
}

const TTL_BUCKETS: [(&str, i64); 6] = [("sem TTL", -1), ("< 1 min", 60_000), ("< 1 h", 3_600_000), ("< 1 dia", 86_400_000), ("< 7 dias", 604_800_000), ("≥ 7 dias", i64::MAX)];
const MAX_PREFIXES: usize = 50_000;

#[derive(Default)]
struct State {
    scanned: u64,
    total: Agg,
    by_type: HashMap<String, Agg>,
    prefixes: HashMap<String, Agg>,
    ttl: [Agg; 6],
    top: BinaryHeap<Reverse<(u64, Vec<u8>, String, i64)>>,
    memory_unavailable: bool,
    nodes_done: usize,
    nodes: usize,
}

impl State {
    fn snapshot(&self, done: bool, elapsed: Duration, error: Option<String>) -> Json {
        let mut prefixes: Vec<(&String, &Agg)> = self.prefixes.iter().collect();
        prefixes.sort_by(|a, b| b.1.bytes.cmp(&a.1.bytes).then(b.1.keys.cmp(&a.1.keys)));
        prefixes.truncate(2000);
        let mut top: Vec<_> = self.top.iter().map(|Reverse(t)| t.clone()).collect();
        top.sort_by(|a, b| b.0.cmp(&a.0));
        json!({
            "done": done,
            "error": error,
            "elapsed_ms": elapsed.as_millis() as u64,
            "scanned": self.scanned,
            "total": self.total,
            "nodes": self.nodes,
            "nodes_done": self.nodes_done,
            "memory_unavailable": self.memory_unavailable,
            "by_type": self.by_type,
            "ttl": TTL_BUCKETS.iter().zip(self.ttl.iter()).map(|((label, _), a)| json!({ "label": label, "keys": a.keys, "bytes": a.bytes })).collect::<Vec<_>>(),
            "prefixes": prefixes.into_iter().map(|(p, a)| json!({ "prefix": p, "keys": a.keys, "bytes": a.bytes })).collect::<Vec<_>>(),
            "top": top.into_iter().map(|(bytes, key, t, ttl)| json!({ "key": bulk(key), "bytes": bytes, "type": t, "ttl": ttl })).collect::<Vec<_>>(),
        })
    }

    fn add(&mut self, key: &[u8], kind: String, bytes: Option<u64>, pttl: i64, sep: &str, depth: usize, top_n: usize) {
        let bytes = bytes.unwrap_or_else(|| {
            self.memory_unavailable = true;
            0
        });
        self.scanned += 1;
        self.total.add(bytes);
        self.by_type.entry(kind.clone()).or_default().add(bytes);
        let bucket = if pttl < 0 { 0 } else { TTL_BUCKETS.iter().position(|(_, lim)| *lim > 0 && pttl < *lim).unwrap_or(5) };
        self.ttl[bucket].add(bytes);
        // Prefixos "a:", "a:b:" … (o último segmento é o nome da chave, não conta).
        if !sep.is_empty() && depth > 0 {
            let text = String::from_utf8_lossy(key);
            let parts: Vec<&str> = text.split(sep).collect();
            for level in 1..=depth.min(parts.len().saturating_sub(1)) {
                let prefix = format!("{}{sep}", parts[..level].join(sep));
                if self.prefixes.len() >= MAX_PREFIXES && !self.prefixes.contains_key(&prefix) {
                    self.prefixes.entry("(outros prefixos)".into()).or_default().add(bytes);
                    break;
                }
                self.prefixes.entry(prefix).or_default().add(bytes);
            }
        }
        if top_n > 0 {
            if self.top.len() < top_n {
                self.top.push(Reverse((bytes, key.to_vec(), kind, pttl)));
            } else if self.top.peek().map(|Reverse(t)| bytes > t.0).unwrap_or(false) {
                self.top.pop();
                self.top.push(Reverse((bytes, key.to_vec(), kind, pttl)));
            }
        }
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Int(i) => Some(*i),
        v => as_text(v).and_then(|t| t.parse().ok()),
    }
}

pub async fn run(h: Arc<Handle>, spec: AnalyzeSpec, sink: Channel<Json>, mut stop: tokio::sync::oneshot::Receiver<()>) {
    let started = Instant::now();
    let mut st = State::default();
    let res = run_inner(&h, &spec, &sink, &mut stop, &mut st, started).await;
    let _ = sink.send(st.snapshot(true, started.elapsed(), res.err()));
}

async fn run_inner(h: &Handle, spec: &AnalyzeSpec, sink: &Channel<Json>, stop: &mut tokio::sync::oneshot::Receiver<()>, st: &mut State, started: Instant) -> Result<(), String> {
    let nodes = masters(h).await?;
    st.nodes = nodes.len();
    let count = if spec.count > 0 { spec.count } else { 500 };
    let sep = if spec.separator.is_empty() { ":".to_string() } else { spec.separator.clone() };
    let depth = if spec.depth > 0 { spec.depth.min(6) } else { 3 };
    let top_n = if spec.top > 0 { spec.top.min(1000) } else { 100 };
    let mut last_emit = Instant::now();
    for node in nodes {
        let mut cursor = "0".to_string();
        loop {
            if stop.try_recv().is_ok() {
                return Ok(());
            }
            let mut cmd = redis::cmd("SCAN");
            cmd.arg(&cursor).arg("COUNT").arg(count);
            if !spec.pattern.is_empty() {
                cmd.arg("MATCH").arg(&spec.pattern);
            }
            let n = node.clone();
            let page = h.with_session("analyze", spec.db, move |s| Box::pin(async move { s.query(cmd, &n).await })).await?;
            let (next, keys) = match page {
                Value::Array(mut parts) if parts.len() == 2 => {
                    let keys = match parts.pop() {
                        Some(Value::Array(k)) => k,
                        _ => vec![],
                    };
                    (parts.pop().and_then(|c| as_text(&c)).unwrap_or_else(|| "0".into()), keys)
                }
                _ => return Err("Resposta inesperada do SCAN".into()),
            };
            let raw: Vec<Vec<u8>> = keys
                .into_iter()
                .filter_map(|k| match k {
                    Value::BulkString(b) => Some(b),
                    _ => None,
                })
                .collect();
            if !raw.is_empty() {
                let mut cmds = Vec::with_capacity(raw.len() * 3);
                for k in &raw {
                    cmds.push(redis::cmd("TYPE").arg(k.as_slice()).clone());
                    cmds.push(redis::cmd("MEMORY").arg("USAGE").arg(k.as_slice()).clone());
                    cmds.push(redis::cmd("PTTL").arg(k.as_slice()).clone());
                }
                let n = node.clone();
                let replies = h.with_session("analyze", spec.db, move |s| Box::pin(async move { s.pipeline(cmds, &n).await })).await?;
                for (k, chunk) in raw.iter().zip(replies.chunks(3)) {
                    let kind = chunk.first().and_then(|r| r.as_ref().ok()).and_then(as_text).unwrap_or_else(|| "?".into());
                    if kind == "none" {
                        continue; // expirou no meio do caminho
                    }
                    let bytes = chunk.get(1).and_then(|r| r.as_ref().ok()).and_then(int).map(|b| b.max(0) as u64);
                    let pttl = chunk.get(2).and_then(|r| r.as_ref().ok()).and_then(int).unwrap_or(-1);
                    st.add(k, kind, bytes, pttl, &sep, depth, top_n);
                    if spec.limit > 0 && st.scanned >= spec.limit {
                        return Ok(());
                    }
                }
            }
            if last_emit.elapsed() >= Duration::from_millis(500) {
                if sink.send(st.snapshot(false, started.elapsed(), None)).is_err() {
                    return Ok(());
                }
                last_emit = Instant::now();
            }
            if spec.pause_ms > 0 {
                tokio::time::sleep(Duration::from_millis(spec.pause_ms.min(5000))).await;
            }
            cursor = next;
            if cursor == "0" {
                break;
            }
        }
        st.nodes_done += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_analyze_aggregates() {
        let mut st = State::default();
        st.add(b"user:1:name", "string".into(), Some(100), -1, ":", 3, 2);
        st.add(b"user:2:name", "string".into(), Some(50), 30_000, ":", 3, 2);
        st.add(b"cache", "hash".into(), Some(500), 7_200_000, ":", 3, 2);
        assert_eq!(st.total.keys, 3);
        assert_eq!(st.prefixes["user:"].bytes, 150);
        assert_eq!(st.prefixes["user:1:"].keys, 1);
        assert!(!st.prefixes.contains_key("cache:"));
        assert_eq!(st.ttl[0].keys, 1);
        assert_eq!(st.ttl[1].keys, 1);
        assert_eq!(st.ttl[3].keys, 1);
        let snap = st.snapshot(true, Duration::from_millis(5), None);
        let top = snap["top"].as_array().unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0]["bytes"], 500);
        assert_eq!(top[1]["bytes"], 100);
    }
}

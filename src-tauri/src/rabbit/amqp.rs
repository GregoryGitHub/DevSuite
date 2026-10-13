//! AMQP 0-9-1 (amqprs): o que a API HTTP não faz bem.
//!
//!  - **Captura** das mensagens trafegadas, gravadas no rabbit.db:
//!    - `tap`: fila temporária (exclusiva, auto-delete) com as mesmas ligações das filas
//!      escolhidas — recebe uma cópia de cada mensagem publicada, sem consumir nada da fila real;
//!    - `exchange`: fila temporária ligada a uma exchange com a routing key informada;
//!    - `firehose`: liga o tracing do vhost e escuta `amq.rabbitmq.trace` (publish.# e deliver.#):
//!      vê também o que é publicado direto na fila (exchange padrão) e cada entrega a consumidores.
//!  - **Mover/copiar** mensagens entre filas em transação AMQP (publish + ack no mesmo commit:
//!    nada se perde se a conexão cair no meio). Mensagens que voltam sem rota (`mandatory`)
//!    são devolvidas à fila de origem.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use amqprs::callbacks::ChannelCallback;
use amqprs::channel::{
    BasicAckArguments, BasicConsumeArguments, BasicGetArguments, BasicPublishArguments, BasicRejectArguments, Channel, QueueBindArguments,
    QueueDeclareArguments,
};
use amqprs::connection::{Connection, OpenConnectionArguments};
use amqprs::tls::TlsAdaptor;
use amqprs::{Ack, BasicProperties, Cancel, CloseChannel, FieldArray, FieldTable, FieldValue, Nack, Return};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::store::MsgIn;
use super::RmqConn;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---------- Conexão ----------

/// Host AMQP: o informado ou o mesmo da URL de management.
pub fn amqp_host(conn: &RmqConn) -> String {
    if !conn.amqp_host.trim().is_empty() {
        return conn.amqp_host.trim().to_string();
    }
    let base = super::mgmt::base_url(&conn.mgmt_url);
    let rest = base.split("://").nth(1).unwrap_or(&base);
    let host_port = rest.split('/').next().unwrap_or(rest);
    let host_port = host_port.rsplit('@').next().unwrap_or(host_port);
    if let Some(stripped) = host_port.strip_prefix('[') {
        return stripped.split(']').next().unwrap_or(stripped).to_string(); // IPv6
    }
    host_port.split(':').next().unwrap_or(host_port).to_string()
}

pub async fn connect(conn: &RmqConn, password: &str, vhost: &str, purpose: &str) -> Result<Connection, String> {
    let host = amqp_host(conn);
    let port = conn.amqp_port.unwrap_or(if conn.amqp_tls { 5671 } else { 5672 });
    let mut args = OpenConnectionArguments::new(&host, port, &conn.user, password);
    args.virtual_host(vhost).connection_name(&format!("TodoRS ({purpose})")).heartbeat(30);
    if conn.amqp_tls {
        ensure_crypto_provider();
        let tls = TlsAdaptor::without_client_auth(None, host.clone()).map_err(|e| format!("TLS: {e}"))?;
        args.tls_adaptor(tls);
    }
    let timeout = Duration::from_secs(conn.timeout_s.unwrap_or(20).clamp(3, 60));
    match tokio::time::timeout(timeout, Connection::open(&args)).await {
        Err(_) => Err(format!("Tempo esgotado ao conectar via AMQP em {host}:{port}.")),
        Ok(Err(e)) => Err(describe_amqp_error(&host, port, &e.to_string())),
        Ok(Ok(c)) => Ok(c),
    }
}

/// rustls 0.23 exige um provedor de criptografia padrão no processo.
fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn describe_amqp_error(host: &str, port: u16, e: &str) -> String {
    let low = e.to_lowercase();
    if low.contains("access_refused") || low.contains("403") || low.contains("authentication") {
        format!("AMQP {host}:{port}: usuário/senha recusados ou sem acesso ao vhost ({e}).")
    } else if low.contains("not_allowed") || low.contains("530") {
        format!("AMQP {host}:{port}: vhost inexistente ou sem permissão ({e}).")
    } else if low.contains("refused") || low.contains("connect") || low.contains("os error") {
        format!("Não foi possível conectar via AMQP em {host}:{port} ({e}). A porta AMQP (5672/5671) está acessível?")
    } else {
        format!("AMQP {host}:{port}: {e}")
    }
}

// ---------- Tabelas AMQP (headers/argumentos) <-> JSON ----------

/// Converte via a codificação de rede (o amqprs não expõe arrays/byte arrays de outra forma).
pub fn table_to_json(t: &FieldTable) -> Value {
    match amqp_serde::to_bytes(t) {
        Ok(bytes) => {
            let mut pos = 0;
            parse_table(&bytes, &mut pos).map(Value::Object).unwrap_or(Value::Null)
        }
        Err(_) => Value::Null,
    }
}

fn take<'a>(b: &'a [u8], pos: &mut usize, n: usize) -> Option<&'a [u8]> {
    let s = b.get(*pos..*pos + n)?;
    *pos += n;
    Some(s)
}

fn take_arr<const N: usize>(b: &[u8], pos: &mut usize) -> Option<[u8; N]> {
    take(b, pos, N)?.try_into().ok()
}

fn parse_table(b: &[u8], pos: &mut usize) -> Option<Map<String, Value>> {
    let len = u32::from_be_bytes(take_arr(b, pos)?) as usize;
    let end = (*pos).checked_add(len).filter(|e| *e <= b.len())?;
    let mut map = Map::new();
    while *pos < end {
        let nl = *take(b, pos, 1)?.first()? as usize;
        let name = String::from_utf8_lossy(take(b, pos, nl)?).into_owned();
        let v = parse_value(b, pos)?;
        map.insert(name, v);
    }
    Some(map)
}

fn parse_value(b: &[u8], pos: &mut usize) -> Option<Value> {
    let tag = *take(b, pos, 1)?.first()?;
    Some(match tag {
        b't' => Value::Bool(take(b, pos, 1)?[0] != 0),
        b'b' => json!(i8::from_be_bytes(take_arr(b, pos)?)),
        b'B' => json!(u8::from_be_bytes(take_arr(b, pos)?)),
        b's' => json!(i16::from_be_bytes(take_arr(b, pos)?)),
        b'u' => json!(u16::from_be_bytes(take_arr(b, pos)?)),
        b'I' => json!(i32::from_be_bytes(take_arr(b, pos)?)),
        b'i' => json!(u32::from_be_bytes(take_arr(b, pos)?)),
        b'l' => json!(i64::from_be_bytes(take_arr(b, pos)?)),
        b'f' => json!(f32::from_be_bytes(take_arr(b, pos)?)),
        b'd' => json!(f64::from_be_bytes(take_arr(b, pos)?)),
        b'T' => json!(u64::from_be_bytes(take_arr(b, pos)?)),
        b'D' => {
            let scale = take(b, pos, 1)?[0] as i32;
            let v = i32::from_be_bytes(take_arr(b, pos)?);
            json!(v as f64 / 10f64.powi(scale))
        }
        b'S' => {
            let n = u32::from_be_bytes(take_arr(b, pos)?) as usize;
            Value::String(String::from_utf8_lossy(take(b, pos, n)?).into_owned())
        }
        b'x' => {
            let n = u32::from_be_bytes(take_arr(b, pos)?) as usize;
            Value::String(B64.encode(take(b, pos, n)?))
        }
        b'A' => {
            let n = u32::from_be_bytes(take_arr(b, pos)?) as usize;
            let end = (*pos).checked_add(n).filter(|e| *e <= b.len())?;
            let mut arr = Vec::new();
            while *pos < end {
                arr.push(parse_value(b, pos)?);
            }
            Value::Array(arr)
        }
        b'F' => Value::Object(parse_table(b, pos)?),
        b'V' => Value::Null,
        _ => return None,
    })
}

fn json_to_value(v: &Value) -> FieldValue {
    match v {
        Value::Null => FieldValue::V,
        Value::Bool(b) => FieldValue::t(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => FieldValue::l(i),
            None => FieldValue::d(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => FieldValue::from(s.as_str()),
        Value::Array(a) => FieldValue::A(FieldArray::try_from(a.iter().map(json_to_value).collect::<Vec<_>>()).unwrap_or_default()),
        Value::Object(_) => FieldValue::F(json_to_table(v)),
    }
}

/// Argumentos de binding / headers em JSON → FieldTable (inteiros viram `long`).
pub fn json_to_table(v: &Value) -> FieldTable {
    let mut t = FieldTable::new();
    if let Value::Object(map) = v {
        for (k, val) in map {
            if let Ok(name) = k.as_str().try_into() {
                t.insert(name, json_to_value(val));
            }
        }
    }
    t
}

/// Propriedades no mesmo formato da API de management (`properties` do /get).
pub fn props_to_json(p: &BasicProperties) -> Value {
    let mut m = Map::new();
    let mut put = |k: &str, v: Option<Value>| {
        if let Some(v) = v {
            m.insert(k.to_string(), v);
        }
    };
    put("content_type", p.content_type().map(|s| json!(s)));
    put("content_encoding", p.content_encoding().map(|s| json!(s)));
    put("headers", p.headers().map(table_to_json));
    put("delivery_mode", p.delivery_mode().map(|v| json!(v)));
    put("priority", p.priority().map(|v| json!(v)));
    put("correlation_id", p.correlation_id().map(|s| json!(s)));
    put("reply_to", p.reply_to().map(|s| json!(s)));
    put("expiration", p.expiration().map(|s| json!(s)));
    put("message_id", p.message_id().map(|s| json!(s)));
    put("timestamp", p.timestamp().map(|v| json!(v)));
    put("type", p.message_type().map(|s| json!(s)));
    put("user_id", p.user_id().map(|s| json!(s)));
    put("app_id", p.app_id().map(|s| json!(s)));
    put("cluster_id", p.cluster_id().map(|s| json!(s)));
    Value::Object(m)
}

/// x-death[0] (morte mais recente): exchange e routing key de origem de uma mensagem na DLQ.
pub fn death_origin(p: &BasicProperties) -> Option<(String, String)> {
    let headers = table_to_json(p.headers()?);
    let first = headers.get("x-death")?.as_array()?.first()?.clone();
    let exchange = first.get("exchange")?.as_str()?.to_string();
    let rk = first.get("routing-keys").and_then(|r| r.as_array()).and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    Some((exchange, rk))
}

// ---------- Captura ----------

#[derive(Deserialize, Clone, Debug, Default)]
pub struct CaptureSpec {
    #[serde(default = "default_vhost")]
    pub vhost: String,
    /// tap | firehose | exchange
    pub mode: String,
    #[serde(default)]
    pub queues: Vec<String>,
    #[serde(default)]
    pub exchange: String,
    #[serde(default)]
    pub routing_key: String,
    /// firehose: "publish", "deliver" ou ambos (vazio).
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub max_body_kb: Option<u32>,
    #[serde(default)]
    pub max_messages: Option<i64>,
}

fn default_vhost() -> String {
    "/".into()
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureEvent {
    Progress { capture_id: i64, count: i64 },
    Warning { capture_id: i64, message: String },
    Stopped { capture_id: i64, count: i64, error: Option<String> },
}

/// Ligações da fila temporária: (exchange, routing key, argumentos, filas de origem).
#[derive(Clone, Debug, Default)]
pub struct TapBinding {
    pub exchange: String,
    pub routing_key: String,
    pub arguments: Value,
    pub queues: Vec<String>,
}

/// Conexão aberta de uma captura, já consumindo a fila temporária.
pub struct Listener {
    pub connection: Connection,
    pub channel: Channel,
    pub rx: tokio::sync::mpsc::UnboundedReceiver<amqprs::channel::ConsumerMessage>,
}

pub async fn open_listener(conn: &RmqConn, password: &str, spec: &CaptureSpec, bindings: &[TapBinding]) -> Result<Listener, String> {
    let connection = connect(conn, password, &spec.vhost, "captura").await?;
    let channel = connection.open_channel(None).await.map_err(|e| e.to_string())?;
    let mut args = FieldTable::new();
    // Limite de segurança: se o app não acompanhar, o servidor descarta as mais antigas.
    args.insert("x-max-length".try_into().unwrap(), FieldValue::l(100_000));
    let mut declare = QueueDeclareArguments::exclusive_server_named();
    declare.arguments(args);
    let (queue, _, _) = channel
        .queue_declare(declare)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("O servidor não devolveu o nome da fila temporária")?;
    for b in bindings {
        let mut bind = QueueBindArguments::new(&queue, &b.exchange, &b.routing_key);
        bind.arguments = json_to_table(&b.arguments);
        channel
            .queue_bind(bind)
            .await
            .map_err(|e| format!("Falha ao ligar à exchange \"{}\" ({}): {e}", b.exchange, b.routing_key))?;
    }
    let mut consume = BasicConsumeArguments::new(&queue, "todors-capture");
    consume.no_ack = true;
    let (_, rx) = channel.basic_consume_rx(consume).await.map_err(|e| e.to_string())?;
    Ok(Listener { connection, channel, rx })
}

impl Listener {
    pub async fn close(self) {
        let _ = self.channel.close().await;
        let _ = self.connection.close().await;
    }
}

/// Interpreta uma mensagem recebida pela fila temporária. `None` = descartar (filtro).
pub fn to_record(spec: &CaptureSpec, bindings: &[TapBinding], deliver_exchange: &str, deliver_rk: &str, props: Option<&BasicProperties>, content: Vec<u8>) -> Option<MsgIn> {
    let mut m = MsgIn { vhost: spec.vhost.clone(), at: now_ms(), size: content.len() as i64, payload: content, ..Default::default() };
    if spec.mode == "firehose" {
        let headers = props.and_then(|p| p.headers()).map(table_to_json).unwrap_or(Value::Null);
        let hs = |k: &str| headers.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let (event, rest) = deliver_rk.split_once('.').unwrap_or((deliver_rk, ""));
        m.event = event.to_string();
        m.exchange = hs("exchange_name");
        m.routing_key = headers
            .get("routing_keys")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        m.properties = headers.get("properties").cloned().unwrap_or(Value::Null);
        m.redelivered = matches!(headers.get("redelivered"), Some(Value::Bool(true))) || headers.get("redelivered").and_then(Value::as_i64) == Some(1);
        m.client = [hs("user"), hs("connection")].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
        m.queues = match event {
            "deliver" => vec![rest.to_string()],
            _ => headers
                .get("routed_queues")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
        };
        if !spec.events.is_empty() && !spec.events.iter().any(|e| e == event) {
            return None;
        }
        // Entregas para as filas temporárias de outras capturas não interessam.
        if event == "deliver" && rest.starts_with("amq.gen-") {
            return None;
        }
        if !spec.queues.is_empty() {
            let wanted: HashSet<&str> = spec.queues.iter().map(String::as_str).collect();
            let routed_known = event == "deliver" || headers.get("routed_queues").is_some();
            if routed_known && !m.queues.iter().any(|q| wanted.contains(q.as_str())) {
                return None;
            }
        }
    } else {
        m.event = "publish".into();
        m.exchange = deliver_exchange.to_string();
        m.routing_key = deliver_rk.to_string();
        m.properties = props.map(props_to_json).unwrap_or(Value::Null);
        // Filas que recebem esta mensagem: ligação exata quando houver; senão todas da exchange.
        let same_ex: Vec<&TapBinding> = bindings.iter().filter(|b| b.exchange == deliver_exchange).collect();
        let exact: Vec<&TapBinding> = same_ex.iter().copied().filter(|b| b.routing_key == deliver_rk).collect();
        let pick = if exact.is_empty() { same_ex } else { exact };
        let mut qs: Vec<String> = pick.iter().flat_map(|b| b.queues.clone()).collect();
        qs.sort();
        qs.dedup();
        m.queues = qs;
    }
    Some(m)
}

// ---------- Mover / copiar ----------

#[derive(Deserialize, Clone, Debug)]
pub struct MoveSpec {
    #[serde(default = "default_vhost")]
    pub vhost: String,
    pub from_queue: String,
    /// queue | exchange | origin (x-death da DLQ)
    pub target: String,
    #[serde(default)]
    pub to_queue: String,
    #[serde(default)]
    pub exchange: String,
    #[serde(default)]
    pub routing_key: String,
    /// Máximo de mensagens (None = todas as que estavam na fila ao começar).
    #[serde(default)]
    pub count: Option<u32>,
    /// Copia sem remover da origem.
    #[serde(default)]
    pub copy: bool,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct MoveResult {
    pub moved: u32,
    /// Sem x-death (alvo "origem"): ficaram na fila.
    pub skipped: u32,
    /// Sem rota no destino: voltaram para a fila de origem.
    pub returned: u32,
}

type Returned = Arc<Mutex<Vec<(BasicProperties, Vec<u8>)>>>;

struct ReturnCollector(Returned);

#[async_trait::async_trait]
impl ChannelCallback for ReturnCollector {
    async fn close(&mut self, _: &Channel, _: CloseChannel) -> Result<(), amqprs::error::Error> {
        Ok(())
    }
    async fn cancel(&mut self, _: &Channel, _: Cancel) -> Result<(), amqprs::error::Error> {
        Ok(())
    }
    async fn flow(&mut self, _: &Channel, active: bool) -> Result<bool, amqprs::error::Error> {
        Ok(active)
    }
    async fn publish_ack(&mut self, _: &Channel, _: Ack) {}
    async fn publish_nack(&mut self, _: &Channel, _: Nack) {}
    async fn publish_return(&mut self, _: &Channel, _: Return, props: BasicProperties, content: Vec<u8>) {
        self.0.lock().unwrap().push((props, content));
    }
}

const MOVE_BATCH: u32 = 200;

pub async fn move_messages(conn: &RmqConn, password: &str, spec: &MoveSpec) -> Result<MoveResult, String> {
    if spec.target == "queue" && spec.to_queue == spec.from_queue && !spec.copy {
        return Err("A fila de destino é a própria fila de origem.".into());
    }
    let connection = connect(conn, password, &spec.vhost, "mover mensagens").await?;
    let result = move_on(&connection, spec).await;
    let _ = connection.close().await;
    result
}

async fn move_on(connection: &Connection, spec: &MoveSpec) -> Result<MoveResult, String> {
    let err = |e: amqprs::error::Error| e.to_string();
    let channel = connection.open_channel(None).await.map_err(err)?;
    let returned: Returned = Arc::default();
    channel.register_callback(ReturnCollector(returned.clone())).await.map_err(err)?;
    if spec.target == "queue" {
        // Destino precisa existir (passive): publicar numa fila inexistente perderia as mensagens.
        let mut q = QueueDeclareArguments::new(&spec.to_queue);
        q.passive(true);
        channel.queue_declare(q).await.map_err(|e| format!("Fila de destino \"{}\" não encontrada: {e}", spec.to_queue))?;
    }
    channel.tx_select().await.map_err(err)?;

    let mut res = MoveResult::default();
    let mut limit: Option<u32> = spec.count;
    let mut done = 0u32;
    let mut in_batch = 0u32;
    loop {
        if limit.is_some_and(|l| done >= l) {
            break;
        }
        let mut get = BasicGetArguments::new(&spec.from_queue);
        get.no_ack = false;
        let Some((ok, props, content)) = channel.basic_get(get).await.map_err(err)? else { break };
        if done == 0 {
            // Só o que estava na fila ao começar: o que for devolvido/requeue não roda de novo.
            let initial = ok.message_count() + 1;
            limit = Some(limit.map_or(initial, |l| l.min(initial)));
        }
        done += 1;
        let dest = match spec.target.as_str() {
            "queue" => Some((String::new(), spec.to_queue.clone())),
            "exchange" => Some((spec.exchange.clone(), spec.routing_key.clone())),
            _ => death_origin(&props),
        };
        match dest {
            Some((ex, rk)) => {
                let mut publish = BasicPublishArguments::new(&ex, &rk);
                publish.mandatory = true;
                channel.basic_publish(props, content, publish).await.map_err(err)?;
                if !spec.copy {
                    channel.basic_ack(BasicAckArguments::new(ok.delivery_tag(), false)).await.map_err(err)?;
                }
                res.moved += 1;
            }
            None => {
                res.skipped += 1;
                if !spec.copy {
                    channel.basic_reject(BasicRejectArguments::new(ok.delivery_tag(), true)).await.map_err(err)?;
                }
            }
        }
        in_batch += 1;
        // Na cópia tudo fica numa transação só: as mensagens ficam "unacked" até o fim e
        // voltam para a fila ao fechar o canal, na ordem original.
        if !spec.copy && in_batch >= MOVE_BATCH {
            channel.tx_commit().await.map_err(err)?;
            in_batch = 0;
        }
    }
    channel.tx_commit().await.map_err(err)?;

    // Retornos (sem rota) chegam antes do commit-ok; o callback roda em outra task.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let back: Vec<_> = std::mem::take(&mut *returned.lock().unwrap());
    if !back.is_empty() {
        res.returned = back.len() as u32;
        res.moved = res.moved.saturating_sub(res.returned);
        if !spec.copy {
            for (props, content) in back {
                channel.basic_publish(props, content, BasicPublishArguments::new("", &spec.from_queue)).await.map_err(err)?;
            }
            channel.tx_commit().await.map_err(err)?;
        }
    }
    let _ = channel.close().await;
    Ok(res)
}

/// Bindings (exceto a exchange padrão) das filas escolhidas, agrupados por (exchange, rk, args).
pub fn group_bindings(per_queue: &[(String, Value)]) -> (Vec<TapBinding>, Vec<String>) {
    let mut out: Vec<TapBinding> = Vec::new();
    let mut only_default = Vec::new();
    let mut idx: HashMap<String, usize> = HashMap::new();
    for (queue, list) in per_queue {
        let mut any = false;
        for b in list.as_array().into_iter().flatten() {
            let source = b.get("source").and_then(Value::as_str).unwrap_or_default();
            if source.is_empty() || b.get("destination_type").and_then(Value::as_str) == Some("exchange") {
                continue;
            }
            any = true;
            let rk = b.get("routing_key").and_then(Value::as_str).unwrap_or_default();
            let args = b.get("arguments").cloned().unwrap_or(Value::Null);
            let key = format!("{source}\u{0}{rk}\u{0}{args}");
            match idx.get(&key) {
                Some(&i) => out[i].queues.push(queue.clone()),
                None => {
                    idx.insert(key, out.len());
                    out.push(TapBinding { exchange: source.into(), routing_key: rk.into(), arguments: args, queues: vec![queue.clone()] });
                }
            }
        }
        if !any {
            only_default.push(queue.clone());
        }
    }
    (out, only_default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_table_json_roundtrip() {
        let v = json!({
            "s": "texto ç",
            "n": 42,
            "neg": -7,
            "f": 1.5,
            "b": true,
            "nil": null,
            "arr": ["a", 1, { "x": "y" }],
            "x-death": [{ "count": 2, "exchange": "pedidos", "queue": "q", "reason": "rejected", "routing-keys": ["pedido.criado"] }]
        });
        let t = json_to_table(&v);
        assert_eq!(table_to_json(&t), v);

        let mut p = BasicProperties::default();
        p.with_headers(t).with_content_type("application/json").with_message_id("m1").with_delivery_mode(2);
        let pj = props_to_json(&p);
        assert_eq!(pj["content_type"], "application/json");
        assert_eq!(pj["delivery_mode"], 2);
        assert_eq!(pj["headers"]["arr"][2]["x"], "y");
        assert_eq!(death_origin(&p), Some(("pedidos".into(), "pedido.criado".into())));
    }

    #[test]
    fn hosts() {
        let mut c = RmqConn { mgmt_url: "https://user@mq.example.com:15671/rabbit".into(), ..Default::default() };
        assert_eq!(amqp_host(&c), "mq.example.com");
        c.mgmt_url = "localhost:15672".into();
        assert_eq!(amqp_host(&c), "localhost");
        c.mgmt_url = "http://[::1]:15672".into();
        assert_eq!(amqp_host(&c), "::1");
        c.amqp_host = " amqp.local ".into();
        assert_eq!(amqp_host(&c), "amqp.local");
    }

    #[test]
    fn bindings_grouping() {
        let q1 = json!([
            { "source": "", "routing_key": "q1", "destination_type": "queue" },
            { "source": "pedidos", "routing_key": "pedido.*", "arguments": {}, "destination_type": "queue" }
        ]);
        let q2 = json!([{ "source": "pedidos", "routing_key": "pedido.*", "arguments": {}, "destination_type": "queue" }]);
        let q3 = json!([{ "source": "", "routing_key": "q3", "destination_type": "queue" }]);
        let (b, only_default) = group_bindings(&[("q1".into(), q1), ("q2".into(), q2), ("q3".into(), q3)]);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].queues, ["q1", "q2"]);
        assert_eq!(only_default, ["q3"]);
    }

    #[test]
    fn firehose_records() {
        let spec = CaptureSpec { mode: "firehose".into(), vhost: "/".into(), queues: vec!["q.orders".into()], ..Default::default() };
        let headers = json!({
            "exchange_name": "orders",
            "routing_keys": ["order.created"],
            "routed_queues": ["q.orders", "q.audit"],
            "properties": { "content_type": "application/json", "headers": { "tenant": "acme" } },
            "user": "guest",
            "connection": "127.0.0.1:5000 -> 127.0.0.1:5672"
        });
        let mut p = BasicProperties::default();
        p.with_headers(json_to_table(&headers));
        let m = to_record(&spec, &[], "amq.rabbitmq.trace", "publish.orders", Some(&p), b"{}".to_vec()).unwrap();
        assert_eq!(m.event, "publish");
        assert_eq!(m.exchange, "orders");
        assert_eq!(m.routing_key, "order.created");
        assert_eq!(m.queues, ["q.orders", "q.audit"]);
        assert_eq!(m.properties["headers"]["tenant"], "acme");
        assert!(m.client.starts_with("guest · "));

        // Outra fila: filtrada.
        let other = json!({ "exchange_name": "x", "routing_keys": ["k"], "routed_queues": ["q.other"] });
        let mut p2 = BasicProperties::default();
        p2.with_headers(json_to_table(&other));
        assert!(to_record(&spec, &[], "amq.rabbitmq.trace", "publish.x", Some(&p2), vec![]).is_none());
        // Entrega na fila escolhida.
        let d = to_record(&spec, &[], "amq.rabbitmq.trace", "deliver.q.orders", Some(&p2), vec![]).unwrap();
        assert_eq!((d.event.as_str(), d.queues.clone()), ("deliver", vec!["q.orders".to_string()]));
        // Só publicações.
        let only_pub = CaptureSpec { events: vec!["publish".into()], ..spec };
        assert!(to_record(&only_pub, &[], "amq.rabbitmq.trace", "deliver.q.orders", Some(&p2), vec![]).is_none());
    }
}

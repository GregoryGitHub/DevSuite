//! Testes de integração com um RabbitMQ de verdade (ignorados sem `TODORS_RABBIT_TEST`):
//!
//! docker run -d --name todors-rabbit-test -p 5673:5672 -p 15673:15672 rabbitmq:3-management
//! TODORS_RABBIT_TEST="http://localhost:15673|5673|guest|guest" cargo test it_rabbit -- --test-threads=1

use std::time::Duration;

use serde_json::{json, Value};

use super::amqp::{self, CaptureSpec, MoveSpec};
use super::mgmt::{self, seg, MgmtClients};
use super::{set_tracing, RmqConn};

fn env() -> Option<(RmqConn, String)> {
    let raw = std::env::var("TODORS_RABBIT_TEST").ok()?;
    let p: Vec<&str> = raw.split('|').collect();
    let conn = RmqConn { id: "it".into(), mgmt_url: p[0].into(), amqp_port: p.get(1).and_then(|s| s.parse().ok()), user: p.get(2).unwrap_or(&"guest").to_string(), ..Default::default() };
    Some((conn, p.get(3).unwrap_or(&"guest").to_string()))
}

struct T {
    conn: RmqConn,
    pw: String,
    clients: MgmtClients,
}

impl T {
    async fn api(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        mgmt::call(&self.clients, &self.conn, &self.pw, method, path, body.as_ref()).await.unwrap_or_else(|e| panic!("{method} {path}: {e}"))
    }

    async fn publish(&self, exchange: &str, rk: &str, payload: &str, props: Value) -> bool {
        let ex = if exchange.is_empty() { "amq.default" } else { exchange };
        let r = self
            .api(
                "POST",
                &format!("/exchanges/%2F/{}/publish", seg(ex)),
                Some(json!({ "properties": props, "routing_key": rk, "payload": payload, "payload_encoding": "string" })),
            )
            .await;
        r["routed"].as_bool().unwrap_or(false)
    }

    async fn depth(&self, q: &str) -> u64 {
        // As estatísticas da API atrasam; o /get com requeue conta de verdade.
        let r = self.api("POST", &format!("/queues/%2F/{}/get", seg(q)), Some(json!({ "count": 10000, "ackmode": "ack_requeue_true", "encoding": "auto", "truncate": 10 }))).await;
        r.as_array().map(|a| a.len() as u64).unwrap_or(0)
    }

    /// Exchange topic + fila principal com DLX para uma DLQ.
    async fn setup(&self, prefix: &str) {
        let ex = format!("{prefix}.ex");
        let dlx = format!("{prefix}.dlx");
        self.api("PUT", &format!("/exchanges/%2F/{}", seg(&ex)), Some(json!({ "type": "topic", "durable": false, "auto_delete": false }))).await;
        self.api("PUT", &format!("/exchanges/%2F/{}", seg(&dlx)), Some(json!({ "type": "fanout", "durable": false }))).await;
        for q in ["main", "dlq", "other"] {
            let name = format!("{prefix}.{q}");
            let _ = mgmt::call(&self.clients, &self.conn, &self.pw, "DELETE", &format!("/queues/%2F/{}", seg(&name)), None).await;
        }
        self.api(
            "PUT",
            &format!("/queues/%2F/{}", seg(&format!("{prefix}.main"))),
            Some(json!({ "durable": false, "arguments": { "x-dead-letter-exchange": dlx } })),
        )
        .await;
        self.api("PUT", &format!("/queues/%2F/{}", seg(&format!("{prefix}.dlq"))), Some(json!({ "durable": false }))).await;
        self.api("PUT", &format!("/queues/%2F/{}", seg(&format!("{prefix}.other"))), Some(json!({ "durable": false }))).await;
        self.api("POST", &format!("/bindings/%2F/e/{}/q/{}", seg(&ex), seg(&format!("{prefix}.main"))), Some(json!({ "routing_key": "pedido.*" }))).await;
        self.api("POST", &format!("/bindings/%2F/e/{}/q/{}", seg(&dlx), seg(&format!("{prefix}.dlq"))), Some(json!({ "routing_key": "" }))).await;
    }
}

async fn t() -> Option<T> {
    let (conn, pw) = env()?;
    Some(T { conn, pw, clients: MgmtClients::default() })
}

async fn drain(l: &mut amqp::Listener, spec: &CaptureSpec, bindings: &[amqp::TapBinding], want: usize) -> Vec<crate::rabbit::store::MsgIn> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while out.len() < want {
        let Ok(Some(m)) = tokio::time::timeout_at(deadline, l.rx.recv()).await else { break };
        let (ex, rk) = m.deliver.as_ref().map(|d| (d.exchange().clone(), d.routing_key().clone())).unwrap_or_default();
        if let Some(r) = amqp::to_record(spec, bindings, &ex, &rk, m.basic_properties.as_ref(), m.content.unwrap_or_default()) {
            out.push(r);
        }
    }
    out
}

#[tokio::test]
async fn it_rabbit_tap_capture() {
    let Some(t) = t().await else { return };
    t.setup("it.tap").await;
    let spec = CaptureSpec { mode: "tap".into(), vhost: "/".into(), queues: vec!["it.tap.main".into()], ..Default::default() };
    let bindings_json = t.api("GET", "/queues/%2F/it.tap.main/bindings", None).await;
    let (bindings, only_default) = amqp::group_bindings(&[("it.tap.main".into(), bindings_json)]);
    assert!(only_default.is_empty());
    let mut l = amqp::open_listener(&t.conn, &t.pw, &spec, &bindings).await.unwrap();

    assert!(t.publish("it.tap.ex", "pedido.criado", r#"{"id":1}"#, json!({ "headers": { "tenant": "acme" }, "content_type": "application/json" })).await);
    assert!(t.publish("it.tap.ex", "outro.evento", "nao casa", json!({})).await == false);
    let got = drain(&mut l, &spec, &bindings, 1).await;
    l.close().await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].routing_key, "pedido.criado");
    assert_eq!(got[0].queues, ["it.tap.main"]);
    assert_eq!(got[0].properties["headers"]["tenant"], "acme");
    assert_eq!(got[0].payload, br#"{"id":1}"#);
    // O tap não consome: a mensagem continua na fila real.
    assert_eq!(t.depth("it.tap.main").await, 1);
}

#[tokio::test]
async fn it_rabbit_firehose_capture() {
    let Some(t) = t().await else { return };
    t.setup("it.fh").await;
    assert!(set_tracing(&t.clients, &t.conn, &t.pw, "/", true).await.is_ok());
    let spec = CaptureSpec { mode: "firehose".into(), vhost: "/".into(), queues: vec!["it.fh.other".into()], ..Default::default() };
    let b = |rk: &str| amqp::TapBinding { exchange: "amq.rabbitmq.trace".into(), routing_key: rk.into(), ..Default::default() };
    let bindings = vec![b("publish.#"), b("deliver.#")];
    let mut l = amqp::open_listener(&t.conn, &t.pw, &spec, &bindings).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Publicação direta na fila (exchange padrão) — o tap não veria; o firehose vê.
    assert!(t.publish("", "it.fh.other", "direto", json!({ "message_id": "abc" })).await);
    assert!(t.publish("it.fh.ex", "pedido.x", "outra fila", json!({})).await);
    let got = drain(&mut l, &spec, &bindings, 1).await;
    l.close().await;
    set_tracing(&t.clients, &t.conn, &t.pw, "/", false).await.unwrap();
    let vh = t.api("GET", "/vhosts/%2F", None).await;
    assert_eq!(vh["tracing"], false);

    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].event, "publish");
    assert_eq!(got[0].exchange, "");
    assert_eq!(got[0].routing_key, "it.fh.other");
    assert_eq!(got[0].properties["message_id"], "abc");
    assert_eq!(got[0].payload, b"direto");
}

#[tokio::test]
async fn it_rabbit_move_from_dlq() {
    let Some(t) = t().await else { return };
    t.setup("it.mv").await;
    for i in 0..5 {
        assert!(t.publish("it.mv.ex", &format!("pedido.{i}"), &format!("m{i}"), json!({ "headers": { "n": i } })).await);
    }
    // Rejeita tudo da fila principal: vão para a DLQ com x-death.
    t.api("POST", "/queues/%2F/it.mv.main/get", Some(json!({ "count": 5, "ackmode": "reject_requeue_false", "encoding": "auto" }))).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(t.depth("it.mv.dlq").await, 5);

    // Copiar não remove.
    let copy = MoveSpec { vhost: "/".into(), from_queue: "it.mv.dlq".into(), target: "queue".into(), to_queue: "it.mv.other".into(), exchange: String::new(), routing_key: String::new(), count: Some(2), copy: true };
    let r = amqp::move_messages(&t.conn, &t.pw, &copy).await.unwrap();
    assert_eq!(r.moved, 2);
    assert_eq!(t.depth("it.mv.dlq").await, 5);
    assert_eq!(t.depth("it.mv.other").await, 2);

    // Reenviar à origem (x-death): voltam para a fila principal pela exchange/routing key originais.
    let origin = MoveSpec { target: "origin".into(), to_queue: String::new(), count: None, copy: false, ..copy.clone() };
    let r = amqp::move_messages(&t.conn, &t.pw, &origin).await.unwrap();
    assert_eq!((r.moved, r.skipped, r.returned), (5, 0, 0));
    assert_eq!(t.depth("it.mv.dlq").await, 0);
    assert_eq!(t.depth("it.mv.main").await, 5);
    // A ordem é preservada.
    let msgs = t.api("POST", "/queues/%2F/it.mv.main/get", Some(json!({ "count": 5, "ackmode": "ack_requeue_true", "encoding": "auto" }))).await;
    let bodies: Vec<&str> = msgs.as_array().unwrap().iter().map(|m| m["payload"].as_str().unwrap()).collect();
    assert_eq!(bodies, ["m0", "m1", "m2", "m3", "m4"]);

    // Exchange sem rota: as mensagens voltam para a origem em vez de sumirem.
    let lost = MoveSpec { from_queue: "it.mv.other".into(), target: "exchange".into(), exchange: "it.mv.ex".into(), routing_key: "sem.rota".into(), count: None, copy: false, ..copy.clone() };
    let r = amqp::move_messages(&t.conn, &t.pw, &lost).await.unwrap();
    assert_eq!((r.moved, r.returned), (0, 2));
    assert_eq!(t.depth("it.mv.other").await, 2);

    // Destino inexistente: erro antes de tirar qualquer mensagem.
    let missing = MoveSpec { to_queue: "nao.existe".into(), target: "queue".into(), ..lost };
    assert!(amqp::move_messages(&t.conn, &t.pw, &missing).await.is_err());
    assert_eq!(t.depth("it.mv.other").await, 2);
}

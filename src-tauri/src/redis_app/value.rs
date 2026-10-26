//! Conversão entre os valores do Redis (RESP2/RESP3) e o JSON da interface, sem perder bytes.
//!
//! Saída (`to_json`): `{ t, v }` com `t` = nil | int | str (bulk UTF-8) | bin (bulk em Base64) |
//! status | err | arr | map (pares) | set | dbl | bool | big | push.
//! Entrada (`Arg`): texto ou `{ "b64": "..." }` para bytes que não são UTF-8 (chaves binárias).

use base64::Engine;
use redis::Value;
use serde::Deserialize;
use serde_json::{json, Value as Json};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum Arg {
    Text(String),
    Bytes { b64: String },
}

impl Arg {
    pub fn bytes(&self) -> Result<Vec<u8>, String> {
        match self {
            Arg::Text(s) => Ok(s.as_bytes().to_vec()),
            Arg::Bytes { b64 } => B64.decode(b64).map_err(|e| format!("Base64 inválido: {e}")),
        }
    }

    /// Nome do comando/subcomando em maiúsculas (só faz sentido para texto).
    pub fn upper(&self) -> String {
        match self {
            Arg::Text(s) => s.to_ascii_uppercase(),
            Arg::Bytes { .. } => String::new(),
        }
    }
}

/// Monta o comando a partir dos argumentos (o primeiro é o nome).
pub fn build_cmd(args: &[Arg]) -> Result<redis::Cmd, String> {
    if args.is_empty() {
        return Err("Comando vazio".into());
    }
    let mut cmd = redis::Cmd::new();
    for a in args {
        cmd.arg(a.bytes()?);
    }
    Ok(cmd)
}

pub fn bulk(b: Vec<u8>) -> Json {
    match String::from_utf8(b) {
        Ok(s) => json!({ "t": "str", "v": s }),
        Err(e) => json!({ "t": "bin", "v": B64.encode(e.into_bytes()) }),
    }
}

fn list(items: Vec<Value>) -> Vec<Json> {
    items.into_iter().map(to_json).collect()
}

pub fn to_json(v: Value) -> Json {
    match v {
        Value::Nil => json!({ "t": "nil" }),
        Value::Int(i) => json!({ "t": "int", "v": i }),
        Value::BulkString(b) => bulk(b),
        Value::Array(a) => json!({ "t": "arr", "v": list(a) }),
        Value::SimpleString(s) => json!({ "t": "status", "v": s }),
        Value::Okay => json!({ "t": "status", "v": "OK" }),
        Value::Map(m) => json!({ "t": "map", "v": m.into_iter().map(|(k, v)| json!([to_json(k), to_json(v)])).collect::<Vec<_>>() }),
        Value::Attribute { data, .. } => to_json(*data),
        Value::Set(a) => json!({ "t": "set", "v": list(a) }),
        Value::Double(d) if d.is_finite() => json!({ "t": "dbl", "v": d }),
        Value::Double(d) => json!({ "t": "dbl", "v": d.to_string() }),
        Value::Boolean(b) => json!({ "t": "bool", "v": b }),
        Value::VerbatimString { text, .. } => json!({ "t": "str", "v": text }),
        Value::BigNumber(n) => json!({ "t": "big", "v": String::from_utf8_lossy(&n).to_string() }),
        Value::Push { kind, data } => json!({ "t": "push", "kind": format!("{kind:?}"), "v": list(data) }),
        Value::ServerError(e) => json!({ "t": "err", "v": server_error_text(&e) }),
        #[allow(unreachable_patterns)]
        _ => json!({ "t": "nil" }),
    }
}

fn server_error_text(e: &redis::ServerError) -> String {
    match e.details() {
        Some(d) => format!("{} {d}", e.code()),
        None => e.code().to_string(),
    }
}

/// Erro de resposta do servidor ("WRONGTYPE …", "NOPERM …"): a conexão continua boa.
pub fn server_error(e: &redis::RedisError) -> Option<String> {
    e.code().map(|c| match e.detail() {
        Some(d) => format!("{c} {d}"),
        None => c.to_string(),
    })
}

/// Texto legível de um erro do driver (o servidor responde "WRONGTYPE ...", "NOAUTH ..." etc.).
pub fn err_text(e: &redis::RedisError) -> String {
    if let Some(s) = server_error(e) {
        return s;
    }
    let s = e.to_string();
    // "An error was signalled by the server - ResponseError: WRONGTYPE ..." → só a mensagem.
    match s.split_once(": ") {
        Some((head, rest)) if head.contains("signalled by the server") => rest.to_string(),
        _ => s,
    }
}

/// Texto de um bulk/status (para ler INFO, CLUSTER SHARDS etc. no Rust).
pub fn as_text(v: &Value) -> Option<String> {
    match v {
        Value::BulkString(b) => Some(String::from_utf8_lossy(b).to_string()),
        Value::SimpleString(s) => Some(s.clone()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        Value::Okay => Some("OK".into()),
        Value::Int(i) => Some(i.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_value_json() {
        assert_eq!(to_json(Value::BulkString(b"abc".to_vec())), json!({ "t": "str", "v": "abc" }));
        assert_eq!(to_json(Value::BulkString(vec![0xff, 0x00])), json!({ "t": "bin", "v": "/wA=" }));
        assert_eq!(to_json(Value::Okay), json!({ "t": "status", "v": "OK" }));
        let arr = to_json(Value::Array(vec![Value::Int(1), Value::Nil]));
        assert_eq!(arr, json!({ "t": "arr", "v": [{ "t": "int", "v": 1 }, { "t": "nil" }] }));
        let a: Arg = serde_json::from_value(json!({ "b64": "/wA=" })).unwrap();
        assert_eq!(a.bytes().unwrap(), vec![0xff, 0x00]);
        let t: Arg = serde_json::from_value(json!("GET")).unwrap();
        assert_eq!(t.upper(), "GET");
    }
}

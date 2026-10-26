//! Catálogo de comandos (`commands.json`): parser dos argumentos, ajuda e `devsuite schema`.

use std::io::Read;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::conn::Failure;

pub const SPEC: &str = include_str!("../commands.json");

pub fn spec() -> Value {
    serde_json::from_str(SPEC).expect("commands.json válido")
}

/// Opções válidas em qualquer comando (tratadas pelo próprio cliente).
pub const GLOBAL_HELP: &[(&str, &str)] = &[
    ("--json", "Saída JSON { ok, data | error } (padrão quando a saída não é um terminal)"),
    ("--text", "Saída para humanos mesmo fora de um terminal"),
    ("--pretty", "JSON indentado"),
    ("--timeout SEGUNDOS", "Desiste depois disso (padrão 300; 0 = sem limite)"),
    ("--no-start", "Não inicia o Dev Suite se ele não estiver aberto"),
    ("-h, --help", "Ajuda do comando"),
];

pub fn find_group<'a>(spec: &'a Value, name: &str) -> Option<&'a Value> {
    spec["groups"].as_array()?.iter().find(|g| g["name"] == name)
}

/// Comando do grupo pelas próximas palavras (os de duas palavras têm prioridade).
pub fn find_command<'a>(group: &'a Value, words: &[String]) -> Option<(&'a Value, usize)> {
    let cmds = group["commands"].as_array()?;
    if words.len() >= 2 {
        let two = format!("{} {}", words[0], words[1]);
        if let Some(c) = cmds.iter().find(|c| c["name"] == two.as_str()) {
            return Some((c, 2));
        }
    }
    let one = words.first()?;
    cmds.iter().find(|c| c["name"] == one.as_str()).map(|c| (c, 1))
}

fn key(name: &str) -> String {
    name.replace('-', "_")
}

fn usage(msg: impl Into<String>) -> Failure {
    Failure::new("usage", msg)
}

/// Valor de uma opção/argumento `input`: texto literal, `@arquivo` ou `-` (stdin).
fn read_input(raw: &str, stdin_used: &mut bool) -> Result<String, Failure> {
    if raw == "-" {
        if *stdin_used {
            return Err(usage("Só um valor pode vir do stdin (-)"));
        }
        *stdin_used = true;
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| usage(format!("Falha ao ler o stdin: {e}")))?;
        return Ok(s);
    }
    if let Some(path) = raw.strip_prefix('@') {
        return std::fs::read_to_string(path).map_err(|e| usage(format!("Falha ao ler {path}: {e}")));
    }
    Ok(raw.to_string())
}

fn absolute(raw: &str) -> String {
    let p = Path::new(raw);
    if p.is_absolute() {
        return raw.to_string();
    }
    std::env::current_dir().map(|d| d.join(p).to_string_lossy().into_owned()).unwrap_or_else(|_| raw.to_string())
}

fn convert(def: &Value, raw: &str, stdin_used: &mut bool) -> Result<Value, Failure> {
    let name = def["name"].as_str().unwrap_or("");
    if def["input"] == true {
        return Ok(Value::String(read_input(raw, stdin_used)?));
    }
    if def["path"] == true {
        return Ok(Value::String(absolute(raw)));
    }
    if def["number"] == true {
        return raw
            .parse::<f64>()
            .ok()
            .and_then(|n| serde_json::Number::from_f64(n))
            .map(|n| match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 9e15 => Value::from(f as i64),
                _ => Value::Number(n),
            })
            .ok_or_else(|| usage(format!("--{name} espera um número: {raw}")));
    }
    Ok(Value::String(raw.to_string()))
}

/// Argumentos do comando -> params (`opcao-x` vira `opcao_x`). Opções `local` ficam no cliente.
pub fn parse(cmd: &Value, args: &[String]) -> Result<(Map<String, Value>, Map<String, Value>), Failure> {
    let empty = vec![];
    let opts = cmd["options"].as_array().unwrap_or(&empty);
    let positionals = cmd["args"].as_array().unwrap_or(&empty);
    let mut params = Map::new();
    let mut local = Map::new();
    let mut pos: Vec<String> = Vec::new();
    let mut stdin_used = false;
    let mut only_positional = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if only_positional || !a.starts_with("--") || a == "-" {
            if a == "--" {
                only_positional = true;
                continue;
            }
            pos.push(a.clone());
            continue;
        }
        if a == "--" {
            only_positional = true;
            continue;
        }
        let body = &a[2..];
        let (name, inline) = match body.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (body, None),
        };
        let def = opts
            .iter()
            .find(|o| o["name"] == name)
            .ok_or_else(|| usage(format!("Opção desconhecida: --{name} (veja --help)")))?;
        let target = if def["local"] == true { &mut local } else { &mut params };
        if def["flag"] == true {
            let v = match inline.as_deref() {
                None | Some("true") | Some("1") => true,
                Some("false") | Some("0") => false,
                Some(other) => return Err(usage(format!("--{name} não recebe valor ({other})"))),
            };
            target.insert(key(name), Value::Bool(v));
            continue;
        }
        let raw = match inline {
            Some(v) => v,
            None => {
                let v = args.get(i).cloned().ok_or_else(|| usage(format!("--{name} precisa de um valor")))?;
                i += 1;
                v
            }
        };
        let value = convert(def, &raw, &mut stdin_used)?;
        if def["multi"] == true {
            let entry = target.entry(key(name)).or_insert_with(|| Value::Array(vec![]));
            entry.as_array_mut().unwrap().push(value);
        } else {
            target.insert(key(name), value);
        }
    }
    // Posicionais na ordem; o último pode ser `rest` (lista).
    let mut it = pos.into_iter();
    for def in positionals {
        let name = def["name"].as_str().unwrap_or("");
        if def["rest"] == true {
            let rest: Vec<String> = it.by_ref().collect();
            if rest.is_empty() && def["required"] == true {
                return Err(usage(format!("Falta o argumento <{name}>")));
            }
            let values = rest.iter().map(|r| convert(def, r, &mut stdin_used)).collect::<Result<Vec<_>, _>>()?;
            params.insert(key(name), Value::Array(values));
            continue;
        }
        match it.next() {
            Some(raw) => {
                let v = convert(def, &raw, &mut stdin_used)?;
                params.insert(key(name), v);
            }
            None if def["required"] == true => return Err(usage(format!("Falta o argumento <{name}>"))),
            None => {}
        }
    }
    if let Some(extra) = it.next() {
        return Err(usage(format!("Argumento a mais: {extra}")));
    }
    for o in opts {
        let name = o["name"].as_str().unwrap_or("");
        if o["required"] == true && !params.contains_key(&key(name)) {
            return Err(usage(format!("Falta a opção --{name}")));
        }
    }
    Ok((params, local))
}

// ---------- Ajuda ----------

pub fn help_root(spec: &Value) -> String {
    let mut s = String::from(
        "devsuite — CLI do Dev Suite (notas, tarefas, HTTP, bancos de dados, RabbitMQ)\n\n\
         Uso: devsuite <grupo> <comando> [argumentos] [opções]\n\n\
         Comandos gerais:\n  \
         status                 Estado do app (inicia se preciso)\n  \
         start                  Inicia o Dev Suite na bandeja\n  \
         show                   Mostra a janela principal\n  \
         schema                 Catálogo de comandos em JSON (para agentes)\n  \
         skills install         Instala as skills para agentes de IA (--dir, padrão ~/.claude/skills)\n  \
         version                Versão da CLI\n\nGrupos:\n",
    );
    for g in spec["groups"].as_array().into_iter().flatten() {
        s += &format!("  {:<22} {}\n", g["name"].as_str().unwrap_or(""), g["summary"].as_str().unwrap_or(""));
    }
    s += "\nOpções globais:\n";
    for (o, h) in GLOBAL_HELP {
        s += &format!("  {o:<22} {h}\n");
    }
    s += "\nValores marcados como entrada aceitam texto, @arquivo ou - (stdin).\n\
          Códigos de saída: 0 ok, 1 erro, 2 uso, 3 app indisponível, 4 falta --write/--yes/--confirm.\n\
          Ajuda de um grupo: devsuite <grupo> --help\n";
    s
}

pub fn help_group(g: &Value) -> String {
    let name = g["name"].as_str().unwrap_or("");
    let mut s = format!("devsuite {name} — {}\n\nComandos:\n", g["summary"].as_str().unwrap_or(""));
    for c in g["commands"].as_array().into_iter().flatten() {
        s += &format!("  {:<20} {}\n", c["name"].as_str().unwrap_or(""), c["summary"].as_str().unwrap_or(""));
    }
    s += &format!("\nAjuda de um comando: devsuite {name} <comando> --help\n");
    s
}

pub fn help_command(group: &str, c: &Value) -> String {
    let name = c["name"].as_str().unwrap_or("");
    let mut line = format!("devsuite {group} {name}");
    let empty = vec![];
    for a in c["args"].as_array().unwrap_or(&empty) {
        let n = a["name"].as_str().unwrap_or("");
        let n = if a["rest"] == true { format!("{n}...") } else { n.to_string() };
        line += &if a["required"] == true { format!(" <{n}>") } else { format!(" [{n}]") };
    }
    if c["options"].as_array().is_some_and(|o| !o.is_empty()) {
        line += " [opções]";
    }
    let mut s = format!("{}\n\nUso: {line}\n", c["summary"].as_str().unwrap_or(""));
    let args = c["args"].as_array().unwrap_or(&empty);
    if !args.is_empty() {
        s += "\nArgumentos:\n";
        for a in args {
            let extra = if a["input"] == true { " [texto|@arquivo|-]" } else { "" };
            s += &format!("  {:<28} {}{extra}\n", a["name"].as_str().unwrap_or(""), a["help"].as_str().unwrap_or(""));
        }
    }
    let opts = c["options"].as_array().unwrap_or(&empty);
    if !opts.is_empty() {
        s += "\nOpções:\n";
        for o in opts {
            let mut flag = format!("--{}", o["name"].as_str().unwrap_or(""));
            if o["flag"] != true {
                flag += &format!(" {}", o["value"].as_str().unwrap_or("VALOR"));
            }
            let mut notes = Vec::new();
            if o["required"] == true {
                notes.push("obrigatória");
            }
            if o["multi"] == true {
                notes.push("repetível");
            }
            if o["input"] == true {
                notes.push("texto|@arquivo|-");
            }
            let notes = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join(", ")) };
            if flag.chars().count() > 28 {
                s += &format!("  {flag}\n  {:<28} {}{notes}\n", "", o["help"].as_str().unwrap_or(""));
            } else {
                s += &format!("  {flag:<28} {}{notes}\n", o["help"].as_str().unwrap_or(""));
            }
        }
    }
    if let Some(ex) = c["examples"].as_array() {
        s += "\nExemplos:\n";
        for e in ex {
            s += &format!("  {}\n", e.as_str().unwrap_or(""));
        }
    }
    s
}

/// `devsuite schema`: o catálogo com as opções globais, para agentes montarem chamadas.
pub fn schema(spec: &Value) -> Value {
    let globals: Vec<Value> = GLOBAL_HELP.iter().map(|(o, h)| json!({ "option": o, "help": h })).collect();
    json!({
        "program": "devsuite",
        "version": env!("CARGO_PKG_VERSION"),
        "usage": "devsuite <group> <command> [args] [--options]",
        "input_values": "Valores de entrada aceitam texto, @arquivo ou - (stdin)",
        "output": "--json: { ok: true, data } | { ok: false, error: { code, message } }",
        "exit_codes": { "0": "ok", "1": "erro", "2": "uso", "3": "app indisponível", "4": "falta --write/--yes/--confirm" },
        "global_options": globals,
        "groups": spec["groups"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn cmd(group: &str, words: &[&str]) -> (Value, usize) {
        let spec = spec();
        let g = find_group(&spec, group).expect("grupo").clone();
        let (c, n) = find_command(&g, &args(words)).expect("comando");
        (c.clone(), n)
    }

    #[test]
    fn commands_json_is_valid_and_has_groups() {
        let s = spec();
        assert!(s["groups"].as_array().unwrap().len() >= 5);
        assert_eq!(schema(&s)["program"], "devsuite");
    }

    #[test]
    fn two_word_commands_win() {
        let (c, n) = cmd("http", &["request", "create", "--name", "x"]);
        assert_eq!((c["name"].as_str().unwrap(), n), ("request create", 2));
        let (c, n) = cmd("notes", &["folders"]);
        assert_eq!((c["name"].as_str().unwrap(), n), ("folders", 1));
        let (c, _) = cmd("notes", &["folder", "create", "a/b"]);
        assert_eq!(c["name"], "folder create");
    }

    #[test]
    fn parses_flags_multi_numbers_and_inline_values() {
        let (c, _) = cmd("notes", &["list"]);
        let (p, _) = parse(&c, &args(&["--tag", "a", "--tag=b", "--all-vaults", "--limit", "7"])).ok().unwrap();
        assert_eq!(p["tag"], json!(["a", "b"]));
        assert_eq!(p["all_vaults"], json!(true));
        assert_eq!(p["limit"], json!(7));
    }

    #[test]
    fn positionals_inputs_and_errors() {
        let (c, _) = cmd("db", &["query"]);
        let (p, _) = parse(&c, &args(&["Local", "select 1", "--write"])).ok().unwrap();
        assert_eq!((p["conn"].as_str(), p["sql"].as_str(), &p["write"]), (Some("Local"), Some("select 1"), &json!(true)));
        // @arquivo
        let path = std::env::temp_dir().join("devsuite-cli-test.sql");
        std::fs::write(&path, "select 2").unwrap();
        let (p, _) = parse(&c, &args(&["Local", &format!("@{}", path.display())])).ok().unwrap();
        assert_eq!(p["sql"], "select 2");
        let _ = std::fs::remove_file(&path);
        let err = |a: &[&str]| parse(&c, &args(a)).err().map(|f| (f.code, f.message)).unwrap();
        assert!(err(&["Local"]).1.contains("<sql>"));
        assert!(err(&["Local", "x", "--nope"]).1.contains("--nope"));
        assert!(err(&["Local", "x", "extra"]).1.contains("extra"));
        assert_eq!(err(&["Local", "x", "--max-rows", "dez"]).0, "usage");
    }

    #[test]
    fn required_options_and_rest_paths() {
        let (c, _) = cmd("notes", &["move"]);
        assert!(parse(&c, &args(&["Nota"])).err().unwrap().message.contains("--folder"));
        let (c, _) = cmd("notes", &["import"]);
        let (p, _) = parse(&c, &args(&["a.md", "b.md"])).ok().unwrap();
        let files = p["file"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert!(std::path::Path::new(files[0].as_str().unwrap()).is_absolute());
    }

    #[test]
    fn double_dash_ends_options() {
        let (c, _) = cmd("notes", &["search"]);
        let (p, _) = parse(&c, &args(&["--", "--literal"])).ok().unwrap();
        assert_eq!(p["query"], "--literal");
    }
}

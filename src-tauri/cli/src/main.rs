//! `devsuite`: CLI do Dev Suite. Conversa com o app em execução (iniciado na bandeja se
//! preciso) por um named pipe/socket local; ver `src-tauri/src/cli/mod.rs` e `src/js/cli/`.
//! Os comandos vêm de `commands.json` (parser, ajuda e `devsuite schema`).

mod conn;
mod out;
mod spec;

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Map, Value};

use conn::Failure;

/// Skills para agentes de IA, embutidas no binário (`devsuite skills install`).
const SKILLS: &[(&str, &str)] = &[
    ("devsuite", include_str!("../../../skills/devsuite/SKILL.md")),
    ("devsuite-notes", include_str!("../../../skills/devsuite-notes/SKILL.md")),
    ("devsuite-tasks", include_str!("../../../skills/devsuite-tasks/SKILL.md")),
    ("devsuite-http", include_str!("../../../skills/devsuite-http/SKILL.md")),
    ("devsuite-db", include_str!("../../../skills/devsuite-db/SKILL.md")),
    ("devsuite-rabbit", include_str!("../../../skills/devsuite-rabbit/SKILL.md")),
    ("devsuite-redis", include_str!("../../../skills/devsuite-redis/SKILL.md")),
];

struct Global {
    json: bool,
    pretty: bool,
    /// None = o padrão (300 s; sem limite no `rabbit watch` e no `redis monitor/subscribe/memory`).
    timeout: Option<u64>,
    autostart: bool,
    help: bool,
}

fn exit_code(code: &str) -> i32 {
    match code {
        "usage" | "not_found" | "ambiguous" => 2,
        "unavailable" | "auth" | "protocol" => 3,
        "needs_write" | "needs_yes" | "needs_confirm" | "read_only" => 4,
        _ => 1,
    }
}

fn print_json(v: &Value, pretty: bool) {
    let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) }.unwrap_or_default();
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{s}");
}

fn fail(g: &Global, f: Failure) -> ! {
    if g.json {
        print_json(&json!({ "ok": false, "error": { "code": f.code, "message": f.message } }), g.pretty);
    } else {
        eprintln!("erro: {}", f.message);
    }
    std::process::exit(exit_code(&f.code));
}

fn split_globals(args: Vec<String>) -> Result<(Global, Vec<String>), Failure> {
    let mut g = Global { json: !std::io::stdout().is_terminal(), pretty: false, timeout: None, autostart: true, help: false };
    let mut rest = Vec::new();
    let mut it = args.into_iter();
    let mut passthrough = false;
    while let Some(a) = it.next() {
        if passthrough {
            rest.push(a);
            continue;
        }
        match a.as_str() {
            "--" => {
                passthrough = true;
                rest.push(a);
            }
            "--json" => g.json = true,
            "--text" => g.json = false,
            "--pretty" => g.pretty = true,
            "--no-start" => g.autostart = false,
            "-h" | "--help" => g.help = true,
            "--timeout" => {
                let v = it.next().ok_or_else(|| Failure::new("usage", "--timeout precisa de um valor"))?;
                g.timeout = Some(v.parse().map_err(|_| Failure::new("usage", format!("--timeout inválido: {v}")))?);
            }
            _ if a.starts_with("--timeout=") => {
                let v = &a["--timeout=".len()..];
                g.timeout = Some(v.parse().map_err(|_| Failure::new("usage", format!("--timeout inválido: {v}")))?);
            }
            _ => rest.push(a),
        }
    }
    Ok((g, rest))
}

fn arm_timeout(g: &Global, default: u64) {
    let secs = g.timeout.unwrap_or(default);
    if secs == 0 {
        return;
    }
    let json = g.json;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(secs));
        let msg = format!("Tempo esgotado ({secs} s); use --timeout para aumentar");
        if json {
            println!("{}", json!({ "ok": false, "error": { "code": "timeout", "message": msg } }));
        } else {
            eprintln!("erro: {msg}");
        }
        std::process::exit(1);
    });
}

fn emit(g: &Global, data: &Value) {
    if g.json {
        print_json(&json!({ "ok": true, "data": data }), g.pretty);
    } else {
        print!("{}", out::human(data));
    }
}

fn skills_install(g: &Global, args: &[String]) {
    let mut dir: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                i += 1;
                dir = args.get(i).map(PathBuf::from);
            }
            a if a.starts_with("--dir=") => dir = Some(PathBuf::from(&a[6..])),
            other => fail(g, Failure::new("usage", format!("Argumento inesperado: {other}"))),
        }
        i += 1;
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    let Some(dir) = dir.or_else(|| home.map(|h| h.join(".claude").join("skills"))) else {
        fail(g, Failure::new("usage", "Informe --dir"));
    };
    let mut written = Vec::new();
    for (name, text) in SKILLS {
        let target = dir.join(name);
        if let Err(e) = std::fs::create_dir_all(&target).and_then(|_| std::fs::write(target.join("SKILL.md"), text)) {
            fail(g, Failure::new("failed", format!("Falha ao gravar {}: {e}", target.display())));
        }
        written.push(target.to_string_lossy().into_owned());
    }
    emit(g, &json!({ "installed": written }));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (g, args) = match split_globals(args) {
        Ok(v) => v,
        Err(f) => {
            eprintln!("erro: {}", f.message);
            std::process::exit(2);
        }
    };
    let spec = spec::spec();
    let first = args.first().map(String::as_str).unwrap_or("");

    match first {
        "" | "help" => {
            print!("{}", spec::help_root(&spec));
            return;
        }
        "version" | "--version" | "-V" => {
            emit(&g, &json!({ "cli": env!("CARGO_PKG_VERSION") }));
            return;
        }
        "schema" => {
            // O catálogo é JSON por natureza.
            print_json(&spec::schema(&spec), g.pretty || std::io::stdout().is_terminal());
            return;
        }
        "skills" => {
            if args.get(1).map(String::as_str) != Some("install") || g.help {
                println!("Uso: devsuite skills install [--dir PASTA]   (padrão: ~/.claude/skills)");
                return;
            }
            skills_install(&g, &args[2..]);
            return;
        }
        "status" | "start" | "show" => {
            if g.help {
                print!("{}", spec::help_root(&spec));
                return;
            }
            arm_timeout(&g, 300);
            let mut c = conn::connect(first != "status" || g.autostart).unwrap_or_else(|f| fail(&g, f));
            let method = match first {
                "show" => "sys.show",
                "start" => "sys.wait_ready",
                _ => "sys.status",
            };
            let mut data = c.call(method, Value::Null, |_| {}).unwrap_or_else(|f| fail(&g, f));
            if first == "show" {
                data = json!({ "shown": true });
            }
            data["cli"] = json!(env!("CARGO_PKG_VERSION"));
            emit(&g, &data);
            return;
        }
        _ => {}
    }

    let Some(group) = spec::find_group(&spec, first) else {
        fail(&g, Failure::new("usage", format!("Comando desconhecido: {first} (veja devsuite --help)")));
    };
    let gname = group["name"].as_str().unwrap_or("");
    let words = &args[1..];
    let Some((cmd, used)) = spec::find_command(group, words) else {
        if g.help || words.is_empty() {
            print!("{}", spec::help_group(group));
            return;
        }
        fail(&g, Failure::new("usage", format!("Comando desconhecido: {gname} {} (veja devsuite {gname} --help)", words[0])));
    };
    let cname = cmd["name"].as_str().unwrap_or("");
    if g.help {
        print!("{}", spec::help_command(gname, cmd));
        return;
    }
    let (mut params, _local): (Map<String, Value>, Map<String, Value>) = spec::parse(cmd, &words[used..]).unwrap_or_else(|f| fail(&g, f));
    // Pasta atual: caminhos relativos dentro de conteúdos (imagens do Markdown importado).
    if let Ok(cwd) = std::env::current_dir() {
        params.insert("_cwd".into(), json!(cwd.to_string_lossy()));
    }

    let format = params.get("format").and_then(Value::as_str).map(str::to_string);
    if format.is_none() && !g.json && gname == "db" && cname == "query" {
        params.insert("format".into(), json!("table"));
    }
    // `rabbit watch` roda até Ctrl+C (ou --cycles).
    arm_timeout(&g, if (gname == "rabbit" && cname == "watch") || (gname == "redis" && matches!(cname, "monitor" | "subscribe" | "memory")) { 0 } else { 300 });
    let mut c = conn::connect(g.autostart).unwrap_or_else(|f| fail(&g, f));
    let method = format!("{gname}.{}", cname.replace(' ', "_").replace('-', "_"));
    let json_mode = g.json;
    let data = c
        .call(&method, Value::Object(params), |ev| {
            // Eventos (watch, progresso): uma linha por evento.
            if json_mode {
                print_json(&json!({ "event": ev }), false);
            } else if let Some(line) = ev["line"].as_str() {
                println!("{line}");
            } else {
                println!("{ev}");
            }
            let _ = std::io::stdout().flush();
        })
        .unwrap_or_else(|f| fail(&g, f));

    if method == "db.query" {
        let format = format.as_deref().unwrap_or(if g.json { "json" } else { "table" });
        if format != "json" {
            print!("{}", out::query_results(&data, format));
            return;
        }
    }
    // Texto puro (ex.: --body-only, db ddl) sai cru no terminal; com --json vai no envelope.
    emit(&g, &data);
}

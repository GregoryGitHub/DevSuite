//! Saída: JSON (agentes) ou texto/tabelas (terminal).

use serde_json::{Map, Value};

const CELL_MAX: usize = 60;

fn scalar(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => if *b { "sim".into() } else { "não".into() },
        other => other.to_string(),
    }
}

fn cell(v: &Value) -> String {
    let s = scalar(v).replace(['\r', '\n', '\t'], " ");
    if s.chars().count() > CELL_MAX {
        let mut t: String = s.chars().take(CELL_MAX - 1).collect();
        t.push('…');
        t
    } else {
        s
    }
}

fn width(s: &str) -> usize {
    s.chars().count()
}

/// Tabela de texto alinhada.
pub fn table(columns: &[String], rows: &[Vec<String>]) -> String {
    let mut w: Vec<usize> = columns.iter().map(|c| width(c)).collect();
    for r in rows {
        for (i, c) in r.iter().enumerate() {
            if i < w.len() {
                w[i] = w[i].max(width(c));
            }
        }
    }
    let line = |cells: &[String]| {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{c}{}", " ".repeat(w[i].saturating_sub(width(c)))))
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    let mut s = line(columns) + "\n";
    s += &(w.iter().map(|n| "─".repeat(*n)).collect::<Vec<_>>().join("  ") + "\n");
    for r in rows {
        s += &(line(r) + "\n");
    }
    s
}

fn objects_table(items: &[Value]) -> String {
    let mut cols: Vec<String> = Vec::new();
    for it in items {
        if let Value::Object(m) = it {
            for (k, v) in m {
                // Campos aninhados grandes não cabem numa tabela.
                if matches!(v, Value::Object(_)) || matches!(v, Value::Array(a) if a.iter().any(|x| x.is_object())) {
                    continue;
                }
                if !cols.contains(k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    let rows: Vec<Vec<String>> = items
        .iter()
        .map(|it| {
            cols.iter()
                .map(|c| match &it[c.as_str()] {
                    Value::Array(a) => cell(&Value::String(a.iter().map(scalar).collect::<Vec<_>>().join(", "))),
                    v => cell(v),
                })
                .collect()
        })
        .collect();
    table(&cols, &rows)
}

fn is_table(v: &Value) -> bool {
    matches!(v, Value::Array(a) if !a.is_empty() && a.iter().all(Value::is_object))
}

fn render_object(m: &Map<String, Value>, indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    let kw = m.keys().filter(|k| !matches!(m[*k], Value::Object(_) | Value::Array(_))).map(|k| width(k)).max().unwrap_or(0);
    for (k, v) in m {
        match v {
            Value::Object(_) | Value::Array(_) => {}
            Value::String(s) if s.contains('\n') => {
                *out += &format!("{pad}{k}:\n");
                for l in s.lines() {
                    *out += &format!("{pad}  {l}\n");
                }
            }
            _ => *out += &format!("{pad}{k}{}  {}\n", " ".repeat(kw - width(k)), scalar(v)),
        }
    }
    for (k, v) in m {
        match v {
            Value::Object(o) if !o.is_empty() => {
                *out += &format!("\n{pad}{k}:\n");
                render_object(o, indent + 2, out);
            }
            Value::Array(a) if is_table(v) => {
                *out += &format!("\n{pad}{k} ({}):\n", a.len());
                for l in objects_table(a).lines() {
                    *out += &format!("{pad}  {l}\n");
                }
            }
            Value::Array(a) if !a.is_empty() => {
                *out += &format!("{pad}{k}: {}\n", a.iter().map(scalar).collect::<Vec<_>>().join(", "));
            }
            _ => {}
        }
    }
}

/// Texto para humanos de um resultado qualquer.
pub fn human(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => {
            if s.ends_with('\n') { s.clone() } else { format!("{s}\n") }
        }
        Value::Array(a) if a.is_empty() => "(nenhum)\n".into(),
        Value::Array(a) if is_table(v) => objects_table(a),
        Value::Array(a) => a.iter().map(|x| scalar(x) + "\n").collect(),
        Value::Object(m) => {
            let mut s = String::new();
            render_object(m, 0, &mut s);
            s
        }
        other => format!("{}\n", scalar(other)),
    }
}

// ---------- db query ----------

fn csv_field(s: &str, sep: char) -> String {
    if s.contains(sep) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Result sets de `db query` ({ results: [{ columns, rows }], ... }) no formato pedido.
pub fn query_results(data: &Value, format: &str) -> String {
    let mut s = String::new();
    let results = data["results"].as_array().cloned().unwrap_or_default();
    for (n, r) in results.iter().enumerate() {
        let cols: Vec<String> = r["columns"].as_array().into_iter().flatten().map(|c| c["name"].as_str().unwrap_or("").to_string()).collect();
        let rows: Vec<Vec<Value>> = r["rows"].as_array().into_iter().flatten().map(|row| row.as_array().cloned().unwrap_or_default()).collect();
        if results.len() > 1 && format != "csv" && format != "tsv" {
            s += &format!("-- result set {}\n", n + 1);
        } else if n > 0 {
            s += "\n";
        }
        match format {
            "csv" | "tsv" => {
                let sep = if format == "csv" { ',' } else { '\t' };
                s += &(cols.iter().map(|c| csv_field(c, sep)).collect::<Vec<_>>().join(&sep.to_string()) + "\n");
                for row in &rows {
                    s += &(row.iter().map(|v| csv_field(&scalar(v), sep)).collect::<Vec<_>>().join(&sep.to_string()) + "\n");
                }
            }
            "md" => {
                let esc = |t: String| t.replace('|', "\\|").replace(['\n', '\r'], " ");
                s += &format!("| {} |\n", cols.iter().map(|c| esc(c.clone())).collect::<Vec<_>>().join(" | "));
                s += &format!("|{}\n", cols.iter().map(|_| " --- |").collect::<String>());
                for row in &rows {
                    s += &format!("| {} |\n", row.iter().map(|v| esc(scalar(v))).collect::<Vec<_>>().join(" | "));
                }
            }
            _ => {
                let text_rows: Vec<Vec<String>> = rows.iter().map(|row| row.iter().map(cell).collect()).collect();
                s += &table(&cols, &text_rows);
            }
        }
        if format != "csv" && format != "tsv" {
            let truncated = if r["truncated"] == true { " (cortado em --max-rows)" } else { "" };
            s += &format!("({} linha(s){truncated})\n", r["row_count"].as_u64().unwrap_or(rows.len() as u64));
        }
    }
    if format != "csv" && format != "tsv" {
        for m in data["messages"].as_array().into_iter().flatten() {
            s += &format!("{}\n", scalar(m));
        }
        if let Some(ms) = data["elapsed_ms"].as_u64() {
            s += &format!("[{ms} ms]\n");
        }
    }
    s
}

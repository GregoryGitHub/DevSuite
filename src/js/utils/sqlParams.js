// Parâmetros das consultas (console e consultas salvas): `:nome` e `{{nome}}` (sem DOM).
// - `:nome` só vale no SQL e fora de strings, comentários e identificadores; `::` (casts,
//   `SCHEMA::`) e `:` no início da linha (comandos do SQLCMD, ex. `:setvar`) não contam.
// - `{{nome}}` vale nas duas linguagens e em qualquer lugar: dentro de uma string entra só o
//   texto escapado (`LIKE '%{{q}}%'`); fora dela, o literal do tipo escolhido.

export const PARAM_TYPES = [
  ["auto", "Automático"],
  ["text", "Texto"],
  ["number", "Número"],
  ["date", "Data/hora"],
  ["bool", "Booleano"],
  ["null", "NULL"],
  ["raw", "SQL cru"],
];

const NAME_RE = /[A-Za-z_][\w]*/y;
const BRACE_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/y;
const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export class ParamError extends Error {}

/**
 * Percorre o texto e chama onParam({ name, start, end, quote }) para cada ocorrência.
 * `quote` = caractere da string/identificador onde o parâmetro está ("" = código).
 */
function scan(text, lang, onParam) {
  const sql = lang !== "mongo";
  const n = text.length;
  let i = 0;
  let lineStart = true; // só espaços desde o início da linha
  const brace = (pos, quote) => {
    BRACE_RE.lastIndex = pos;
    const m = BRACE_RE.exec(text);
    if (!m) return pos;
    onParam({ name: m[1], start: pos, end: pos + m[0].length, quote });
    return pos + m[0].length;
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    const atLineStart = lineStart;
    lineStart = false;
    // Comentários
    if ((sql && ch === "-" && next === "-") || (!sql && ch === "/" && next === "/")) {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // Strings e identificadores delimitados
    const close = ch === "[" && sql ? "]" : ch === "'" || ch === '"' || (ch === "`" && !sql) ? ch : "";
    if (close) {
      i++;
      while (i < n) {
        if (text[i] === "{" && text[i + 1] === "{") {
          const after = brace(i, close);
          if (after !== i) {
            i = after;
            continue;
          }
        }
        if (!sql && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === close) {
          // SQL: aspas/colchete dobrados são o próprio caractere.
          if (sql && text[i + 1] === close) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{" && next === "{") {
      const after = brace(i, "");
      if (after !== i) {
        i = after;
        continue;
      }
    }
    if (sql && ch === ":") {
      if (next === ":") {
        i += 2;
        continue;
      }
      const prev = text[i - 1];
      if (!atLineStart && !(prev && /[\w:]/.test(prev))) {
        NAME_RE.lastIndex = i + 1;
        const m = NAME_RE.exec(text);
        if (m) {
          onParam({ name: m[0], start: i, end: i + 1 + m[0].length, quote: "" });
          i += 1 + m[0].length;
          continue;
        }
      }
    }
    i++;
  }
}

/** Nomes dos parâmetros, na ordem em que aparecem (sem repetir). */
export function findParams(text, lang = "sql") {
  const names = [];
  scan(String(text || ""), lang, ({ name }) => names.includes(name) || names.push(name));
  return names;
}

/** Tipo efetivo de um valor "automático". */
export function inferType(value) {
  const s = String(value ?? "").trim();
  if (NUMBER_RE.test(s)) return "number";
  if (/^(true|false)$/i.test(s)) return "bool";
  if (/^null$/i.test(s)) return "null";
  return "text";
}

function sqlLiteral(type, value, dialect) {
  const s = String(value ?? "");
  switch (type) {
    case "null":
      return "NULL";
    case "raw":
      return s;
    case "number":
      if (!NUMBER_RE.test(s.trim())) throw new ParamError(`"${s}" não é um número`);
      return s.trim();
    case "bool":
      if (/^(1|true|sim|s|yes)$/i.test(s.trim())) return "1";
      if (/^(0|false|não|nao|n|no)$/i.test(s.trim())) return "0";
      throw new ParamError(`"${s}" não é um booleano (true/false)`);
    case "date":
      return dialect.literal(s.trim(), "datetime");
    default:
      return dialect.string(s);
  }
}

function mongoLiteral(type, value) {
  const s = String(value ?? "");
  switch (type) {
    case "null":
      return "null";
    case "raw":
      return s;
    case "number":
      if (!NUMBER_RE.test(s.trim())) throw new ParamError(`"${s}" não é um número`);
      return s.trim();
    case "bool":
      if (/^(1|true|sim|s|yes)$/i.test(s.trim())) return "true";
      if (/^(0|false|não|nao|n|no)$/i.test(s.trim())) return "false";
      throw new ParamError(`"${s}" não é um booleano (true/false)`);
    case "date":
      return `ISODate(${JSON.stringify(s.trim())})`;
    default:
      return JSON.stringify(s);
  }
}

/** Texto do valor dentro de uma string/identificador já aberto (sem as aspas). */
function inQuote(value, quote, lang) {
  const s = String(value ?? "");
  if (lang !== "mongo") return s.split(quote).join(quote + quote);
  return s.replace(/\\/g, "\\\\").split(quote).join(`\\${quote}`).replace(/\n/g, "\\n");
}

/**
 * Substitui os parâmetros. values: { nome: { type, value } }. Falta de valor = erro.
 * `dialect` (sqlDialect.js) monta os literais do SQL; no MongoDB os literais são do mongosh.
 */
export function bindParams(text, values, { lang = "sql", dialect } = {}) {
  const src = String(text || "");
  let out = "";
  let pos = 0;
  scan(src, lang, ({ name, start, end, quote }) => {
    const v = values?.[name];
    if (!v) throw new ParamError(`Parâmetro sem valor: ${name}`);
    const type = !v.type || v.type === "auto" ? inferType(v.value) : v.type;
    let rep;
    if (quote) rep = type === "null" ? "" : inQuote(v.value, quote, lang);
    else rep = lang === "mongo" ? mongoLiteral(type, v.value) : sqlLiteral(type, v.value, dialect);
    out += src.slice(pos, start) + rep;
    pos = end;
  });
  return out + src.slice(pos);
}

// Utilitários da CLI sem DOM nem Tauri (testados em tests/cli.test.mjs): erros com código,
// busca de itens por id/nome, pares chave=valor e as regras de leitura/escrita.

import { getTodayStr, addDays } from "../utils/date.js";
import { newAuth } from "../utils/httpModel.js";
import { parseApiDate } from "../utils/rabbitModel.js";
import { isReadOnlyQuery, isWriteStatement, splitStatements, firstKeyword } from "../utils/sqlSplit.js";

/** Erro com código para a CLI (usage, not_found, ambiguous, needs_write, needs_yes, needs_confirm, read_only...). */
export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/**
 * Acha um item por id ou nome: id exato > nome igual (sem acento/maiúsculas) > nome que começa
 * com > contém. Mais de um candidato no melhor nível = erro "ambiguous" listando-os.
 */
export function pick(items, wanted, { what = "item", id = (x) => x.id, name = (x) => x.name, label = null } = {}) {
  const w = String(wanted ?? "").trim();
  if (!w) throw new CliError("usage", `Informe ${what}`);
  const byId = items.filter((x) => String(id(x)) === w);
  if (byId.length === 1) return byId[0];
  const f = fold(w);
  const tiers = [(n) => n === f, (n) => n.startsWith(f), (n) => n.includes(f)];
  for (const test of tiers) {
    const hits = items.filter((x) => test(fold(name(x))));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const list = hits.slice(0, 10).map((x) => `${label ? label(x) : name(x)} (${id(x)})`).join("; ");
      throw new CliError("ambiguous", `Mais de um ${what} para "${w}": ${list}${hits.length > 10 ? "…" : ""}. Use o id.`);
    }
  }
  throw new CliError("not_found", `${what[0].toUpperCase()}${what.slice(1)} não encontrado: ${w}`);
}

/** "chave=valor" (ou "Chave: valor") -> [chave, valor]. */
export function splitPair(raw, seps = ["="]) {
  const s = String(raw);
  let best = -1;
  for (const sep of seps) {
    const i = s.indexOf(sep);
    if (i > 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) throw new CliError("usage", `Esperado chave${seps[0]}valor: ${s}`);
  const sep = seps.find((x) => s.startsWith(x, best));
  return [s.slice(0, best).trim(), s.slice(best + sep.length).trim()];
}

export const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export function requireFlag(params, flag, message) {
  if (!params[flag]) throw new CliError(flag === "yes" ? "needs_yes" : "needs_write", message);
}

export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// ---------- Tarefas ----------

/** "2026-10-21", "hoje", "amanha", "+3" (dias), "none" -> data ou null. */
export function parseDue(raw) {
  const v = fold(raw);
  if (["none", "nenhum", "sem", ""].includes(v)) return null;
  const today = getTodayStr();
  if (v === "hoje" || v === "today") return today;
  if (v === "amanha" || v === "tomorrow") return addDays(today, 1);
  if (/^\+\d+$/.test(v)) return addDays(today, Number(v.slice(1)));
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  throw new CliError("usage", `Prazo inválido: ${raw} (use AAAA-MM-DD, DD/MM/AAAA, hoje, amanha ou +N)`);
}

// ---------- HTTP ----------

/** "bearer:TOKEN" | "basic:USUÁRIO:SENHA" | "apikey:NOME:VALOR[:query]" | "inherit" | "none". */
export function parseAuth(raw) {
  const s = String(raw);
  const i = s.indexOf(":");
  const type = fold(i < 0 ? s : s.slice(0, i));
  const rest = i < 0 ? "" : s.slice(i + 1);
  const auth = newAuth(type === "herdar" ? "inherit" : type);
  if (type === "inherit" || type === "herdar") return newAuth("inherit");
  if (type === "none" || type === "nenhuma") return newAuth("none");
  if (type === "bearer") auth.bearer.token = rest;
  else if (type === "basic") {
    const j = rest.indexOf(":");
    auth.basic.username = j < 0 ? rest : rest.slice(0, j);
    auth.basic.password = j < 0 ? "" : rest.slice(j + 1);
  } else if (type === "apikey") {
    const parts = rest.split(":");
    const where = parts.length > 2 && ["query", "header"].includes(parts[parts.length - 1]) ? parts.pop() : "header";
    auth.apikey.key = parts.shift() || "";
    auth.apikey.value = parts.join(":");
    auth.apikey.in = where;
  } else throw new CliError("usage", `--auth inválido: ${s} (inherit, none, bearer:TOKEN, basic:USUÁRIO:SENHA, apikey:NOME:VALOR[:query])`);
  return auth;
}

// ---------- Banco ----------

const SESSION_WORDS = new Set(["DECLARE", "SET", "PRINT", "USE"]);

/** Lote SQL sem efeito em dados/estrutura: SELECT/WITH (sem INTO) e DECLARE/SET/PRINT de sessão. */
export function sqlReadOnly(sql) {
  if (isReadOnlyQuery(sql)) return true;
  if (isWriteStatement(sql)) return false;
  const stmts = splitStatements(sql).map((s) => (typeof s === "string" ? s : s.sql ?? sql.slice(s.start, s.end)));
  if (!stmts.length) return true;
  return stmts.every((st) => isReadOnlyQuery(st) || (SESSION_WORDS.has(firstKeyword(st)) && !/\bINTO\b/i.test(st)));
}

// ---------- RabbitMQ ----------

/** "10m" / "2h" / "1d" / data ISO -> ms. */
export function sinceMs(raw) {
  const m = /^(\d+)\s*([smhd])$/i.exec(String(raw).trim());
  if (m) return Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2].toLowerCase()];
  const t = parseApiDate(raw) || Date.parse(raw);
  if (!t) throw new CliError("usage", `--since inválido: ${raw}`);
  return t;
}

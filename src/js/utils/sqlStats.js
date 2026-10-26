// SET STATISTICS IO/TIME do SQL Server: mensagens INFO → tabelas legíveis (sem DOM).
// O texto vem no idioma do login, então a leitura é pelo número da mensagem e pela ordem
// dos números, nunca pelos rótulos (as traduções nem sempre batem com o inglês).

/** 3615 = leituras por tabela; 3612 = tempo de execução; 3613 = tempo de compilação. */
export const MSG_IO = 3615;
export const MSG_EXEC_TIME = 3612;
export const MSG_COMPILE_TIME = 3613;
export const isStatsMessage = (m) => m && (m.number === MSG_IO || m.number === MSG_EXEC_TIME || m.number === MSG_COMPILE_TIME);

// Campos da 3615 na ordem em que aparecem (2019+ com "page server"; versões antigas sem).
const IO_FIELDS_11 = ["scans", "logical", "physical", "pageServer", "readAhead", "pageServerReadAhead", "lobLogical", "lobPhysical", "lobPageServer", "lobReadAhead", "lobPageServerReadAhead"];
const IO_FIELDS_7 = ["scans", "logical", "physical", "readAhead", "lobLogical", "lobPhysical", "lobReadAhead"];
export const IO_KEYS = ["scans", "logical", "physical", "readAhead", "pageServer", "pageServerReadAhead", "lobLogical", "lobPhysical", "lobReadAhead", "lobPageServer", "lobPageServerReadAhead"];

const numbersIn = (text) => (text.match(/-?\d+/g) || []).map(Number);

/** "Table 'x'. Scan count 1, logical reads 3, ..." → `{ table, scans, logical, ... }`. */
export function parseIoMessage(text) {
  const m = /^\s*\S+\s+['"‘’“”«]([^'"‘’“”»]+)['"‘’“”»]/.exec(text);
  const table = m ? m[1] : "";
  const rest = m ? text.slice(m.index + m[0].length) : text;
  const values = numbersIn(rest);
  const fields = values.length >= 11 ? IO_FIELDS_11 : values.length >= 7 ? IO_FIELDS_7 : IO_FIELDS_7.slice(0, values.length);
  const row = { table };
  for (const k of IO_KEYS) row[k] = 0;
  fields.forEach((k, i) => (row[k] = values[i] ?? 0));
  return row;
}

/** "... CPU time = 20 ms, elapsed time = 21 ms." → `{ cpuMs, elapsedMs }`. */
export function parseTimeMessage(text) {
  const n = numbersIn(text);
  return { cpuMs: n[n.length - 2] ?? 0, elapsedMs: n[n.length - 1] ?? 0 };
}

/**
 * Mensagens `{ number, text }` de uma execução → leituras por tabela (somadas), tempos
 * e totais. `statements` agrupa por comando: uma 3612 encerra o comando atual.
 */
export function parseStatsMessages(messages) {
  const io = [];
  const time = [];
  const statements = [];
  let cur = { io: [], compile: null, exec: null };
  const byTable = new Map();
  for (const m of messages || []) {
    if (m.number === MSG_IO) {
      const r = parseIoMessage(m.text);
      cur.io.push(r);
      io.push(r);
      const acc = byTable.get(r.table) || { table: r.table, ...Object.fromEntries(IO_KEYS.map((k) => [k, 0])) };
      for (const k of IO_KEYS) acc[k] += r[k];
      byTable.set(r.table, acc);
    } else if (m.number === MSG_COMPILE_TIME) {
      const t = { phase: "compile", ...parseTimeMessage(m.text) };
      time.push(t);
      cur.compile = t;
    } else if (m.number === MSG_EXEC_TIME) {
      const t = { phase: "exec", ...parseTimeMessage(m.text) };
      time.push(t);
      cur.exec = t;
      if (cur.io.length || cur.compile) statements.push(cur);
      cur = { io: [], compile: null, exec: null };
    }
  }
  if (cur.io.length) statements.push(cur);
  const tables = [...byTable.values()].sort((a, b) => b.logical - a.logical);
  const sum = (list, k) => list.reduce((t, x) => t + x[k], 0);
  const compile = time.filter((t) => t.phase === "compile");
  const exec = time.filter((t) => t.phase === "exec");
  return {
    io,
    time,
    tables,
    statements,
    totals: {
      logical: sum(tables, "logical"),
      physical: sum(tables, "physical"),
      readAhead: sum(tables, "readAhead"),
      lobLogical: sum(tables, "lobLogical"),
      scans: sum(tables, "scans"),
      compileCpuMs: sum(compile, "cpuMs"),
      compileElapsedMs: sum(compile, "elapsedMs"),
      execCpuMs: sum(exec, "cpuMs"),
      execElapsedMs: sum(exec, "elapsedMs"),
    },
  };
}

/** Páginas de 8 KB → texto curto ("27,5 MB"). */
export function pagesText(pages) {
  const bytes = pages * 8192;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} KB`;
}

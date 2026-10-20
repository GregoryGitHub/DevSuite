// Documentos MongoDB no grid: Extended JSON ↔ células, formatação no estilo do mongosh e as
// operações (updateOne/insertOne/deleteOne por _id) geradas a partir das edições.
//
// As células guardam valores simples (string/number/bool/null) para o grid ordenar, filtrar e
// copiar; o tipo BSON de cada célula vem do documento original (ou do tipo dominante da coluna)
// e é usado para converter de volta sem trocar o tipo (long continua long, ObjectId continua ObjectId).

import { parseShellValue, uuidToBinary } from "./mongoShell.js";
import { DEFAULT, GENERATED, isMarker } from "./sqlDialect.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Tipo BSON de um valor em Extended JSON (relaxado ou canônico). */
export function bsonType(v) {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "double";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  const keys = Object.keys(v);
  if (keys.length === 1 || (keys.length === 2 && "$scope" in v)) {
    switch (keys[0]) {
      case "$oid":
        return "objectId";
      case "$date":
        return "date";
      case "$numberLong":
        return "long";
      case "$numberInt":
        return "int";
      case "$numberDouble":
        return "double";
      case "$numberDecimal":
        return "decimal";
      case "$binary":
        return v.$binary?.subType === "04" ? "uuid" : "binData";
      case "$regularExpression":
        return "regex";
      case "$timestamp":
        return "timestamp";
      case "$minKey":
        return "minKey";
      case "$maxKey":
        return "maxKey";
      case "$code":
        return "javascript";
      case "$symbol":
        return "symbol";
    }
  }
  return "object";
}

/** Classe de coluna do grid para um tipo BSON. */
export function kindOfType(t) {
  switch (t) {
    case "objectId":
      return "oid";
    case "date":
      return "datetime";
    case "int":
    case "long":
      return "int";
    case "double":
      return "num";
    case "decimal":
      return "dec";
    case "bool":
      return "bool";
    case "string":
      return "str";
    case "object":
    case "array":
      return "json";
    case "binData":
    case "uuid":
      return "bin";
    default:
      return "other";
  }
}

function b64ToHex(b64) {
  const s = atob(b64);
  let h = "";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(2, "0");
  return h;
}

export function uuidString(b64) {
  const h = b64ToHex(b64);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function dateText(d) {
  if (typeof d === "string") return d;
  if (isObj(d) && d.$numberLong !== undefined) {
    const ms = Number(d.$numberLong);
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? `Date(${d.$numberLong})` : dt.toISOString();
  }
  return String(d);
}

/** Valor exibido na célula (simples, para ordenar/filtrar/copiar). `undefined` = campo ausente. */
export function cellOf(v) {
  switch (bsonType(v)) {
    case "missing":
      return undefined;
    case "null":
    case "bool":
    case "string":
      return v;
    case "int":
      return typeof v === "number" ? v : Number(v.$numberInt);
    case "double":
      // double inteiro chega como {$numberDouble: "5.0"}: mostra "5.0" para não parecer int.
      return typeof v === "number" ? v : v.$numberDouble;
    case "objectId":
      return v.$oid;
    case "date":
      return dateText(v.$date);
    case "long": {
      const n = Number(v.$numberLong);
      return Number.isSafeInteger(n) ? n : v.$numberLong;
    }
    case "decimal":
      return v.$numberDecimal;
    case "uuid":
      return uuidString(v.$binary.base64);
    case "binData":
      return `BinData(${parseInt(v.$binary.subType, 16)}, '${v.$binary.base64.length > 60 ? v.$binary.base64.slice(0, 60) + "…" : v.$binary.base64}')`;
    default:
      return toShell(v);
  }
}

// ---------- Formatação no estilo do mongosh ----------

const IDENT = /^[A-Za-z_$][\w$]*$/;
const quote = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;

/** Extended JSON → texto do mongosh. indent = "" (uma linha) ou "  " (identado). */
export function toShell(v, indent = "", level = 0) {
  const t = bsonType(v);
  const pad = indent ? "\n" + indent.repeat(level + 1) : " ";
  const close = indent ? "\n" + indent.repeat(level) : " ";
  switch (t) {
    case "missing":
      return "undefined";
    case "null":
      return "null";
    case "bool":
    case "int":
      return String(v);
    case "double":
      return typeof v === "number" ? String(v) : /^-?\d+$/.test(v.$numberDouble) ? `${v.$numberDouble}.0` : /^[-\d.e+]+$/i.test(v.$numberDouble) ? v.$numberDouble : `Double(${quote(v.$numberDouble)})`;
    case "string":
      return quote(v);
    case "objectId":
      return `ObjectId(${quote(v.$oid)})`;
    case "date":
      return `ISODate(${quote(dateText(v.$date))})`;
    case "long":
      return `NumberLong(${quote(v.$numberLong)})`;
    case "decimal":
      return `NumberDecimal(${quote(v.$numberDecimal)})`;
    case "uuid":
      return `UUID(${quote(uuidString(v.$binary.base64))})`;
    case "binData":
      return `BinData(${parseInt(v.$binary.subType, 16)}, ${quote(v.$binary.base64)})`;
    case "regex":
      return `/${v.$regularExpression.pattern.replace(/\//g, "\\/")}/${v.$regularExpression.options}`;
    case "timestamp":
      return `Timestamp({ t: ${v.$timestamp.t}, i: ${v.$timestamp.i} })`;
    case "minKey":
      return "MinKey()";
    case "maxKey":
      return "MaxKey()";
    case "array":
      if (!v.length) return "[]";
      return `[${pad}${v.map((x) => toShell(x, indent, level + 1)).join(`,${pad}`)}${close}]`;
    case "object": {
      const keys = Object.keys(v);
      if (!keys.length) return "{}";
      return `{${pad}${keys.map((k) => `${IDENT.test(k) ? k : quote(k)}: ${toShell(v[k], indent, level + 1)}`).join(`,${pad}`)}${close}}`;
    }
    default:
      return JSON.stringify(v);
  }
}

// ---------- Texto digitado → Extended JSON ----------

const SHELL_LITERAL = /^\s*([[{'"`/]|-?\d|ObjectId|ISODate|new\s|NumberLong|NumberDecimal|NumberInt|UUID|BinData|Timestamp|Date\(|true\b|false\b|null\b)/;

/**
 * Converte o texto editado numa célula para Extended JSON, mantendo o tipo `type`
 * (tipo BSON original da célula ou o dominante da coluna; vazio/"mixed" = deduz do texto).
 */
export function ejsonFromInput(text, type) {
  const s = String(text);
  const t = s.trim();
  const shell = () => parseShellValue(t);
  switch (type) {
    case "string":
      return s;
    case "int": {
      if (!/^[+-]?\d+$/.test(t)) throw new Error(`"${s}" não é um inteiro`);
      const n = Number(t);
      return Math.abs(n) <= 2147483647 ? n : { $numberLong: t.replace(/^\+/, "") };
    }
    case "long":
      if (!/^[+-]?\d+$/.test(t)) throw new Error(`"${s}" não é um inteiro`);
      return { $numberLong: t.replace(/^\+/, "") };
    case "double":
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new Error(`"${s}" não é um número`);
      return { $numberDouble: String(Number(t)) };
    case "decimal":
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new Error(`"${s}" não é um número decimal`);
      return { $numberDecimal: t };
    case "bool":
      if (/^(true|1|sim|s)$/i.test(t)) return true;
      if (/^(false|0|não|nao|n)$/i.test(t)) return false;
      throw new Error(`"${s}" não é booleano (true/false)`);
    case "objectId": {
      const m = /^(?:ObjectId\(\s*['"]?)?([0-9a-fA-F]{24})(?:['"]?\s*\))?$/.exec(t);
      if (!m) throw new Error(`"${s}" não é um ObjectId (24 caracteres hexadecimais)`);
      return { $oid: m[1].toLowerCase() };
    }
    case "date": {
      if (/^(ISODate|new Date|Date)\(/.test(t)) return shell();
      const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(t) ? t.replace(" ", "T") : t);
      if (Number.isNaN(d.getTime())) throw new Error(`"${s}" não é uma data (ex.: 2026-01-31T10:00:00Z)`);
      return { $date: d.toISOString() };
    }
    case "uuid":
      return /^UUID\(/.test(t) ? shell() : uuidToBinary(t);
    case "object":
    case "array":
    case "binData":
    case "regex":
    case "timestamp":
      return shell();
    default:
      // Sem tipo conhecido: literal do shell se parecer um, senão texto.
      if (SHELL_LITERAL.test(t)) {
        try {
          return shell();
        } catch {
          /* texto comum */
        }
      }
      return s;
  }
}

// ---------- Documentos → linhas do grid ----------

/**
 * Acumula colunas (campos de topo, na ordem em que aparecem) e converte documentos em linhas.
 * state: { columns: [], index: Map, docs: [] } — reaproveitado entre os lotes do streaming.
 */
export function createDocState() {
  return { columns: [], index: new Map(), docs: [] };
}

function addColumn(state, k) {
  const col = { name: k, kind: "other", type: "mongo", types: new Set(), full_type: "", nullable: k !== "_id", is_pk: k === "_id", is_identity: k === "_id", blank: k === "_id" ? GENERATED : undefined };
  state.index.set(k, state.columns.length);
  state.columns.push(col);
  return col;
}

/** Coluna _id antes de chegar qualquer documento: coleção vazia continua editável (inserir). */
export function ensureIdColumn(state) {
  if (!state.index.has("_id")) addColumn(state, "_id");
}

/** A projeção esconde o _id? ({ _id: 0 } / { _id: false }) */
export function projectionHidesId(projection) {
  const v = projection && typeof projection === "object" ? projection._id : undefined;
  return v === false || v === 0 || v?.$numberInt === "0";
}

/** Converte um lote; devolve { rows, added } (added = colunas novas, para o grid acrescentar). */
export function docsToRows(state, docs) {
  const added = [];
  for (const d of docs) {
    for (const k of Object.keys(d)) {
      if (!state.index.has(k)) added.push(addColumn(state, k));
      const col = state.columns[state.index.get(k)];
      const t = bsonType(d[k]);
      if (t !== "null" && !col.types.has(t)) {
        col.types.add(t);
        col.full_type = [...col.types].join(" | ");
        col.kind = col.types.size === 1 ? kindOfType(t) : [...col.types].every((x) => ["int", "long", "double", "decimal"].includes(x)) ? "num" : "other";
      }
    }
  }
  const rows = docs.map((d) => {
    state.docs.push(d);
    const row = new Array(state.columns.length);
    for (const [k, v] of Object.entries(d)) row[state.index.get(k)] = cellOf(v);
    return row;
  });
  return { rows, added };
}

/** Tipo BSON dominante de uma coluna (para células novas/ausentes). */
export function columnType(col) {
  const types = [...(col.types || [])];
  return types.length === 1 ? types[0] : "";
}

/** Tipo BSON da célula: o do documento original, senão o da coluna. */
export function cellType(state, rowIndex, col) {
  const d = state.docs[rowIndex];
  const t = d ? bsonType(d[col.name]) : "missing";
  return t === "missing" || t === "null" ? columnType(col) : t;
}

/** Valor da célula → Extended JSON (para gravar). */
export function cellToEjson(value, type) {
  if (value === undefined || isMarker(value)) return undefined;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (type === "long") return { $numberLong: String(value) };
    if (type === "double") return { $numberDouble: String(value) };
    if (type === "decimal") return { $numberDecimal: String(value) };
    return value;
  }
  return ejsonFromInput(value, type);
}

/**
 * Operações das alterações pendentes (GridModel.pending()) para a coleção.
 * Devolve [{ kind, row, op, text }] (op = JSON para o backend, text = mongosh para revisão).
 */
export function buildMongoChanges(collection, state, columns, pending) {
  const idCol = columns.findIndex((c) => c.name === "_id");
  if (idCol < 0) throw new Error("Os documentos não têm _id (projeção sem _id?): edição desativada.");
  const coll = /^[A-Za-z_$][\w$]*$/.test(collection) ? `db.${collection}` : `db.getCollection(${quote(collection)})`;
  const idOf = (r) => {
    const raw = state.docs[r]?._id;
    if (raw === undefined) throw new Error("Documento sem _id");
    return raw;
  };
  const out = [];
  for (const d of pending.deletes) {
    const filter = { _id: idOf(d.row) };
    out.push({ kind: "delete", row: d.row, op: { op: "deleteOne", collection, filter }, text: `${coll}.deleteOne(${toShell(filter)})` });
  }
  for (const u of pending.updates) {
    const set = {};
    const unset = {};
    for (const c of u.cols) {
      const col = columns[c];
      const v = cellToEjson(u.values[c], cellType(state, u.row, col));
      if (v === undefined) unset[col.name] = "";
      else set[col.name] = v;
    }
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (!Object.keys(update).length) continue;
    const filter = { _id: idOf(u.row) };
    out.push({ kind: "update", row: u.row, op: { op: "updateOne", collection, filter, update }, text: `${coll}.updateOne(${toShell(filter)}, ${toShell(update)})` });
  }
  for (const ins of pending.inserts) {
    const doc = {};
    ins.values.forEach((v, c) => {
      const e = cellToEjson(v, columnType(columns[c]));
      if (e !== undefined) doc[columns[c].name] = e;
    });
    out.push({ kind: "insert", row: ins.row, op: { op: "insertOne", collection, document: doc }, text: `${coll}.insertOne(${toShell(doc)})` });
  }
  return out;
}

export { DEFAULT };

/**
 * Texto do editor para uma célula de documento: subdocumentos/arrays identados no editor de
 * valor (expanded) e em uma linha no campo sobre a célula; ausente/NULL = vazio.
 */
export function cellEditText(value, column, expanded = false) {
  if (value === undefined || value === null || isMarker(value)) return "";
  if (column?.kind === "json" && typeof value === "string") {
    try {
      return toShell(parseShellValue(value), expanded ? "  " : "");
    } catch {
      return value;
    }
  }
  return typeof value === "boolean" ? String(value) : String(value);
}

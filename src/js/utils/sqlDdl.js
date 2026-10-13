// DDL do SQL Server para o diálogo "Modificar tabela" e as ações rápidas do Explorer
// (renomear, excluir, esvaziar). Sem DOM: o modelo editável sai de TableSchema
// (db_table_schema) e buildSchemaChanges() compara com o original e devolve os comandos.

export const TYPE_SUGGESTIONS = [
  "int", "bigint", "smallint", "tinyint", "bit", "decimal(18,2)", "numeric(18,2)", "money", "float", "real",
  "nvarchar(50)", "nvarchar(100)", "nvarchar(255)", "nvarchar(max)", "varchar(50)", "varchar(255)", "varchar(max)",
  "nchar(10)", "char(10)", "date", "datetime", "datetime2(7)", "datetimeoffset(7)", "time(7)", "smalldatetime",
  "uniqueidentifier", "varbinary(max)", "binary(16)", "xml", "sql_variant",
];

export const INDEX_KINDS = [
  ["pk", "Chave primária"],
  ["unique", "Única (constraint)"],
  ["uindex", "Índice único"],
  ["index", "Índice"],
];

export const FK_ACTIONS = ["NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT"];

let seq = 0;
const key = () => `k${++seq}`;

const TYPE_RE = /^[A-Za-z_][\w]*( [A-Za-z_]\w*)*\s*(\(\s*(max|\d+)\s*(,\s*\d+\s*)?\))?$/i;

/** Tipo digitado é seguro para ir cru no SQL (nome + tamanho/precisão opcionais). */
export const validType = (t) => TYPE_RE.test(String(t).trim());

const normType = (t) => String(t).trim().replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").toLowerCase();

/** "((0))" → "0": compara expressões ignorando os parênteses que o servidor acrescenta. */
export function stripParens(expr) {
  let s = String(expr ?? "").trim();
  while (s.startsWith("(") && s.endsWith(")") && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s;
}

function balanced(s) {
  let depth = 0;
  let quote = false;
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

// ---------- Listas de colunas ("Id, [Nome Completo] DESC") ----------

export function parseColumnList(text, { order = true } = {}) {
  const out = [];
  let cur = "";
  let bracket = false;
  for (const ch of String(text) + ",") {
    if (ch === "[") bracket = true;
    else if (ch === "]") bracket = false;
    if (ch === "," && !bracket) {
      const item = cur.trim();
      cur = "";
      if (!item) continue;
      const m = order ? /^(.*?)\s+(ASC|DESC)$/i.exec(item) : null;
      const raw = (m ? m[1] : item).trim();
      const name = /^\[.*\]$/.test(raw) ? raw.slice(1, -1).replace(/]]/g, "]") : raw;
      out.push(order ? { name, desc: !!m && m[2].toUpperCase() === "DESC" } : name);
      continue;
    }
    cur += ch;
  }
  return out;
}

const plain = (n) => (/^[A-Za-z_][\w@#$]*$/.test(n) ? n : `[${n.replace(/]/g, "]]")}]`);

export function formatColumnList(cols) {
  return cols.map((c) => (typeof c === "string" ? plain(c) : `${plain(c.name)}${c.desc ? " DESC" : ""}`)).join(", ");
}

// ---------- Modelo editável ----------

export function fromSchema(s) {
  return {
    isNew: false,
    original: s,
    schema: s.schema,
    name: s.name,
    columns: s.columns.map((c) => ({ key: key(), orig: c, name: c.name, type: c.type, nullable: c.nullable, default: c.default, identity: c.identity, seed: c.seed, increment: c.increment, computed: c.computed, dropped: false })),
    indexes: s.indexes.map((i) => ({ key: key(), orig: i, name: i.name, kind: i.kind, clustered: i.clustered, columns: i.columns.map((c) => ({ ...c })), include: [...i.include], filter: i.filter, dropped: false, droppedBy: null })),
    fks: s.fks.map((f) => ({ key: key(), orig: f, name: f.name, columns: [...f.columns], ref_schema: f.ref_schema, ref_table: f.ref_table, ref_columns: [...f.ref_columns], on_delete: f.on_delete, on_update: f.on_update, dropped: false, droppedBy: null })),
    checks: s.checks.map((c) => ({ key: key(), orig: c, name: c.name, definition: c.definition, dropped: false, droppedBy: null })),
  };
}

export function newTableModel(schema = "dbo") {
  const model = { isNew: true, original: null, schema, name: "", columns: [], indexes: [], fks: [], checks: [] };
  model.columns.push({ ...newColumn(model), name: "Id", type: "int", nullable: false, identity: true });
  model.indexes.push({ ...newIndex(model, "pk"), columns: [{ name: "Id", desc: false }] });
  return model;
}

export function newColumn(model) {
  const n = model.columns.filter((c) => /^coluna\d*$/i.test(c.name)).length;
  return { key: key(), orig: null, name: n ? `coluna${n + 1}` : "coluna", type: "nvarchar(255)", nullable: true, default: "", identity: false, seed: 1, increment: 1, computed: "", dropped: false };
}

export function newIndex(model, kind = "index") {
  const live = model.indexes.filter((i) => !i.dropped);
  return { key: key(), orig: null, name: "", kind, clustered: kind === "pk" && !live.some((i) => i.clustered), columns: [], include: [], filter: "", dropped: false, droppedBy: null };
}

export function newFk() {
  return { key: key(), orig: null, name: "", columns: [], ref_schema: "dbo", ref_table: "", ref_columns: [], on_delete: "NO ACTION", on_update: "NO ACTION", dropped: false, droppedBy: null };
}

export function newCheck() {
  return { key: key(), orig: null, name: "", definition: "", dropped: false, droppedBy: null };
}

const slug = (s) => String(s).replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");

/** Nome sugerido (o usuário pode trocar); vazio no modelo = usa este. */
export function suggestName(model, kind, item) {
  const t = slug(model.name) || "tabela";
  if (kind === "pk") return `PK_${t}`;
  if (kind === "fk") return `FK_${t}_${slug(item.ref_table) || "ref"}`;
  if (kind === "check") return `CK_${t}_${model.checks.indexOf(item) + 1}`;
  if (kind === "default") return `DF_${t}_${slug(item.name)}`;
  const cols = item.columns.map((c) => slug(c.name)).join("_");
  return `${kind === "unique" ? "UQ" : kind === "uindex" ? "UX" : "IX"}_${t}${cols ? `_${cols}` : ""}`;
}

const nameOf = (model, kind, item) => item.name.trim() || suggestName(model, kind, item);

/** Renomear uma coluna no modelo atualiza as referências em índices e FKs. */
export function renameColumnRefs(model, from, to) {
  if (!from || from === to) return;
  for (const i of model.indexes) {
    for (const c of i.columns) if (c.name === from) c.name = to;
    i.include = i.include.map((n) => (n === from ? to : n));
  }
  for (const f of model.fks) {
    f.columns = f.columns.map((n) => (n === from ? to : n));
    if (selfRef(model, f)) f.ref_columns = f.ref_columns.map((n) => (n === from ? to : n));
  }
}

const selfRef = (model, f) => f.ref_table === (model.original?.name ?? model.name) && (f.ref_schema || "dbo") === (model.original?.schema ?? model.schema);

/** O servidor guarda as expressões dos checks com as colunas entre colchetes. */
const mentions = (expr, col) => String(expr).toLowerCase().includes(`[${col.replace(/]/g, "]]").toLowerCase()}]`);

/** Excluir uma coluna leva junto (marcados) índices, FKs e checks que dependem dela. */
export function dropColumn(model, col) {
  if (!col.orig) {
    model.columns.splice(model.columns.indexOf(col), 1);
    for (const i of model.indexes) {
      i.columns = i.columns.filter((c) => c.name !== col.name);
      i.include = i.include.filter((n) => n !== col.name);
    }
    for (const f of model.fks) f.columns = f.columns.filter((n) => n !== col.name);
    return;
  }
  col.dropped = true;
  const dep = (list, uses) => {
    for (const x of list) {
      if (x.dropped || !uses(x)) continue;
      if (x.orig) {
        x.dropped = true;
        x.droppedBy = col.key;
      } else list.splice(list.indexOf(x), 1);
    }
  };
  dep(model.indexes, (i) => i.columns.some((c) => c.name === col.name) || i.include.includes(col.name));
  dep(model.fks, (f) => f.columns.includes(col.name));
  dep(model.checks, (c) => mentions(c.definition, col.name));
}

export function restoreColumn(model, col) {
  col.dropped = false;
  for (const list of [model.indexes, model.fks, model.checks]) {
    for (const x of list) {
      if (x.droppedBy === col.key) {
        x.dropped = false;
        x.droppedBy = null;
      }
    }
  }
}

export function primaryKey(model) {
  return model.indexes.find((i) => i.kind === "pk" && !i.dropped) || null;
}

/** Liga/desliga a coluna na chave primária (cria a PK se não houver). */
export function togglePk(model, col, on) {
  let pk = primaryKey(model);
  if (on) {
    col.nullable = false;
    if (!pk) {
      pk = newIndex(model, "pk");
      model.indexes.unshift(pk);
    }
    if (!pk.columns.some((c) => c.name === col.name)) pk.columns.push({ name: col.name, desc: false });
  } else if (pk) {
    pk.columns = pk.columns.filter((c) => c.name !== col.name);
    if (!pk.columns.length) {
      if (pk.orig) pk.dropped = true;
      else model.indexes.splice(model.indexes.indexOf(pk), 1);
    }
  }
}

// ---------- Validação ----------

export function validate(model) {
  const errors = [];
  if (!model.name.trim()) errors.push("Informe o nome da tabela.");
  if (!model.schema.trim()) errors.push("Informe o schema.");
  const live = model.columns.filter((c) => !c.dropped);
  if (!live.length) errors.push("A tabela precisa de pelo menos uma coluna.");
  const names = new Map();
  for (const c of live) {
    const n = c.name.trim();
    if (!n) errors.push("Há uma coluna sem nome.");
    else if (names.has(n.toLowerCase())) errors.push(`Coluna "${n}" repetida.`);
    names.set(n.toLowerCase(), c);
    if (!c.computed && !validType(c.type)) errors.push(`Tipo inválido na coluna "${n || "?"}": ${c.type || "(vazio)"}`);
  }
  const has = (n) => names.has(String(n).toLowerCase());
  const idx = model.indexes.filter((i) => !i.dropped);
  if (idx.filter((i) => i.kind === "pk").length > 1) errors.push("Só pode haver uma chave primária.");
  if (idx.filter((i) => i.clustered).length > 1) errors.push("Só pode haver um índice clustered.");
  for (const i of idx) {
    if (i.kind === "other") continue;
    const label = nameOf(model, i.kind, i);
    if (!i.columns.length) errors.push(`"${label}": informe as colunas.`);
    for (const c of [...i.columns.map((c) => c.name), ...i.include]) if (!has(c)) errors.push(`"${label}": coluna "${c}" não existe.`);
    if (i.kind === "pk") for (const c of i.columns) if (names.get(c.name.toLowerCase())?.nullable) errors.push(`Coluna "${c.name}" da chave primária não pode aceitar NULL.`);
    if ((i.include.length || i.filter.trim()) && (i.kind === "pk" || i.kind === "unique")) errors.push(`"${label}": INCLUDE e filtro só valem para índices.`);
  }
  for (const f of model.fks.filter((f) => !f.dropped)) {
    const label = nameOf(model, "fk", f);
    if (!f.columns.length || !f.ref_table.trim() || !f.ref_columns.length) errors.push(`"${label}": informe colunas, tabela e colunas referenciadas.`);
    else if (f.columns.length !== f.ref_columns.length) errors.push(`"${label}": o número de colunas difere do de colunas referenciadas.`);
    for (const c of f.columns) if (!has(c)) errors.push(`"${label}": coluna "${c}" não existe.`);
  }
  for (const c of model.checks.filter((c) => !c.dropped)) if (!c.definition.trim()) errors.push(`"${nameOf(model, "check", c)}": informe a expressão.`);
  return [...new Set(errors)];
}

// ---------- Geração ----------

const wrap = (expr) => `(${stripParens(expr)})`;

function columnDef(d, model, c, { inline = false } = {}) {
  if (c.computed) return `${d.quote(c.name)} AS ${c.computed}`;
  let s = `${d.quote(c.name)} ${c.type.trim()}`;
  if (c.identity) s += ` IDENTITY(${Number(c.seed) || 1}, ${Number(c.increment) || 1})`;
  s += c.nullable ? " NULL" : " NOT NULL";
  if (String(c.default).trim()) s += ` CONSTRAINT ${d.quote(suggestName(model, "default", c))} DEFAULT ${wrap(c.default)}`;
  return inline ? `    ${s}` : s;
}

function constraintDef(d, model, i) {
  const kw = i.kind === "pk" ? "PRIMARY KEY" : "UNIQUE";
  return `CONSTRAINT ${d.quote(nameOf(model, i.kind, i))} ${kw} ${i.clustered ? "CLUSTERED" : "NONCLUSTERED"} (${i.columns.map((c) => d.quote(c.name) + (c.desc ? " DESC" : "")).join(", ")})`;
}

function createIndex(d, model, table, i) {
  let s = `CREATE ${i.kind === "uindex" ? "UNIQUE " : ""}${i.clustered ? "CLUSTERED" : "NONCLUSTERED"} INDEX ${d.quote(nameOf(model, i.kind, i))} ON ${table} (${i.columns.map((c) => d.quote(c.name) + (c.desc ? " DESC" : "")).join(", ")})`;
  if (i.include.length) s += ` INCLUDE (${i.include.map((n) => d.quote(n)).join(", ")})`;
  if (i.filter.trim()) s += ` WHERE ${i.filter.trim()}`;
  return s;
}

function fkDef(d, model, f) {
  let s = `CONSTRAINT ${d.quote(nameOf(model, "fk", f))} FOREIGN KEY (${f.columns.map((n) => d.quote(n)).join(", ")}) REFERENCES ${d.qualified(f.ref_schema.trim() || "dbo", f.ref_table.trim())} (${f.ref_columns.map((n) => d.quote(n)).join(", ")})`;
  if (f.on_delete && f.on_delete !== "NO ACTION") s += ` ON DELETE ${f.on_delete}`;
  if (f.on_update && f.on_update !== "NO ACTION") s += ` ON UPDATE ${f.on_update}`;
  return s;
}

const checkDef = (d, model, c) => `CONSTRAINT ${d.quote(nameOf(model, "check", c))} CHECK ${wrap(c.definition)}`;

export const renameSql = (d, objname, newName, type = "") => `EXEC sp_rename ${d.string(objname)}, ${d.string(newName)}${type ? `, '${type}'` : ""}`;

function createTable(d, model) {
  const table = d.qualified(model.schema.trim(), model.name.trim());
  const lines = model.columns.map((c) => columnDef(d, model, c, { inline: true }));
  const idx = model.indexes.filter((i) => !i.dropped);
  for (const i of idx.filter((i) => i.kind === "pk" || i.kind === "unique")) lines.push(`    ${constraintDef(d, model, i)}`);
  for (const c of model.checks) lines.push(`    ${checkDef(d, model, c)}`);
  for (const f of model.fks) lines.push(`    ${fkDef(d, model, f)}`);
  const out = [`CREATE TABLE ${table}\n(\n${lines.join(",\n")}\n)`];
  for (const i of idx.filter((i) => i.kind === "index" || i.kind === "uindex")) out.push(createIndex(d, model, table, i));
  return out;
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Comandos (sem ";") que levam a tabela original ao modelo, na ordem em que precisam rodar. */
export function buildSchemaChanges(d, model) {
  if (model.isNew) return createTable(d, model);
  const o = model.original;
  const table = d.qualified(o.schema, o.name);
  const cols = model.columns;

  // Nome original → nome atual (null = coluna excluída).
  const rename = new Map(cols.filter((c) => c.orig).map((c) => [c.orig.name, c.dropped ? null : c.name]));
  const mapName = (n) => (rename.has(n) ? rename.get(n) : n);
  const altered = new Set(cols.filter((c) => c.orig && !c.dropped && !c.computed && (normType(c.type) !== normType(c.orig.type) || c.nullable !== c.orig.nullable)).map((c) => c.name));
  const touches = (names) => names.some((n) => altered.has(n));
  const defaultChanged = (c) => stripParens(c.default) !== stripParens(c.orig.default);

  const indexChanged = (i) => {
    const oi = i.orig;
    if (i.kind === "other") return false;
    return (
      i.kind !== oi.kind ||
      i.clustered !== oi.clustered ||
      !sameList(i.columns.map((c) => [c.name, !!c.desc]), oi.columns.map((c) => [mapName(c.name), !!c.desc])) ||
      !sameList(i.include, oi.include.map(mapName)) ||
      stripParens(i.filter) !== stripParens(oi.filter) ||
      touches([...i.columns.map((c) => c.name), ...i.include])
    );
  };
  const fkChanged = (f) => {
    const of = f.orig;
    const refCols = selfRef(model, f) ? of.ref_columns.map(mapName) : of.ref_columns;
    return (
      !sameList(f.columns, of.columns.map(mapName)) ||
      f.ref_schema !== of.ref_schema ||
      f.ref_table !== of.ref_table ||
      !sameList(f.ref_columns, refCols) ||
      f.on_delete !== of.on_delete ||
      f.on_update !== of.on_update ||
      touches(f.columns)
    );
  };
  const checkChanged = (c) => stripParens(c.definition) !== stripParens(c.orig.definition) || [...altered].some((n) => mentions(c.definition, n));

  const out = [];
  const recreate = { idx: [], fk: [], ck: [] };

  // 1. Remove o que sai ou muda (FKs → checks → índices/chaves → defaults → colunas).
  for (const f of model.fks.filter((f) => f.orig)) {
    if (f.dropped || fkChanged(f)) {
      out.push(`ALTER TABLE ${table} DROP CONSTRAINT ${d.quote(f.orig.name)}`);
      if (!f.dropped) recreate.fk.push(f);
    }
  }
  for (const c of model.checks.filter((c) => c.orig)) {
    if (c.dropped || checkChanged(c)) {
      out.push(`ALTER TABLE ${table} DROP CONSTRAINT ${d.quote(c.orig.name)}`);
      if (!c.dropped) recreate.ck.push(c);
    }
  }
  for (const i of model.indexes.filter((i) => i.orig)) {
    if (i.dropped || indexChanged(i)) {
      out.push(i.orig.kind === "pk" || i.orig.kind === "unique" ? `ALTER TABLE ${table} DROP CONSTRAINT ${d.quote(i.orig.name)}` : `DROP INDEX ${d.quote(i.orig.name)} ON ${table}`);
      if (!i.dropped) recreate.idx.push(i);
    }
  }
  const readdDefault = [];
  for (const c of cols.filter((c) => c.orig && c.orig.default_name)) {
    const typeChange = altered.has(c.name);
    if (c.dropped || typeChange || defaultChanged(c)) {
      out.push(`ALTER TABLE ${table} DROP CONSTRAINT ${d.quote(c.orig.default_name)}`);
      if (!c.dropped && String(c.default).trim()) readdDefault.push(c);
    }
  }
  for (const c of cols.filter((c) => c.orig && c.dropped)) out.push(`ALTER TABLE ${table} DROP COLUMN ${d.quote(c.orig.name)}`);

  // 2. Renomeia o que fica (índices/constraints sem outra mudança, depois colunas).
  for (const i of model.indexes.filter((i) => i.orig && !i.dropped && !recreate.idx.includes(i) && nameOf(model, i.kind, i) !== i.orig.name)) {
    out.push(
      i.orig.kind === "pk" || i.orig.kind === "unique"
        ? renameSql(d, d.qualified(o.schema, i.orig.name), nameOf(model, i.kind, i), "OBJECT")
        : renameSql(d, `${table}.${d.quote(i.orig.name)}`, nameOf(model, i.kind, i), "INDEX"),
    );
  }
  for (const [list, kind, re] of [
    [model.fks, "fk", recreate.fk],
    [model.checks, "check", recreate.ck],
  ]) {
    for (const x of list.filter((x) => x.orig && !x.dropped && !re.includes(x) && nameOf(model, kind, x) !== x.orig.name)) {
      out.push(renameSql(d, d.qualified(o.schema, x.orig.name), nameOf(model, kind, x), "OBJECT"));
    }
  }
  for (const c of cols.filter((c) => c.orig && !c.dropped && c.name !== c.orig.name)) out.push(renameSql(d, `${table}.${d.quote(c.orig.name)}`, c.name, "COLUMN"));

  // 3. Altera e adiciona colunas.
  for (const c of cols.filter((c) => c.orig && !c.dropped && altered.has(c.name))) {
    out.push(`ALTER TABLE ${table} ALTER COLUMN ${d.quote(c.name)} ${c.type.trim()} ${c.nullable ? "NULL" : "NOT NULL"}`);
  }
  for (const c of cols.filter((c) => c.orig && !c.dropped && !c.orig.default_name && String(c.default).trim() && defaultChanged(c))) readdDefault.push(c);
  for (const c of readdDefault) {
    const name = c.orig.default_name || suggestName(model, "default", c);
    out.push(`ALTER TABLE ${table} ADD CONSTRAINT ${d.quote(name)} DEFAULT ${wrap(c.default)} FOR ${d.quote(c.name)}`);
  }
  for (const c of cols.filter((c) => !c.orig)) out.push(`ALTER TABLE ${table} ADD ${columnDef(d, model, c)}`);

  // 4. Cria chaves/índices (PK e clustered primeiro), checks e FKs.
  const create = [...recreate.idx, ...model.indexes.filter((i) => !i.orig && !i.dropped)].sort((a, b) => (b.kind === "pk") - (a.kind === "pk") || b.clustered - a.clustered);
  for (const i of create) out.push(i.kind === "pk" || i.kind === "unique" ? `ALTER TABLE ${table} ADD ${constraintDef(d, model, i)}` : createIndex(d, model, table, i));
  for (const c of [...recreate.ck, ...model.checks.filter((c) => !c.orig && !c.dropped)]) out.push(`ALTER TABLE ${table} ADD ${checkDef(d, model, c)}`);
  for (const f of [...recreate.fk, ...model.fks.filter((f) => !f.orig && !f.dropped)]) out.push(`ALTER TABLE ${table} ADD ${fkDef(d, model, f)}`);

  // 5. Por último, o nome/schema da tabela (os comandos acima usam o nome original).
  if (model.schema.trim() !== o.schema) out.push(`ALTER SCHEMA ${d.quote(model.schema.trim())} TRANSFER ${table}`);
  if (model.name.trim() !== o.name) out.push(renameSql(d, d.qualified(model.schema.trim(), o.name), model.name.trim()));
  return out;
}

// ---------- Ações rápidas ----------

const DROP_KIND = { table: "TABLE", view: "VIEW", procedure: "PROCEDURE", function: "FUNCTION" };

export function dropObjectSql(d, { kind, schema, name }) {
  return `DROP ${DROP_KIND[kind] || "TABLE"} ${d.qualified(schema, name)}`;
}

export const truncateSql = (d, { schema, name }) => `TRUNCATE TABLE ${d.qualified(schema, name)}`;

/** Renomeia tabela/view/procedure/função (sp_rename só recebe o nome novo, sem schema). */
export const renameObjectSql = (d, { schema, name }, newName) => renameSql(d, d.qualified(schema, name), newName);

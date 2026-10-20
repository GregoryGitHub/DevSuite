import { el, icon } from "../utils/dom.js";
import { highlightCode } from "../utils/highlight.js";
import { target, metaSession, connLabel } from "../utils/dbModel.js";
import {
  TYPE_SUGGESTIONS,
  INDEX_KINDS,
  FK_ACTIONS,
  fromSchema,
  newTableModel,
  newColumn,
  newIndex,
  newFk,
  newCheck,
  suggestName,
  renameColumnRefs,
  dropColumn,
  restoreColumn,
  primaryKey,
  togglePk,
  validate,
  buildSchemaChanges,
  parseColumnList,
  formatColumnList,
  stripParens,
} from "../utils/sqlDdl.js";
import { btn } from "./modal.js";
import { dbModal } from "./dbDialogs.js";
import { dbApi } from "../api.js";

// Estrutura das tabelas SQL (estilo "Modify Table" do DataGrip): diálogo com colunas,
// chaves/índices, FKs e checks, prévia do SQL gerado (sqlDdl.js) e execução numa transação.
// Também as ações rápidas do Explorer (renomear, excluir, esvaziar) com o SQL à vista.

/**
 * ctx: { dialect(conn), toast, log, copy, openConsole(conn, db, sql), completions(conn, db),
 *        attachColumnComplete(input, getWords, opts), afterDdl({ conn, database, schema, name, renamed, dropped }) }
 */

const metaTarget = (conn, database) => target(conn, metaSession(conn.id, database), database);
const plainQuote = (w) => (/^[A-Za-z_][\w@#$]*$/.test(w) ? w : `[${w.replace(/]/g, "]]")}]`);
const script = (statements) => statements.map((s) => `${s};`).join("\n\n");

/**
 * Executa os comandos numa transação (tudo ou nada) na sessão de metadados e registra no log.
 * LOCK_TIMEOUT: uma aba com transação aberta na tabela não deixa o diálogo esperando para sempre.
 */
async function runDdl(ctx, conn, database, statements) {
  const sql = script(statements);
  const t0 = performance.now();
  try {
    const [first, ...rest] = statements;
    await dbApi.apply(metaTarget(conn, database), [`SET LOCK_TIMEOUT 15000;\n${first}`, ...rest], true);
    ctx.log({ conn, database, sql, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    const msg = /lock request time ?out/i.test(String(e)) ? `${e} — a tabela está bloqueada por outra transação (há uma aba com transação aberta?)` : String(e);
    ctx.log({ conn, database, sql, error: msg });
    throw msg;
  }
}

function guardReadOnly(ctx, conn) {
  if (!conn?.read_only) return false;
  ctx.toast("Conexão somente leitura: alterações de estrutura bloqueadas");
  return true;
}

// ---------- Confirmação / renomear (ações rápidas) ----------

/**
 * Mostra o SQL e executa ao confirmar. `input` (opcional): { label, value } — o SQL é refeito
 * a cada tecla por `build(valor)` (que pode lançar um erro de validação).
 */
export function ddlActionDialog(ctx, { conn, database, title, message = "", input = null, build, confirmLabel = "Executar", danger = false, done }) {
  if (guardReadOnly(ctx, conn)) return;
  const pre = el("pre.db-sql-preview");
  const err = el("div.dbs-error", { hidden: true });
  const field = input ? el("input.hx-input", { type: "text", value: input.value, spellcheck: false, autocomplete: "off" }) : null;
  let statements = [];

  function refresh() {
    try {
      statements = build(field?.value.trim());
      pre.innerHTML = highlightCode(script(statements), "sql");
      showError("");
    } catch (e) {
      statements = [];
      pre.innerHTML = "";
      showError(e.message || String(e));
    }
    ok.disabled = !statements.length;
  }

  function showError(text) {
    err.hidden = !text;
    err.textContent = text;
  }

  async function run() {
    if (!statements.length) return;
    ok.disabled = true;
    try {
      await runDdl(ctx, conn, database, statements);
      dbModal.close();
      done?.(field?.value.trim());
    } catch (e) {
      showError(String(e));
      ok.disabled = false;
    }
  }

  const ok = btn(confirmLabel, run, danger ? "hx-btn.danger" : "hx-btn.primary");
  dbModal.open({
    title,
    iconCls: danger ? "fa-solid fa-triangle-exclamation" : "fa-solid fa-pen-ruler",
    className: "dbs-action-modal",
    body: el(
      "div.dbs-action",
      {},
      message ? el("p.hx-modal-text", {}, message) : null,
      field ? el("label.hx-field", {}, el("span.hx-field-label", {}, input.label), field) : null,
      pre,
      err,
      el("p.dbs-where", {}, icon("fa-solid fa-database"), ` ${connLabel(conn)} / ${database}`),
    ),
    footer: [btn([icon("fa-solid fa-terminal"), " Abrir no console"], () => statements.length && (dbModal.close(), ctx.openConsole(conn, database, script(statements)))), el("span.hx-flex"), btn("Cancelar", dbModal.close), ok],
  });
  if (field) {
    field.addEventListener("input", refresh);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        run();
      }
    });
    field.focus();
    field.select();
  } else ok.focus();
  refresh();
}

/**
 * Altera um item da tabela pelo modelo (garante defaults/índices dependentes) e confirma o SQL.
 * mutate(model, value) aplica a mudança; com `input`, roda a cada tecla num modelo novo.
 */
export async function quickSchemaAction(ctx, { conn, database, schema, name, title, message, input, mutate, confirmLabel, danger }) {
  if (guardReadOnly(ctx, conn)) return;
  let original;
  try {
    original = await dbApi.tableSchema(metaTarget(conn, database), schema, name);
  } catch (e) {
    return ctx.toast(String(e));
  }
  let last = null;
  ddlActionDialog(ctx, {
    conn,
    database,
    title,
    message,
    input,
    confirmLabel,
    danger,
    build(value) {
      const model = fromSchema(original);
      mutate(model, value);
      const errors = validate(model);
      if (errors.length) throw new Error(errors[0]);
      last = model;
      return buildSchemaChanges(ctx.dialect(conn), model);
    },
    done: () =>
      ctx.afterDdl({
        conn,
        database,
        schema,
        name,
        renamed: last && (last.name !== original.name || last.schema !== original.schema) ? { schema: last.schema, name: last.name } : null,
      }),
  });
}

// ---------- Diálogo "Modificar tabela" / "Nova tabela" ----------

const SECTIONS = [
  ["columns", "Colunas", "fa-solid fa-table-columns"],
  ["indexes", "Chaves e índices", "fa-solid fa-key"],
  ["fks", "Chaves estrangeiras", "fa-solid fa-link"],
  ["checks", "Checks", "fa-solid fa-check-double"],
];

/**
 * Abre o editor da tabela. Sem `name` = nova tabela no schema informado.
 * focus: { section, column, index, add } — seção inicial, item a destacar ou item novo.
 */
export async function tableDesigner(ctx, { conn, database, schema = "dbo", name = "", focus = {} }) {
  if (guardReadOnly(ctx, conn)) return;
  let model;
  try {
    model = name ? fromSchema(await dbApi.tableSchema(metaTarget(conn, database), schema, name)) : newTableModel(schema);
  } catch (e) {
    return ctx.toast(String(e));
  }
  const d = ctx.dialect(conn);
  let section = focus.section || "columns";
  let statements = [];
  const refColumns = new Map(); // "schema.tabela" -> Promise<{ names, pk }>

  ctx
    .completions(conn, database)
    .then((src) => {
      // Tabelas do banco para o campo "Referencia" das FKs.
      for (const o of src.objects) if (o.kind === "table") tableList.append(el("option", { value: `${o.schema}.${o.name}` }));
    })
    .catch(() => {});

  function refInfo(refSchema, refTable) {
    const k = `${refSchema}.${refTable}`.toLowerCase();
    if (!refColumns.has(k)) {
      refColumns.set(
        k,
        dbApi
          .tableInfo(metaTarget(conn, database), refSchema, refTable)
          .then((info) => ({ names: info.columns.map((c) => c.name), pk: info.columns.filter((c) => c.is_pk).map((c) => c.name) }))
          .catch(() => ({ names: [], pk: [] })),
      );
    }
    return refColumns.get(k);
  }

  // ---------- Estrutura do diálogo ----------

  const typeList = el("datalist", { id: "dbs-types" }, ...TYPE_SUGGESTIONS.map((t) => el("option", { value: t })));
  const tableList = el("datalist", { id: "dbs-tables" });
  const schemaInput = el("input.hx-input", { value: model.schema, spellcheck: false, oninput: () => ((model.schema = schemaInput.value), update()) });
  const nameInput = el("input.hx-input", { value: model.name, spellcheck: false, placeholder: "nome_da_tabela", oninput: () => ((model.name = nameInput.value), update()) });
  const sectionBar = el("div.dbs-tabs");
  const addBtn = el("button.hx-btn.dbs-add", { type: "button", onclick: () => addItem() });
  const content = el("div.dbs-content");
  const errorsEl = el("div.dbs-error", { hidden: true });
  const preview = el("pre.db-sql-preview.dbs-preview");
  const previewHead = el("div.dbs-preview-head");
  const runBtn = btn("Executar", run, "hx-btn.primary");
  const body = el(
    "div.dbs",
    {},
    typeList,
    tableList,
    el(
      "div.dbs-head",
      {},
      el("label.hx-field.dbs-schema", {}, el("span.hx-field-label", {}, "Schema"), schemaInput),
      el("label.hx-field.dbs-name", {}, el("span.hx-field-label", {}, "Tabela"), nameInput),
    ),
    el("div.dbs-bar", {}, sectionBar, el("span.hx-flex"), addBtn),
    content,
    errorsEl,
    previewHead,
    preview,
  );

  dbModal.open({
    title: model.isNew ? `Nova tabela — ${connLabel(conn)} / ${database}` : `Modificar tabela ${schema}.${name}`,
    iconCls: "fa-solid fa-pen-ruler",
    wide: true,
    className: "dbs-modal",
    body,
    footer: [
      btn([icon("fa-solid fa-terminal"), " Abrir no console"], () => statements.length && (dbModal.close(), ctx.openConsole(conn, database, script(statements)))),
      btn([icon("fa-regular fa-copy"), " Copiar SQL"], () => statements.length && ctx.copy(script(statements), "SQL copiado")),
      el("span.hx-flex"),
      btn("Cancelar", dbModal.close),
      runBtn,
    ],
  });
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  });

  // ---------- Atualização ----------

  function update() {
    const errors = validate(model);
    try {
      statements = errors.length ? [] : buildSchemaChanges(d, model);
    } catch (e) {
      errors.push(String(e.message || e));
      statements = [];
    }
    errorsEl.hidden = !errors.length;
    errorsEl.innerHTML = "";
    for (const msg of errors.slice(0, 4)) errorsEl.append(el("div", {}, icon("fa-solid fa-circle-exclamation"), ` ${msg}`));
    if (errors.length > 4) errorsEl.append(el("div", {}, `… e mais ${errors.length - 4}`));
    preview.innerHTML = statements.length ? highlightCode(script(statements), "sql") : `<span class="dbs-muted">${errors.length ? "Corrija os problemas acima." : "-- nenhuma alteração"}</span>`;
    previewHead.textContent = statements.length ? `SQL gerado · ${statements.length} comando(s), executados numa transação` : "SQL gerado";
    runBtn.disabled = !statements.length;
    runBtn.textContent = model.isNew ? "Criar tabela" : statements.length ? `Executar (${statements.length})` : "Executar";
    paintTabs();
  }

  function paintTabs() {
    sectionBar.innerHTML = "";
    const counts = {
      columns: model.columns.filter((c) => !c.dropped).length,
      indexes: model.indexes.filter((i) => !i.dropped).length,
      fks: model.fks.filter((f) => !f.dropped).length,
      checks: model.checks.filter((c) => !c.dropped).length,
    };
    for (const [id, label, ic] of SECTIONS) {
      sectionBar.append(el("button", { type: "button", class: `dbs-tab${id === section ? " on" : ""}`, onclick: () => ((section = id), render()) }, icon(ic), ` ${label}`, el("span.dbs-count", {}, counts[id])));
    }
    addBtn.innerHTML = "";
    addBtn.append(icon("fa-solid fa-plus"), { columns: " Coluna", indexes: " Índice", fks: " Chave estrangeira", checks: " Check" }[section]);
  }

  function render() {
    content.innerHTML = "";
    content.append({ columns: renderColumns, indexes: renderIndexes, fks: renderFks, checks: renderChecks }[section]());
    update();
  }

  /** Estado visual da linha: nova, alterada, excluída. */
  function rowState(item, changed) {
    if (item.dropped) return " dropped";
    if (!item.orig) return " added";
    return changed ? " changed" : "";
  }

  const liveColumns = () => model.columns.filter((c) => !c.dropped).map((c) => c.name);

  function textInput(value, { placeholder = "", disabled = false, list, cls = "", oninput }) {
    const inp = el(`input.hx-input${cls ? `.${cls}` : ""}`, { value: value ?? "", placeholder, disabled, spellcheck: false, autocomplete: "off", list });
    inp.addEventListener("input", () => (oninput(inp.value), update()));
    return inp;
  }

  /** Input com autocomplete das colunas da tabela (lista "a, b DESC"). */
  function columnsInput(value, { placeholder, disabled, words = liveColumns, oninput }) {
    const inp = textInput(value, { placeholder, disabled, oninput });
    ctx.attachColumnComplete?.(inp, () => words(), { quote: plainQuote });
    return el("span.dbs-ac", {}, inp);
  }

  function check(checked, { disabled = false, title = "", onchange }) {
    const box = el("input", { type: "checkbox", checked, disabled, title });
    box.addEventListener("change", () => onchange(box.checked));
    return el("label.dbs-check", { title }, box);
  }

  function removeBtn(item, { onRemove, onRestore }) {
    if (item.dropped) {
      return el("button.dbt-btn.dbs-x", { type: "button", title: item.droppedBy ? "Restaurar (removido junto com a coluna)" : "Desfazer exclusão", disabled: !!item.droppedBy, onclick: onRestore }, icon("fa-solid fa-rotate-left"));
    }
    return el("button.dbt-btn.dbs-x", { type: "button", title: "Excluir", onclick: onRemove }, icon("fa-regular fa-trash-can"));
  }

  function dropFrom(list, item) {
    if (item.orig) item.dropped = true;
    else list.splice(list.indexOf(item), 1);
    render();
  }

  // ---------- Colunas ----------

  function renderColumns() {
    const pk = primaryKey(model);
    const pkCols = new Set(pk?.columns.map((c) => c.name) || []);
    const head = el(
      "div.dbs-row.dbs-cols.head",
      {},
      el("span"),
      el("span", {}, "Nome"),
      el("span", {}, "Tipo"),
      el("span", { title: "Aceita NULL" }, "Nulo"),
      el("span", {}, "Padrão"),
      el("span", { title: "Chave primária" }, "PK"),
      el("span", { title: "IDENTITY(1, 1)" }, "Ident."),
      el("span"),
    );
    const rows = model.columns.map((c) => {
      const changed = c.orig && (c.name !== c.orig.name || c.type.replace(/\s+/g, "").toLowerCase() !== c.orig.type.replace(/\s+/g, "").toLowerCase() || c.nullable !== c.orig.nullable || stripParens(c.default) !== stripParens(c.orig.default));
      const dis = c.dropped;
      const nameIn = textInput(c.name, {
        disabled: dis,
        cls: "dbs-colname",
        oninput: (v) => {
          renameColumnRefs(model, c.name, v);
          c.name = v;
        },
      });
      nameIn.dataset.key = c.key;
      const typeIn = c.computed
        ? textInput(`AS ${c.computed}`, { disabled: true })
        : textInput(c.type, { disabled: dis, list: "dbs-types", oninput: (v) => (c.type = v) });
      const row = el(
        "div",
        { class: `dbs-row dbs-cols${rowState(c, changed)}`, title: c.orig ? (c.orig.name !== c.name ? `Original: ${c.orig.name} ${c.orig.type}` : "") : "Coluna nova" },
        el("span.dbs-mark", {}, pkCols.has(c.name) ? icon("fa-solid fa-key") : null),
        nameIn,
        typeIn,
        check(c.nullable, { disabled: dis || !!c.computed || pkCols.has(c.name), title: pkCols.has(c.name) ? "Colunas da chave primária não aceitam NULL" : "Aceita NULL", onchange: (v) => ((c.nullable = v), update()) }),
        c.computed ? el("span") : textInput(c.default, { disabled: dis || c.identity, placeholder: c.identity ? "" : "ex.: 0, N'abc', getdate()", oninput: (v) => (c.default = v) }),
        check(pkCols.has(c.name), { disabled: dis || !!c.computed, title: "Chave primária", onchange: (v) => (togglePk(model, c, v), render()) }),
        check(c.identity, {
          disabled: dis || !!c.orig || !!c.computed,
          title: c.orig ? "IDENTITY não pode ser alterado numa coluna existente" : "IDENTITY(1, 1)",
          onchange: (v) => {
            for (const o of model.columns) if (v && o !== c && !o.orig) o.identity = false;
            c.identity = v;
            if (v) c.default = "";
            render();
          },
        }),
        removeBtn(c, {
          onRemove: () => (dropColumn(model, c), render()),
          onRestore: () => (restoreColumn(model, c), render()),
        }),
      );
      return row;
    });
    return el("div.dbs-list", {}, head, ...rows);
  }

  // ---------- Chaves e índices ----------

  function renderIndexes() {
    const head = el(
      "div.dbs-row.dbs-idx.head",
      {},
      el("span", {}, "Nome"),
      el("span", {}, "Tipo"),
      el("span", { title: "Clustered" }, "Clust."),
      el("span", {}, "Colunas (ASC/DESC)"),
      el("span", {}, "INCLUDE"),
      el("span", {}, "Filtro (WHERE)"),
      el("span"),
    );
    const rows = model.indexes.map((i) => {
      const o = i.orig;
      const other = i.kind === "other";
      const dis = i.dropped || other;
      const changed = o && (i.name !== o.name || i.kind !== o.kind || i.clustered !== o.clustered || formatColumnList(i.columns) !== formatColumnList(o.columns) || i.include.join() !== o.include.join() || stripParens(i.filter) !== stripParens(o.filter));
      // Índices especiais (columnstore, XML...) só podem ser renomeados ou excluídos.
      const nameIn = textInput(i.name, { disabled: i.dropped, placeholder: suggestName(model, i.kind, i), oninput: (v) => (i.name = v) });
      nameIn.dataset.key = i.key;
      const kindSel = other
        ? el("span.dbs-static", { title: o.type_desc }, o.type_desc.toLowerCase())
        : el("select.hx-select", { disabled: dis, onchange: (e) => ((i.kind = e.target.value), i.kind === "pk" || i.kind === "unique" ? ((i.include = []), (i.filter = "")) : null, render()) }, ...INDEX_KINDS.map(([v, label]) => el("option", { value: v, selected: v === i.kind }, label)));
      const keyed = i.kind === "pk" || i.kind === "unique";
      return el(
        "div",
        { class: `dbs-row dbs-idx${rowState(i, changed)}` },
        nameIn,
        kindSel,
        check(i.clustered, { disabled: dis, title: "Clustered (um por tabela)", onchange: (v) => ((i.clustered = v), update()) }),
        columnsInput(formatColumnList(i.columns), { placeholder: "Id, Nome DESC", disabled: dis, oninput: (v) => (i.columns = parseColumnList(v)) }),
        columnsInput(formatColumnList(i.include), { placeholder: keyed ? "—" : "colunas extras", disabled: dis || keyed, oninput: (v) => (i.include = parseColumnList(v, { order: false })) }),
        textInput(i.filter, { disabled: dis || keyed, placeholder: keyed ? "—" : "[Ativo] = 1", oninput: (v) => (i.filter = v) }),
        removeBtn(i, { onRemove: () => dropFrom(model.indexes, i), onRestore: () => ((i.dropped = false), render()) }),
      );
    });
    return el("div.dbs-list", {}, head, ...rows, model.indexes.length ? null : el("p.dbs-empty", {}, "Nenhuma chave ou índice."));
  }

  // ---------- Chaves estrangeiras ----------

  function renderFks() {
    const head = el(
      "div.dbs-row.dbs-fk.head",
      {},
      el("span", {}, "Nome"),
      el("span", {}, "Colunas"),
      el("span", {}, "Referencia (schema.tabela)"),
      el("span", {}, "Colunas referenciadas"),
      el("span", {}, "ON DELETE"),
      el("span", {}, "ON UPDATE"),
      el("span"),
    );
    const action = (value, dis, set) => el("select.hx-select", { disabled: dis, onchange: (e) => (set(e.target.value), update()) }, ...FK_ACTIONS.map((a) => el("option", { value: a, selected: a === value }, a)));
    const rows = model.fks.map((f) => {
      const o = f.orig;
      const dis = f.dropped;
      const changed = o && JSON.stringify([f.name, f.columns, f.ref_schema, f.ref_table, f.ref_columns, f.on_delete, f.on_update]) !== JSON.stringify([o.name, o.columns, o.ref_schema, o.ref_table, o.ref_columns, o.on_delete, o.on_update]);
      if (f.ref_table) refInfo(f.ref_schema || "dbo", f.ref_table).then((r) => refCache.set(f.key, r.names));
      const refCols = columnsInput(formatColumnList(f.ref_columns), { placeholder: "Id", disabled: dis, words: () => refCache.get(f.key) || [], oninput: (v) => (f.ref_columns = parseColumnList(v, { order: false })) });
      const refTable = textInput(f.ref_table ? `${f.ref_schema || "dbo"}.${f.ref_table}` : "", {
        disabled: dis,
        list: "dbs-tables",
        placeholder: "dbo.clientes",
        oninput: (v) => {
          const [a, b] = v.includes(".") ? [v.slice(0, v.indexOf(".")), v.slice(v.indexOf(".") + 1)] : ["dbo", v];
          f.ref_schema = a.replace(/^\[|\]$/g, "").trim();
          f.ref_table = b.replace(/^\[|\]$/g, "").trim();
        },
      });
      // Ao escolher a tabela, sugere a chave primária dela como colunas referenciadas.
      refTable.addEventListener("change", async () => {
        if (!f.ref_table) return;
        const r = await refInfo(f.ref_schema || "dbo", f.ref_table);
        refCache.set(f.key, r.names);
        if (!f.ref_columns.length && r.pk.length) {
          f.ref_columns = [...r.pk];
          refCols.querySelector("input").value = formatColumnList(f.ref_columns);
          update();
        }
      });
      const nameIn = textInput(f.name, { disabled: dis, placeholder: suggestName(model, "fk", f), oninput: (v) => (f.name = v) });
      nameIn.dataset.key = f.key;
      return el(
        "div",
        { class: `dbs-row dbs-fk${rowState(f, changed)}` },
        nameIn,
        columnsInput(formatColumnList(f.columns), { placeholder: "ClienteId", disabled: dis, oninput: (v) => (f.columns = parseColumnList(v, { order: false })) }),
        refTable,
        refCols,
        action(f.on_delete, dis, (v) => (f.on_delete = v)),
        action(f.on_update, dis, (v) => (f.on_update = v)),
        removeBtn(f, { onRemove: () => dropFrom(model.fks, f), onRestore: () => ((f.dropped = false), render()) }),
      );
    });
    return el("div.dbs-list", {}, head, ...rows, model.fks.length ? null : el("p.dbs-empty", {}, "Nenhuma chave estrangeira."));
  }

  const refCache = new Map(); // fk.key -> nomes das colunas da tabela referenciada

  // ---------- Checks ----------

  function renderChecks() {
    const head = el("div.dbs-row.dbs-ck.head", {}, el("span", {}, "Nome"), el("span", {}, "Expressão"), el("span"));
    const rows = model.checks.map((c) => {
      const changed = c.orig && (c.name !== c.orig.name || stripParens(c.definition) !== stripParens(c.orig.definition));
      const nameIn = textInput(c.name, { disabled: c.dropped, placeholder: suggestName(model, "check", c), oninput: (v) => (c.name = v) });
      nameIn.dataset.key = c.key;
      return el(
        "div",
        { class: `dbs-row dbs-ck${rowState(c, changed)}` },
        nameIn,
        textInput(c.definition, { disabled: c.dropped, cls: "mono", placeholder: "[Quantidade] > 0", oninput: (v) => (c.definition = v) }),
        removeBtn(c, { onRemove: () => dropFrom(model.checks, c), onRestore: () => ((c.dropped = false), render()) }),
      );
    });
    return el("div.dbs-list", {}, head, ...rows, model.checks.length ? null : el("p.dbs-empty", {}, "Nenhuma constraint CHECK."));
  }

  // ---------- Ações ----------

  function addItem(kind = section) {
    section = kind;
    let item;
    if (kind === "columns") model.columns.push((item = newColumn(model)));
    else if (kind === "indexes") model.indexes.push((item = newIndex(model, primaryKey(model) ? "index" : "pk")));
    else if (kind === "fks") model.fks.push((item = newFk()));
    else model.checks.push((item = newCheck()));
    render();
    focusItem(item.key, kind === "columns");
  }

  function focusItem(key, select = false) {
    const inp = content.querySelector(`input[data-key="${key}"]`) || content.querySelector(".dbs-row:last-child input:not([disabled])");
    if (!inp) return;
    inp.closest(".dbs-row")?.scrollIntoView({ block: "nearest" });
    inp.focus();
    if (select) inp.select();
  }

  async function run() {
    if (!statements.length) return;
    runBtn.disabled = true;
    try {
      await runDdl(ctx, conn, database, statements);
      dbModal.close();
      ctx.toast(model.isNew ? `Tabela ${model.schema}.${model.name} criada` : "Estrutura da tabela alterada");
      const o = model.original;
      ctx.afterDdl({
        conn,
        database,
        schema: o?.schema ?? model.schema,
        name: o?.name ?? model.name,
        created: model.isNew,
        renamed: o && (o.name !== model.name.trim() || o.schema !== model.schema.trim()) ? { schema: model.schema.trim(), name: model.name.trim() } : null,
      });
    } catch (e) {
      errorsEl.hidden = false;
      errorsEl.innerHTML = "";
      errorsEl.append(el("div", {}, icon("fa-solid fa-circle-exclamation"), ` ${String(e)}`), el("div.dbs-muted", {}, "Nada foi alterado (a transação foi desfeita)."));
      runBtn.disabled = false;
    }
  }

  // ---------- Foco inicial ----------

  render();
  if (focus.add) addItem(section);
  else if (focus.column) focusItem(model.columns.find((c) => c.name === focus.column)?.key, true);
  else if (focus.index) focusItem((model.indexes.find((i) => i.name === focus.index) || model.fks.find((f) => f.name === focus.index))?.key, true);
  else (model.isNew ? nameInput : null)?.focus();
}

// ---------- Script do banco inteiro ----------

const SCRIPT_KINDS = [
  ["tables", "Tabelas"],
  ["indexes", "Índices"],
  ["foreign_keys", "Chaves estrangeiras"],
  ["types", "Tipos de usuário"],
  ["sequences", "Sequences"],
  ["synonyms", "Sinônimos"],
  ["views", "Views"],
  ["functions", "Funções"],
  ["procedures", "Procedures"],
  ["triggers", "Triggers"],
];
const SCRIPT_OPTS_KEY = "db-script-opts";

function scriptCheck(label, checked, onchange) {
  const box = el("input", { type: "checkbox", checked, onchange: () => onchange(box.checked) });
  return el("label.db-check", {}, box, el("span", {}, label));
}

/**
 * "Gerar DDL do banco": escolhe o que entra no script (lembrado no localStorage) e os schemas;
 * o script é gerado no Rust e aberto numa aba de DDL (ctx.openDatabaseScript).
 * `schema` (opcional): vem marcado sozinho (menu do schema no Explorer).
 */
export function databaseScriptDialog(ctx, { conn, database, schema = "" }) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SCRIPT_OPTS_KEY) || "{}") || {};
  } catch {}
  const opts = { ...Object.fromEntries(SCRIPT_KINDS.map(([k]) => [k, true])), if_not_exists: false, ...saved };
  const err = el("div.dbs-error", { hidden: true });
  const schemaBox = el("div.dbs-script-schemas", {}, el("span.dbs-muted", {}, "Carregando schemas…"));
  let schemas = []; // [{ name, on }]

  const kinds = el(
    "div.dbs-script-kinds",
    {},
    SCRIPT_KINDS.map(([k, label]) => scriptCheck(label, opts[k], (v) => (opts[k] = v))),
  );

  dbApi
    .introspect(metaTarget(conn, database), { kind: "schemas" })
    .then((list) => {
      schemas = list.map((s) => ({ name: s.name, on: !schema || s.name === schema }));
      schemaBox.innerHTML = "";
      schemaBox.append(...schemas.map((s) => scriptCheck(s.name, s.on, (v) => (s.on = v))));
    })
    .catch((e) => {
      schemaBox.innerHTML = "";
      schemaBox.append(el("span.dbs-muted", {}, `Schemas indisponíveis (${e}); o script inclui todos.`));
    });

  function generate() {
    const picked = schemas.filter((s) => s.on).map((s) => s.name);
    if (schemas.length && !picked.length) {
      err.hidden = false;
      err.textContent = "Marque pelo menos um schema.";
      return;
    }
    try {
      localStorage.setItem(SCRIPT_OPTS_KEY, JSON.stringify(opts));
    } catch {}
    dbModal.close();
    // Todos marcados = vazio (o Rust inclui todos).
    ctx.openDatabaseScript({ conn, database, options: { ...opts, schemas: picked.length === schemas.length ? [] : picked } });
  }

  const ok = btn([icon("fa-solid fa-scroll"), " Gerar"], generate, "hx-btn.primary");
  dbModal.open({
    title: `Gerar DDL de ${database}`,
    iconCls: "fa-solid fa-scroll",
    className: "dbs-action-modal",
    body: el(
      "div.dbs-action.dbs-script",
      {},
      el("p.hx-modal-text", {}, "Script com tudo na ordem de criação (tabelas pai antes das filhas, cada uma com índices e FKs; views e funções na ordem de dependência), para recriar o banco em outro ambiente. Não inclui dados nem permissões."),
      el("div.dbs-preview-head", {}, "Objetos"),
      kinds,
      el("div.dbs-preview-head", {}, "Schemas"),
      schemaBox,
      scriptCheck("Proteger com IF NOT EXISTS (só cria o que falta; pode rodar sobre um banco já criado)", opts.if_not_exists, (v) => (opts.if_not_exists = v)),
      err,
      el("p.dbs-where", {}, icon("fa-solid fa-database"), ` ${connLabel(conn)} / ${database}`),
    ),
    footer: [el("span.hx-flex"), btn("Cancelar", dbModal.close), ok],
  });
  ok.focus();
}

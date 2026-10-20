import { el, icon } from "../utils/dom.js";
import { uid, target } from "../utils/dbModel.js";
import { parseShellValue } from "../utils/mongoShell.js";
import { createDocState, ensureIdColumn, projectionHidesId, docsToRows, cellType, cellOf, ejsonFromInput, buildMongoChanges, toShell, cellEditText } from "../utils/mongoValue.js";
import { createDataGrid } from "./dataGrid.js";
import { openValueEditor } from "./dataGridEditor.js";
import { codeEditor } from "./codeEditor.js";
import { reviewChangesDialog, dbConfirm } from "./dbDialogs.js";
import { createResultFooter, copyAsItems, exportMenuItems } from "./dbShared.js";
import { attachWordComplete } from "./sqlComplete.js";
import { dbApi } from "../api.js";

// Aba de uma coleção MongoDB: filtro/ordenação/projeção no servidor (sintaxe do mongosh),
// paginação (skip/limit), grid com os campos de topo como colunas e edição que preserva o tipo
// BSON de cada valor. As alterações viram updateOne/insertOne/deleteOne por _id.

const PAGE_SIZES = [50, 100, 200, 500, 1000];
const shellName = (n) => (/^[A-Za-z_$][\w$]*$/.test(n) ? `db.${n}` : `db.getCollection(${toShell(n)})`);

/** tab: { id, conn_id, database, name, kind: "collection" | "view", where (filtro), order_by (sort), projection } */
export function createMongoTab(ctx, tab) {
  const conn = () => ctx.conn(tab.conn_id);
  const sessionId = `tab:${tab.id}`;
  const tgt = () => target(conn(), sessionId, tab.database);
  const isView = tab.kind === "view";

  let state = createDocState();
  let offset = 0;
  let hasMore = false;
  let total = null;
  let loading = null;
  let loadedOnce = false;
  let mode = "grid"; // "grid" | "json"

  const grid = createDataGrid({
    showMenu: ctx.showMenu,
    onChange: updateToolbar,
    onStatus: (s) => footer.setSelection(s),
    onError: (m) => ctx.toast(m),
    onInfo: (m) => ctx.toast(m),
    onCopied: (n) => n > 1 && ctx.toast(`${n.toLocaleString("pt-BR")} células copiadas`),
    onSubmit: submit,
    copyAsItems: (m) => copyAsItems(ctx, ctx.dialect(conn()), m, null, { mongo: true }),
    // Texto digitado → mesmo tipo BSON do valor original (ou o dominante da coluna).
    parseValue: (text, col, r) => {
      if (text.trim() === "" && col.kind !== "str") return null;
      return cellOf(ejsonFromInput(text, cellType(state, r, col)));
    },
    editText: (v, col, r, o) => cellEditText(v, col, o.expanded),
    headerMenuItems: (col) => [
      "sep",
      { label: "Ordenar no servidor (crescente)", icon: "fa-solid fa-server", run: () => serverSort(col, 1) },
      { label: "Ordenar no servidor (decrescente)", icon: "fa-solid fa-server", run: () => serverSort(col, -1) },
      { label: "Ocultar no servidor (projeção)", icon: "fa-regular fa-eye-slash", run: () => project(col) },
    ],
    cellMenuItems: (cell) => [
      "sep",
      { label: "Filtrar no servidor por este valor", icon: "fa-solid fa-server", run: () => serverFilter(cell) },
      grid.editable && cell.column.name !== "_id" ? { label: "Remover campo do documento", icon: "fa-solid fa-eraser", run: () => grid.setSelected(() => undefined) } : null,
      { label: grid.editable ? "Editar documento inteiro (JSON)…" : "Ver documento (JSON)…", icon: "fa-solid fa-file-code", run: () => editDocument(cell.r) },
    ],
  });

  // ---------- Barra ----------

  const tb = (iconCls, title, onclick, extra = {}) => el("button.dbt-btn", { type: "button", title, onclick, ...extra }, icon(iconCls), extra.label ? el("span", {}, extra.label) : null);
  const reloadBtn = tb("fa-solid fa-rotate-right", "Recarregar (F5)", () => load());
  const cancelBtn = tb("fa-solid fa-stop", "Cancelar consulta", () => loading && dbApi.cancel(loading), { disabled: true });
  const firstBtn = tb("fa-solid fa-backward-step", "Primeira página", () => goPage(0));
  const prevBtn = tb("fa-solid fa-chevron-left", "Página anterior", () => goPage(Math.max(0, offset - pageSize())));
  const pageLabel = el("button.dbt-page", { type: "button", title: "Documentos por página / contar", onclick: (e) => pageMenu(e.currentTarget) });
  const nextBtn = tb("fa-solid fa-chevron-right", "Próxima página", () => goPage(offset + pageSize()));
  const addBtn = tb("fa-solid fa-plus", "Novo documento (Alt+Insert)", () => grid.addRow());
  const delBtn = tb("fa-solid fa-minus", "Excluir documentos selecionados (Ctrl+Delete)", () => grid.deleteSelectedRows());
  const revertBtn = tb("fa-solid fa-rotate-left", "Reverter alterações", () => grid.revertAll());
  const submitBtn = el("button.dbt-submit", { type: "button", title: "Enviar alterações (Ctrl+Enter)", onclick: () => submit() }, icon("fa-solid fa-arrow-up-from-bracket"), el("span", {}, "Enviar"));
  const jsonBtn = tb("fa-solid fa-code", "Alternar grid / JSON", () => setMode(mode === "grid" ? "json" : "grid"));
  const findBtn = tb("fa-solid fa-magnifying-glass", "Buscar (Ctrl+F)", () => grid.openFind());
  const recordBtn = tb("fa-solid fa-table-list", "Modo registro", () => {
    grid.setRecordMode(!grid.recordMode);
    recordBtn.classList.toggle("on", grid.recordMode);
  });
  const exportBtn = tb("fa-solid fa-file-export", "Exportar", (e) => ctx.showMenuBelow(e.currentTarget, exportMenuItems(ctx, ctx.dialect(conn()), grid, null, { baseName: tab.name, mongo: true, docs: () => state.docs })));
  const consoleBtn = tb("fa-solid fa-terminal", "Abrir esta consulta no console", () => ctx.openConsole(conn(), tab.database, currentShell()));
  const roBadge = el("span.dbt-ro", { hidden: true }, icon("fa-solid fa-lock"), "somente leitura");
  const toolbar = el(
    "div.dbt-toolbar",
    {},
    reloadBtn,
    cancelBtn,
    el("span.dbt-sep"),
    firstBtn,
    prevBtn,
    pageLabel,
    nextBtn,
    el("span.dbt-sep"),
    addBtn,
    delBtn,
    revertBtn,
    submitBtn,
    el("span.dbt-sep"),
    jsonBtn,
    findBtn,
    recordBtn,
    exportBtn,
    consoleBtn,
    el("span.hx-flex"),
    roBadge,
  );

  // ---------- Filtro / ordenação / projeção ----------

  const mk = (value, placeholder) => el("input.dbt-filter-input", { type: "text", value, placeholder, spellcheck: false, autocomplete: "off" });
  const filterInput = mk(tab.where, "{ status: 'ativo', criado: { $gte: ISODate('2026-01-01') } }");
  const sortInput = mk(tab.order_by, "{ criado: -1 }");
  const projInput = mk(tab.projection, "{ nome: 1, email: 1 }");
  const apply = () => {
    tab.where = filterInput.value.trim();
    tab.order_by = sortInput.value.trim();
    tab.projection = projInput.value.trim();
    ctx.saveUi();
    offset = 0;
    total = null;
    load();
  };
  for (const inp of [filterInput, sortInput, projInput]) {
    attachWordComplete(inp, () => state.columns.map((c) => c.name), { quote: (w) => toShell(w) });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      } else if (e.key === "Escape" && inp.value) {
        inp.value = "";
        apply();
      }
    });
  }
  const filters = el(
    "div.dbt-filters",
    {},
    el("label.dbt-filter", {}, el("span.dbt-filter-label", {}, icon("fa-solid fa-filter"), "filtro"), filterInput),
    el("label.dbt-filter", {}, el("span.dbt-filter-label", {}, icon("fa-solid fa-arrow-down-wide-short"), "sort"), sortInput),
    el("label.dbt-filter", {}, el("span.dbt-filter-label", {}, icon("fa-solid fa-eye"), "projeção"), projInput),
  );

  const jsonView = codeEditor({ value: "", lang: "javascript", fill: true, readOnly: true });
  const jsonPane = el("div.dbc-editor.full", { hidden: true }, jsonView.root);
  const footer = createResultFooter();
  const gridPane = el("div.dbt-grid", {}, grid.root);
  const root = el("div.dbt", {}, toolbar, filters, gridPane, jsonPane, footer.root);

  const pageSize = () => Math.min(ctx.pageSize(), 1000);

  function parseDoc(text, what) {
    if (!text.trim()) return null;
    let v;
    try {
      v = parseShellValue(text);
    } catch (e) {
      throw `${what}: ${e.message}`;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw `${what} deve ser um documento { … }`;
    return v;
  }

  function query() {
    return {
      filter: parseDoc(tab.where, "Filtro") || {},
      sort: parseDoc(tab.order_by, "Ordenação"),
      projection: parseDoc(tab.projection, "Projeção"),
    };
  }

  function currentShell() {
    let q;
    try {
      q = query();
    } catch {
      q = { filter: {} };
    }
    let s = `${shellName(tab.name)}.find(${toShell(q.filter)}${q.projection ? `, ${toShell(q.projection)}` : ""})`;
    if (q.sort) s += `\n  .sort(${toShell(q.sort)})`;
    if (offset) s += `\n  .skip(${offset})`;
    return `${s}\n  .limit(${pageSize()})`;
  }

  function editableNow() {
    return !isView && !conn()?.read_only && state.columns.some((c) => c.name === "_id");
  }

  function updateToolbar() {
    const pending = grid.model.pendingCount;
    const editable = editableNow() && mode === "grid";
    addBtn.disabled = delBtn.disabled = !editable || !!loading;
    revertBtn.disabled = !pending;
    submitBtn.disabled = !pending || !!loading;
    submitBtn.querySelector("span").textContent = pending ? `Enviar (${pending})` : "Enviar";
    submitBtn.classList.toggle("on", !!pending);
    roBadge.hidden = !loadedOnce || editableNow();
    roBadge.title = isView ? "Views do MongoDB são somente leitura" : conn()?.read_only ? "Conexão somente leitura" : "Os documentos não têm _id (projeção sem _id?)";
    reloadBtn.disabled = !!loading;
    cancelBtn.disabled = !loading;
    prevBtn.disabled = firstBtn.disabled = offset === 0 || !!loading;
    nextBtn.disabled = !hasMore || !!loading;
    jsonBtn.classList.toggle("on", mode === "json");
    const shown = state.docs.length;
    pageLabel.innerHTML = "";
    pageLabel.append(
      el("span", {}, !loadedOnce ? "—" : offset === 0 && !hasMore ? `${shown.toLocaleString("pt-BR")} documento${shown === 1 ? "" : "s"}` : `${(shown ? offset + 1 : 0).toLocaleString("pt-BR")}–${(offset + shown).toLocaleString("pt-BR")}${total !== null ? ` de ${total.toLocaleString("pt-BR")}` : hasMore ? " de ?" : ""}`),
      icon("fa-solid fa-chevron-down"),
    );
    ctx.onTitleChange?.(tab, { dirty: pending > 0 });
  }

  async function confirmDiscard() {
    if (!grid.model.pendingCount) return true;
    return dbConfirm({ title: "Descartar alterações?", message: `Há ${grid.model.pendingCount} alteração(ões) não enviada(s). Recarregar descarta essas alterações.`, confirmLabel: "Descartar", danger: true });
  }

  async function load({ force = false } = {}) {
    if (loading) return;
    if (!force && !(await confirmDiscard())) return;
    const c = conn();
    if (!c) return;
    let q;
    try {
      q = query();
    } catch (e) {
      footer.setInfo(String(e), "bad");
      return ctx.toast(String(e));
    }
    const size = pageSize();
    const op = { op: "find", collection: tab.name, filter: q.filter, projection: q.projection, sort: q.sort, skip: offset || null, limit: size + 1 };
    const queryId = uid();
    loading = queryId;
    updateToolbar();
    grid.setMessage(loadedOnce ? "" : "Carregando…");
    footer.setInfo("Executando…", "busy");
    const next = createDocState();
    if (!projectionHidesId(q.projection)) ensureIdColumn(next);
    let count = 0;
    let started = false;
    try {
      const summary = await dbApi.execute(tgt(), queryId, JSON.stringify(op), {
        onEvent: (ev) => {
          if (ev.type !== "docs" || ev.index !== 0) return;
          const room = size - count;
          count += ev.docs.length;
          const docs = room < ev.docs.length ? ev.docs.slice(0, Math.max(0, room)) : ev.docs;
          if (!docs.length) return;
          const { rows, added } = docsToRows(next, docs);
          if (!started) {
            started = true;
            state = next;
            grid.setColumns([...next.columns], { keepLayout: true });
          } else grid.addColumns(added);
          grid.appendRows(rows);
        },
      });
      if (!started) {
        state = next;
        grid.setColumns([...next.columns]);
      }
      hasMore = count > size;
      loadedOnce = true;
      grid.setEditable(editableNow());
      grid.setMessage(count ? "" : tab.where ? "Nenhum documento atende ao filtro" : "Coleção vazia");
      footer.setInfo(`${Math.min(count, size).toLocaleString("pt-BR")} documento(s) a partir de ${(offset + 1).toLocaleString("pt-BR")} em ${summary.elapsed_ms} ms`);
      ctx.log({ conn: c, database: tab.database, sql: currentShell(), lang: "javascript", rows: Math.min(count, size), ms: summary.elapsed_ms });
      if (mode === "json") paintJson();
    } catch (e) {
      grid.setMessage(loadedOnce ? "" : String(e));
      footer.setInfo(String(e), "bad");
      ctx.log({ conn: c, database: tab.database, sql: currentShell(), lang: "javascript", error: String(e) });
    } finally {
      loading = null;
      updateToolbar();
    }
  }

  async function goPage(next) {
    if (next === offset) return;
    if (!(await confirmDiscard())) return;
    offset = next;
    load({ force: true });
  }

  function pageMenu(anchor) {
    ctx.showMenuBelow(anchor, [
      { header: "Documentos por página" },
      ...PAGE_SIZES.map((n) => ({
        label: n.toLocaleString("pt-BR"),
        icon: n === pageSize() ? "fa-solid fa-check" : "",
        indent: true,
        run: () => {
          ctx.setPageSize(n);
          offset = 0;
          load();
        },
      })),
      "sep",
      { label: "Contar documentos (countDocuments)", icon: "fa-solid fa-calculator", run: countDocs },
    ]);
  }

  async function countDocs() {
    try {
      const { filter } = query();
      let n = null;
      await dbApi.execute(tgt(), uid(), JSON.stringify({ op: "countDocuments", collection: tab.name, filter }), {
        onEvent: (ev) => {
          if (ev.type === "docs") n = Number(cellOf(ev.docs[0]?.count));
        },
      });
      total = n;
      updateToolbar();
      ctx.toast(`${(n ?? 0).toLocaleString("pt-BR")} documento(s)${tab.where ? " com o filtro" : ""}`);
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  const fieldKey = (name) => (/^[A-Za-z_$][\w$.]*$/.test(name) ? name : toShell(name));

  function serverSort(col, dir) {
    sortInput.value = `{ ${fieldKey(col.name)}: ${dir} }`;
    apply();
  }

  function project(col) {
    let p = {};
    try {
      p = parseDoc(projInput.value, "Projeção") || {};
    } catch {
      p = {};
    }
    p[col.name] = 0;
    projInput.value = toShell(p);
    apply();
  }

  function serverFilter(cell) {
    const doc = state.docs[cell.r];
    const raw = doc ? doc[cell.column.name] : undefined;
    let f = {};
    try {
      f = parseDoc(filterInput.value, "Filtro") || {};
    } catch {
      f = {};
    }
    f[cell.column.name] = raw === undefined ? { $exists: false } : raw;
    filterInput.value = toShell(f);
    apply();
  }

  // ---------- JSON ----------

  function paintJson() {
    jsonView.setValue(state.docs.length ? state.docs.map((d) => toShell(d, "  ")).join(",\n") : "// nenhum documento");
  }

  function setMode(m) {
    if (m === "json" && grid.model.pendingCount) return ctx.toast("Envie ou reverta as alterações antes de ver em JSON");
    mode = m;
    gridPane.hidden = mode !== "grid";
    jsonPane.hidden = mode !== "json";
    if (mode === "json") paintJson();
    else grid.refresh();
    updateToolbar();
  }

  // ---------- Gravar ----------

  async function applyOps(statements, label) {
    if (!(await reviewChangesDialog({ statements, connection: `${tab.database}.${tab.name}`, mongo: true }))) return false;
    try {
      const affected = await dbApi.apply(tgt(), statements.map((s) => JSON.stringify(s.op)), false);
      const zero = statements.filter((s, i) => s.kind !== "insert" && affected[i] === 0).length;
      ctx.log({ conn: conn(), database: tab.database, sql: statements.map((s) => s.text).join("\n"), lang: "javascript", affected: affected.reduce((a, b) => a + b, 0) });
      ctx.toast(zero ? `Gravado, mas ${zero} operação(ões) não alteraram nenhum documento (mudou no banco?)` : label);
      return true;
    } catch (e) {
      ctx.log({ conn: conn(), database: tab.database, sql: statements.map((s) => s.text).join("\n"), lang: "javascript", error: String(e) });
      ctx.toast(String(e));
      return false;
    }
  }

  async function submit() {
    if (!grid.model.pendingCount || loading) return;
    if (conn()?.read_only) return ctx.toast("Conexão somente leitura");
    let statements;
    try {
      statements = buildMongoChanges(tab.name, state, grid.model.columns, grid.model.pending());
    } catch (e) {
      return ctx.toast(e.message);
    }
    if (!statements.length) return grid.revertAll();
    // Recarrega depois: _id gerados e tipos finais vêm do servidor.
    if (await applyOps(statements, `${statements.length} alteração(ões) gravada(s)`)) load({ force: true });
  }

  function editDocument(r) {
    const doc = state.docs[r];
    if (!doc) return ctx.toast("Envie o documento novo antes de editá-lo em JSON");
    const canEdit = editableNow();
    openValueEditor({
      host: grid.root,
      title: `${tab.name} · documento`,
      subtitle: doc._id !== undefined ? `_id: ${toShell(doc._id)}` : "",
      text: toShell(doc, "  "),
      readOnly: !canEdit,
      onSave: async (text) => {
        let replacement;
        try {
          replacement = parseShellValue(text);
        } catch (e) {
          return ctx.toast(`JSON inválido: ${e.message}`);
        }
        if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) return ctx.toast("O documento deve ser { … }");
        // _id não pode mudar num replaceOne.
        const filter = { _id: doc._id };
        replacement = { _id: doc._id, ...replacement };
        const statement = { kind: "replace", row: r, op: { op: "replaceOne", collection: tab.name, filter, replacement }, text: `${shellName(tab.name)}.replaceOne(${toShell(filter)}, ${toShell(replacement, "  ")})` };
        if (await applyOps([statement], "Documento substituído")) load({ force: true });
      },
    });
  }

  root.addEventListener("keydown", (e) => {
    if (e.key === "F5") {
      e.preventDefault();
      load();
    }
  });

  updateToolbar();

  return {
    root,
    tab,
    activate() {
      if (!loadedOnce && !loading) load({ force: true });
      if (mode === "grid") grid.focus();
      else jsonView.refresh();
    },
    refresh: () => load(),
    get dirty() {
      return grid.model.pendingCount > 0;
    },
    async beforeClose() {
      if (grid.model.pendingCount) {
        return dbConfirm({ title: "Fechar aba?", message: `Há ${grid.model.pendingCount} alteração(ões) não enviada(s).`, confirmLabel: "Descartar e fechar", danger: true });
      }
      return true;
    },
    dispose() {
      if (loading) dbApi.cancel(loading);
      dbApi.disconnect(sessionId);
    },
  };
}

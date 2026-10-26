import { el, icon } from "../utils/dom.js";
import { escapeHtml } from "../utils/noteContent.js";
import { codeEditor } from "./codeEditor.js";
import { createTable } from "./rabbitViews.js";
import { fmtNum, fmtBytes, fmtTime } from "../utils/rabbitModel.js";
import {
  argOf,
  bulkBytes,
  bulkLabel,
  bulkOf,
  b64ToBytes,
  bytesToB64,
  utf8,
  detectFormat,
  hexDumpBytes,
  respText,
  respInt,
  respPairs,
  respObject,
  typeInfo,
  fmtTtl,
  quoteArg,
  streamIdTime,
} from "../utils/redisModel.js";

// Aba de uma chave: cabeçalho (tipo, TTL, tamanho, memória, encoding, renomear, excluir) e o
// editor do tipo. Coleções (hash, list, set, zset) carregam em páginas (HSCAN, LRANGE, SSCAN,
// ZRANGE/ZSCAN) e editam um item por vez num editor de valor; streams têm entradas e grupos.

const esc = (v) => escapeHtml(v === null || v === undefined ? "" : String(v));
const PAGE = 200;
const STRING_LIMIT = 512 * 1024;
const PREVIEW = 160;

/** Prévia de uma linha (texto ou \xHH), cortada. */
function preview(bulk) {
  const t = bulkLabel(bulk).replace(/\s+/g, " ");
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW)}…` : t;
}

// ---------- Editor de valor ----------

const MODES = [
  ["auto", "Automático"],
  ["text", "Texto"],
  ["json", "JSON"],
  ["hex", "Hex (leitura)"],
  ["base64", "Base64"],
];

/**
 * Mostra/edita um valor binário-seguro. onSave(bulk) grava; readOnly desliga a edição.
 * O texto exibido em JSON é indentado; ao salvar, JSON que era compacto volta compacto.
 */
export function valueEditor({ onSave, onCopy, label = "Valor" } = {}) {
  let original = null;
  let shown = "";
  let mode = "auto";
  let effective = "text";
  let readOnly = false;
  let saving = false;
  const info = el("span.rds-val-info");
  const modeSel = el("select.hx-select.small", { title: "Formato de exibição", onchange: () => ((mode = modeSel.value), render()) }, ...MODES.map(([v, l]) => el("option", { value: v }, l)));
  const saveBtn = el("button.hx-btn.primary.small", { type: "button", title: "Salvar (Ctrl+S)", onclick: () => save() }, icon("fa-solid fa-floppy-disk"), " Salvar");
  const revertBtn = el("button.hx-btn.small", { type: "button", title: "Descartar alterações", onclick: () => render() }, icon("fa-solid fa-rotate-left"));
  const copyBtn = el("button.hx-btn.small", { type: "button", title: "Copiar valor", onclick: () => onCopy?.(editor.value) }, icon("fa-regular fa-copy"));
  const editor = codeEditor({ value: "", lang: "text", fill: true, onInput: () => syncDirty() });
  const errorEl = el("div.rds-val-error", { hidden: true });
  const root = el("div.rds-val", {}, el("div.rds-val-bar", {}, el("span.rds-val-label", {}, label), modeSel, info, el("span.hx-flex"), copyBtn, revertBtn, saveBtn), errorEl, el("div.rds-val-editor", {}, editor.root));
  editor.input.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      save();
    }
  });

  function render() {
    errorEl.hidden = true;
    if (!original) {
      shown = "";
      editor.setValue("");
      info.textContent = "";
      syncDirty();
      return;
    }
    const bytes = bulkBytes(original);
    const fmt = detectFormat(original);
    effective = mode === "auto" ? (fmt.kind === "binary" ? "hex" : fmt.kind === "json" ? "json" : "text") : mode;
    if (effective === "json") {
      if (fmt.kind === "json") shown = fmt.pretty;
      else {
        shown = utf8(bytes) ?? "";
        errorEl.hidden = false;
        errorEl.textContent = "O valor não é JSON válido; mostrado como texto.";
      }
    } else if (effective === "hex") shown = hexDumpBytes(bytes);
    else if (effective === "base64") shown = bytesToB64(bytes);
    else shown = utf8(bytes) ?? bulkLabel(original);
    editor.setValue(shown);
    editor.setLang(effective === "json" ? "json" : "text");
    editor.input.readOnly = readOnly || effective === "hex" || (effective === "text" && utf8(bytes) === null);
    info.textContent = `${fmtBytes(bytes.length)}${fmt.kind === "binary" ? " · binário" : fmt.kind === "json" ? " · JSON" : ""}${modeSel.value === "auto" && effective !== fmt.kind && !(effective === "hex" && fmt.kind === "binary") ? ` · ${effective}` : ""}`;
    syncDirty();
  }

  const dirty = () => !!original && !editor.input.readOnly && editor.value !== shown;
  function syncDirty() {
    saveBtn.disabled = !dirty() || saving;
    revertBtn.disabled = !dirty();
    root.classList.toggle("dirty", dirty());
  }

  /** Valor a gravar (bulk) a partir do editor. */
  function current() {
    const text = editor.value;
    if (effective === "base64") {
      try {
        return bulkOf(b64ToBytes(text.replace(/\s+/g, "")));
      } catch {
        throw new Error("Base64 inválido.");
      }
    }
    if (effective === "json") {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`JSON inválido: ${e.message}`);
      }
      const wasCompact = !String(utf8(bulkBytes(original)) ?? "").includes("\n");
      return { t: "str", v: wasCompact ? JSON.stringify(parsed) : text };
    }
    return { t: "str", v: text };
  }

  async function save() {
    if (!dirty() || saving) return;
    let next;
    try {
      next = current();
    } catch (e) {
      errorEl.hidden = false;
      errorEl.textContent = e.message;
      return;
    }
    saving = true;
    syncDirty();
    try {
      await onSave(next);
      original = next;
      render();
    } catch (e) {
      errorEl.hidden = false;
      errorEl.textContent = String(e);
    } finally {
      saving = false;
      syncDirty();
    }
  }

  return {
    root,
    set(bulk, { readOnly: ro = false } = {}) {
      original = bulk;
      readOnly = ro;
      saveBtn.hidden = revertBtn.hidden = ro;
      render();
    },
    clear() {
      original = null;
      render();
    },
    get dirty() {
      return dirty();
    },
    refresh: () => editor.refresh(),
    focus: () => editor.input.focus(),
  };
}

// ---------- Aba da chave ----------

/**
 * tab: { id, conn_id, db, key: { t, v } }
 * ctx: { conn, exec, pipeline, toast, copy, showMenu, showMenuBelow, confirm, danger(c, opts), prompt, form, ttlDialog,
 *        keyChanged(c, db, key, change), onTitleChange(tab), openConsole(c, db, text), serverInfo(c) }
 */
export function createKeyTab(ctx, tab) {
  const conn = () => ctx.conn(tab.conn_id);
  const k = () => argOf(tab.key);
  const run = (args) => ctx.exec(conn(), tab.db, args);
  const pipe = (cmds) => ctx.pipeline(conn(), tab.db, cmds);
  const check = (r) => {
    if (r?.t === "err") throw r.v;
    return r;
  };

  let meta = { type: "", ttl: -1, memory: null, encoding: "", size: null };
  let body = null;
  let loading = false;

  const typeBadge = el("span.rds-type");
  const nameEl = el("span.rds-key-name");
  const ttlBtn = el("button.rds-chip", { type: "button", title: "Alterar TTL", onclick: () => editTtl() });
  const stats = el("span.rds-key-stats");
  const head = el(
    "div.rds-key-head",
    {},
    typeBadge,
    nameEl,
    el("button.hx-icon-btn", { type: "button", title: "Copiar nome", onclick: () => ctx.copy(bulkLabel(tab.key), "Nome copiado") }, icon("fa-regular fa-copy")),
    el("span.hx-flex"),
    ttlBtn,
    stats,
    el("button.hx-btn.small", { type: "button", title: "Recarregar (F5)", onclick: () => load() }, icon("fa-solid fa-rotate")),
    el("button.hx-btn.small", { type: "button", title: "Renomear", onclick: () => rename() }, icon("fa-solid fa-i-cursor")),
    el("button.hx-btn.small", { type: "button", title: "Mais", onclick: (e) => moreMenu(e.currentTarget) }, icon("fa-solid fa-ellipsis")),
    el("button.hx-btn.small.danger", { type: "button", title: "Excluir chave", onclick: () => remove() }, icon("fa-regular fa-trash-can")),
  );
  const bodyEl = el("div.rds-key-body");
  const root = el("div.rds-key", {}, head, bodyEl);

  function renderHead() {
    const info = typeInfo(meta.type);
    typeBadge.textContent = info.label;
    typeBadge.style.setProperty("--t", info.color);
    nameEl.textContent = bulkLabel(tab.key);
    nameEl.title = bulkLabel(tab.key);
    ttlBtn.innerHTML = "";
    ttlBtn.append(icon("fa-regular fa-clock"), ` ${fmtTtl(meta.ttl)}`);
    ttlBtn.classList.toggle("on", meta.ttl > 0);
    const parts = [];
    if (meta.size !== null) parts.push(meta.type === "string" ? fmtBytes(meta.size) : `${fmtNum(meta.size)} ${meta.type === "hash" ? "campo(s)" : meta.type === "stream" ? "entrada(s)" : "item(ns)"}`);
    if (meta.memory !== null) parts.push(`memória ${fmtBytes(meta.memory)}`);
    if (meta.encoding) parts.push(meta.encoding);
    stats.textContent = parts.join(" · ");
  }

  async function load() {
    if (loading) return;
    loading = true;
    root.classList.add("loading");
    try {
      const r = await pipe([["TYPE", k()], ["PTTL", k()], ["MEMORY", "USAGE", k()], ["OBJECT", "ENCODING", k()]]);
      const type = respText(r[0]);
      if (r[0]?.t === "err") throw r[0].v;
      if (type === "none") return showMissing();
      meta = { type, ttl: respInt(r[1]), memory: r[2]?.t === "int" ? r[2].v : null, encoding: r[3]?.t === "err" ? "" : respText(r[3]), size: null };
      const sizeCmd = typeInfo(type).size;
      if (sizeCmd) meta.size = respInt(await run([sizeCmd, k()]));
      renderHead();
      if (!body || body.type !== type) {
        body?.dispose?.();
        body = makeBody(type);
        bodyEl.innerHTML = "";
        bodyEl.append(body.root);
      }
      await body.load();
    } catch (e) {
      bodyEl.innerHTML = "";
      bodyEl.append(el("div.db-placeholder.err", {}, icon("fa-solid fa-triangle-exclamation"), el("p", {}, String(e)), el("button.hx-btn.primary", { type: "button", onclick: () => load() }, "Tentar de novo")));
      body = null;
    } finally {
      loading = false;
      root.classList.remove("loading");
    }
  }

  function showMissing() {
    meta = { type: "", ttl: -2, memory: null, encoding: "", size: null };
    renderHead();
    body?.dispose?.();
    body = null;
    bodyEl.innerHTML = "";
    bodyEl.append(el("div.db-placeholder", {}, icon("fa-regular fa-circle-xmark"), el("p", {}, "A chave não existe (expirou ou foi removida)."), el("button.hx-btn", { type: "button", onclick: () => load() }, "Recarregar")));
  }

  /** Depois de uma escrita: recarrega o cabeçalho (tamanho/memória) sem refazer o corpo. */
  async function refreshMeta() {
    try {
      const r = await pipe([["PTTL", k()], ["MEMORY", "USAGE", k()], ...(typeInfo(meta.type).size ? [[typeInfo(meta.type).size, k()]] : [])]);
      meta.ttl = respInt(r[0]);
      meta.memory = r[1]?.t === "int" ? r[1].v : meta.memory;
      if (r[2]) meta.size = respInt(r[2]);
      if (meta.ttl === -2) return showMissing();
      renderHead();
      ctx.keyChanged(conn(), tab.db, tab.key, { type: meta.type });
    } catch {
      /* cabeçalho desatualizado não impede nada */
    }
  }

  async function editTtl() {
    if (!meta.type) return;
    const s = await ctx.ttlDialog({ key: bulkLabel(tab.key), currentMs: meta.ttl });
    if (s === null) return;
    try {
      check(await run(s === 0 ? ["PERSIST", k()] : ["EXPIRE", k(), String(s)]));
      ctx.toast(s === 0 ? "Expiração removida" : `Expira em ${fmtTtl(s * 1000)}`);
      refreshMeta();
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  async function rename() {
    const next = await ctx.prompt({ title: "Renomear chave", label: "Novo nome", value: bulkLabel(tab.key), hint: tab.key.t === "bin" ? "A chave tem bytes binários: o novo nome é gravado como texto (\\xHH não é interpretado)." : "" });
    if (next === null || next === bulkLabel(tab.key) || !next) return;
    try {
      const r = await run(["RENAMENX", k(), next]);
      check(r);
      if (respInt(r) === 0) {
        const ok = await ctx.confirm({ title: "Já existe", message: `"${next}" já existe. Substituir?`, confirmLabel: "Substituir", danger: true });
        if (!ok) return;
        check(await run(["RENAME", k(), next]));
      }
      const old = tab.key;
      tab.key = { t: "str", v: next };
      ctx.keyChanged(conn(), tab.db, old, { renamedTo: tab.key, type: meta.type });
      ctx.onTitleChange(tab);
      renderHead();
      ctx.toast("Chave renomeada");
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  async function remove() {
    const c = conn();
    const ok = await ctx.danger(c, { title: "Excluir chave?", message: `"${bulkLabel(tab.key)}" (${typeInfo(meta.type).label}) será excluída.`, name: bulkLabel(tab.key), confirmLabel: "Excluir" });
    if (!ok) return;
    try {
      check(await run(["UNLINK", k()]));
      ctx.keyChanged(c, tab.db, tab.key, { deleted: true });
      ctx.toast("Chave excluída");
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  function moreMenu(anchor) {
    ctx.showMenuBelow(anchor, [
      { label: "Duplicar (COPY)…", icon: "fa-regular fa-clone", run: () => duplicate() },
      { label: "Copiar como comando (DUMP/RESTORE)", icon: "fa-solid fa-terminal", run: () => copyDump() },
      { label: "Abrir no console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn(), tab.db, `TYPE ${quoteArg(k())}\nPTTL ${quoteArg(k())}`) },
      "sep",
      { label: "Copiar nome", icon: "fa-regular fa-copy", run: () => ctx.copy(bulkLabel(tab.key), "Nome copiado") },
    ]);
  }

  async function duplicate() {
    const next = await ctx.prompt({ title: "Duplicar chave", label: "Nome da cópia", value: `${bulkLabel(tab.key)}:copia` });
    if (!next) return;
    try {
      const r = check(await run(["COPY", k(), next]));
      if (respInt(r) === 0) return ctx.toast(`"${next}" já existe`);
      ctx.keyChanged(conn(), tab.db, { t: "str", v: next }, { created: true, type: meta.type });
      ctx.toast("Chave duplicada");
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  /** RESTORE com o DUMP da chave (move entre servidores/bancos pelo console). */
  async function copyDump() {
    try {
      const r = check(await run(["DUMP", k()]));
      const bytes = bulkBytes(r);
      const hex = [...bytes].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
      ctx.copy(`RESTORE ${quoteArg(k())} ${meta.ttl > 0 ? meta.ttl : 0} "${hex}" REPLACE`, "Comando RESTORE copiado");
    } catch (e) {
      ctx.toast(String(e));
    }
  }

  // ---------- Corpos por tipo ----------

  const bodyCtx = { tab, conn, k, run, pipe, check, ctx, refreshMeta, meta: () => meta };

  function makeBody(type) {
    if (type === "string") return stringBody(bodyCtx);
    if (type === "hash") return hashBody(bodyCtx);
    if (type === "list") return listBody(bodyCtx);
    if (type === "set") return setBody(bodyCtx);
    if (type === "zset") return zsetBody(bodyCtx);
    if (type === "stream") return streamBody(bodyCtx);
    if (type === "ReJSON-RL") return jsonBody(bodyCtx);
    return otherBody(bodyCtx, type);
  }

  return {
    root,
    tab,
    activate() {
      if (!meta.type && !loading && !body) load();
      body?.refresh?.();
    },
    refresh: () => load(),
    reload: () => load(),
    get dirty() {
      return !!body?.dirty;
    },
    async beforeClose() {
      if (body?.dirty) return ctx.confirm({ title: "Descartar alterações?", message: "O valor editado não foi salvo.", confirmLabel: "Descartar", danger: true });
      return true;
    },
    dispose() {
      body?.dispose?.();
    },
  };
}

// ---------- string ----------

function stringBody(b) {
  const editor = valueEditor({
    onCopy: (t) => b.ctx.copy(t, "Valor copiado"),
    onSave: async (v) => {
      // KEEPTTL (Redis 6+); servidor antigo: SET + PEXPIRE com o TTL que restava.
      let r = await b.run(["SET", b.k(), argOf(v), "KEEPTTL"]);
      if (r?.t === "err" && /syntax/i.test(r.v)) {
        const ttl = b.meta().ttl;
        r = await b.run(["SET", b.k(), argOf(v)]);
        if (ttl > 0) await b.run(["PEXPIRE", b.k(), String(ttl)]);
      }
      b.check(r);
      b.ctx.toast("Valor salvo");
      b.refreshMeta();
    },
  });
  const note = el("div.rmq-alert", { hidden: true });
  const root = el("div.rds-string", {}, note, editor.root);
  async function load(all = false) {
    const size = b.meta().size ?? 0;
    const partial = !all && size > STRING_LIMIT;
    const r = b.check(await b.run(partial ? ["GETRANGE", b.k(), "0", String(STRING_LIMIT - 1)] : ["GET", b.k()]));
    editor.set(r, { readOnly: partial });
    note.hidden = !partial;
    note.innerHTML = "";
    if (partial) note.append(icon("fa-solid fa-scissors"), el("span", {}, `Mostrando os primeiros ${fmtBytes(STRING_LIMIT)} de ${fmtBytes(size)} (somente leitura).`), el("button.hx-btn.small", { type: "button", onclick: () => load(true) }, "Carregar tudo"));
  }
  return { type: "string", root, load: () => load(), refresh: editor.refresh, get dirty() { return editor.dirty; } };
}

// ---------- coleções (layout comum) ----------

/**
 * Lista paginada + editor do item selecionado. spec: {
 *   columns, rowKey, fetch(cursor, filter) → { rows, cursor (null = fim) }, filterPlaceholder,
 *   add(), menu(rows, e), valueOf(row) → bulk, saveValue(row, bulk), itemLabel(row), extraTools[] }
 */
function collectionBody(b, spec) {
  let rows = [];
  let cursor = null;
  let done = false;
  let filter = "";
  let busy = false;
  let selected = null;
  const countEl = el("span.rds-coll-count");
  const moreBtn = el("button.hx-btn.small", { type: "button", hidden: true, onclick: () => loadMore() }, icon("fa-solid fa-angles-down"), " Carregar mais");
  const filterInput = el("input", {
    type: "search",
    placeholder: spec.filterPlaceholder || "Filtrar (padrão com *)",
    spellcheck: false,
    autocomplete: "off",
    onkeydown: (e) => e.key === "Enter" && ((filter = filterInput.value.trim()), reload()),
    onsearch: () => ((filter = filterInput.value.trim()), reload()),
  });
  const table = createTable({
    columns: spec.columns,
    rowKey: spec.rowKey,
    state: {},
    onSelect: (list) => select(list.length === 1 ? list[0] : null),
    onOpen: (r) => select(r, true),
    onMenu: (list, e) => spec.menu(list, e),
    emptyText: "Nenhum item.",
  });
  const editor = valueEditor({
    label: spec.valueLabel || "Valor",
    onCopy: (t) => b.ctx.copy(t, "Valor copiado"),
    onSave: async (v) => {
      if (!selected) return;
      await spec.saveValue(selected, v);
      selected.value = v;
      table.setRows(rows);
      b.ctx.toast("Item salvo");
      b.refreshMeta();
    },
  });
  const editorBox = el("div.rds-coll-editor", {}, editor.root);
  const placeholderEl = el("div.rds-coll-hint", {}, "Selecione um item para ver/editar o valor.");
  editorBox.append(placeholderEl);
  const tools = el(
    "div.rds-coll-tools",
    {},
    spec.filter === false ? null : el("label.db-search.rmq-filter", {}, icon("fa-solid fa-magnifying-glass"), filterInput),
    ...(spec.extraTools || []),
    el("span.hx-flex"),
    countEl,
    el("button.hx-btn.small", { type: "button", title: "Adicionar", onclick: () => spec.add().then((ok) => ok && reload()) }, icon("fa-solid fa-plus"), " Adicionar"),
  );
  const listBox = el("div.rds-coll-list", {}, table.root, el("div.rds-coll-more", {}, moreBtn));
  const split = el("div.rds-coll-split", {}, listBox, el("div.rds-coll-handle", { title: "Arraste para redimensionar" }), editorBox);
  const root = el("div.rds-coll", {}, tools, split);

  // Separador lista | editor (vertical).
  split.querySelector(".rds-coll-handle").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = split.getBoundingClientRect();
    const move = (ev) => split.style.setProperty("--rds-list-h", `${Math.min(85, Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100))}%`);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  function select(r, focus = false) {
    selected = r;
    placeholderEl.hidden = !!r;
    editor.root.hidden = !r;
    if (r) {
      editor.set(spec.valueOf(r), { readOnly: !!spec.readOnly });
      if (focus) editor.focus();
    } else editor.clear();
  }
  select(null);

  function renderCount() {
    const total = b.meta().size;
    countEl.textContent = `${fmtNum(rows.length)}${total !== null && !filter ? ` de ${fmtNum(total)}` : done ? "" : "+"}`;
    moreBtn.hidden = done;
  }

  async function loadMore() {
    if (busy || done) return;
    busy = true;
    moreBtn.disabled = true;
    try {
      const page = await spec.fetch(cursor, filter);
      rows = rows.concat(page.rows);
      cursor = page.cursor;
      done = page.cursor === null;
      table.setRows(rows);
      renderCount();
    } catch (e) {
      b.ctx.toast(String(e));
    } finally {
      busy = false;
      moreBtn.disabled = false;
    }
  }

  async function reload() {
    const keep = selected ? spec.rowKey(selected) : null;
    rows = [];
    cursor = null;
    done = false;
    await loadMore();
    const again = keep !== null ? rows.find((r) => spec.rowKey(r) === keep) : null;
    if (again && !editor.dirty) select(again);
    else if (!again) select(null);
  }

  return {
    root,
    load: reload,
    reload,
    rows: () => rows,
    setRows: (next) => (rows = next, table.setRows(rows), renderCount()),
    select,
    selectedRows: () => table.selectedRows(),
    refresh: () => editor.refresh(),
    get dirty() {
      return editor.dirty;
    },
  };
}

/** SCAN de coleção (HSCAN/SSCAN/ZSCAN) até ~PAGE itens. */
async function scanPage(b, cmd, cursor, filter, toRows) {
  let cur = cursor ?? "0";
  const out = [];
  let guard = 0;
  do {
    const args = [cmd, b.k(), cur, "COUNT", "500"];
    if (filter) args.push("MATCH", filter.includes("*") || filter.includes("?") ? filter : `*${filter}*`);
    const r = b.check(await b.run(args));
    cur = respText(r.v[0]);
    out.push(...toRows(r.v[1]?.v || []));
  } while (cur !== "0" && out.length < PAGE && ++guard < 50);
  return { rows: out, cursor: cur === "0" ? null : cur };
}

const sizeCell = (bulk) => `<span class="rmq-zero">${fmtBytes(bulkBytes(bulk).length)}</span>`;
const cellHtml = (bulk) => `<span class="rds-cell${bulk.t === "bin" ? " bin" : ""}">${esc(preview(bulk))}</span>`;

async function itemDialog(b, { title, fields }) {
  return b.ctx.form({ title, iconCls: "fa-solid fa-plus", fields, confirmLabel: "Salvar", wide: true });
}

// ---------- hash ----------

function hashBody(b) {
  let coll;
  const del = async (list) => {
    const ok = await b.ctx.confirm({ title: list.length > 1 ? `Excluir ${list.length} campos?` : "Excluir campo?", message: list.map((r) => bulkLabel(r.field)).join(", "), confirmLabel: "Excluir", danger: true });
    if (!ok) return;
    try {
      b.check(await b.run(["HDEL", b.k(), ...list.map((r) => argOf(r.field))]));
      await coll.reload();
      b.refreshMeta();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  const renameField = async (r) => {
    const next = await b.ctx.prompt({ title: "Renomear campo", label: "Novo nome", value: bulkLabel(r.field) });
    if (!next || next === bulkLabel(r.field)) return;
    try {
      if (respInt(await b.run(["HEXISTS", b.k(), next])) && !(await b.ctx.confirm({ title: "Campo já existe", message: `Substituir "${next}"?`, confirmLabel: "Substituir", danger: true }))) return;
      const res = await b.pipe([["HSET", b.k(), next, argOf(r.value)], ["HDEL", b.k(), argOf(r.field)]]);
      res.forEach(b.check);
      await coll.reload();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  coll = collectionBody(b, {
    columns: [
      { key: "field", label: "Campo", html: (r) => cellHtml(r.field), sort: (r) => bulkLabel(r.field), width: "35%" },
      { key: "value", label: "Valor", html: (r) => cellHtml(r.value), sort: (r) => bulkLabel(r.value) },
      { key: "size", label: "Tamanho", html: (r) => sizeCell(r.value), sort: (r) => bulkBytes(r.value).length, align: "right", width: "90px" },
    ],
    rowKey: (r) => `${r.field.t}:${r.field.v}`,
    filterPlaceholder: "Filtrar campos (HSCAN MATCH)",
    fetch: (cursor, filter) =>
      scanPage(b, "HSCAN", cursor, filter, (list) => {
        const out = [];
        for (let i = 0; i + 1 < list.length; i += 2) out.push({ field: list[i], value: list[i + 1] });
        return out;
      }),
    valueOf: (r) => r.value,
    saveValue: async (r, v) => b.check(await b.run(["HSET", b.k(), argOf(r.field), argOf(v)])),
    add: async () => {
      const v = await itemDialog(b, { title: "Novo campo", fields: [{ name: "field", label: "Campo" }, { name: "value", label: "Valor", type: "textarea", rows: 6 }] });
      if (!v || !v.field) return false;
      try {
        if (respInt(await b.run(["HEXISTS", b.k(), v.field])) && !(await b.ctx.confirm({ title: "Campo já existe", message: `Substituir o valor de "${v.field}"?`, confirmLabel: "Substituir", danger: true }))) return false;
        b.check(await b.run(["HSET", b.k(), v.field, v.value]));
        b.refreshMeta();
        return true;
      } catch (e) {
        b.ctx.toast(String(e));
        return false;
      }
    },
    menu: (list, e) =>
      b.ctx.showMenu(e.clientX, e.clientY, [
        list.length === 1 ? { label: "Copiar campo", icon: "fa-regular fa-copy", run: () => b.ctx.copy(bulkLabel(list[0].field)) } : null,
        list.length === 1 ? { label: "Copiar valor", icon: "fa-regular fa-copy", run: () => b.ctx.copy(bulkLabel(list[0].value)) } : null,
        { label: "Copiar como JSON", icon: "fa-solid fa-code", run: () => b.ctx.copy(JSON.stringify(Object.fromEntries(list.map((r) => [bulkLabel(r.field), bulkLabel(r.value)])), null, 2)) },
        list.length === 1 ? { label: "Renomear campo…", icon: "fa-solid fa-i-cursor", run: () => renameField(list[0]) } : null,
        "sep",
        { label: list.length > 1 ? `Excluir ${list.length} campos` : "Excluir campo", icon: "fa-regular fa-trash-can", danger: true, run: () => del(list) },
      ]),
  });
  coll.type = "hash";
  return coll;
}

// ---------- list ----------

function listBody(b) {
  let coll;
  const DELETED = () => `__devsuite_removido__${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
  const del = async (list) => {
    const ok = await b.ctx.confirm({ title: list.length > 1 ? `Remover ${list.length} elementos?` : "Remover elemento?", message: "Os elementos são marcados (LSET) e removidos (LREM); se a lista mudar no meio, outro elemento pode ser afetado.", confirmLabel: "Remover", danger: true });
    if (!ok) return;
    try {
      const mark = DELETED();
      const res = await b.pipe([...list.map((r) => ["LSET", b.k(), String(r.index), mark]), ["LREM", b.k(), "0", mark]]);
      res.forEach(b.check);
      await coll.reload();
      b.refreshMeta();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  coll = collectionBody(b, {
    filter: false,
    columns: [
      { key: "index", label: "#", html: (r) => `<span class="rmq-zero">${r.index}</span>`, sort: (r) => r.index, align: "right", width: "70px" },
      { key: "value", label: "Valor", html: (r) => cellHtml(r.value), sort: (r) => bulkLabel(r.value) },
      { key: "size", label: "Tamanho", html: (r) => sizeCell(r.value), sort: (r) => bulkBytes(r.value).length, align: "right", width: "90px" },
    ],
    rowKey: (r) => String(r.index),
    fetch: async (cursor) => {
      const start = cursor ? Number(cursor) : 0;
      const r = b.check(await b.run(["LRANGE", b.k(), String(start), String(start + PAGE - 1)]));
      const items = (r.v || []).map((value, i) => ({ index: start + i, value }));
      return { rows: items, cursor: items.length < PAGE ? null : String(start + PAGE) };
    },
    valueOf: (r) => r.value,
    saveValue: async (r, v) => b.check(await b.run(["LSET", b.k(), String(r.index), argOf(v)])),
    add: async () => {
      const v = await itemDialog(b, {
        title: "Inserir elemento",
        fields: [
          { name: "where", label: "Onde", type: "select", value: "tail", options: [["tail", "No fim (RPUSH)"], ["head", "No início (LPUSH)"]] },
          { name: "value", label: "Valor", type: "textarea", rows: 6 },
        ],
      });
      if (!v) return false;
      try {
        b.check(await b.run([v.where === "head" ? "LPUSH" : "RPUSH", b.k(), v.value]));
        b.refreshMeta();
        return true;
      } catch (e) {
        b.ctx.toast(String(e));
        return false;
      }
    },
    menu: (list, e) =>
      b.ctx.showMenu(e.clientX, e.clientY, [
        list.length === 1 ? { label: "Copiar valor", icon: "fa-regular fa-copy", run: () => b.ctx.copy(bulkLabel(list[0].value)) } : null,
        { label: "Copiar como JSON", icon: "fa-solid fa-code", run: () => b.ctx.copy(JSON.stringify(list.map((r) => bulkLabel(r.value)), null, 2)) },
        "sep",
        { label: list.length > 1 ? `Remover ${list.length} elementos` : "Remover elemento", icon: "fa-regular fa-trash-can", danger: true, run: () => del(list) },
      ]),
  });
  coll.type = "list";
  return coll;
}

// ---------- set ----------

function setBody(b) {
  let coll;
  const del = async (list) => {
    const ok = await b.ctx.confirm({ title: list.length > 1 ? `Remover ${list.length} membros?` : "Remover membro?", message: list.map((r) => bulkLabel(r.value)).join(", "), confirmLabel: "Remover", danger: true });
    if (!ok) return;
    try {
      b.check(await b.run(["SREM", b.k(), ...list.map((r) => argOf(r.value))]));
      await coll.reload();
      b.refreshMeta();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  coll = collectionBody(b, {
    valueLabel: "Membro",
    columns: [
      { key: "value", label: "Membro", html: (r) => cellHtml(r.value), sort: (r) => bulkLabel(r.value) },
      { key: "size", label: "Tamanho", html: (r) => sizeCell(r.value), sort: (r) => bulkBytes(r.value).length, align: "right", width: "90px" },
    ],
    rowKey: (r) => `${r.value.t}:${r.value.v}`,
    filterPlaceholder: "Filtrar membros (SSCAN MATCH)",
    fetch: (cursor, filter) => scanPage(b, "SSCAN", cursor, filter, (list) => list.map((value) => ({ value }))),
    valueOf: (r) => r.value,
    // Editar um membro = trocar (SREM antigo + SADD novo).
    saveValue: async (r, v) => {
      const res = await b.pipe([["SREM", b.k(), argOf(r.value)], ["SADD", b.k(), argOf(v)]]);
      res.forEach(b.check);
    },
    add: async () => {
      const v = await itemDialog(b, { title: "Novos membros", fields: [{ name: "values", label: "Membros (um por linha)", type: "textarea", rows: 6 }] });
      const members = (v?.values || "").split(/\r?\n/).filter((x) => x !== "");
      if (!members.length) return false;
      try {
        const n = respInt(b.check(await b.run(["SADD", b.k(), ...members])));
        b.ctx.toast(`${fmtNum(n)} membro(s) adicionado(s)`);
        b.refreshMeta();
        return true;
      } catch (e) {
        b.ctx.toast(String(e));
        return false;
      }
    },
    menu: (list, e) =>
      b.ctx.showMenu(e.clientX, e.clientY, [
        { label: "Copiar", icon: "fa-regular fa-copy", run: () => b.ctx.copy(list.map((r) => bulkLabel(r.value)).join("\n")) },
        "sep",
        { label: list.length > 1 ? `Remover ${list.length} membros` : "Remover membro", icon: "fa-regular fa-trash-can", danger: true, run: () => del(list) },
      ]),
  });
  coll.type = "set";
  return coll;
}

// ---------- zset ----------

function zsetBody(b) {
  let coll;
  let desc = false;
  const del = async (list) => {
    const ok = await b.ctx.confirm({ title: list.length > 1 ? `Remover ${list.length} membros?` : "Remover membro?", message: list.map((r) => bulkLabel(r.value)).join(", "), confirmLabel: "Remover", danger: true });
    if (!ok) return;
    try {
      b.check(await b.run(["ZREM", b.k(), ...list.map((r) => argOf(r.value))]));
      await coll.reload();
      b.refreshMeta();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  const editScore = async (r) => {
    const v = await b.ctx.prompt({ title: "Alterar score", label: `Score de ${bulkLabel(r.value)}`, value: String(r.score) });
    if (v === null || !Number.isFinite(Number(v))) return;
    try {
      b.check(await b.run(["ZADD", b.k(), "XX", "CH", v, argOf(r.value)]));
      await coll.reload();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  const orderBtn = el("button.hx-btn.small", { type: "button", title: "Ordem por score", onclick: () => ((desc = !desc), (orderBtn.innerHTML = ""), orderBtn.append(icon(`fa-solid fa-arrow-${desc ? "down-wide-short" : "up-short-wide"}`)), coll.reload()) }, icon("fa-solid fa-arrow-up-short-wide"));
  const pairs = (list) => {
    const out = [];
    for (let i = 0; i + 1 < list.length; i += 2) out.push({ value: list[i], score: Number(respText(list[i + 1])) });
    return out;
  };
  coll = collectionBody(b, {
    valueLabel: "Membro",
    extraTools: [orderBtn],
    columns: [
      { key: "score", label: "Score", html: (r) => `<span class="rds-score">${esc(r.score)}</span>`, sort: (r) => r.score, align: "right", width: "130px" },
      { key: "value", label: "Membro", html: (r) => cellHtml(r.value), sort: (r) => bulkLabel(r.value) },
    ],
    rowKey: (r) => `${r.value.t}:${r.value.v}`,
    filterPlaceholder: "Filtrar membros (ZSCAN MATCH)",
    fetch: async (cursor, filter) => {
      if (filter) return scanPage(b, "ZSCAN", cursor, filter, pairs);
      const start = cursor ? Number(cursor) : 0;
      const args = ["ZRANGE", b.k(), String(start), String(start + PAGE - 1)];
      if (desc) args.push("REV");
      args.push("WITHSCORES");
      const r = b.check(await b.run(args));
      // RESP3 devolve pares [membro, score]; RESP2, lista plana.
      const list = r.v || [];
      const rows = list.length && list[0]?.t === "arr" ? list.map((p) => ({ value: p.v[0], score: Number(respText(p.v[1])) })) : pairs(list);
      return { rows, cursor: rows.length < PAGE ? null : String(start + PAGE) };
    },
    valueOf: (r) => r.value,
    saveValue: async (r, v) => {
      const res = await b.pipe([["ZREM", b.k(), argOf(r.value)], ["ZADD", b.k(), String(r.score), argOf(v)]]);
      res.forEach(b.check);
    },
    add: async () => {
      const v = await itemDialog(b, { title: "Novo membro", fields: [{ name: "score", label: "Score", type: "number", value: "0" }, { name: "value", label: "Membro", type: "textarea", rows: 4 }] });
      if (!v || !Number.isFinite(Number(v.score))) return false;
      try {
        b.check(await b.run(["ZADD", b.k(), String(v.score), v.value]));
        b.refreshMeta();
        return true;
      } catch (e) {
        b.ctx.toast(String(e));
        return false;
      }
    },
    menu: (list, e) =>
      b.ctx.showMenu(e.clientX, e.clientY, [
        list.length === 1 ? { label: "Alterar score…", icon: "fa-solid fa-hashtag", run: () => editScore(list[0]) } : null,
        { label: "Copiar como JSON", icon: "fa-solid fa-code", run: () => b.ctx.copy(JSON.stringify(list.map((r) => ({ member: bulkLabel(r.value), score: r.score })), null, 2)) },
        "sep",
        { label: list.length > 1 ? `Remover ${list.length} membros` : "Remover membro", icon: "fa-regular fa-trash-can", danger: true, run: () => del(list) },
      ]),
  });
  coll.type = "zset";
  return coll;
}

// ---------- stream ----------

function streamBody(b) {
  let coll;
  const fieldsOf = (entry) => {
    const list = entry.v?.[1]?.v || [];
    const out = [];
    for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]);
    return out;
  };
  const toObj = (fields) => Object.fromEntries(fields.map(([f, v]) => [bulkLabel(f), bulkLabel(v)]));
  const del = async (list) => {
    const ok = await b.ctx.confirm({ title: list.length > 1 ? `Excluir ${list.length} entradas?` : "Excluir entrada?", message: list.map((r) => r.id).join(", "), confirmLabel: "Excluir", danger: true });
    if (!ok) return;
    try {
      b.check(await b.run(["XDEL", b.k(), ...list.map((r) => r.id)]));
      await coll.reload();
      b.refreshMeta();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  const trim = async () => {
    const v = await b.ctx.form({
      title: "Aparar stream (XTRIM)",
      fields: [
        { name: "kind", label: "Critério", type: "select", value: "MAXLEN", options: [["MAXLEN", "Manter as N entradas mais novas (MAXLEN)"], ["MINID", "Remover ids menores que (MINID)"]] },
        { name: "value", label: "Valor", placeholder: "ex.: 1000 ou 1700000000000-0" },
        { name: "approx", label: "Aproximado (~, mais rápido)", type: "check", value: true },
      ],
      confirmLabel: "Aparar",
      danger: true,
      validate: (x) => (!x.value.trim() ? "Informe o valor." : ""),
    });
    if (!v) return;
    try {
      const n = respInt(b.check(await b.run(["XTRIM", b.k(), v.kind, ...(v.approx ? ["~"] : []), v.value.trim()])));
      b.ctx.toast(`${fmtNum(n)} entrada(s) removida(s)`);
      await coll.reload();
      b.refreshMeta();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  };
  const groupsBtn = el("button.hx-btn.small", { type: "button", title: "Grupos de consumidores", onclick: () => toggleGroups() }, icon("fa-solid fa-users"), " Grupos");
  const trimBtn = el("button.hx-btn.small", { type: "button", title: "Aparar (XTRIM)", onclick: () => trim() }, icon("fa-solid fa-scissors"));
  coll = collectionBody(b, {
    filter: false,
    readOnly: true,
    valueLabel: "Entrada (somente leitura: entradas de stream não mudam)",
    extraTools: [groupsBtn, trimBtn],
    columns: [
      { key: "id", label: "ID", html: (r) => `<span class="rds-mono">${esc(r.id)}</span>`, sort: (r) => r.id, width: "190px" },
      { key: "at", label: "Data", html: (r) => `<span class="rmq-zero">${r.at ? esc(fmtTime(r.at)) : ""}</span>`, sort: (r) => r.at, width: "170px" },
      { key: "fields", label: "Campos", html: (r) => `<span class="rds-cell">${esc(r.fields.map(([f, v]) => `${bulkLabel(f)}=${preview(v)}`).join("  ").slice(0, 400))}</span>` },
    ],
    rowKey: (r) => r.id,
    fetch: async (cursor) => {
      // Mais novas primeiro; a página seguinte começa antes do último id visto ("(id").
      const end = cursor ? `(${cursor}` : "+";
      const r = b.check(await b.run(["XREVRANGE", b.k(), end, "-", "COUNT", String(PAGE)]));
      const rows = (r.v || []).map((e) => {
        const id = respText(e.v[0]);
        return { id, at: streamIdTime(id), fields: fieldsOf(e) };
      });
      return { rows, cursor: rows.length < PAGE ? null : rows[rows.length - 1].id };
    },
    valueOf: (r) => ({ t: "str", v: JSON.stringify(toObj(r.fields)) }),
    saveValue: async () => {},
    add: async () => {
      const v = await itemDialog(b, {
        title: "Nova entrada (XADD)",
        fields: [
          { name: "id", label: "ID", value: "*", hint: "* = gerado pelo servidor" },
          { name: "fields", label: "Campos (campo=valor, um por linha)", type: "textarea", rows: 6, value: "campo=valor" },
        ],
      });
      if (!v) return false;
      const pairs = v.fields
        .split(/\r?\n/)
        .filter((l) => l.includes("="))
        .flatMap((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i), l.slice(i + 1)];
        });
      if (!pairs.length) return false;
      try {
        const id = respText(b.check(await b.run(["XADD", b.k(), v.id.trim() || "*", ...pairs])));
        b.ctx.toast(`Entrada ${id} adicionada`);
        b.refreshMeta();
        return true;
      } catch (e) {
        b.ctx.toast(String(e));
        return false;
      }
    },
    menu: (list, e) =>
      b.ctx.showMenu(e.clientX, e.clientY, [
        { label: "Copiar como JSON", icon: "fa-solid fa-code", run: () => b.ctx.copy(JSON.stringify(list.map((r) => ({ id: r.id, ...toObj(r.fields) })), null, 2)) },
        { label: "Copiar ID", icon: "fa-regular fa-copy", run: () => b.ctx.copy(list.map((r) => r.id).join("\n")) },
        "sep",
        { label: list.length > 1 ? `Excluir ${list.length} entradas` : "Excluir entrada", icon: "fa-regular fa-trash-can", danger: true, run: () => del(list) },
      ]),
  });

  const groups = streamGroups(b);
  groups.root.hidden = true;
  const root = el("div.rds-stream", {}, coll.root, groups.root);
  function toggleGroups() {
    groups.root.hidden = !groups.root.hidden;
    groupsBtn.classList.toggle("on", !groups.root.hidden);
    if (!groups.root.hidden) groups.load();
  }
  return {
    type: "stream",
    root,
    load: async () => {
      await coll.load();
      if (!groups.root.hidden) groups.load();
    },
    refresh: coll.refresh,
    get dirty() {
      return false;
    },
  };
}

/** Grupos de consumidores: XINFO GROUPS/CONSUMERS, XPENDING, XACK, XCLAIM, criar/excluir/SETID. */
function streamGroups(b) {
  let group = null;
  const groupTable = createTable({
    columns: [
      { key: "name", label: "Grupo", html: (r) => `<strong>${esc(r.name)}</strong>`, sort: (r) => r.name },
      { key: "consumers", label: "Consumidores", html: (r) => fmtNum(r.consumers), sort: (r) => r.consumers, align: "right" },
      { key: "pending", label: "Pendentes", html: (r) => (r.pending ? `<span class="rds-warn">${fmtNum(r.pending)}</span>` : "0"), sort: (r) => r.pending, align: "right" },
      { key: "lag", label: "Lag", html: (r) => (r.lag === null || r.lag === undefined ? "—" : fmtNum(r.lag)), sort: (r) => r.lag, align: "right", title: "Entradas ainda não entregues ao grupo (Redis 7+)" },
      { key: "last", label: "Último entregue", html: (r) => `<span class="rds-mono">${esc(r["last-delivered-id"])}</span>`, sort: (r) => r["last-delivered-id"] },
    ],
    rowKey: (r) => r.name,
    onSelect: (list) => list.length === 1 && openGroup(list[0].name),
    onMenu: (list, e) => groupMenu(list[0], e),
    emptyText: "Nenhum grupo. Crie um para consumir com XREADGROUP.",
  });
  const consumerTable = createTable({
    columns: [
      { key: "name", label: "Consumidor", html: (r) => esc(r.name), sort: (r) => r.name },
      { key: "pending", label: "Pendentes", html: (r) => fmtNum(r.pending), sort: (r) => r.pending, align: "right" },
      { key: "idle", label: "Ocioso", html: (r) => `${fmtNum(Math.round((r.idle || 0) / 1000))} s`, sort: (r) => r.idle, align: "right" },
    ],
    rowKey: (r) => r.name,
    onMenu: (list, e) =>
      b.ctx.showMenu(e.clientX, e.clientY, [
        { label: "Excluir consumidor (as pendentes dele são perdidas)", icon: "fa-regular fa-trash-can", danger: true, run: () => groupCmd(["XGROUP", "DELCONSUMER", b.k(), group, list[0].name], "Consumidor excluído") },
      ]),
    emptyText: "Nenhum consumidor.",
  });
  const pendingTable = createTable({
    columns: [
      { key: "id", label: "ID", html: (r) => `<span class="rds-mono">${esc(r.id)}</span>`, sort: (r) => r.id },
      { key: "consumer", label: "Consumidor", html: (r) => esc(r.consumer), sort: (r) => r.consumer },
      { key: "idle", label: "Ocioso", html: (r) => `${fmtNum(Math.round(r.idle / 1000))} s`, sort: (r) => r.idle, align: "right" },
      { key: "deliveries", label: "Entregas", html: (r) => (r.deliveries > 1 ? `<span class="rds-warn">${r.deliveries}</span>` : String(r.deliveries)), sort: (r) => r.deliveries, align: "right" },
    ],
    rowKey: (r) => r.id,
    onMenu: (list, e) => pendingMenu(list, e),
    emptyText: "Nada pendente (sem XACK).",
  });
  const groupTitle = el("span.rds-sub-title");
  const detail = el("div.rds-groups-detail", { hidden: true }, el("div.rds-sub-head", {}, groupTitle), el("div.rds-groups-cols", {}, el("div", {}, el("h4", {}, "Consumidores"), consumerTable.root), el("div", {}, el("h4", {}, "Pendentes (XPENDING, até 500)"), pendingTable.root)));
  const root = el(
    "div.rds-groups",
    {},
    el(
      "div.rds-sub-head",
      {},
      el("h3", {}, icon("fa-solid fa-users"), " Grupos de consumidores"),
      el("span.hx-flex"),
      el("button.hx-btn.small", { type: "button", onclick: () => createGroup() }, icon("fa-solid fa-plus"), " Novo grupo"),
      el("button.hx-btn.small", { type: "button", title: "Atualizar", onclick: () => load() }, icon("fa-solid fa-rotate")),
    ),
    groupTable.root,
    detail,
  );

  async function load() {
    try {
      const r = b.check(await b.run(["XINFO", "GROUPS", b.k()]));
      groupTable.setRows((r.v || []).map((g) => respObject(g)));
      if (group) openGroup(group);
    } catch (e) {
      b.ctx.toast(String(e));
    }
  }

  async function openGroup(name) {
    group = name;
    detail.hidden = false;
    groupTitle.textContent = `Grupo ${name}`;
    try {
      const [cons, pend] = await b.pipe([["XINFO", "CONSUMERS", b.k(), name], ["XPENDING", b.k(), name, "-", "+", "500"]]);
      consumerTable.setRows((b.check(cons).v || []).map((c) => respObject(c)));
      pendingTable.setRows((b.check(pend).v || []).map((p) => ({ id: respText(p.v[0]), consumer: respText(p.v[1]), idle: respInt(p.v[2]), deliveries: respInt(p.v[3]) })));
    } catch (e) {
      b.ctx.toast(String(e));
    }
  }

  async function groupCmd(args, ok) {
    try {
      b.check(await b.run(args));
      b.ctx.toast(ok);
      await load();
    } catch (e) {
      b.ctx.toast(String(e));
    }
  }

  async function createGroup() {
    const v = await b.ctx.form({
      title: "Novo grupo de consumidores",
      fields: [
        { name: "name", label: "Nome do grupo" },
        { name: "id", label: "Começar a partir de", type: "select", value: "$", options: [["$", "Só entradas novas ($)"], ["0", "Desde o início (0)"]] },
      ],
      validate: (x) => (!x.name.trim() ? "Informe o nome." : ""),
    });
    if (v) groupCmd(["XGROUP", "CREATE", b.k(), v.name.trim(), v.id], "Grupo criado");
  }

  async function groupMenu(g, e) {
    b.ctx.showMenu(e.clientX, e.clientY, [
      {
        label: "Mudar último entregue (SETID)…",
        icon: "fa-solid fa-backward",
        run: async () => {
          const id = await b.ctx.prompt({ title: "XGROUP SETID", label: "Novo último id entregue", value: g["last-delivered-id"], hint: "0 = reprocessar tudo; $ = só as próximas" });
          if (id) groupCmd(["XGROUP", "SETID", b.k(), g.name, id.trim()], "Último entregue alterado");
        },
      },
      "sep",
      {
        label: "Excluir grupo…",
        icon: "fa-regular fa-trash-can",
        danger: true,
        run: async () => {
          const ok = await b.ctx.danger(b.conn(), { title: "Excluir grupo?", message: `O grupo "${g.name}" e suas ${fmtNum(g.pending)} pendente(s) serão removidos.`, name: g.name, confirmLabel: "Excluir" });
          if (!ok) return;
          group = null;
          groupCmd(["XGROUP", "DESTROY", b.k(), g.name], "Grupo excluído");
        },
      },
    ]);
  }

  function pendingMenu(list, e) {
    const ids = list.map((r) => r.id);
    b.ctx.showMenu(e.clientX, e.clientY, [
      { label: `Confirmar (XACK) ${ids.length > 1 ? `${ids.length} entradas` : ""}`, icon: "fa-solid fa-check", run: () => groupCmd(["XACK", b.k(), group, ...ids], `${ids.length} entrada(s) confirmada(s)`) },
      {
        label: "Transferir para consumidor (XCLAIM)…",
        icon: "fa-solid fa-right-left",
        run: async () => {
          const to = await b.ctx.prompt({ title: "XCLAIM", label: "Consumidor de destino", value: "" });
          if (to) groupCmd(["XCLAIM", b.k(), group, to.trim(), "0", ...ids, "JUSTID"], "Entradas transferidas");
        },
      },
      { label: "Copiar IDs", icon: "fa-regular fa-copy", run: () => b.ctx.copy(ids.join("\n")) },
    ]);
  }

  return { root, load };
}

// ---------- RedisJSON ----------

function jsonBody(b) {
  const editor = valueEditor({
    label: "Documento JSON",
    onCopy: (t) => b.ctx.copy(t, "JSON copiado"),
    onSave: async (v) => {
      b.check(await b.run(["JSON.SET", b.k(), "$", argOf(v)]));
      b.ctx.toast("Documento salvo");
      b.refreshMeta();
    },
  });
  const root = el("div.rds-string", {}, editor.root);
  async function load() {
    const r = b.check(await b.run(["JSON.GET", b.k()]));
    editor.set(r);
  }
  return { type: "ReJSON-RL", root, load, refresh: editor.refresh, get dirty() { return editor.dirty; } };
}

// ---------- outros tipos (módulos) ----------

function otherBody(b, type) {
  const root = el(
    "div.db-placeholder",
    {},
    icon("fa-solid fa-puzzle-piece"),
    el("p", {}, `Tipo ${type} (módulo) não tem editor próprio. Use o console com os comandos do módulo.`),
    el("button.hx-btn.primary", { type: "button", onclick: () => b.ctx.openConsole(b.conn(), b.tab.db, `TYPE ${quoteArg(b.k())}`) }, icon("fa-solid fa-terminal"), " Abrir console"),
  );
  return { type, root, load: async () => {}, dirty: false };
}

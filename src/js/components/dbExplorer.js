import { el, icon } from "../utils/dom.js";
import { escapeHtml } from "../utils/noteContent.js";
import { connLabel, metaSession, target, isMongo } from "../utils/dbModel.js";
import { toShell } from "../utils/mongoValue.js";
import { dbApi } from "../api.js";

// Database Explorer: árvore carregada sob demanda.
// conexão → bancos → schemas → (tabelas | views | procedures | funções) → objeto → (colunas | chaves | índices | FKs | triggers)
// Cada banco aberto mostra antes "consultas salvas" (pastas → consultas), montado do
// databases.json a cada desenho, sem rede.

const SYSTEM_DBS = new Set(["master", "tempdb", "model", "msdb"]);
const MONGO_SYSTEM_DBS = new Set(["admin", "local", "config"]);
const FOLDERS = [
  ["table", "tabelas", "fa-regular fa-folder"],
  ["view", "views", "fa-regular fa-folder"],
  ["procedure", "procedures", "fa-regular fa-folder"],
  ["function", "funções", "fa-regular fa-folder"],
];
const TABLE_GROUPS = [
  ["column", "colunas"],
  ["key", "chaves"],
  ["fk", "chaves estrangeiras"],
  ["index", "índices"],
  ["trigger", "triggers"],
];
const ICONS = {
  conn: "fa-solid fa-server",
  database: "fa-solid fa-database",
  sysfolder: "fa-regular fa-folder",
  schema: "fa-solid fa-sitemap",
  folder: "fa-regular fa-folder",
  group: "fa-regular fa-folder",
  table: "fa-solid fa-table",
  view: "fa-solid fa-eye",
  procedure: "fa-solid fa-gears",
  function: "fa-solid fa-square-root-variable",
  column: "fa-solid fa-table-columns",
  key: "fa-solid fa-key",
  index: "fa-solid fa-arrow-down-a-z",
  fk: "fa-solid fa-link",
  trigger: "fa-solid fa-bolt",
  param: "fa-solid fa-at",
  collection: "fa-solid fa-layer-group",
  mview: "fa-solid fa-eye",
  field: "fa-solid fa-tag",
  qroot: "fa-solid fa-bookmark",
  query: "fa-regular fa-file-code",
};

const collator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });

const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/**
 * ctx: { data, conn(id), status(connId), ensureConnected(conn), disconnect(conn), openTable, openDdl,
 *        openConsole, editConnection, deleteConnection, duplicateConnection, showMenu, copy,
 *        copyConnectionString(conn, { withPassword }), saveUi, toast,
 *        schema: { modify, newTable, rename, drop, truncate, renameItem, dropItem },
 *        perf: { open(conn, database, section, patch), openPlanFile(conn, database) },
 *        queries: { list(connId, database, isDefault), get, open(q, { run }), create, edit, duplicate, move, remove, removeFolder, renameFolder } }
 */
export function createExplorer(ctx, { treeEl, searchEl }) {
  const nodes = new Map(); // key -> node
  const expanded = new Set(ctx.data().ui.expanded);
  let selected = null;
  let query = "";
  let frame = 0;

  // ---------- Nós ----------

  function node(key, init) {
    let n = nodes.get(key);
    if (!n) {
      n = { key, children: null, loading: false, error: "", ...init };
      nodes.set(key, n);
    } else Object.assign(n, init);
    return n;
  }

  function connNode(conn) {
    return node(`c:${conn.id}`, { kind: "conn", label: connLabel(conn), connId: conn.id, database: "" });
  }

  function dropSubtree(key) {
    for (const k of [...nodes.keys()]) if (k !== key && k.startsWith(`${key}`) && k.length > key.length && k[key.length] === "/") nodes.delete(k);
  }

  async function load(n) {
    const conn = ctx.conn(n.connId);
    if (!conn || n.loading) return;
    n.loading = true;
    n.error = "";
    schedule();
    try {
      n.children = await fetchChildren(n, conn);
    } catch (e) {
      n.error = String(e);
      n.children = null;
      // Banco com consultas salvas continua aberto: elas não dependem do servidor.
      if (!(n.kind === "database" && savedRoot(n))) expanded.delete(n.key);
    } finally {
      n.loading = false;
      schedule();
    }
  }

  const tgt = (conn, database) => target(conn, metaSession(conn.id, database), database);

  async function fetchChildren(n, conn) {
    const k = n.key;
    if (n.kind === "conn") {
      const info = await ctx.ensureConnected(conn);
      const list = await dbApi.introspect(tgt(conn, ""), { kind: "databases" });
      const current = info?.database || conn.database;
      const sysSet = isMongo(conn) ? MONGO_SYSTEM_DBS : SYSTEM_DBS;
      const user = list.filter((d) => !sysSet.has(d.name) || d.name === current);
      const system = list.filter((d) => sysSet.has(d.name) && d.name !== current);
      const keys = user.map((d) => node(`${k}/d:${d.name}`, { kind: "database", label: d.name, connId: conn.id, database: d.name, current: d.name === current }).key);
      if (system.length) {
        const sys = node(`${k}/sys`, { kind: "sysfolder", label: "bancos de sistema", connId: conn.id, count: system.length });
        sys.children = system.map((d) => node(`${k}/d:${d.name}`, { kind: "database", label: d.name, connId: conn.id, database: d.name }).key);
        keys.push(sys.key);
      }
      // Reabre a árvore como estava; sem histórico, abre o banco padrão (como o DataGrip).
      const cur = keys.find((key) => nodes.get(key).current);
      const hadState = [...expanded].some((e) => e.startsWith(`${k}/`));
      setTimeout(() => (hadState ? restoreExpanded(k) : cur && toggle(cur, true)), 0);
      return keys;
    }
    if (n.kind === "qroot" || n.kind === "qfolder") return n.children || [];
    if (isMongo(conn)) return fetchMongo(n, conn);
    if (n.kind === "database") {
      const list = await dbApi.introspect(tgt(conn, n.database), { kind: "schemas" });
      const keys = list.map((s) => node(`${k}/s:${s.name}`, { kind: "schema", label: s.name, connId: conn.id, database: n.database, schema: s.name, count: s.rows ?? null }).key);
      // Um único schema com objetos (geralmente dbo) já abre.
      const withObjects = list.filter((s) => s.rows);
      if (withObjects.length === 1) {
        const only = keys[list.indexOf(withObjects[0])];
        if (!expanded.has(only)) setTimeout(() => toggle(only, true), 0);
      }
      return keys;
    }
    if (n.kind === "schema") {
      const list = await dbApi.introspect(tgt(conn, n.database), { kind: "schema", schema: n.schema });
      const keys = [];
      for (const [kind, label, ic] of FOLDERS) {
        const items = list.filter((o) => o.kind === kind);
        if (!items.length) continue;
        const folder = node(`${k}/f:${kind}`, { kind: "folder", label, icon: ic, connId: conn.id, database: n.database, schema: n.schema, count: items.length });
        folder.children = items.map(
          (o) =>
            node(`${folder.key}/o:${o.name}`, {
              kind: o.kind,
              label: o.name,
              connId: conn.id,
              database: n.database,
              schema: n.schema,
              name: o.name,
              rows: o.rows ?? null,
            }).key,
        );
        keys.push(folder.key);
      }
      return keys;
    }
    if (n.kind === "table" || n.kind === "view") {
      const list = await dbApi.introspect(tgt(conn, n.database), { kind: n.kind, schema: n.schema, name: n.name });
      const keys = [];
      for (const [kind, label] of TABLE_GROUPS) {
        const items = list.filter((o) => o.kind === kind);
        if (!items.length) continue;
        const group = node(`${k}/g:${kind}`, { kind: "group", label, group: kind, connId: conn.id, database: n.database, schema: n.schema, table: n.name, tableKind: n.kind, count: items.length });
        group.children = items.map(
          (o, i) =>
            node(`${group.key}/${i}:${o.name}`, {
              kind,
              label: o.name,
              detail: o.detail || "",
              flag: !!o.flag,
              connId: conn.id,
              database: n.database,
              schema: n.schema,
              name: kind === "trigger" ? o.name : n.name,
              table: n.name,
              tableKind: n.kind,
            }).key,
        );
        group.children.length && keys.push(group.key);
      }
      return keys;
    }
    if (n.kind === "procedure" || n.kind === "function") {
      const list = await dbApi.introspect(tgt(conn, n.database), { kind: n.kind, schema: n.schema, name: n.name });
      n.params = list;
      return list.map((p, i) => node(`${k}/p${i}`, { kind: "param", label: p.name, detail: p.detail, connId: conn.id }).key);
    }
    return [];
  }

  /** MongoDB: banco → (coleções | views) → coleção → (campos | índices). */
  async function fetchMongo(n, conn) {
    const k = n.key;
    if (n.kind === "database") {
      const list = await dbApi.introspect(tgt(conn, n.database), { kind: "collections" });
      const keys = [];
      for (const [kind, label] of [
        ["collection", "coleções"],
        ["view", "views"],
      ]) {
        const items = list.filter((o) => o.kind === kind);
        if (!items.length) continue;
        const folder = node(`${k}/f:${kind}`, { kind: "folder", label, connId: conn.id, database: n.database, count: items.length });
        folder.children = items.map(
          (o) => node(`${folder.key}/o:${o.name}`, { kind: kind === "view" ? "mview" : "collection", label: o.name, connId: conn.id, database: n.database, schema: "", name: o.name }).key,
        );
        keys.push(folder.key);
        // A pasta de coleções já abre (é quase sempre o que se quer ver).
        if (kind === "collection" && !expanded.has(folder.key)) expanded.add(folder.key);
      }
      return keys;
    }
    if (n.kind === "collection" || n.kind === "mview") {
      const list = await dbApi.introspect(tgt(conn, n.database), { kind: n.kind === "mview" ? "view" : "collection", name: n.name });
      const keys = [];
      for (const [kind, label] of [
        ["field", "campos (amostra)"],
        ["index", "índices"],
      ]) {
        const items = list.filter((o) => o.kind === kind);
        if (!items.length) continue;
        const group = node(`${k}/g:${kind}`, { kind: "group", label, connId: conn.id, count: items.length });
        group.children = items.map((o, i) => node(`${group.key}/${i}:${o.name}`, { kind, label: o.name, detail: o.detail || "", flag: !!o.flag, connId: conn.id }).key);
        keys.push(group.key);
      }
      return keys;
    }
    return [];
  }

  function expandable(n) {
    return ["conn", "database", "sysfolder", "schema", "folder", "group", "table", "view", "procedure", "function", "collection", "mview", "qroot", "qfolder"].includes(n.kind);
  }

  // ---------- Consultas salvas ----------

  /** Nó "consultas salvas" do banco (null sem consultas), com pastas e itens já montados. */
  function savedRoot(db) {
    const list = ctx.queries.list(db.connId, db.database, !!db.current);
    if (!list.length) return null;
    const scope = { connId: db.connId, database: db.database, isDefault: !!db.current };
    const root = node(`${db.key}/q`, { kind: "qroot", label: "consultas salvas", ...scope, folder: "", count: list.length });
    const build = (parent, prefix) => {
      const subs = new Set();
      const items = [];
      for (const q of list) {
        if (q.folder === prefix) items.push(q);
        else if (!prefix || q.folder.startsWith(`${prefix}/`)) subs.add(q.folder.slice(prefix ? prefix.length + 1 : 0).split("/")[0]);
      }
      const keys = [];
      for (const name of [...subs].sort(collator.compare)) {
        const path = prefix ? `${prefix}/${name}` : name;
        const count = list.filter((q) => q.folder === path || q.folder.startsWith(`${path}/`)).length;
        const f = node(`${parent.key}/qf:${encodeURIComponent(name)}`, { kind: "qfolder", label: name, ...scope, folder: path, count });
        build(f, path);
        keys.push(f.key);
      }
      items.sort((a, b) => collator.compare(a.name, b.name));
      for (const q of items) keys.push(node(`${parent.key}/qi:${q.id}`, { kind: "query", label: q.name, ...scope, folder: q.folder, queryId: q.id, title: q.description }).key);
      parent.children = keys;
    };
    build(root, "");
    return root;
  }

  /** Filhos para desenhar: num banco, "consultas salvas" vem antes do que veio do servidor. */
  function kids(n) {
    if (n.kind !== "database") return n.children || [];
    const root = savedRoot(n);
    if (!root) return n.children || [];
    return [root.key, ...(n.children || [])];
  }

  async function toggle(key, open = !expanded.has(key)) {
    if (!nodes.has(key) && key.startsWith("c:") && !key.includes("/")) {
      const c = ctx.conn(key.slice(2));
      if (c) connNode(c);
    }
    const n = nodes.get(key);
    if (!n || !expandable(n)) return;
    if (open) {
      expanded.add(key);
      if (!n.children) await load(n);
    } else expanded.delete(key);
    persistExpanded();
    schedule();
  }

  let saveTimer = 0;
  function persistExpanded() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const conns = new Set(ctx.data().connections.map((c) => `c:${c.id}`));
      ctx.data().ui.expanded = [...expanded].filter((k) => conns.has(k.split("/")[0])).slice(0, 400);
      ctx.saveUi();
    }, 800);
  }

  async function refresh(key) {
    const n = nodes.get(key);
    if (!n) return;
    const target = expandable(n) ? n : nodes.get(key.slice(0, key.lastIndexOf("/")));
    if (!target) return;
    dropSubtree(target.key);
    target.children = null;
    if (expanded.has(target.key)) await load(target);
    schedule();
  }

  /** Recarrega os nós que estavam abertos dentro de `prefix` (pais antes dos filhos). */
  async function restoreExpanded(prefix) {
    const keys = [...expanded].filter((k) => k.startsWith(`${prefix}/`)).sort((a, b) => a.split("/").length - b.split("/").length);
    for (const k of keys) {
      const n = nodes.get(k);
      if (n && expandable(n) && !n.children) await load(n);
    }
    schedule();
  }

  // ---------- Renderização ----------

  /** Linhas visíveis (pré-ordem), respeitando expansão e a busca. */
  function flatten() {
    const rows = [];
    const conns = ctx.data().connections;
    const q = query.toLowerCase();
    const matches = (n) => !q || n.label.toLowerCase().includes(q);
    // Na busca, mostra um nó se ele ou algum descendente carregado combina.
    const hasMatch = (n) => {
      if (matches(n)) return true;
      return kids(n).some((k) => {
        const c = nodes.get(k);
        return c && hasMatch(c);
      });
    };
    const walk = (n, depth) => {
      if (q && !hasMatch(n)) return;
      rows.push({ n, depth });
      const children = kids(n);
      const open = expanded.has(n.key) || (q && children.length && n.kind !== "conn" && children.some((k) => hasMatch(nodes.get(k))));
      if (open) for (const k of children) walk(nodes.get(k), depth + 1);
    };
    for (const c of conns) walk(connNode(c), 0);
    return rows;
  }

  function rowHtml({ n, depth }) {
    const exp = expandable(n);
    const open = expanded.has(n.key);
    const conn = ctx.conn(n.connId);
    let ic = n.icon || ICONS[n.kind] || "fa-regular fa-circle";
    if (n.kind === "folder" || n.kind === "group" || n.kind === "sysfolder" || n.kind === "qfolder") ic = open ? "fa-regular fa-folder-open" : "fa-regular fa-folder";
    if (n.kind === "conn" && /\.database\.windows\.net$/i.test(conn?.host || "")) ic = "fa-brands fa-microsoft";
    if (n.kind === "conn" && isMongo(conn)) ic = "fa-solid fa-leaf";
    let extra = "";
    if (n.kind === "conn") {
      const st = ctx.status(n.connId);
      extra = `<span class="dbx-state ${st.state}" title="${escapeHtml(st.error || st.title || "")}"></span>`;
      if (conn?.read_only) extra += '<i class="fa-solid fa-lock dbx-ro" title="Somente leitura"></i>';
    }
    let meta = "";
    if (n.kind === "database" && n.current) meta = '<span class="dbx-meta">padrão</span>';
    if (n.count !== undefined && n.count !== null) meta = `<span class="dbx-meta">${n.count}</span>`;
    if ((n.kind === "table" || n.kind === "view") && n.rows !== null && n.rows !== undefined) meta = `<span class="dbx-meta" title="${n.rows.toLocaleString("pt-BR")} linhas (estimativa)">${fmtCount(n.rows)}</span>`;
    if (n.detail) meta = `<span class="dbx-detail">${escapeHtml(n.detail)}</span>`;
    const status = n.loading ? '<i class="fa-solid fa-spinner fa-spin dbx-spin"></i>' : n.error ? `<i class="fa-solid fa-triangle-exclamation dbx-err" title="${escapeHtml(n.error)}"></i>` : "";
    const color = n.kind === "conn" && conn?.color ? ` style="--conn:${conn.color}"` : "";
    return (
      `<div class="dbx-row k-${n.kind}${n.key === selected ? " sel" : ""}${n.flag ? " flag" : ""}${n.kind === "conn" && conn?.color ? " colored" : ""}" data-key="${escapeHtml(n.key)}"${(n.kind === "conn" && !query) || n.kind === "query" ? ' draggable="true"' : ""}${n.title ? ` title="${escapeHtml(n.title)}"` : ""} style="padding-left:${6 + depth * 14}px"${color}>` +
      `<span class="dbx-caret">${exp ? `<i class="fa-solid fa-chevron-${open ? "down" : "right"}"></i>` : ""}</span>` +
      `<i class="${ic} dbx-icon"></i><span class="dbx-label">${escapeHtml(n.label)}</span>${extra}${meta}${status}</div>` +
      (n.error && n.kind === "conn" ? `<div class="dbx-error" style="padding-left:${26 + depth * 14}px">${escapeHtml(n.error)}</div>` : "")
    );
  }

  let flat = [];
  function render() {
    frame = 0;
    flat = flatten();
    if (!ctx.data().connections.length) {
      treeEl.innerHTML = "";
      treeEl.append(
        el(
          "div.dbx-empty",
          {},
          icon("fa-solid fa-database"),
          el("p", {}, "Nenhuma conexão"),
          el("button.hx-btn.primary", { type: "button", onclick: () => ctx.newConnection() }, icon("fa-solid fa-plus"), " Nova conexão"),
        ),
      );
      return;
    }
    treeEl.innerHTML = flat.map(rowHtml).join("");
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function select(key, { reveal = true } = {}) {
    selected = key;
    render();
    if (reveal) treeEl.querySelector(".dbx-row.sel")?.scrollIntoView({ block: "nearest" });
  }

  // ---------- Ações ----------

  const connIndex = (id) => ctx.data().connections.findIndex((c) => c.id === id);

  /** Reordena as conexões: `id` passa a ocupar a posição `to` (a ordem do array é a da árvore). */
  function moveConn(id, to) {
    const list = ctx.data().connections;
    const from = connIndex(id);
    if (from < 0 || to < 0 || to >= list.length || from === to) return;
    list.splice(to, 0, ...list.splice(from, 1));
    ctx.saveUi();
    ctx.onConnectionsReordered?.();
    render();
  }

  function objectRef(n) {
    return { conn: ctx.conn(n.connId), database: n.database, schema: n.schema, name: n.name, kind: n.kind };
  }

  function activate(n) {
    if (!n) return;
    if (n.kind === "table" || n.kind === "view") return ctx.openTable(objectRef(n));
    if (n.kind === "collection" || n.kind === "mview") return ctx.openTable({ ...objectRef(n), kind: n.kind === "mview" ? "view" : "collection" });
    if (n.kind === "field") return ctx.copy(n.label, `"${n.label}" copiado`);
    if (n.kind === "procedure" || n.kind === "function" || n.kind === "trigger") return ctx.openDdl({ ...objectRef(n), kind: n.kind });
    if (n.kind === "column") return ctx.copy(n.label, `"${n.label}" copiado`);
    if (n.kind === "query") {
      const q = ctx.queries.get(n.queryId);
      return q && ctx.queries.open(q);
    }
    if (expandable(n)) toggle(n.key);
  }

  function menuFor(n, x, y) {
    const conn = ctx.conn(n.connId);
    if (!conn) return;
    const st = ctx.status(conn.id);
    const items = [];
    const consoleItem = (database) => ({ label: "Novo console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn, database) });
    const perf = (database, section, patch) => () => ctx.perf.open(conn, database, section, patch);
    if (n.kind === "query") {
      const q = ctx.queries.get(n.queryId);
      if (!q) return;
      items.push(
        { label: "Executar", icon: "fa-solid fa-play", run: () => ctx.queries.open(q, { run: true }) },
        { label: "Abrir no console", icon: "fa-solid fa-terminal", run: () => ctx.queries.open(q) },
        "sep",
        { label: "Editar detalhes…", icon: "fa-solid fa-pen", run: () => ctx.queries.edit(q) },
        { label: "Duplicar", icon: "fa-regular fa-copy", run: () => ctx.queries.duplicate(q) },
        { label: isMongo(conn) ? "Copiar comando" : "Copiar SQL", icon: "fa-regular fa-clipboard", run: () => ctx.copy(q.sql, "Copiado") },
        "sep",
        { label: "Excluir", icon: "fa-regular fa-trash-can", danger: true, run: () => ctx.queries.remove(q) },
      );
      return ctx.showMenu(x, y, items);
    }
    if (n.kind === "qroot" || n.kind === "qfolder") {
      const scope = { connId: n.connId, database: n.database, isDefault: n.isDefault, folder: n.folder };
      items.push(
        { label: "Nova consulta…", icon: "fa-solid fa-plus", run: () => ctx.openConsole(conn, n.database) },
        n.kind === "qfolder" ? { label: "Renomear pasta…", icon: "fa-solid fa-i-cursor", run: () => ctx.queries.renameFolder(scope) } : null,
        "sep",
        { label: n.kind === "qfolder" ? "Excluir pasta e consultas" : "Excluir todas as consultas", icon: "fa-regular fa-trash-can", danger: true, run: () => ctx.queries.removeFolder(scope) },
      );
      return ctx.showMenu(x, y, items);
    }
    if (n.kind === "conn") {
      items.push(
        st.state === "connected"
          ? { label: "Desconectar", icon: "fa-solid fa-plug-circle-xmark", run: () => disconnect(conn) }
          : { label: "Conectar", icon: "fa-solid fa-plug", run: () => toggle(n.key, true) },
        consoleItem(conn.database),
        { label: "Atualizar", icon: "fa-solid fa-rotate", run: () => refresh(n.key) },
        isMongo(conn) ? null : "sep",
        isMongo(conn) ? null : { label: "Sessões e bloqueios", icon: "fa-solid fa-users-gear", run: perf(conn.database, "sessions") },
        isMongo(conn) ? null : { label: "Esperas do servidor", icon: "fa-solid fa-hourglass-half", run: perf(conn.database, "waits") },
        isMongo(conn) ? null : { label: "Abrir plano .sqlplan…", icon: "fa-solid fa-diagram-project", run: () => ctx.perf.openPlanFile(conn, conn.database) },
        "sep",
        { label: "Editar conexão…", icon: "fa-solid fa-pen", run: () => ctx.editConnection(conn) },
        { label: "Duplicar", icon: "fa-regular fa-copy", run: () => ctx.duplicateConnection(conn) },
        { label: "Copiar connection string", icon: "fa-regular fa-clipboard", run: () => ctx.copyConnectionString(conn) },
        isMongo(conn) || conn.auth.kind === "sql" ? { label: "Copiar connection string com senha", icon: "fa-solid fa-key", run: () => ctx.copyConnectionString(conn, { withPassword: true }) } : null,
        conn.auth.kind === "entra" ? { label: "Sair da conta Microsoft", icon: "fa-solid fa-right-from-bracket", run: () => ctx.signOut(conn) } : null,
        "sep",
        { label: "Mover para cima", icon: "fa-solid fa-arrow-up", disabled: connIndex(conn.id) === 0, run: () => moveConn(conn.id, connIndex(conn.id) - 1) },
        { label: "Mover para baixo", icon: "fa-solid fa-arrow-down", disabled: connIndex(conn.id) === ctx.data().connections.length - 1, run: () => moveConn(conn.id, connIndex(conn.id) + 1) },
        "sep",
        { label: "Excluir conexão", icon: "fa-regular fa-trash-can", danger: true, run: () => ctx.deleteConnection(conn) },
      );
    } else if (n.kind === "database" || n.kind === "schema") {
      items.push(consoleItem(n.database));
      if (!isMongo(conn)) {
        items.push(
          { label: "Nova tabela…", icon: "fa-solid fa-square-plus", run: () => ctx.schema.newTable({ conn, database: n.database, schema: n.schema || "dbo" }) },
          {
            label: n.kind === "schema" ? "Gerar DDL do schema…" : "Gerar DDL do banco…",
            icon: "fa-solid fa-scroll",
            run: () => ctx.schema.databaseScript({ conn, database: n.database, schema: n.kind === "schema" ? n.schema : "" }),
          },
          { header: "Desempenho" },
          { label: "Top consultas", icon: "fa-solid fa-ranking-star", indent: true, run: perf(n.database, "top", { proc: null }) },
          { label: "Query Store", icon: "fa-solid fa-clock-rotate-left", indent: true, run: perf(n.database, "qs") },
          { label: "Sessões e bloqueios", icon: "fa-solid fa-users-gear", indent: true, run: perf(n.database, "sessions") },
          { label: "Esperas", icon: "fa-solid fa-hourglass-half", indent: true, run: perf(n.database, "waits") },
          { label: "Índices e estatísticas", icon: "fa-solid fa-bolt", indent: true, run: perf(n.database, "indexes", { table: null }) },
          "sep",
        );
      }
      items.push({ label: "Atualizar", icon: "fa-solid fa-rotate", run: () => refresh(n.key) }, { label: "Copiar nome", icon: "fa-regular fa-clipboard", run: () => ctx.copy(n.label) });
    } else if (n.kind === "collection" || n.kind === "mview") {
      const ref = { ...objectRef(n), kind: n.kind === "mview" ? "view" : "collection" };
      const coll = /^[A-Za-z_$][\w$]*$/.test(n.name) ? `db.${n.name}` : `db.getCollection(${toShell(n.name)})`;
      items.push(
        { label: "Abrir documentos", icon: "fa-solid fa-table", run: () => ctx.openTable(ref) },
        { label: "Novo console com find()", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn, n.database, `${coll}.find({})\n  .limit(100)`) },
        { label: "Novo console com aggregate()", icon: "fa-solid fa-diagram-project", run: () => ctx.openConsole(conn, n.database, `${coll}.aggregate([\n  { $match: {} },\n  { $limit: 100 }\n])`) },
        { label: "Ver script (índices/opções)", icon: "fa-solid fa-code", run: () => ctx.openDdl(ref) },
        "sep",
        { label: "Copiar nome", icon: "fa-regular fa-clipboard", run: () => ctx.copy(n.name) },
        { label: "Atualizar", icon: "fa-solid fa-rotate", run: () => refresh(n.key) },
      );
    } else if (n.kind === "table" || n.kind === "view") {
      const ref = objectRef(n);
      const qn = ctx.dialect(conn).qualified(n.schema, n.name);
      items.push(
        { label: "Abrir dados", icon: "fa-solid fa-table", run: () => ctx.openTable(ref) },
        { label: "Novo console com SELECT", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn, n.database, ctx.dialect(conn).selectTop({ schema: n.schema, name: n.name })) },
        { label: "Ver DDL", icon: "fa-solid fa-code", run: () => ctx.openDdl(ref) },
        { label: "Gerar script…", icon: "fa-solid fa-scroll", run: () => ctx.scriptMenu(ref, x, y) },
        n.kind === "table" && !isMongo(conn) ? { label: "Índices: uso e faltantes", icon: "fa-solid fa-bolt", run: perf(n.database, "indexes", { table: { schema: n.schema, name: n.name }, view_ix: "usage" }) } : null,
        n.kind === "table" && !isMongo(conn) ? { label: "Estatísticas desatualizadas", icon: "fa-solid fa-chart-simple", indent: true, run: perf(n.database, "indexes", { table: { schema: n.schema, name: n.name }, view_ix: "stats" }) } : null,
        "sep",
        n.kind === "table" ? { label: "Modificar tabela…", icon: "fa-solid fa-pen-ruler", run: () => ctx.schema.modify(ref) } : null,
        n.kind === "table" ? { label: "Adicionar coluna…", icon: "fa-solid fa-plus", indent: true, run: () => ctx.schema.modify(ref, { section: "columns", add: true }) } : null,
        n.kind === "table" ? { label: "Novo índice…", icon: "fa-solid fa-arrow-down-a-z", indent: true, run: () => ctx.schema.modify(ref, { section: "indexes", add: true }) } : null,
        { label: "Renomear…", icon: "fa-solid fa-i-cursor", run: () => ctx.schema.rename(ref) },
        n.kind === "table" ? { label: "Esvaziar tabela (TRUNCATE)…", icon: "fa-solid fa-eraser", run: () => ctx.schema.truncate(ref) } : null,
        { label: n.kind === "table" ? "Excluir tabela…" : "Excluir view…", icon: "fa-regular fa-trash-can", danger: true, run: () => ctx.schema.drop(ref) },
        "sep",
        { label: "Copiar nome qualificado", icon: "fa-regular fa-clipboard", run: () => ctx.copy(qn) },
        { label: "Atualizar", icon: "fa-solid fa-rotate", run: () => refresh(n.key) },
      );
    } else if (n.kind === "procedure" || n.kind === "function") {
      items.push(
        { label: "Ver definição", icon: "fa-solid fa-code", run: () => ctx.openDdl({ ...objectRef(n), kind: n.kind }) },
        n.kind === "procedure"
          ? {
              label: "Novo console com EXEC",
              icon: "fa-solid fa-play",
              run: async () => {
                if (!n.children) await load(n);
                ctx.openConsole(conn, n.database, ctx.dialect(conn).execProcedure({ schema: n.schema, name: n.name, params: n.params || [] }));
              },
            }
          : null,
        n.kind === "procedure" ? { label: "Estatísticas de execução", icon: "fa-solid fa-gauge-high", run: perf(n.database, "top", { proc: { schema: n.schema, name: n.name } }) } : null,
        { label: "Copiar nome qualificado", icon: "fa-regular fa-clipboard", run: () => ctx.copy(ctx.dialect(conn).qualified(n.schema, n.name)) },
        "sep",
        { label: "Renomear…", icon: "fa-solid fa-i-cursor", run: () => ctx.schema.rename(objectRef(n)) },
        { label: n.kind === "procedure" ? "Excluir procedure…" : "Excluir função…", icon: "fa-regular fa-trash-can", danger: true, run: () => ctx.schema.drop(objectRef(n)) },
      );
    } else if (n.kind === "folder" || n.kind === "group" || n.kind === "sysfolder") {
      const table = n.kind === "group" && n.tableKind === "table" && !isMongo(conn) ? { conn, database: n.database, schema: n.schema, name: n.table, kind: "table" } : null;
      if (table && n.group === "column") items.push({ label: "Adicionar coluna…", icon: "fa-solid fa-plus", run: () => ctx.schema.modify(table, { section: "columns", add: true }) });
      if (table && (n.group === "key" || n.group === "index")) items.push({ label: "Novo índice…", icon: "fa-solid fa-plus", run: () => ctx.schema.modify(table, { section: "indexes", add: true }) });
      if (table && n.group === "fk") items.push({ label: "Nova chave estrangeira…", icon: "fa-solid fa-plus", run: () => ctx.schema.modify(table, { section: "fks", add: true }) });
      if (n.kind === "folder" && n.key.endsWith("/f:table") && !isMongo(conn)) items.push({ label: "Nova tabela…", icon: "fa-solid fa-square-plus", run: () => ctx.schema.newTable({ conn, database: n.database, schema: n.schema }) });
      items.push({ label: "Atualizar", icon: "fa-solid fa-rotate", run: () => refresh(n.key) });
    } else if (n.tableKind === "table" && ["column", "key", "index", "fk"].includes(n.kind) && !isMongo(conn)) {
      const table = { conn, database: n.database, schema: n.schema, name: n.table, kind: "table" };
      const what = { column: "coluna", key: "chave", index: "índice", fk: "chave estrangeira" }[n.kind];
      items.push(
        n.kind === "column"
          ? { label: "Editar coluna…", icon: "fa-solid fa-pen-ruler", run: () => ctx.schema.modify(table, { section: "columns", column: n.label }) }
          : { label: `Editar ${what}…`, icon: "fa-solid fa-pen-ruler", run: () => ctx.schema.modify(table, { section: n.kind === "fk" ? "fks" : "indexes", index: n.label }) },
        { label: `Renomear ${what}…`, icon: "fa-solid fa-i-cursor", run: () => ctx.schema.renameItem(table, n.kind, n.label) },
        { label: `Excluir ${what}…`, icon: "fa-regular fa-trash-can", danger: true, run: () => ctx.schema.dropItem(table, n.kind, n.label) },
        "sep",
        { label: "Copiar nome", icon: "fa-regular fa-clipboard", run: () => ctx.copy(n.label) },
      );
      if (n.detail) items.push({ label: "Copiar detalhe", icon: "fa-regular fa-clipboard", run: () => ctx.copy(n.detail) });
    } else {
      items.push({ label: "Copiar nome", icon: "fa-regular fa-clipboard", run: () => ctx.copy(n.label) });
      if (n.detail) items.push({ label: "Copiar detalhe", icon: "fa-regular fa-clipboard", run: () => ctx.copy(n.detail) });
    }
    ctx.showMenu(x, y, items);
  }

  async function disconnect(conn) {
    await ctx.disconnect(conn);
    const key = `c:${conn.id}`;
    dropSubtree(key);
    const n = nodes.get(key);
    if (n) n.children = null;
    expanded.delete(key);
    schedule();
  }

  // ---------- Eventos ----------

  // destroy() solta tudo (setDbData recria o Explorer ao recarregar databases.json).
  const listeners = new AbortController();
  const on = { signal: listeners.signal };


  treeEl.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".dbx-row");
    if (!row) return;
    selected = row.dataset.key;
    if (e.target.closest(".dbx-caret")) toggle(selected);
    // Sem recriar o HTML: o dblclick precisa que os dois cliques caiam no mesmo elemento.
    treeEl.querySelectorAll(".dbx-row.sel").forEach((r) => r.classList.remove("sel"));
    row.classList.add("sel");
    treeEl.focus({ preventScroll: true });
  }, on);
  treeEl.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".dbx-row");
    if (!row || e.target.closest(".dbx-caret")) return;
    activate(nodes.get(row.dataset.key));
  }, on);
  treeEl.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".dbx-row");
    if (!row) return;
    e.preventDefault();
    select(row.dataset.key, { reveal: false });
    menuFor(nodes.get(row.dataset.key), e.clientX, e.clientY);
  }, on);
  treeEl.addEventListener("keydown", (e) => {
    const i = flat.findIndex((r) => r.n.key === selected);
    const cur = flat[i]?.n;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) select(next.n.key);
    } else if (e.key === "ArrowRight" && cur) {
      e.preventDefault();
      if (expandable(cur) && !expanded.has(cur.key)) toggle(cur.key, true);
      else if (kids(cur).length) select(kids(cur)[0]);
    } else if (e.key === "Delete" && cur?.kind === "query") {
      e.preventDefault();
      const q = ctx.queries.get(cur.queryId);
      if (q) ctx.queries.remove(q);
    } else if (e.key === "ArrowLeft" && cur) {
      e.preventDefault();
      if (expanded.has(cur.key)) toggle(cur.key, false);
      else {
        const parent = cur.key.slice(0, cur.key.lastIndexOf("/"));
        if (nodes.has(parent)) select(parent);
      }
    } else if (e.key === "Enter" && cur) {
      e.preventDefault();
      activate(cur);
    } else if (e.key === "F6" && (e.ctrlKey || e.metaKey) && cur?.kind === "table" && !isMongo(ctx.conn(cur.connId))) {
      e.preventDefault();
      ctx.schema.modify(objectRef(cur));
    } else if (e.key === "F5" && cur) {
      e.preventDefault();
      refresh(cur.key);
    } else if (e.key === "ContextMenu" && cur) {
      e.preventDefault();
      const r = treeEl.querySelector(".dbx-row.sel")?.getBoundingClientRect();
      if (r) menuFor(cur, r.left + 40, r.bottom);
    }
  }, on);
  // Arrastar uma conexão sobre outra: entra antes (metade de cima) ou depois (de baixo).
  // Arrastar uma consulta salva sobre uma pasta/"consultas salvas"/banco: vai para dentro.
  let draggedConn = null;
  let draggedQuery = null;
  const clearDrop = () => treeEl.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-into"));
  const queryDropAt = (e) => {
    const row = e.target.closest(".dbx-row");
    const n = row && nodes.get(row.dataset.key);
    if (!n) return null;
    if (n.kind === "qroot" || n.kind === "qfolder") return { row, connId: n.connId, database: n.database, folder: n.folder };
    if (n.kind === "query") {
      const parent = nodes.get(n.key.slice(0, n.key.lastIndexOf("/")));
      return parent && { row: treeEl.querySelector(`.dbx-row[data-key="${CSS.escape(parent.key)}"]`) || row, connId: n.connId, database: n.database, folder: n.folder };
    }
    if (n.kind === "database") return { row, connId: n.connId, database: n.database, folder: "" };
    return null;
  };
  const connRowAt = (e) => {
    const row = e.target.closest(".dbx-row.k-conn");
    const n = row && nodes.get(row.dataset.key);
    if (!n || n.connId === draggedConn) return null;
    const r = row.getBoundingClientRect();
    return { row, n, after: e.clientY > r.top + r.height / 2 };
  };
  treeEl.addEventListener("dragstart", (e) => {
    const qrow = e.target.closest(".dbx-row.k-query");
    if (qrow) {
      draggedQuery = nodes.get(qrow.dataset.key)?.queryId || null;
      e.dataTransfer.setData("application/x-db-query", draggedQuery || "");
      e.dataTransfer.effectAllowed = "move";
      return;
    }
    const row = e.target.closest(".dbx-row.k-conn");
    const n = row && nodes.get(row.dataset.key);
    if (!n) return;
    draggedConn = n.connId;
    e.dataTransfer.setData("application/x-db-conn", n.connId);
    e.dataTransfer.effectAllowed = "move";
  }, on);
  treeEl.addEventListener("dragend", () => {
    draggedConn = null;
    draggedQuery = null;
    clearDrop();
  }, on);
  treeEl.addEventListener("dragover", (e) => {
    if (draggedQuery) {
      const hit = queryDropAt(e);
      clearDrop();
      if (!hit) return;
      e.preventDefault();
      hit.row.classList.add("drop-into");
      return;
    }
    if (!draggedConn) return;
    const hit = connRowAt(e);
    clearDrop();
    if (!hit) return;
    e.preventDefault();
    hit.row.classList.add(hit.after ? "drop-after" : "drop-before");
  }, on);
  treeEl.addEventListener("drop", (e) => {
    if (draggedQuery) {
      const hit = queryDropAt(e);
      const q = ctx.queries.get(draggedQuery);
      clearDrop();
      draggedQuery = null;
      if (!hit || !q) return;
      e.preventDefault();
      ctx.queries.move(q, hit);
      return;
    }
    const hit = draggedConn && connRowAt(e);
    clearDrop();
    if (!hit) return;
    e.preventDefault();
    const from = connIndex(draggedConn);
    let to = connIndex(hit.n.connId) + (hit.after ? 1 : 0);
    if (from < to) to--;
    moveConn(draggedConn, to);
    draggedConn = null;
  }, on);

  searchEl?.addEventListener("input", () => {
    query = searchEl.value.trim();
    render();
  }, on);

  return {
    destroy: () => listeners.abort(),
    render: schedule,
    refresh,
    refreshConnection: (connId) => refresh(`c:${connId}`),
    /** Recarrega um schema (depois de DDL) e reabre o que estava aberto dentro dele. */
    async refreshSchema(connId, database, schema) {
      const key = `c:${connId}/d:${database}/s:${schema}`;
      if (!nodes.has(key)) return;
      await refresh(key);
      await restoreExpanded(key);
    },
    expandConnection: (connId) => toggle(`c:${connId}`, true),
    forgetConnection(connId) {
      const key = `c:${connId}`;
      dropSubtree(key);
      nodes.delete(key);
      expanded.delete(key);
      schedule();
    },
    collapseAll() {
      expanded.clear();
      persistExpanded();
      schedule();
    },
    selectedNode: () => nodes.get(selected),
    /** Abre "consultas salvas" (e as pastas) até a consulta e a seleciona, se o banco estiver na árvore. */
    revealQuery(q) {
      const db = [...nodes.values()].find((n) => n.kind === "database" && n.connId === q.conn_id && (n.database === q.database || (!q.database && n.current)));
      if (!db) return schedule();
      let key = `${db.key}/q`;
      expanded.add(db.key);
      expanded.add(key);
      for (const part of q.folder ? q.folder.split("/") : []) {
        key += `/qf:${encodeURIComponent(part)}`;
        expanded.add(key);
      }
      persistExpanded();
      flatten(); // monta os nós antes de selecionar
      select(`${key}/qi:${q.id}`);
    },
  };
}

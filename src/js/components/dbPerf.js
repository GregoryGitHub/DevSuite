import { el, icon } from "../utils/dom.js";
import { uid, target } from "../utils/dbModel.js";
import { highlightCode } from "../utils/highlight.js";
import { formatCount, formatMs } from "../utils/sqlPlan.js";
import {
  rowsToObjects,
  majorVersion,
  friendlyError,
  TOP_METRICS,
  QS_METRICS,
  topQueriesSql,
  procStatsSql,
  cachedPlanSql,
  qsOptionsSql,
  qsTopSql,
  qsRegressedSql,
  qsMultiPlanSql,
  qsForcedSql,
  qsPlansSql,
  qsTimelineSql,
  qsPlanXmlSql,
  qsForceSql,
  qsUnforceSql,
  qsEnableSql,
  sessionsSql,
  livePlanSql,
  killSql,
  blockingTree,
  waitsSql,
  summarizeWaits,
  waitsDelta,
  missingIndexesSql,
  missingIndexRowDdl,
  indexUsageSql,
  isUnusedIndex,
  fragmentationSql,
  maintenanceSql,
  staleStatsSql,
  updateStatsSql,
} from "../utils/sqlPerf.js";
import { createDataGrid } from "./dataGrid.js";
import { createResultFooter, copyAsItems, exportMenuItems } from "./dbShared.js";
import { createPlanView } from "./dbPlan.js";
import { dbConfirm } from "./dbDialogs.js";
import { dbApi } from "../api.js";

// Aba "Desempenho" de um banco SQL Server: Top consultas (cache de planos), Query Store,
// Sessões e bloqueios, Esperas e Índices. Tudo é SQL de sqlPerf.js executado numa sessão
// própria (perf:<conn>:<banco>); escritas (KILL, forçar plano, criar índice...) mostram o SQL
// e pedem confirmação, e são recusadas em conexão somente leitura.

export const PERF_SECTIONS = [
  { id: "top", label: "Top consultas", icon: "fa-solid fa-ranking-star" },
  { id: "qs", label: "Query Store", icon: "fa-solid fa-clock-rotate-left" },
  { id: "sessions", label: "Sessões e bloqueios", icon: "fa-solid fa-users-gear" },
  { id: "waits", label: "Esperas", icon: "fa-solid fa-hourglass-half" },
  { id: "indexes", label: "Índices e estatísticas", icon: "fa-solid fa-bolt" },
];

const HIDDEN_COLUMNS = new Set(["plan_handle", "statement_start_offset", "statement_end_offset", "query_hash"]);
const PLAN_COLORS = ["#38bdf8", "#f97316", "#a855f7", "#22c55e", "#ef4444", "#eab308", "#ec4899", "#14b8a6"];

/**
 * tab: { conn_id, database, options: { section, table?: { schema, name }, proc?, view? } }
 * ctx: tabCtx do db.js (conn, toast, copy, showMenu, showMenuBelow, openConsole, openPlan, serverInfo, saveDataSoon, dialect, log)
 */
export function createPerfTab(ctx, tab) {
  const conn = () => ctx.conn(tab.conn_id);
  const sessionId = `perf:${tab.conn_id}:${tab.database}`;
  const tgt = () => target(conn(), sessionId, tab.database);
  tab.options ||= {};
  const opt = tab.options;
  opt.section ||= "top";
  const major = () => majorVersion(ctx.serverInfo(conn()));

  let running = null;
  let timer = null;
  let disposed = false;
  let loadedSection = null;
  let activeDetail = null; // dispose de planos na área de detalhe

  // ---------- Estrutura ----------

  const nav = el("div.dbq-nav");
  const controls = el("div.dbq-controls");
  const status = el("span.dbf-info");
  const refreshBtn = el("button.dbt-btn", { type: "button", title: "Atualizar (F5)", onclick: () => load() }, icon("fa-solid fa-rotate-right"));
  const cancelBtn = el("button.dbt-btn", { type: "button", title: "Cancelar", hidden: true, onclick: () => running && dbApi.cancel(running) }, icon("fa-solid fa-stop"));
  const toolbar = el("div.dbt-toolbar", {}, controls, el("span.hx-flex"), status, cancelBtn, refreshBtn);
  const content = el("div.dbq-content");
  const detail = el("div.dbq-detail", { hidden: true });
  const split = el("div.dbc-split.dbq-split", { hidden: true, title: "Arraste para redimensionar" });
  const main = el("div.dbq-main", {}, content, split, detail);
  const root = el("div.dbc.dbq", { tabIndex: -1 }, toolbar, el("div.dbq-body", {}, nav, main));
  root.addEventListener("keydown", (e) => {
    if (e.key === "F5") {
      e.preventDefault();
      load();
    }
  });

  let detailH = 0.58;
  split.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = main.getBoundingClientRect();
    const move = (ev) => {
      detailH = Math.min(0.85, Math.max(0.15, (rect.bottom - ev.clientY) / rect.height));
      detail.style.flexBasis = `${Math.round(detailH * 100)}%`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      activeDetail?.refresh?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  function renderNav() {
    nav.innerHTML = "";
    for (const s of PERF_SECTIONS) {
      nav.append(el("button.dbq-nav-item", { type: "button", class: `dbq-nav-item${opt.section === s.id ? " on" : ""}`, onclick: () => go(s.id) }, icon(s.icon), el("span", {}, s.label)));
    }
    nav.append(el("div.dbq-nav-foot", {}, el("div", {}, tab.database || conn()?.database || "(padrão)"), el("div.dbp-muted", {}, ctx.serverInfo(conn())?.product || "")));
  }

  function go(section, patch = {}) {
    opt.section = section;
    Object.assign(opt, patch);
    ctx.saveDataSoon();
    ctx.onTitleChange?.(tab, {});
    renderNav();
    load();
  }

  // ---------- Execução ----------

  /** Executa e devolve os result sets como objetos. */
  async function query(sql, { quiet = false } = {}) {
    const queryId = uid();
    const sets = [];
    let cur = null;
    running = queryId;
    cancelBtn.hidden = false;
    if (!quiet) status.textContent = "Consultando…";
    try {
      const t0 = performance.now();
      await dbApi.execute(tgt(), queryId, sql, {
        onEvent: (ev) => {
          if (ev.type === "result_start") sets.push((cur = { columns: ev.columns, rows: [] }));
          else if (ev.type === "rows") cur.rows.push(...ev.rows);
        },
      });
      if (!quiet) status.textContent = `${formatMs(performance.now() - t0)} · ${new Date().toLocaleTimeString("pt-BR")}`;
      return sets.map((s) => ({ columns: s.columns, rows: s.rows, objects: rowsToObjects(s.columns, s.rows) }));
    } finally {
      if (running === queryId) {
        running = null;
        cancelBtn.hidden = true;
      }
    }
  }

  /** Escrita (KILL, forçar plano, índices...): mostra o SQL e confirma. */
  async function write(sql, { title, message, label = "Executar", danger = true, reload = true } = {}) {
    const c = conn();
    if (c?.read_only) return ctx.toast("Conexão somente leitura: abra o SQL num console se quiser executá-lo");
    const ok = await dbConfirm({ title, message, body: el("pre.db-sql-preview", { html: highlightCode(sql, "sql") }), confirmLabel: label, danger, wide: true });
    if (!ok) return false;
    try {
      const t0 = performance.now();
      await query(sql);
      ctx.log({ conn: c, database: tab.database, sql, lang: "sql", rows: null, ms: Math.round(performance.now() - t0) });
      ctx.toast("Comando executado");
      if (reload) load();
      return true;
    } catch (e) {
      ctx.log({ conn: c, database: tab.database, sql, lang: "sql", error: String(e) });
      showError(e, false);
      return false;
    }
  }

  function showError(e, replace = true) {
    const box = el("div.dbq-error", {}, icon("fa-solid fa-circle-xmark"), el("pre", {}, friendlyError(String(e))));
    if (replace) {
      content.innerHTML = "";
      content.append(box);
    } else ctx.toast(friendlyError(String(e)).split("\n")[0]);
    status.textContent = "Erro";
  }

  // ---------- Grid ----------

  /** Grid com as linhas (objetos); colunas técnicas ficam fora da exibição. */
  function makeGrid({ columns, objects, onRow, rowMenu, decorate, baseName }) {
    const shown = columns.filter((c) => !HIDDEN_COLUMNS.has(c.name));
    const footer = createResultFooter();
    let lastRow = -1;
    // Só reage à seleção feita pelo usuário (o grid também avisa ao montar).
    let armed = false;
    const grid = createDataGrid({
      showMenu: ctx.showMenu,
      onStatus: (s) => {
        footer.setSelection(s);
        const r = s.active?.r;
        if (armed && r !== undefined && r !== lastRow) {
          lastRow = r;
          onRow?.(objects[r], r);
        }
      },
      onError: (m) => ctx.toast(m),
      copyAsItems: (m) => copyAsItems(ctx, ctx.dialect(), m),
      cellMenuItems: (cell) => (rowMenu ? ["sep", ...rowMenu(objects[cell.r])] : []),
    });
    grid.root.addEventListener("pointerdown", () => (armed = true), true);
    grid.root.addEventListener("keydown", () => (armed = true), true);
    grid.setColumns(shown);
    const rows = objects.map((o, i) => shown.map((c) => (decorate ? decorate(o, c.name, i) : o[c.name])));
    grid.appendRows(rows);
    footer.setInfo(`${formatCount(objects.length)} linha(s)`);
    if (!objects.length) grid.setMessage("Nenhuma linha");
    const exportBtn = el("button.dbt-btn", { type: "button", title: "Exportar", onclick: (e) => ctx.showMenuBelow(e.currentTarget, exportMenuItems(ctx, ctx.dialect(), grid, null, { baseName: baseName || opt.section })) }, icon("fa-solid fa-file-export"));
    const findBtn = el("button.dbt-btn", { type: "button", title: "Buscar (Ctrl+F)", onclick: () => grid.openFind() }, icon("fa-solid fa-magnifying-glass"));
    const box = el("div.dbc-result", {}, el("div.dbc-rtools", {}, findBtn, exportBtn), el("div.dbt-grid", {}, grid.root), footer.root);
    requestAnimationFrame(() => grid.refresh());
    return { root: box, grid };
  }

  /** Controles da seção na barra (itens condicionais chegam como null). */
  function addControls(...nodes) {
    controls.append(...nodes.filter(Boolean));
  }

  function setContent(...nodes) {
    content.innerHTML = "";
    content.append(...nodes.filter(Boolean));
  }

  function setDetail(...nodes) {
    activeDetail?.dispose?.();
    activeDetail = null;
    detail.innerHTML = "";
    const any = nodes.filter(Boolean);
    detail.hidden = split.hidden = !any.length;
    detail.style.flexBasis = `${Math.round(detailH * 100)}%`;
    detail.append(...any);
  }

  /** SQL realçado com ações; `plan` carrega o plano abaixo. */
  function sqlDetail(text, { actions = [], loadPlan = null, title = "" } = {}) {
    const planBox = el("div.dbq-planbox");
    const showPlan = async () => {
      planBox.innerHTML = "";
      planBox.append(el("div.dbp-empty", {}, icon("fa-solid fa-spinner fa-spin"), " Carregando plano…"));
      try {
        const xml = await loadPlan();
        planBox.innerHTML = "";
        if (!xml) return planBox.append(el("div.dbp-empty", {}, "Plano indisponível (saiu do cache ou a consulta já terminou)."));
        activeDetail?.dispose?.();
        const view = createPlanView(ctx, { xml, compact: true, baseName: "plano", openSql: (sql) => ctx.openConsole(conn(), tab.database, sql), onOpenTab: (xmls) => ctx.openPlan({ conn: conn(), database: tab.database, xml: xmls, name: title || "Plano" }) });
        activeDetail = view;
        planBox.append(view.root);
        requestAnimationFrame(() => view.refresh());
      } catch (e) {
        planBox.innerHTML = "";
        planBox.append(el("div.dbq-error", {}, el("pre", {}, friendlyError(String(e)))));
      }
    };
    const bar = el(
      "div.dbq-detail-bar",
      {},
      title ? el("b", {}, title) : null,
      el("span.hx-flex"),
      loadPlan ? el("button.hx-btn", { type: "button", onclick: showPlan }, icon("fa-solid fa-diagram-project"), " Ver plano") : null,
      text ? el("button.hx-btn", { type: "button", onclick: () => ctx.openConsole(conn(), tab.database, text) }, icon("fa-solid fa-terminal"), " Abrir no console") : null,
      text ? el("button.hx-btn", { type: "button", onclick: () => ctx.copy(text, "SQL copiado") }, icon("fa-regular fa-copy"), " Copiar") : null,
      ...actions,
    );
    return { root: el("div.dbq-sqldetail", {}, bar, text ? el("pre.dbq-sql", { html: highlightCode(text, "sql") }) : null, planBox), showPlan };
  }

  const select = (options, value, onchange, title = "") =>
    el("select.dbt-tx-select", { title, onchange: (e) => onchange(e.target.value) }, options.map(([v, label]) => el("option", { value: v, selected: String(v) === String(value) }, label)));
  const check = (label, checked, onchange) => el("label.dbq-check", {}, el("input", { type: "checkbox", checked, onchange: (e) => onchange(e.target.checked) }), label);
  const chip = (text, onclear) => el("span.dbq-chip", {}, text, el("button", { type: "button", title: "Remover filtro", onclick: onclear }, icon("fa-solid fa-xmark")));
  const sectionTitle = () => {
    const s = PERF_SECTIONS.find((x) => x.id === opt.section);
    return el("span.dbq-title", {}, icon(s.icon), s.label);
  };

  // ---------- Seções ----------

  async function load() {
    if (disposed) return;
    stopTimer();
    if (running) dbApi.cancel(running);
    const section = opt.section;
    const changed = loadedSection !== section;
    loadedSection = section;
    if (changed) setDetail();
    controls.innerHTML = "";
    addControls(sectionTitle(), el("span.dbt-sep"));
    try {
      if (section === "top") await loadTop();
      else if (section === "qs") await loadQueryStore();
      else if (section === "sessions") await loadSessions();
      else if (section === "waits") await loadWaits();
      else if (section === "indexes") await loadIndexes();
    } catch (e) {
      if (!disposed && loadedSection === section) showError(e);
    }
  }

  // Top consultas -------------------------------------------------------------

  async function loadTop() {
    const proc = opt.view === "procs";
    const by = opt.by || "cpu";
    const limit = opt.limit || 50;
    addControls(
      select([["queries", "Consultas"], ["procs", "Procedures"]], proc ? "procs" : "queries", (v) => go("top", { view: v })),
      proc ? null : select(Object.entries(TOP_METRICS).filter(([, m]) => (m.since || 0) <= major()).map(([k, m]) => [k, `Por ${m.label.toLowerCase()}`]), by, (v) => go("top", { by: v })),
      select([25, 50, 100, 200, 500].map((n) => [n, `Top ${n}`]), limit, (v) => go("top", { limit: Number(v) })),
      proc ? null : check("Só este banco", opt.allDbs !== true, (v) => go("top", { allDbs: !v })),
      opt.proc ? chip(`Procedure: ${opt.proc.schema}.${opt.proc.name}`, () => go("top", { proc: null })) : null,
    );
    const sql = proc || opt.proc ? procStatsSql({ limit, proc: opt.proc }) : topQueriesSql({ by, limit, thisDb: opt.allDbs !== true, major: major() });
    const [res] = await query(sql);
    const view = makeGrid({
      ...res,
      baseName: "top-consultas",
      onRow: (o) => {
        const text = o.query_text || o.procedure || "";
        const d = sqlDetail(o.query_text ? o.query_text : "", {
          title: o.procedure ? `Procedure ${o.procedure}` : `${formatCount(Number(o.executions))} execução(ões) · média ${formatMs(Number(o.avg_duration_ms))}`,
          loadPlan: o.plan_handle ? async () => (await query(cachedPlanSql(o.plan_handle, o.statement_start_offset ?? 0, o.statement_end_offset ?? -1), { quiet: true }))[0]?.objects[0]?.query_plan : null,
        });
        setDetail(d.root);
        if (!text) d.showPlan();
      },
      rowMenu: (o) => [
        o.query_text ? { label: "Abrir no console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn(), tab.database, o.query_text) } : null,
        o.plan_handle ? { label: "Ver plano do cache", icon: "fa-solid fa-diagram-project", run: async () => openPlanTab(o.plan_handle, o) } : null,
      ],
    });
    setContent(view.root);
  }

  async function openPlanTab(handle, o) {
    try {
      const xml = (await query(cachedPlanSql(handle, o.statement_start_offset ?? 0, o.statement_end_offset ?? -1)))[0]?.objects[0]?.query_plan;
      if (!xml) return ctx.toast("Plano indisponível (saiu do cache)");
      ctx.openPlan({ conn: conn(), database: tab.database, xml, name: "Plano do cache" });
    } catch (e) {
      showError(e, false);
    }
  }

  // Query Store ---------------------------------------------------------------

  async function loadQueryStore() {
    if (major() < 13) {
      setContent(el("div.dbq-notice", {}, icon("fa-solid fa-circle-info"), el("p", {}, "O Query Store existe a partir do SQL Server 2016.")));
      return;
    }
    const [optsRes] = await query(qsOptionsSql());
    const qs = optsRes?.objects[0];
    const state = qs?.actual_state_desc || "OFF";
    const mode = opt.view || "top";
    const hours = opt.hours || 24;
    addControls(
      select([["top", "Mais custosas"], ["regressed", "Regredidas"], ["multi", "Vários planos"], ["forced", "Planos forçados"]], mode, (v) => go("qs", { view: v })),
      mode === "top" ? select(Object.entries(QS_METRICS).map(([k, m]) => [k, `Por ${m.label.toLowerCase()}`]), opt.by_qs || "duration", (v) => go("qs", { by_qs: v })) : null,
      mode === "multi" || mode === "forced" ? null : select([[1, "Última hora"], [24, "Últimas 24 h"], [168, "Últimos 7 dias"], [720, "Últimos 30 dias"]], hours, (v) => go("qs", { hours: Number(v) })),
      el("span.dbq-state", { class: `dbq-state ${state === "READ_WRITE" ? "ok" : state === "READ_ONLY" ? "warn" : "bad"}`, title: qs ? `Captura: ${qs.query_capture_mode_desc} · ${qs.current_storage_size_mb}/${qs.max_storage_size_mb} MB · intervalo ${qs.interval_length_minutes} min` : "" }, `Query Store: ${state}`),
    );
    if (state === "OFF") {
      setContent(
        el(
          "div.dbq-notice",
          {},
          icon("fa-solid fa-clock-rotate-left"),
          el("p", {}, "O Query Store está desligado neste banco. Ele guarda o histórico de consultas, planos e métricas e permite forçar um plano bom quando uma consulta regride."),
          el("button.hx-btn.primary", { type: "button", disabled: !!conn()?.read_only, onclick: () => write(qsEnableSql(), { title: "Ativar o Query Store", message: `Ativar o Query Store em ${tab.database || "banco padrão"}?`, label: "Ativar", danger: false }) }, icon("fa-solid fa-power-off"), " Ativar Query Store"),
        ),
      );
      return;
    }
    const notice = state === "READ_ONLY" ? el("div.dbq-banner.warn", {}, icon("fa-solid fa-triangle-exclamation"), ` Query Store somente leitura${qs.readonly_reason ? ` (motivo ${qs.readonly_reason}; geralmente espaço esgotado)` : ""}: não registra consultas novas.`) : null;
    const sql = mode === "regressed" ? qsRegressedSql({ hours }) : mode === "multi" ? qsMultiPlanSql({}) : mode === "forced" ? qsForcedSql() : qsTopSql({ hours, by: opt.by_qs || "duration" });
    const [res] = await query(sql);
    const view = makeGrid({
      ...res,
      baseName: "query-store",
      onRow: (o) => showQueryStoreQuery(o, hours),
      rowMenu: (o) => [{ label: "Abrir no console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn(), tab.database, o.query_text) }],
    });
    setContent(notice, view.root);
  }

  async function showQueryStoreQuery(o, hours) {
    const qid = o.query_id;
    const planArea = el("div.dbq-qsplans");
    const chartBox = el("div.dbq-chart");
    const planView = el("div.dbq-planbox");
    const d = sqlDetail(o.query_text, { title: `Consulta ${qid}` });
    setDetail(el("div.dbq-qs", {}, d.root, el("div.dbq-qsrow", {}, planArea, chartBox), planView));
    try {
      const [[plansRes], [tl]] = await Promise.all([query(qsPlansSql(qid, { hours }), { quiet: true }), query(qsTimelineSql(qid, { hours }), { quiet: true })]);
      const plans = plansRes.objects;
      const color = (id) => PLAN_COLORS[plans.findIndex((p) => p.plan_id === id) % PLAN_COLORS.length];
      let picked = [];
      const renderPlans = () => {
        planArea.innerHTML = "";
        planArea.append(
          el(
            "table.dbp-table",
            {},
            el("thead", {}, el("tr", {}, ["", "Plano", "Execuções", "Duração média", "CPU média", "Leituras médias", "Última execução", ""].map((h) => el("th", {}, h)))),
            el(
              "tbody",
              {},
              plans.map((p) =>
                el(
                  "tr",
                  { class: picked.includes(p.plan_id) ? "on" : "", onclick: (e) => pick(p.plan_id, e.ctrlKey || e.metaKey || e.shiftKey) },
                  el("td", {}, el("span.dbq-dot", { style: `background:${color(p.plan_id)}` })),
                  el("td", {}, `${p.plan_id}`, Number(p.forced) ? el("span.dbq-forced", { title: "Plano forçado" }, icon("fa-solid fa-thumbtack")) : null),
                  el("td.num", {}, formatCount(Number(p.executions) || 0)),
                  el("td.num", {}, p.avg_duration_ms !== null ? formatMs(Number(p.avg_duration_ms)) : "—"),
                  el("td.num", {}, p.avg_cpu_ms !== null ? formatMs(Number(p.avg_cpu_ms)) : "—"),
                  el("td.num", {}, p.avg_logical_reads !== null ? formatCount(Number(p.avg_logical_reads)) : "—"),
                  el("td", {}, String(p.last_execution_time || "").slice(0, 19)),
                  el(
                    "td",
                    {},
                    Number(p.forced)
                      ? el("button.hx-btn", { type: "button", onclick: (e) => (e.stopPropagation(), write(qsUnforceSql(qid, p.plan_id), { title: "Desforçar plano", message: `Deixar o otimizador escolher o plano da consulta ${qid} de novo?`, label: "Desforçar", danger: false })) }, "Desforçar")
                      : el("button.hx-btn", { type: "button", onclick: (e) => (e.stopPropagation(), write(qsForceSql(qid, p.plan_id), { title: "Forçar plano", message: `Forçar o plano ${p.plan_id} para a consulta ${qid}? O SQL Server passa a usá-lo sempre (enquanto for válido).`, label: "Forçar plano" })) }, icon("fa-solid fa-thumbtack"), " Forçar"),
                  ),
                ),
              ),
            ),
          ),
          plans.length > 1 ? el("div.dbp-muted.dbq-hint", {}, "Clique para ver o plano; Ctrl+clique em outro para comparar lado a lado.") : "",
        );
      };
      const pick = async (planId, add) => {
        picked = add && picked.length && !picked.includes(planId) ? [picked[picked.length - 1], planId] : [planId];
        renderPlans();
        planView.innerHTML = "";
        planView.append(el("div.dbp-empty", {}, icon("fa-solid fa-spinner fa-spin"), " Carregando plano…"));
        try {
          const xmls = await Promise.all(picked.map(async (id) => (await query(qsPlanXmlSql(id), { quiet: true }))[0]?.objects[0]?.query_plan));
          planView.innerHTML = "";
          activeDetail?.dispose?.();
          const views = xmls.map((xml, i) => createPlanView(ctx, { xml, compact: true, baseName: `plano-${picked[i]}`, openSql: (sql) => ctx.openConsole(conn(), tab.database, sql), onOpenTab: (x) => ctx.openPlan({ conn: conn(), database: tab.database, xml: x, name: `Plano ${picked[i]}` }) }));
          activeDetail = { dispose: () => views.forEach((v) => v.dispose()), refresh: () => views.forEach((v) => v.refresh()) };
          planView.append(
            el(
              "div.dbq-compare",
              { class: `dbq-compare${views.length > 1 ? " two" : ""}` },
              views.map((v, i) => el("div.dbq-compare-col", {}, el("div.dbq-compare-title", {}, el("span.dbq-dot", { style: `background:${color(picked[i])}` }), ` Plano ${picked[i]}`), v.root)),
            ),
          );
          requestAnimationFrame(() => views.forEach((v) => v.refresh()));
        } catch (e) {
          planView.innerHTML = "";
          planView.append(el("div.dbq-error", {}, el("pre", {}, friendlyError(String(e)))));
        }
      };
      renderPlans();
      chartBox.append(timelineChart(tl.objects, color));
      if (plans.length) pick(plans[0].plan_id, false);
    } catch (e) {
      planArea.append(el("div.dbq-error", {}, el("pre", {}, friendlyError(String(e)))));
    }
  }

  /** Duração média por intervalo, uma linha por plano (SVG simples). */
  function timelineChart(points, color) {
    if (!points.length) return el("div.dbp-empty", {}, "Sem execuções no período.");
    const W = 420;
    const H = 120;
    const P = { l: 46, r: 10, t: 10, b: 22 };
    const times = points.map((p) => Date.parse(String(p.start_time).replace(" ", "T").replace(/ ([+-]\d\d:\d\d)$/, "$1")));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times, t0 + 1);
    const vmax = Math.max(...points.map((p) => Number(p.avg_duration_ms) || 0), 1);
    const x = (t) => P.l + ((t - t0) / (t1 - t0)) * (W - P.l - P.r);
    const y = (v) => H - P.b - (v / vmax) * (H - P.t - P.b);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.classList.add("dbq-svg");
    const add = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text) n.textContent = text;
      svg.append(n);
      return n;
    };
    for (const f of [0, 0.5, 1]) {
      add("line", { x1: P.l, x2: W - P.r, y1: y(vmax * f), y2: y(vmax * f), class: "grid" });
      add("text", { x: P.l - 4, y: y(vmax * f) + 3, "text-anchor": "end", class: "axis" }, formatMs(vmax * f));
    }
    add("text", { x: P.l, y: H - 6, class: "axis" }, new Date(t0).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
    add("text", { x: W - P.r, y: H - 6, "text-anchor": "end", class: "axis" }, new Date(t1).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
    const byPlan = new Map();
    points.forEach((p, i) => {
      if (!byPlan.has(p.plan_id)) byPlan.set(p.plan_id, []);
      byPlan.get(p.plan_id).push([times[i], Number(p.avg_duration_ms) || 0, p]);
    });
    for (const [planId, list] of byPlan) {
      const c = color(planId);
      if (list.length > 1) add("polyline", { points: list.map(([t, v]) => `${x(t)},${y(v)}`).join(" "), fill: "none", stroke: c, "stroke-width": 1.6 });
      for (const [t, v, p] of list) {
        const dot = add("circle", { cx: x(t), cy: y(v), r: 3, fill: c });
        const title = document.createElementNS(ns, "title");
        title.textContent = `Plano ${planId}\n${String(p.start_time).slice(0, 16)}\nMédia ${formatMs(v)} · ${formatCount(Number(p.executions))} execução(ões)`;
        dot.append(title);
      }
    }
    return el("div.dbq-chartbox", {}, el("div.dbq-chart-title", {}, "Duração média por intervalo"), svg);
  }

  // Sessões ---------------------------------------------------------------------

  async function loadSessions() {
    const every = opt.refresh_s ?? 5;
    addControls(
      check("Todas as sessões", !!opt.all, (v) => go("sessions", { all: v })),
      select([[0, "Sem auto-atualizar"], [2, "A cada 2 s"], [5, "A cada 5 s"], [10, "A cada 10 s"], [30, "A cada 30 s"]], every, (v) => go("sessions", { refresh_s: Number(v) })),
    );
    const [res] = await query(sessionsSql({ all: !!opt.all }));
    const tree = blockingTree(res.objects);
    const objects = tree.map((t) => ({ ...t.row, _depth: t.depth, _blocked: t.blocked, _head: t.head }));
    const columns = [{ name: "sessão", type: "", kind: "str" }, { name: "bloqueia", type: "int", kind: "int" }, ...res.columns.filter((c) => c.name !== "session_id")];
    const blockedCount = objects.filter((o) => Number(o.blocking_session_id) > 0).length;
    const view = makeGrid({
      columns,
      objects,
      baseName: "sessoes",
      decorate: (o, name) => (name === "sessão" ? `${o._depth ? `${"   ".repeat(o._depth - 1)}└─ ` : o._head ? "● " : ""}${o.session_id}` : name === "bloqueia" ? o._blocked || null : o[name]),
      onRow: (o) => {
        const id = Number(o.session_id);
        const d = sqlDetail(o.query_text || "", {
          title: `Sessão ${id}${o.login_name ? ` · ${o.login_name}` : ""}${o.host_name ? `@${o.host_name}` : ""}${o.wait_type ? ` · esperando ${o.wait_type} há ${formatMs(Number(o.wait_ms))}` : ""}`,
          loadPlan: o.status !== "sleeping" ? async () => (await query(livePlanSql(id), { quiet: true }))[0]?.objects[0]?.query_plan : null,
          actions: [el("button.hx-btn.danger", { type: "button", onclick: () => kill(o) }, icon("fa-solid fa-skull"), " KILL")],
        });
        // Auto-atualizar não pode apagar o detalhe que o usuário está lendo.
        stopTimer();
        opt.paused = true;
        pauseBtn.replaceWith((pauseBtn = pauseButton()));
        setDetail(d.root);
      },
      rowMenu: (o) => [{ label: `KILL ${o.session_id}`, icon: "fa-solid fa-skull", danger: true, run: () => kill(o) }],
    });
    let pauseBtn = pauseButton();
    if (every > 0) addControls(pauseBtn);
    const banner = blockedCount
      ? el("div.dbq-banner.bad", {}, icon("fa-solid fa-lock"), ` ${blockedCount} sessão(ões) bloqueada(s). Quem está na raiz da cadeia (●) segura os locks: normalmente uma transação aberta esperando o cliente.`)
      : null;
    setContent(banner, view.root);
    if (every > 0 && !opt.paused) timer = setTimeout(() => loadedSection === "sessions" && !disposed && document.contains(root) && load(), every * 1000);
  }

  function pauseButton() {
    return el(
      "button.dbt-btn",
      { type: "button", class: `dbt-btn${opt.paused ? " on" : ""}`, title: opt.paused ? "Retomar auto-atualização" : "Pausar auto-atualização", onclick: () => ((opt.paused = !opt.paused), load()) },
      icon(opt.paused ? "fa-solid fa-play" : "fa-solid fa-pause"),
    );
  }

  function kill(o) {
    write(killSql(o.session_id), {
      title: `Encerrar a sessão ${o.session_id}`,
      message: `KILL desconecta a sessão de ${o.login_name || "?"}${o.host_name ? ` em ${o.host_name}` : ""} e desfaz a transação aberta dela (o rollback pode demorar).`,
      label: "KILL",
    });
  }

  // Esperas ---------------------------------------------------------------------

  async function loadWaits() {
    const sample = opt.sample || 0;
    addControls(select([[0, "Desde o início do servidor"], [10, "Amostra de 10 s"], [30, "Amostra de 30 s"], [60, "Amostra de 60 s"]], sample, (v) => go("waits", { sample: Number(v) })));
    let rows;
    if (sample) {
      const [a] = await query(waitsSql(), { quiet: true });
      for (let left = sample; left > 0 && !disposed && loadedSection === "waits"; left--) {
        status.textContent = `Amostrando… ${left} s`;
        setContent(el("div.dbq-notice", {}, icon("fa-solid fa-hourglass-half fa-spin"), el("p", {}, `Medindo as esperas dos próximos ${sample} segundos (${left} s)…`)));
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (disposed || loadedSection !== "waits" || opt.sample !== sample) return;
      const [b] = await query(waitsSql());
      rows = waitsDelta(a.objects, b.objects);
    } else rows = (await query(waitsSql())).flatMap((r) => r.objects);
    const sum = summarizeWaits(rows);
    const cats = el(
      "div.dbq-cats",
      {},
      sum.categories.slice(0, 8).map((c) =>
        el(
          "div.dbq-cat",
          { title: c.tip },
          el("div.dbq-cat-head", {}, el("b", {}, c.category), el("span", {}, `${c.pct.toFixed(1)}% · ${formatMs(c.waitMs)}`)),
          el("div.dbq-meter", {}, el("span", { style: `width:${Math.min(100, c.pct)}%` })),
          c.tip ? el("div.dbq-cat-tip", {}, c.tip) : null,
        ),
      ),
    );
    const columns = [
      { name: "tipo", type: "", kind: "str" },
      { name: "categoria", type: "", kind: "str" },
      { name: "%", type: "decimal", kind: "num" },
      { name: "espera (ms)", type: "bigint", kind: "int" },
      { name: "tarefas", type: "bigint", kind: "int" },
      { name: "média (ms)", type: "decimal", kind: "num" },
      { name: "sinal (ms)", type: "bigint", kind: "int" },
      { name: "máx. (ms)", type: "bigint", kind: "int" },
    ];
    const objects = sum.waits.map((w) => ({ tipo: w.type, categoria: w.category, "%": Math.round(w.pct * 10) / 10, "espera (ms)": w.waitMs, tarefas: w.tasks, "média (ms)": Math.round(w.avgMs * 10) / 10, "sinal (ms)": w.signalMs, "máx. (ms)": w.maxMs }));
    const view = makeGrid({ columns, objects, baseName: "esperas" });
    setContent(sum.waits.length ? cats : el("div.dbq-notice", {}, icon("fa-solid fa-circle-check"), el("p", {}, sample ? "Nenhuma espera relevante na amostra." : "Nenhuma espera relevante.")), view.root);
  }

  // Índices ---------------------------------------------------------------------

  async function loadIndexes() {
    const mode = opt.view_ix || "missing";
    const table = opt.table || null;
    addControls(
      select([["missing", "Índices faltantes"], ["usage", "Uso dos índices"], ["fragmentation", "Fragmentação"], ["stats", "Estatísticas desatualizadas"]], mode, (v) => go("indexes", { view_ix: v })),
      table ? chip(`Tabela: ${table.schema}.${table.name}`, () => go("indexes", { table: null })) : null,
    );
    if (mode === "fragmentation" && !opt.fragRun) {
      setContent(
        el(
          "div.dbq-notice",
          {},
          icon("fa-solid fa-puzzle-piece"),
          el("p", {}, `A análise de fragmentação lê as páginas dos índices${table ? " da tabela" : " do banco inteiro"} (modo LIMITED). Em bancos grandes pode levar alguns minutos e gerar IO.`),
          el("button.hx-btn.primary", { type: "button", onclick: () => ((opt.fragRun = true), load()) }, icon("fa-solid fa-play"), " Analisar"),
        ),
      );
      return;
    }
    const sql = mode === "usage" ? indexUsageSql({ table }) : mode === "fragmentation" ? fragmentationSql({ table }) : mode === "stats" ? staleStatsSql({ table }) : missingIndexesSql({ table });
    const [res] = await query(sql);
    if (mode === "fragmentation") opt.fragRun = false;
    let rowMenu;
    let onRow;
    let columns = res.columns;
    let decorate;
    if (mode === "missing") {
      columns = [...res.columns, { name: "ddl", type: "", kind: "str" }];
      decorate = (o, name) => (name === "ddl" ? missingIndexRowDdl(o).replace(/\s+/g, " ") : o[name]);
      const actions = (o) => {
        const ddl = missingIndexRowDdl(o);
        return [
          { label: "Abrir DDL no console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn(), tab.database, ddl) },
          { label: "Criar índice…", icon: "fa-solid fa-plus", run: () => write(ddl, { title: "Criar índice", message: "Criar um índice bloqueia escritas na tabela durante a criação (exceto com ONLINE = ON, Enterprise/Azure). Revise as colunas antes.", label: "Criar índice" }) },
        ];
      };
      rowMenu = actions;
      onRow = (o) => setDetail(sqlDetail(missingIndexRowDdl(o), { title: `${o.schema}.${o.table} · impacto ${o.avg_impact}% · ${formatCount(Number(o.user_seeks) + Number(o.user_scans))} uso(s)`, actions: [el("button.hx-btn", { type: "button", onclick: () => actions(o)[1].run() }, icon("fa-solid fa-plus"), " Criar índice…")] }).root);
    } else if (mode === "usage") {
      columns = [{ name: "sugestão", type: "", kind: "str" }, ...res.columns];
      decorate = (o, name) => (name === "sugestão" ? (isUnusedIndex(o) ? (Number(o.writes) > 0 ? "não usado (só custa escrita)" : "não usado") : Number(o.writes) > Number(o.reads) * 10 && Number(o.reads) > 0 ? "muito mais escrito que lido" : "") : o[name]);
      const dropSql = (o) => `DROP INDEX ${ctx.dialect().quote(o.index)} ON ${ctx.dialect().qualified(o.schema, o.table)};`;
      rowMenu = (o) => (o.is_pk || /^CLUSTERED/.test(o.type_desc) ? [] : [{ label: "Abrir DROP INDEX no console", icon: "fa-regular fa-trash-can", run: () => ctx.openConsole(conn(), tab.database, `-- Contadores zeram quando o servidor reinicia: confirme que o índice não é usado por rotinas mensais etc.\n${dropSql(o)}`) }]);
    } else if (mode === "fragmentation") {
      columns = [...res.columns, { name: "manutenção", type: "", kind: "str" }];
      decorate = (o, name) => (name === "manutenção" ? maintenanceSql(o) : o[name]);
      rowMenu = (o) => (maintenanceSql(o) ? [{ label: "Abrir manutenção no console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn(), tab.database, maintenanceSql(o)) }] : []);
    } else if (mode === "stats") {
      rowMenu = (o) => [
        { label: "Atualizar estatística…", icon: "fa-solid fa-rotate", run: () => write(updateStatsSql(o), { title: "Atualizar estatística", message: "UPDATE STATISTICS lê a tabela (amostra) e pode invalidar planos em cache.", label: "Atualizar", danger: false }) },
        { label: "Abrir no console", icon: "fa-solid fa-terminal", run: () => ctx.openConsole(conn(), tab.database, updateStatsSql(o)) },
      ];
    }
    const view = makeGrid({ columns, objects: res.objects, decorate, onRow, rowMenu, baseName: `indices-${mode}` });
    const hint =
      mode === "missing"
        ? el("div.dbq-banner", {}, icon("fa-solid fa-circle-info"), " Sugestões do otimizador desde o último restart. Elas se sobrepõem: combine as que têm as mesmas colunas antes de criar.")
        : mode === "usage"
          ? el("div.dbq-banner", {}, icon("fa-solid fa-circle-info"), " Os contadores zeram quando o servidor reinicia ou o índice é recriado.")
          : null;
    setContent(hint, view.root);
  }

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
  }

  renderNav();
  let loaded = false;

  return {
    root,
    tab,
    activate() {
      renderNav();
      if (!loaded) {
        loaded = true;
        load();
      } else if (opt.section === "sessions" && !timer && !opt.paused) load();
      activeDetail?.refresh?.();
    },
    refresh: load,
    /** Explorer pediu outra seção/filtro nesta mesma aba. */
    navigate(section, patch) {
      go(section, patch);
    },
    dirty: false,
    beforeClose: async () => true,
    dispose() {
      disposed = true;
      stopTimer();
      if (running) dbApi.cancel(running);
      activeDetail?.dispose?.();
      dbApi.disconnect(sessionId);
    },
  };
}

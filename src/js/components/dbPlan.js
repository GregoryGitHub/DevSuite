import { el, icon } from "../utils/dom.js";
import { highlightCode } from "../utils/highlight.js";
import {
  parsePlan,
  planInsights,
  planLayout,
  opLabel,
  objectText,
  estTotalRows,
  flowRows,
  formatCount,
  shortCount,
  formatMs,
  prettyXml,
  NODE_W,
  NODE_H,
} from "../utils/sqlPlan.js";
import { codeEditor } from "./codeEditor.js";
import { saveFileDialogApi, writeFileApi } from "../api.js";

// Visualizador de plano de execução do SQL Server (estilo SSMS/DataGrip): diagrama com zoom e
// arrastar, árvore em tabela, diagnósticos, propriedades do operador e o XML. Usado pelo
// console (aba "Plano" do resultado), pela aba de plano e pela aba Desempenho.

const PAD = 24;

const OP_ICONS = [
  [/Key Lookup|RID Lookup/, "fa-solid fa-key"],
  [/Index Seek|Clustered Index Seek/, "fa-solid fa-magnifying-glass"],
  [/Columnstore/, "fa-solid fa-table-columns"],
  [/Index Scan/, "fa-solid fa-table-list"],
  [/Table Scan/, "fa-solid fa-table"],
  [/Constant Scan/, "fa-solid fa-list-ol"],
  [/Nested Loops/, "fa-solid fa-repeat"],
  [/Hash Match/, "fa-solid fa-hashtag"],
  [/Merge Join|Adaptive Join/, "fa-solid fa-code-merge"],
  [/Sort/, "fa-solid fa-arrow-down-wide-short"],
  [/Aggregate/, "fa-solid fa-calculator"],
  [/Compute Scalar/, "fa-solid fa-square-root-variable"],
  [/Filter/, "fa-solid fa-filter"],
  [/^Top/, "fa-solid fa-arrow-up-1-9"],
  [/Parallelism/, "fa-solid fa-shuffle"],
  [/Spool/, "fa-solid fa-layer-group"],
  [/Concatenation/, "fa-solid fa-link"],
  [/Insert/, "fa-solid fa-plus"],
  [/Update|Merge$/, "fa-solid fa-pen"],
  [/Delete/, "fa-solid fa-trash"],
  [/Assert/, "fa-solid fa-circle-check"],
  [/Segment|Sequence Project|Window/, "fa-solid fa-bars-staggered"],
  [/Remote|Exchange/, "fa-solid fa-network-wired"],
  [/Bitmap/, "fa-solid fa-border-all"],
];
export const opIcon = (n) => (n.statement ? "fa-solid fa-play" : OP_ICONS.find(([re]) => re.test(opLabel(n)))?.[1] || "fa-solid fa-gear");

const EARLY_ABORT = { GoodEnoughPlanFound: "plano bom o bastante", TimeOut: "tempo limite", MemoryLimitExceeded: "limite de memória" };
const LEVEL_ICON = { error: "fa-solid fa-circle-xmark", warn: "fa-solid fa-triangle-exclamation", info: "fa-solid fa-circle-info" };
const pct = (v) => `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`;
const costClass = (v) => (v >= 50 ? " hot" : v >= 25 ? " warm" : "");
const num6 = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 6 }));

/** Nó "comando" à esquerda da árvore (como o SELECT do SSMS): clicar mostra as propriedades do comando. */
function statementNode(st) {
  return {
    id: -1,
    statement: st,
    physicalOp: st.type,
    logicalOp: "",
    estRows: st.estRows ?? 0,
    estRebinds: 0,
    estRewinds: 0,
    actual: null,
    warnings: st.warnings,
    costPct: 0,
    ownCost: 0,
    subtreeCost: st.subtreeCost,
    children: st.root ? [st.root] : [],
  };
}

/**
 * opts: { xml: string | string[], sql?, title?, baseName?, openSql?(sql), onOpenTab?(xmls), compact? }
 * ctx: { toast, copy(text, msg) }
 */
export function createPlanView(ctx, opts) {
  let sources = []; // XMLs (um por ShowPlanXML)
  let statements = []; // { st, source }
  let plans = [];
  let insights = [];
  let current = 0;
  let view = "diagram";
  let selected = null;
  let layout = null;
  let error = "";
  let propsOpen = !opts.compact;
  const zoom = { scale: 1, tx: PAD, ty: PAD };

  // ---------- Estrutura ----------

  const stmtSel = el("select.dbt-tx-select.dbp-stmt", { title: "Comando", onchange: () => selectStatement(Number(stmtSel.value)) });
  const viewBtns = {};
  const viewBtn = (id, label, ic) => (viewBtns[id] = el("button.dbt-btn", { type: "button", onclick: () => setView(id) }, icon(ic), el("span", {}, label)));
  const insightsCount = el("span.dbp-badge");
  const zoomLabel = el("span.dbp-zoom", {}, "100%");
  const zoomTools = el(
    "span.dbp-zoomtools",
    {},
    el("button.dbt-btn", { type: "button", title: "Diminuir (Ctrl+roda)", onclick: () => zoomBy(1 / 1.2) }, icon("fa-solid fa-minus")),
    zoomLabel,
    el("button.dbt-btn", { type: "button", title: "Aumentar (Ctrl+roda)", onclick: () => zoomBy(1.2) }, icon("fa-solid fa-plus")),
    el("button.dbt-btn", { type: "button", title: "Ajustar à área", onclick: () => fit() }, icon("fa-solid fa-expand")),
  );
  const propsBtn = el("button.dbt-btn", { type: "button", title: "Propriedades", onclick: () => toggleProps() }, icon("fa-solid fa-sliders"));
  const fullBtn = el("button.dbt-btn", { type: "button", title: "Tela cheia (Esc sai)", onclick: () => toggleFull() }, icon("fa-solid fa-up-right-and-down-left-from-center"));
  const moreBtn = el("button.dbt-btn", { type: "button", title: "Mais ações", onclick: (e) => moreMenu(e.currentTarget) }, icon("fa-solid fa-ellipsis"));
  const bar = el(
    "div.dbp-bar",
    {},
    stmtSel,
    el("span.dbt-sep"),
    viewBtn("diagram", "Diagrama", "fa-solid fa-diagram-project"),
    viewBtn("tree", "Árvore", "fa-solid fa-list-ul"),
    el("span.dbp-ins-wrap", {}, viewBtn("insights", "Diagnósticos", "fa-solid fa-stethoscope"), insightsCount),
    viewBtn("xml", "XML", "fa-solid fa-code"),
    el("span.dbt-sep"),
    zoomTools,
    el("span.hx-flex"),
    propsBtn,
    fullBtn,
    moreBtn,
  );
  const head = el("div.dbp-head");
  const edges = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  edges.classList.add("dbp-edges");
  const stage = el("div.dbp-stage", {}, edges);
  const canvas = el("div.dbp-canvas", { tabIndex: 0 }, stage);
  const treeBox = el("div.dbp-tree");
  const insBox = el("div.dbp-insights");
  let xmlEditor = null;
  const xmlBox = el("div.dbp-xml");
  const main = el("div.dbp-main", {}, canvas, treeBox, insBox, xmlBox);
  const props = el("div.dbp-props");
  const body = el("div.dbp-body", {}, main, props);
  const root = el("div.dbp", {}, bar, head, body);

  // ---------- Dados ----------

  function load(xml) {
    sources = (Array.isArray(xml) ? xml : [xml]).filter(Boolean);
    statements = [];
    plans = [];
    error = "";
    try {
      sources.forEach((x, source) => {
        const p = parsePlan(x);
        plans.push(p);
        p.statements.forEach((st) => statements.push({ st, source, plan: p }));
      });
    } catch (e) {
      error = String(e.message || e);
    }
    // Reindexa os comandos (diagnósticos usam o índice global).
    statements.forEach((s, i) => (s.st.index = i));
    insights = plans.flatMap((p) => planInsights(p));
    insights.sort((a, b) => ["error", "warn", "info"].indexOf(a.level) - ["error", "warn", "info"].indexOf(b.level));
    const withPlan = statements.filter((s) => s.st.root);
    stmtSel.innerHTML = "";
    const total = withPlan.reduce((t, s) => t + s.st.subtreeCost, 0) || 1;
    statements.forEach((s, i) => {
      if (!s.st.root) return;
      const text = s.st.text.replace(/\s+/g, " ").slice(0, 70);
      stmtSel.append(el("option", { value: i }, `${withPlan.indexOf(s) + 1}. ${s.st.type} · ${pct((s.st.subtreeCost / total) * 100)} do lote — ${text}`));
    });
    stmtSel.hidden = withPlan.length <= 1;
    insightsCount.textContent = insights.filter((i) => i.level !== "info").length || insights.length || "";
    insightsCount.className = `dbp-badge${insights.some((i) => i.level === "error") ? " error" : insights.some((i) => i.level === "warn") ? " warn" : ""}`;
    current = withPlan.length ? statements.indexOf(withPlan[0]) : 0;
    if (xmlEditor) xmlEditor.setValue(currentXmlPretty());
    selectStatement(current);
  }

  const cur = () => statements[current]?.st || null;
  const currentXml = () => sources[statements[current]?.source ?? 0] || "";
  let prettyCache = new Map();
  function currentXmlPretty() {
    const src = currentXml();
    if (!prettyCache.has(src)) {
      try {
        prettyCache.set(src, prettyXml(src));
      } catch {
        prettyCache.set(src, src);
      }
    }
    return prettyCache.get(src);
  }

  function selectStatement(i) {
    current = i;
    stmtSel.value = String(i);
    const st = cur();
    selected = st ? statementNode(st) : null;
    renderHead();
    renderDiagram();
    renderTree();
    renderInsights();
    renderProps();
    if (xmlEditor) xmlEditor.setValue(currentXmlPretty());
    requestAnimationFrame(() => fit());
  }

  // ---------- Cabeçalho do comando ----------

  function renderHead() {
    head.innerHTML = "";
    const st = cur();
    if (error) return head.append(el("div.dbp-error", {}, icon("fa-solid fa-circle-xmark"), ` ${error}`));
    if (!st) return head.append(el("div.dbp-empty", {}, "Sem plano de execução"));
    const chips = [];
    const chip = (label, value, cls = "") => value !== null && value !== undefined && value !== "" && chips.push(el("span.dbp-chip", { class: `dbp-chip${cls}` }, el("b", {}, label), ` ${value}`));
    chip("Custo", num6(Math.round(st.subtreeCost * 1e4) / 1e4));
    chip(st.actual ? "Plano" : "Plano", st.actual ? "real" : "estimado", st.actual ? " real" : "");
    if (st.timeStats) {
      chip("Decorrido", formatMs(st.timeStats.elapsedMs));
      chip("CPU", formatMs(st.timeStats.cpuMs));
    }
    chip("Linhas est.", st.estRows !== null ? shortCount(st.estRows) : null);
    chip("DOP", st.dop);
    chip("Compilação", st.compileMs !== null ? formatMs(st.compileMs) : null);
    if (st.memoryGrant?.grantedKb) chip("Memória", `${formatCount(st.memoryGrant.grantedKb)} KB${st.memoryGrant.maxUsedKb !== null ? ` (usou ${formatCount(st.memoryGrant.maxUsedKb)})` : ""}`);
    if (st.optimizationLevel) chip("Otimização", st.optimizationLevel === "FULL" ? "completa" : "trivial");
    if (st.earlyAbort) chip("Otimizador parou", EARLY_ABORT[st.earlyAbort] || st.earlyAbort, st.earlyAbort === "GoodEnoughPlanFound" ? "" : " warn");
    head.append(el("div.dbp-text", { title: st.text, html: highlightCode(st.text.replace(/\s+/g, " ").slice(0, 400), "sql") }), el("div.dbp-chips", {}, chips));
  }

  // ---------- Diagrama ----------

  const nodeEls = new Map(); // id -> div

  function renderDiagram() {
    for (const c of [...stage.children]) if (c !== edges) c.remove();
    edges.innerHTML = "";
    nodeEls.clear();
    const st = cur();
    if (!st?.root) {
      layout = null;
      return;
    }
    const top = statementNode(st);
    layout = planLayout(top);
    const w = layout.width + PAD * 2;
    const h = layout.height + PAD * 2;
    edges.setAttribute("width", w);
    edges.setAttribute("height", h);
    edges.setAttribute("viewBox", `${-PAD} ${-PAD} ${w} ${h}`);
    edges.style.left = edges.style.top = `${-PAD}px`;
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    defs.innerHTML = `<marker id="dbp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>`;
    edges.append(defs);
    // Filhos de um mesmo pai saem de alturas diferentes na borda direita dele.
    const byParent = new Map();
    for (const e of layout.edges) {
      if (!byParent.has(e.from)) byParent.set(e.from, []);
      byParent.get(e.from).push(e);
    }
    for (const [from, list] of byParent) {
      list.forEach((e, k) => {
        const x1 = e.to.x;
        const y1 = e.to.y + NODE_H / 2;
        const x2 = from.x + NODE_W;
        const spread = Math.min(NODE_H - 20, 12 * (list.length - 1));
        const y2 = from.y + NODE_H / 2 - spread / 2 + (list.length > 1 ? (spread / (list.length - 1)) * k : 0);
        const mx = x2 + (x1 - x2) / 2;
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 + 2} ${y2}`);
        path.setAttribute("stroke-width", e.width.toFixed(1));
        path.setAttribute("marker-end", "url(#dbp-arrow)");
        path.classList.add("dbp-edge");
        path.dataset.to = e.to.node.id;
        path.dataset.from = from.node.id;
        const n = e.to.node;
        const t = document.createElementNS(ns, "title");
        const est = estTotalRows(n);
        t.textContent = [
          n.actual ? `Linhas reais: ${formatCount(n.actual.rows)}` : null,
          `Linhas estimadas: ${formatCount(est)}`,
          n.avgRowSize ? `Tamanho estimado: ${bytes(est * n.avgRowSize)}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        path.append(t);
        edges.append(path);
        const label = document.createElementNS(ns, "text");
        // Perto do filho (de onde as linhas saem), acima da linha.
        label.setAttribute("x", x1 - 6);
        label.setAttribute("y", y1 - 4 - e.width / 2);
        label.setAttribute("text-anchor", "end");
        label.classList.add("dbp-edge-label");
        label.textContent = shortCount(flowRows(n));
        edges.append(label);
      });
    }
    for (const item of layout.nodes) stage.append(nodeCard(item));
    markSelected();
  }

  function nodeCard({ node: n, x, y }) {
    const a = n.actual;
    const est = estTotalRows(n);
    const rowsLine = n.statement
      ? `Custo: ${num6(Math.round(n.subtreeCost * 1e4) / 1e4)}`
      : a
        ? `${shortCount(a.rows)} de ${shortCount(est)}${est > 0 ? ` (${Math.round((a.rows / est) * 100)}%)` : ""}`
        : `${shortCount(est)} linha(s) est.`;
    const skew = a && Math.max(est, a.rows) >= 100 && (a.rows / Math.max(est, 1e-9) >= 10 || a.rows / Math.max(est, 1e-9) <= 0.1);
    const obj = n.object ? [n.object.table, n.object.index].filter(Boolean).join(".") : "";
    const card = el(
      "div.dbp-node",
      {
        class: `dbp-node${n.statement ? " stmt" : ""}${costClass(n.costPct)}`,
        style: `left:${x}px;top:${y}px;width:${NODE_W}px;height:${NODE_H}px`,
        title: [opLabel(n), n.logicalOp && n.logicalOp !== n.physicalOp ? `(${n.logicalOp})` : "", obj].filter(Boolean).join(" "),
        onclick: (e) => {
          e.stopPropagation();
          select(n);
        },
        ondblclick: (e) => {
          e.stopPropagation();
          select(n);
          if (!propsOpen) toggleProps(true);
        },
        onmouseenter: () => hover(n, true),
        onmouseleave: () => hover(n, false),
      },
      el("div.dbp-node-top", {}, icon(opIcon(n)), n.warnings?.length ? icon("fa-solid fa-triangle-exclamation dbp-warn") : null, n.parallel ? icon("fa-solid fa-shuffle dbp-par") : null),
      el("div.dbp-node-op", {}, opLabel(n)),
      n.logicalOp && n.logicalOp !== n.physicalOp && !n.lookup ? el("div.dbp-node-sub", {}, `(${n.logicalOp})`) : null,
      obj ? el("div.dbp-node-obj", {}, obj) : null,
      n.statement ? null : el("div.dbp-node-cost", {}, `Custo: ${pct(n.costPct)}`, a?.elapsedMs !== null && a?.elapsedMs !== undefined ? el("span.dbp-node-time", {}, ` · ${formatMs(a.elapsedMs)}`) : null),
      el("div.dbp-node-rows", { class: `dbp-node-rows${skew ? " skew" : ""}` }, rowsLine),
    );
    nodeEls.set(n.id, { card, node: n });
    return card;
  }

  function hover(n, on) {
    for (const p of edges.querySelectorAll(".dbp-edge")) {
      if (Number(p.dataset.to) === n.id || Number(p.dataset.from) === n.id) p.classList.toggle("hl", on);
    }
  }

  function select(n) {
    selected = n;
    markSelected();
    renderProps();
    for (const tr of treeBox.querySelectorAll("tr[data-id]")) tr.classList.toggle("on", Number(tr.dataset.id) === n.id);
  }

  function markSelected() {
    for (const { card, node } of nodeEls.values()) card.classList.toggle("sel", node === selected || (selected && node.id === selected.id));
  }

  /** Mostra o nó (diagnóstico "Ir para o nó"). */
  function reveal(id) {
    const st = cur();
    const n = id === null || id === undefined ? null : st?.nodes.find((x) => x.id === id);
    if (!n) return;
    setView("diagram");
    select(n);
    const item = layout?.nodes.find((x) => x.node.id === id);
    if (!item) return;
    const r = canvas.getBoundingClientRect();
    zoom.scale = Math.max(zoom.scale, 0.8);
    zoom.tx = r.width / 2 - (item.x + NODE_W / 2) * zoom.scale;
    zoom.ty = r.height / 2 - (item.y + NODE_H / 2) * zoom.scale;
    applyZoom();
    const card = nodeEls.get(id)?.card;
    card?.classList.add("pulse");
    setTimeout(() => card?.classList.remove("pulse"), 900);
  }

  // Zoom / arrastar
  function applyZoom() {
    stage.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
    zoomLabel.textContent = `${Math.round(zoom.scale * 100)}%`;
  }
  function zoomAt(factor, cx, cy) {
    const s = Math.min(3, Math.max(0.1, zoom.scale * factor));
    zoom.tx = cx - ((cx - zoom.tx) * s) / zoom.scale;
    zoom.ty = cy - ((cy - zoom.ty) * s) / zoom.scale;
    zoom.scale = s;
    applyZoom();
  }
  function zoomBy(factor) {
    const r = canvas.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  }
  function fit() {
    if (!layout || view !== "diagram") return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    zoom.scale = Math.min(1, (r.width - PAD * 2) / layout.width, (r.height - PAD * 2) / layout.height);
    zoom.scale = Math.max(0.15, zoom.scale);
    zoom.tx = Math.max(PAD, (r.width - layout.width * zoom.scale) / 2);
    zoom.ty = Math.max(PAD, (r.height - layout.height * zoom.scale) / 2);
    applyZoom();
  }
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
      else {
        zoom.tx -= e.shiftKey ? e.deltaY : e.deltaX;
        zoom.ty -= e.shiftKey ? 0 : e.deltaY;
        applyZoom();
      }
    },
    { passive: false },
  );
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".dbp-node")) return;
    e.preventDefault();
    canvas.focus();
    const sx = e.clientX - zoom.tx;
    const sy = e.clientY - zoom.ty;
    canvas.classList.add("dragging");
    const move = (ev) => {
      zoom.tx = ev.clientX - sx;
      zoom.ty = ev.clientY - sy;
      applyZoom();
    };
    const up = () => {
      canvas.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  canvas.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) (e.preventDefault(), zoomBy(1.2));
    else if ((e.ctrlKey || e.metaKey) && e.key === "-") (e.preventDefault(), zoomBy(1 / 1.2));
    else if ((e.ctrlKey || e.metaKey) && e.key === "0") (e.preventDefault(), fit());
  });

  // ---------- Árvore ----------

  const collapsed = new Set();
  function renderTree() {
    treeBox.innerHTML = "";
    const st = cur();
    if (!st?.root) return;
    const actual = st.actual;
    const cols = ["Operador", "Objeto", "Custo", "Próprio", "Subárvore", "Linhas est.", actual ? "Linhas reais" : null, actual ? "Execuções" : null, actual ? "Leituras lóg." : null, actual ? "Tempo" : null, "Avisos"].filter(Boolean);
    const tbody = el("tbody");
    const walk = (n, depth) => {
      const kidsN = n.children.length;
      const isCollapsed = collapsed.has(n.id);
      const toggle = kidsN
        ? el("button.dbp-tw", { type: "button", onclick: (e) => (e.stopPropagation(), isCollapsed ? collapsed.delete(n.id) : collapsed.add(n.id), renderTree()) }, icon(isCollapsed ? "fa-solid fa-chevron-right" : "fa-solid fa-chevron-down"))
        : el("span.dbp-tw");
      const a = n.actual;
      const cells = [
        el("td.dbp-op", { style: `padding-left:${6 + depth * 16}px` }, toggle, icon(opIcon(n)), " ", opLabel(n)),
        el("td.dbp-objc", { title: objectText(n) }, objectText(n)),
        el("td.num", { class: `num${costClass(n.costPct)}` }, el("span.dbp-bar-cell", { style: `--w:${Math.min(100, n.costPct)}%` }), pct(n.costPct)),
        el("td.num", {}, num6(Math.round(n.ownCost * 1e5) / 1e5)),
        el("td.num", {}, num6(Math.round(n.subtreeCost * 1e5) / 1e5)),
        el("td.num", {}, formatCount(estTotalRows(n))),
        actual ? el("td.num", {}, a ? formatCount(a.rows) : "—") : null,
        actual ? el("td.num", {}, a ? formatCount(a.executions) : "—") : null,
        actual ? el("td.num", {}, a?.logicalReads !== null && a?.logicalReads !== undefined ? formatCount(a.logicalReads) : "—") : null,
        actual ? el("td.num", {}, a?.elapsedMs !== null && a?.elapsedMs !== undefined ? formatMs(a.elapsedMs) : "—") : null,
        el("td.dbp-wcell", { title: n.warnings.map((w) => w.text).join("\n") }, n.warnings.length ? [icon("fa-solid fa-triangle-exclamation"), ` ${n.warnings.length}`] : ""),
      ];
      tbody.append(el("tr", { dataset: { id: n.id }, class: selected?.id === n.id ? "on" : "", onclick: () => select(n), ondblclick: () => reveal(n.id) }, cells));
      if (!isCollapsed) n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(st.root, 0);
    treeBox.append(el("table.dbp-table", {}, el("thead", {}, el("tr", {}, cols.map((c) => el("th", {}, c)))), tbody));
  }

  // ---------- Diagnósticos ----------

  function renderInsights() {
    insBox.innerHTML = "";
    if (!insights.length) {
      insBox.append(el("div.dbp-empty", {}, icon("fa-solid fa-circle-check"), " Nenhum ponto de atenção encontrado no plano."));
      return;
    }
    const withPlan = statements.filter((s) => s.st.root);
    for (const i of insights) {
      const isMissing = i.kind === "missingIndex";
      const st = statements[i.statement]?.st;
      const actions = el(
        "div.dbp-ins-actions",
        {},
        i.nodeId !== null && i.nodeId !== undefined
          ? el("button.hx-btn", { type: "button", onclick: () => (i.statement !== current && selectStatement(i.statement), reveal(i.nodeId)) }, icon("fa-solid fa-location-crosshairs"), " Ir para o nó")
          : null,
        isMissing ? el("button.hx-btn", { type: "button", onclick: () => ctx.copy(i.detail, "DDL copiado") }, icon("fa-regular fa-copy"), " Copiar DDL") : null,
        isMissing && opts.openSql ? el("button.hx-btn", { type: "button", onclick: () => opts.openSql(i.detail) }, icon("fa-solid fa-terminal"), " Abrir no console") : null,
      );
      insBox.append(
        el(
          "div.dbp-ins",
          { class: `dbp-ins ${i.level}` },
          icon(LEVEL_ICON[i.level]),
          el(
            "div.dbp-ins-body",
            {},
            el("div.dbp-ins-title", {}, i.title),
            withPlan.length > 1 && st ? el("div.dbp-ins-stmt", {}, `Comando ${withPlan.findIndex((s) => s.st === st) + 1}: ${st.text.replace(/\s+/g, " ").slice(0, 90)}`) : null,
            i.detail ? (isMissing ? el("pre.dbp-code", { html: highlightCode(i.detail, "sql") }) : el("div.dbp-ins-detail", {}, i.detail)) : null,
            actions.children.length ? actions : null,
          ),
        ),
      );
    }
  }

  // ---------- Propriedades ----------

  function renderProps() {
    props.innerHTML = "";
    props.hidden = !propsOpen || view === "insights" || view === "xml";
    propsBtn.classList.toggle("on", propsOpen);
    const n = selected;
    if (!n) return;
    const sections = [];
    const section = (title, rows) => {
      const list = rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== "");
      if (list.length) sections.push(el("div.dbp-psec", {}, el("div.dbp-ptitle", {}, title), list.map(([k, v, code]) => el("div.dbp-prow", {}, el("span.dbp-pk", {}, k), code ? el("code.dbp-pv.code", { html: highlightCode(String(v), "sql") }) : el("span.dbp-pv", {}, String(v))))));
    };
    const block = (title, text, lang = "sql") => text && sections.push(el("div.dbp-psec", {}, el("div.dbp-ptitle", {}, title), el("pre.dbp-code", { html: highlightCode(text, lang) })));
    if (n.statement) {
      const st = n.statement;
      props.append(el("div.dbp-phead", {}, icon("fa-solid fa-play"), el("b", {}, st.type), el("span.dbp-muted", {}, st.actual ? "plano real" : "plano estimado")));
      block("Comando", st.text);
      section("Custo e linhas", [
        ["Custo estimado", num6(st.subtreeCost)],
        ["Linhas estimadas", st.estRows !== null ? formatCount(st.estRows) : null],
        st.timeStats ? ["Tempo decorrido", formatMs(st.timeStats.elapsedMs)] : null,
        st.timeStats ? ["Tempo de CPU", formatMs(st.timeStats.cpuMs)] : null,
      ]);
      section("Otimização", [
        ["Nível", st.optimizationLevel],
        ["Otimizador parou", EARLY_ABORT[st.earlyAbort] || st.earlyAbort],
        ["Estimador de cardinalidade", st.cardinalityEstimator],
        ["Paralelismo (DOP)", st.dop],
        ["Motivo de não paralelizar", st.nonParallelReason],
        ["Compilação", st.compileMs !== null ? `${formatMs(st.compileMs)} (CPU ${formatMs(st.compileCpuMs)})` : null],
        ["Memória de compilação", st.compileMemoryKb !== null ? `${formatCount(st.compileMemoryKb)} KB` : null],
        ["Tamanho do plano em cache", st.cachedPlanKb !== null ? `${formatCount(st.cachedPlanKb)} KB` : null],
        ["Do cache", st.retrievedFromCache ? "sim" : null],
        ["Query hash", st.queryHash],
        ["Plan hash", st.planHash],
      ]);
      if (st.memoryGrant) {
        const g = st.memoryGrant;
        const kb = (v) => (v !== null && v !== undefined ? `${formatCount(v)} KB` : null);
        section("Memory grant", [["Pedido", kb(g.requestedKb)], ["Concedido", kb(g.grantedKb)], ["Usado (máx.)", kb(g.maxUsedKb)], ["Desejado", kb(g.desiredKb)], ["Mínimo (serial)", kb(g.serialRequiredKb)], ["Espera pelo grant", g.waitMs ? formatMs(g.waitMs) : null]]);
      }
      if (st.parameters.length) {
        sections.push(
          el(
            "div.dbp-psec",
            {},
            el("div.dbp-ptitle", {}, "Parâmetros"),
            el(
              "table.dbp-ptable",
              {},
              el("tr", {}, el("th", {}, "Nome"), el("th", {}, "Compilado"), el("th", {}, "Execução")),
              st.parameters.map((p) => el("tr", { class: p.runtime !== null && p.compiled !== null && p.runtime !== p.compiled ? "diff" : "" }, el("td", {}, p.name, p.type ? el("span.dbp-muted", {}, ` ${p.type}`) : null), el("td", {}, p.compiled ?? "—"), el("td", {}, p.runtime ?? "—"))),
            ),
          ),
        );
      }
      if (st.waits.length) section("Esperas", [...st.waits].sort((a, b) => b.ms - a.ms).map((w) => [w.type, `${formatMs(w.ms)} (${formatCount(w.count)}×)`]));
      if (st.warnings.length) section("Avisos", st.warnings.map((w, k) => [`${k + 1}`, w.text]));
    } else {
      const a = n.actual;
      props.append(el("div.dbp-phead", {}, icon(opIcon(n)), el("b", {}, opLabel(n)), el("span.dbp-muted", {}, `nó ${n.id}`)));
      section("Operação", [
        ["Física", n.physicalOp],
        ["Lógica", n.logicalOp],
        ["Modo", n.executionMode],
        ["Paralelo", n.parallel ? "sim" : "não"],
        ["Ordenado", n.ordered ? "sim" : null],
      ]);
      section("Custo estimado", [
        ["Do operador", `${num6(n.ownCost)} (${pct(n.costPct)})`],
        ["Subárvore", num6(n.subtreeCost)],
        ["IO", num6(n.estIO)],
        ["CPU", num6(n.estCPU)],
      ]);
      section("Linhas", [
        ["Estimadas por execução", formatCount(n.estRows)],
        ["Execuções estimadas", formatCount(1 + n.estRebinds + n.estRewinds)],
        ["Estimadas no total", formatCount(estTotalRows(n))],
        a ? ["Reais", formatCount(a.rows)] : null,
        a ? ["Execuções reais", formatCount(a.executions)] : null,
        a?.rowsRead !== null && a?.rowsRead !== undefined ? ["Lidas (reais)", formatCount(a.rowsRead)] : null,
        n.estRowsRead !== null ? ["Lidas (estimadas)", formatCount(n.estRowsRead)] : null,
        n.tableCardinality !== null ? ["Linhas da tabela", formatCount(n.tableCardinality)] : null,
        n.avgRowSize !== null ? ["Tamanho médio da linha", `${n.avgRowSize} B`] : null,
      ]);
      if (a) {
        section("Execução real", [
          ["Tempo decorrido", formatMs(a.elapsedMs)],
          ["Tempo de CPU", formatMs(a.cpuMs)],
          ["Leituras lógicas", a.logicalReads !== null ? formatCount(a.logicalReads) : null],
          ["Leituras físicas", a.physicalReads !== null ? formatCount(a.physicalReads) : null],
          ["Read-ahead", a.readAheads !== null ? formatCount(a.readAheads) : null],
          ["Threads", a.threads > 1 ? a.threads : null],
          ["Modo real", a.mode],
        ]);
      }
      if (n.object) section("Objeto", [["Tabela", [n.object.schema, n.object.table].filter(Boolean).join(".")], ["Índice", n.object.index], ["Alias", n.object.alias], ["Tipo", n.object.kind], ["Banco", n.object.database]]);
      block("Seek", n.seekPredicate);
      block("Predicado", n.predicate);
      block("Residual", n.residual);
      if (n.outputList.length) block("Saída", n.outputList.join(",\n"));
      if (n.warnings.length) section("Avisos", n.warnings.map((w, k) => [`${k + 1}`, w.text]));
      const attrs = Object.entries(n.attrs).filter(([k]) => k !== "NodeId");
      if (attrs.length) {
        const det = el("details.dbp-psec", {}, el("summary.dbp-ptitle", {}, "Todos os atributos"), attrs.map(([k, v]) => el("div.dbp-prow", {}, el("span.dbp-pk", {}, k), el("span.dbp-pv", {}, v))));
        sections.push(det);
      }
    }
    props.append(...sections);
  }

  // ---------- Visões e ações ----------

  function setView(v) {
    view = v;
    for (const [id, b] of Object.entries(viewBtns)) b.classList.toggle("on", id === v);
    canvas.hidden = v !== "diagram";
    treeBox.hidden = v !== "tree";
    insBox.hidden = v !== "insights";
    xmlBox.hidden = v !== "xml";
    zoomTools.hidden = v !== "diagram";
    if (v === "xml" && !xmlEditor) {
      xmlEditor = codeEditor({ value: currentXmlPretty(), lang: "xml", fill: true, readOnly: true });
      xmlBox.append(xmlEditor.root);
    }
    if (v === "xml") requestAnimationFrame(() => xmlEditor.refresh());
    if (v === "diagram") requestAnimationFrame(() => applyZoom());
    renderProps();
  }

  function toggleProps(on = !propsOpen) {
    propsOpen = on;
    renderProps();
  }

  // Tela cheia: o nó sai do container (overflow hidden) e um marcador guarda o lugar.
  const placeholder = el("div.dbp-placeholder");
  let parentBefore = null;
  let nextBefore = null;
  function toggleFull() {
    if (!root.classList.contains("full")) {
      parentBefore = root.parentNode;
      nextBefore = root.nextSibling;
      parentBefore?.insertBefore(placeholder, root);
      // Dentro do app (variáveis de cor e menus continuam valendo), por cima de tudo.
      (document.getElementById("db-app") || document.body).append(root);
      root.classList.add("full");
      document.addEventListener("keydown", onFullKey, true);
    } else exitFull();
    requestAnimationFrame(() => fit());
  }
  function exitFull() {
    root.classList.remove("full");
    document.removeEventListener("keydown", onFullKey, true);
    if (placeholder.parentNode) placeholder.replaceWith(root);
    requestAnimationFrame(() => fit());
  }
  function onFullKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitFull();
    }
  }

  function moreMenu(anchor) {
    const items = [
      { label: "Copiar XML do plano", icon: "fa-regular fa-copy", run: () => ctx.copy(currentXml(), "XML copiado") },
      { label: "Salvar .sqlplan…", icon: "fa-solid fa-download", run: save },
      opts.onOpenTab ? { label: "Abrir em aba própria", icon: "fa-regular fa-window-restore", run: () => opts.onOpenTab(sources) } : null,
      cur()?.text ? { label: "Copiar texto do comando", icon: "fa-solid fa-terminal", run: () => ctx.copy(cur().text, "Comando copiado") } : null,
    ];
    ctx.showMenuBelow(anchor, items);
  }

  async function save() {
    const base = (opts.baseName || "plano").replace(/[\\/:*?"<>|]+/g, "_");
    const path = await saveFileDialogApi({ defaultPath: `${base}.sqlplan`, filters: [{ name: "Plano de execução (SSMS)", extensions: ["sqlplan"] }, { name: "XML", extensions: ["xml"] }], title: "Salvar plano de execução" });
    if (!path) return;
    try {
      await writeFileApi(path, { text: currentXml() });
      ctx.toast("Plano salvo");
    } catch (e) {
      ctx.toast(`Falha ao salvar: ${e}`);
    }
  }

  setView("diagram");
  load(opts.xml);

  const ro = new ResizeObserver(() => {
    if (view === "diagram" && layout && !root.dataset.fitted) {
      const r = canvas.getBoundingClientRect();
      if (r.width && r.height) {
        root.dataset.fitted = "1";
        fit();
      }
    }
  });
  ro.observe(canvas);

  return {
    root,
    /** Chamado quando o container fica visível (o diagrama precisa do tamanho real). */
    refresh() {
      if (view === "diagram") {
        if (!root.dataset.fitted) fit();
        if (canvas.getBoundingClientRect().width) root.dataset.fitted = "1";
      }
      xmlEditor?.refresh();
    },
    setXml(xml) {
      delete root.dataset.fitted;
      prettyCache = new Map();
      load(xml);
    },
    get statements() {
      return statements.map((s) => s.st);
    },
    get insights() {
      return insights;
    },
    dispose() {
      ro.disconnect();
      if (root.classList.contains("full")) exitFull();
    },
  };
}

const bytes = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${Math.round(b)} B`);

/** Aba própria com um plano (do console, de um arquivo .sqlplan ou do cache/Query Store). */
export function createPlanTab(ctx, tab, getXml) {
  let view = null;
  const status = el("span.dbf-info");
  const root = el("div.dbc.dbp-tab");
  async function load() {
    root.innerHTML = "";
    let xml = getXml(tab);
    if (!xml && tab.options?.path) {
      try {
        xml = await ctx.readFile(tab.options.path);
      } catch (e) {
        root.append(el("div.dbp-empty", {}, `Não foi possível ler ${tab.options.path}: ${e}`));
        return;
      }
    }
    if (!xml) {
      root.append(el("div.dbp-empty", {}, "O plano não está mais disponível (planos de execução não são guardados entre sessões). Gere-o de novo no console."));
      return;
    }
    view?.dispose();
    view = createPlanView(ctx, { xml, baseName: tab.name || "plano", openSql: (sql) => ctx.openConsole(ctx.conn(tab.conn_id), tab.database, sql) });
    root.append(view.root);
    requestAnimationFrame(() => view.refresh());
  }
  let loaded = false;
  return {
    root,
    tab,
    status,
    activate() {
      if (!loaded) {
        loaded = true;
        load();
      } else view?.refresh();
    },
    refresh: load,
    dirty: false,
    beforeClose: async () => true,
    dispose() {
      view?.dispose();
    },
  };
}

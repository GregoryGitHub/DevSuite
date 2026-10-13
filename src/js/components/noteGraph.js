import { el, icon } from "../utils/dom.js";
import { createLayout, DEFAULT_FORCES } from "../utils/graphLayout.js";
import { fold, NOTE_TYPES } from "../utils/zettel.js";

// Grafo das Notas (modo Zettelkasten): notas e tags como nós, links [[ ]] como arestas.
// <canvas> com simulação de forças própria (graphLayout.js). Só há requestAnimationFrame
// enquanto a simulação está ativa ou há interação: parado, o grafo não gasta CPU.

const OPTS_KEY = "nt-graph-opts";
const memory = new Map(); // key do nó -> {x, y}: o desenho se mantém entre aberturas
const MIN_K = 0.08;
const MAX_K = 6;

const DEFAULT_LABEL_ZOOM = 0.8; // abaixo deste zoom, só os rótulos pedidos (mouse, nota atual, busca)
const FOCUS_IN_MS = 180;
const FOCUS_OUT_MS = 260;

function loadOpts() {
  const def = { mode: "global", depth: 1, tags: true, orphans: true, missing: false, folder: "all", labelZoom: DEFAULT_LABEL_ZOOM, forces: { ...DEFAULT_FORCES } };
  try {
    const saved = JSON.parse(localStorage.getItem(OPTS_KEY) || "{}");
    return { ...def, ...saved, forces: { ...DEFAULT_FORCES, ...(saved.forces || {}) } };
  } catch {
    return def;
  }
}

// Foco do hover: entra e sai com easing (sem escurecer o resto de uma vez).
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function saveOpts(o) {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(o));
  } catch {}
}

/**
 * host: <section> do grafo. cb: {
 *   data(opts) -> { nodes, edges } (buildGraph), folders() -> [{id, name}], currentId(),
 *   open(id), openTag(tag), create(title), back()
 * }
 */
export function createGraph(host, cb) {
  const opts = loadOpts();
  let center = null; // nota central do modo local
  let graph = { nodes: [], edges: [] };
  let sim = null;
  let adj = [];
  let labelOrder = []; // índices dos nós na ordem de prioridade dos rótulos
  let labelW = new Float32Array(0); // largura medida de cada rótulo (-1 = ainda não medida)
  let cam = { x: 0, y: 0, k: 1 };
  let autoFit = true;
  let frame = 0;
  let visible = false;
  let hover = -1; // nó sob o mouse (cursor, tooltip)
  let focusNode = -1; // nó em foco: continua durante o fade-out depois que o mouse sai
  let focusT = 0; // 0..1, progresso do foco
  let focusTarget = 0;
  let lastFrame = 0;
  let matches = [];
  let matchSet = null;
  let matchCursor = -1;
  let tween = null;
  let colors = null;
  let dpr = 1;
  let width = 0;
  let height = 0;

  // ---------- DOM ----------

  const search = el("input.ng-search", { type: "search", placeholder: "Buscar nó (título, #tag, tag:, type:)", spellcheck: false, autocomplete: "off" });
  const count = el("span.ng-count");
  const seg = el(
    "div.ng-seg",
    {},
    el("button", { type: "button", dataset: { mode: "global" } }, "Global"),
    el("button", { type: "button", dataset: { mode: "local" } }, "Local"),
  );
  const depth = el("select.ng-select", { title: "Profundidade do grafo local" }, ...[1, 2, 3].map((d) => el("option", { value: String(d) }, `${d} nível${d > 1 ? "s" : ""}`)));
  const folder = el("select.ng-select", { title: "Pasta" });
  const toggle = (key, label, iconCls) =>
    el("button.ng-toggle", { type: "button", dataset: { opt: key }, title: label }, icon(iconCls), el("span", {}, label));
  const toggles = el("div.ng-toggles", {}, toggle("tags", "Tags", "fa-solid fa-hashtag"), toggle("orphans", "Órfãs", "fa-regular fa-circle"), toggle("missing", "Pendentes", "fa-regular fa-file"));
  const fitBtn = el("button.ng-icon", { type: "button", title: "Enquadrar (duplo clique no fundo)" }, icon("fa-solid fa-expand"));
  const shakeBtn = el("button.ng-icon", { type: "button", title: "Reorganizar" }, icon("fa-solid fa-wand-magic-sparkles"));
  const backBtn = el("button.nt-back.compact-only", { type: "button" }, icon("fa-solid fa-chevron-left"), " Pastas");
  const panelBtn = el("button.ng-icon", { type: "button", title: "Ajustes: títulos e forças" }, icon("fa-solid fa-sliders"));

  // Painel de ajustes (como "Exibição/Forças" do Obsidian). Fica no nt-graph-opts do localStorage.
  const zoomOut = el("span.ng-panel-hint");
  const sliders = [];
  const slider = (label, { min, max, step, get, set, fmt = (v) => String(v), live }) => {
    const out = el("span.ng-panel-val");
    const input = el("input.ng-range", { type: "range", min, max, step });
    const sync = () => {
      input.value = String(get());
      out.textContent = fmt(get());
    };
    input.addEventListener("input", () => {
      set(Number(input.value));
      out.textContent = fmt(get());
      live();
    });
    input.addEventListener("change", () => saveOpts(opts));
    input.addEventListener("keydown", (e) => e.key !== "Escape" && e.stopPropagation());
    sliders.push(sync);
    return el("label.ng-panel-row", {}, el("span.ng-panel-label", {}, label, out), input);
  };
  const applyForces = () => {
    sim?.setForces(opts.forces);
    request();
  };
  const force = (key) => ({ get: () => opts.forces[key], set: (v) => (opts.forces[key] = v), live: applyForces });
  const panel = el(
    "div.ng-panel",
    { hidden: true },
    el("div.ng-panel-head", {}, "Exibição"),
    slider("Títulos a partir do zoom", {
      min: 0.1, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`,
      get: () => opts.labelZoom, set: (v) => (opts.labelZoom = v), live: () => request(),
    }),
    zoomOut,
    el("div.ng-panel-head", {}, "Forças"),
    slider("Repulsão", { min: 20, max: 400, step: 5, ...force("repulsion") }),
    slider("Distância das ligações", { min: 20, max: 250, step: 5, ...force("linkDistance") }),
    slider("Força das ligações (atração)", { min: 0.1, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), ...force("linkStrength") }),
    slider("Gravidade ao centro", { min: 0, max: 0.15, step: 0.005, fmt: (v) => v.toFixed(3), ...force("gravity") }),
    el(
      "button.ng-panel-reset",
      {
        type: "button",
        onclick: () => {
          opts.labelZoom = DEFAULT_LABEL_ZOOM;
          opts.forces = { ...DEFAULT_FORCES };
          saveOpts(opts);
          sliders.forEach((s) => s());
          applyForces();
        },
      },
      icon("fa-solid fa-rotate-left"),
      "Restaurar padrões",
    ),
  );
  const togglePanel = (open = panel.hidden) => {
    panel.hidden = !open;
    panelBtn.classList.toggle("active", open);
    if (open) sliders.forEach((s) => s());
    request(); // atualiza o "zoom atual"
  };
  panelBtn.addEventListener("click", () => togglePanel());
  // Clique fora fecha (o canvas continua interativo com o painel aberto).
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !panelBtn.contains(e.target)) togglePanel(false);
  });

  const canvas = el("canvas.ng-canvas");
  const empty = el("div.ng-empty", { hidden: true });
  const legend = el("div.ng-legend");
  const stage = el("div.ng-stage", {}, canvas, empty, legend, panel);
  const bar = el(
    "div.ng-bar",
    {},
    backBtn,
    el("label.ng-search-wrap", {}, icon("fa-solid fa-magnifying-glass"), search, count),
    seg,
    depth,
    folder,
    toggles,
    el("span.ng-spacer"),
    panelBtn,
    shakeBtn,
    fitBtn,
  );
  host.replaceChildren(bar, stage);
  const ctx = canvas.getContext("2d");

  // ---------- Cores (tokens do tema) ----------

  function readColors() {
    const cs = getComputedStyle(host);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    const text = v("--nt-text", "#ddd");
    colors = {
      text,
      muted: v("--nt-muted", "#888"),
      accent: v("--nt-yellow", "#f5c518"),
      bg: v("--nt-bg", "#1e1e1e"),
      edge: v("--nt-sep-strong", "rgba(128,128,128,.3)"),
      tag: v("--syn-tag", "#569cd6"),
      type: {
        permanent: v("--nt-yellow", "#f5c518"),
        literature: v("--syn-type", "#4ec9b0"),
        fleeting: v("--nt-muted", "#888"),
        hub: v("--syn-keyword", "#c586c0"),
        "": v("--nt-text-2", text),
      },
    };
  }

  let themeValue = document.documentElement.dataset.theme;
  new MutationObserver(() => {
    // data-theme é regravado com o mesmo valor ao carregar as configurações: só redesenha se mudou.
    if (document.documentElement.dataset.theme === themeValue) return;
    themeValue = document.documentElement.dataset.theme;
    if (!visible) return (colors = null);
    readColors();
    renderLegend();
    request();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------- Dados ----------

  function rebuild() {
    sim?.positions();
    const f = opts.folder === "all" ? null : Number(opts.folder);
    graph = cb.data({
      tags: opts.tags,
      orphans: opts.orphans,
      missing: opts.missing,
      folderId: opts.mode === "local" ? null : f,
      center: opts.mode === "local" ? center : null,
      depth: opts.depth,
    });
    adj = graph.nodes.map(() => []);
    for (const [a, b] of graph.edges) adj[a].push(b), adj[b].push(a);
    // Ordem dos rótulos: notas antes de tags, mais ligadas primeiro.
    labelOrder = graph.nodes
      .map((_, i) => i)
      .sort((a, b) => (graph.nodes[a].kind === "tag") - (graph.nodes[b].kind === "tag") || adj[b].length - adj[a].length);
    labelW = new Float32Array(graph.nodes.length).fill(-1);
    const fresh = graph.nodes.some((n) => !memory.has(n.key));
    sim = createLayout(graph.nodes, graph.edges, memory, opts.forces);
    autoFit = fresh || opts.mode === "local";
    resetFocus();
    applySearch();
    renderChrome();
    request();
  }

  function radius(i) {
    const n = graph.nodes[i];
    return (n.kind === "tag" ? 3 : 3.6) + Math.sqrt(n.degree) * 1.5;
  }

  // ---------- Câmera ----------

  function toWorld(sx, sy) {
    return { x: (sx - width / 2) / cam.k + cam.x, y: (sy - height / 2) / cam.k + cam.y };
  }

  function bounds(indices) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of indices) {
      const r = radius(i);
      minX = Math.min(minX, sim.x[i] - r);
      minY = Math.min(minY, sim.y[i] - r);
      maxX = Math.max(maxX, sim.x[i] + r);
      maxY = Math.max(maxY, sim.y[i] + r);
    }
    return { minX, minY, maxX, maxY };
  }

  function fitCamera() {
    if (!sim?.n || !width) return cam;
    const b = bounds(graph.nodes.keys());
    const pad = 40;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((width - pad * 2) / (b.maxX - b.minX || 1), (height - pad * 2) / (b.maxY - b.minY || 1), 3)));
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, k };
  }

  function animateTo(target, ms = 380) {
    tween = { from: { ...cam }, to: target, t0: performance.now(), ms };
    request();
  }

  // ---------- Desenho ----------

  function request() {
    if (!frame && visible) frame = requestAnimationFrame(tick);
  }

  function setHover(i) {
    hover = i;
    if (i >= 0) {
      focusNode = i; // de um nó direto para outro: o fundo continua escuro, só troca o foco
      focusTarget = 1;
    } else focusTarget = 0;
    // Só opacidade, sem movimento: vale também com "reduzir animações" do sistema.
    request();
  }

  function resetFocus() {
    hover = -1;
    focusNode = -1;
    focusT = focusTarget = 0;
  }

  function stepFocus(dt) {
    if (focusT === focusTarget) return;
    focusT = focusTarget
      ? Math.min(1, focusT + dt / FOCUS_IN_MS)
      : Math.max(0, focusT - dt / FOCUS_OUT_MS);
    if (!focusT) focusNode = -1;
  }

  function tick(now) {
    frame = 0;
    if (!visible) return;
    stepFocus(lastFrame ? Math.min(64, now - lastFrame) : 16);
    lastFrame = now;
    if (sim?.active) {
      // Vários passos por quadro dentro de ~7 ms: assenta rápido sem travar a interface.
      const t0 = performance.now();
      let steps = 0;
      do sim.step();
      while (sim.active && ++steps < 12 && !drag && performance.now() - t0 < 7);
      if (autoFit) {
        const f = fitCamera();
        cam = { x: cam.x + (f.x - cam.x) * 0.25, y: cam.y + (f.y - cam.y) * 0.25, k: cam.k + (f.k - cam.k) * 0.25 };
      }
    } else if (autoFit) {
      autoFit = false;
      animateTo(fitCamera(), 250);
    }
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / tween.ms);
      const e = 1 - Math.pow(1 - t, 3);
      const { from, to } = tween;
      cam = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
      if (t >= 1) tween = null;
    }
    draw();
    if (sim?.active || tween || drag || focusT !== focusTarget) request();
    else lastFrame = 0; // parado: o próximo quadro não conta o tempo ocioso
  }

  function draw() {
    if (!colors) readColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!sim?.n) return;
    const { x, y } = sim;
    const k = cam.k;
    const ox = width / 2 - cam.x * k;
    const oy = height / 2 - cam.y * k;
    // fe = intensidade do foco (0 = sem foco, 1 = foco completo), com easing.
    const fn = focusNode >= 0 && focusNode < sim.n ? focusNode : -1;
    const fe = fn >= 0 ? easeInOut(focusT) : 0;
    const focus = fe > 0 ? new Set([fn, ...adj[fn]]) : null;
    // Quanto cada nó está "apagado" (0..1): fora da busca = 1; fora do foco = fe.
    const dimOf = (i) => Math.max(matchSet && !matchSet.has(i) ? 1 : 0, focus && !focus.has(i) ? fe : 0);

    // Arestas: um traço só para todas; as do nó em foco por cima, destacadas.
    ctx.lineWidth = Math.max(0.6, Math.min(1.4, k));
    ctx.strokeStyle = colors.edge;
    ctx.globalAlpha = matchSet ? 0.35 : 0.9 - 0.55 * fe;
    ctx.beginPath();
    for (const [a, b] of graph.edges) {
      ctx.moveTo(x[a] * k + ox, y[a] * k + oy);
      ctx.lineTo(x[b] * k + ox, y[b] * k + oy);
    }
    ctx.stroke();
    if (focus) {
      ctx.globalAlpha = fe;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = Math.max(1, Math.min(2, k * 1.4));
      ctx.beginPath();
      for (const j of adj[fn]) {
        ctx.moveTo(x[fn] * k + ox, y[fn] * k + oy);
        ctx.lineTo(x[j] * k + ox, y[j] * k + oy);
      }
      ctx.stroke();
    }

    // Nós agrupados por cor (poucas trocas de estado no canvas).
    const buckets = new Map();
    const cur = cb.currentId();
    for (let i = 0; i < sim.n; i++) {
      const sx = x[i] * k + ox;
      const sy = y[i] * k + oy;
      const r = Math.max(1.6, radius(i) * k);
      if (sx < -r || sy < -r || sx > width + r || sy > height + r) continue;
      const n = graph.nodes[i];
      const color = n.kind === "tag" ? colors.tag : n.kind === "missing" ? colors.muted : colors.type[n.type] || colors.type[""];
      // Durante o fade só existem 3 níveis (0, fe, 1): poucos grupos por quadro.
      const alpha = 1 - 0.82 * dimOf(i);
      const key = `${color}|${alpha}|${n.kind}`;
      if (!buckets.has(key)) buckets.set(key, { color, alpha, kind: n.kind, items: [] });
      buckets.get(key).items.push(sx, sy, r);
    }
    for (const b of buckets.values()) {
      ctx.globalAlpha = b.alpha;
      ctx.beginPath();
      const it = b.items;
      for (let j = 0; j < it.length; j += 3) {
        const [sx, sy, r] = [it[j], it[j + 1], it[j + 2]];
        if (b.kind === "tag") {
          ctx.moveTo(sx, sy - r * 1.15);
          ctx.lineTo(sx + r * 1.15, sy);
          ctx.lineTo(sx, sy + r * 1.15);
          ctx.lineTo(sx - r * 1.15, sy);
          ctx.closePath();
        } else {
          ctx.moveTo(sx + r, sy);
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
        }
      }
      if (b.kind === "missing") {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        ctx.fillStyle = b.color;
        ctx.fill();
      }
    }

    // Destaques: nota atual, resultado da busca selecionado, nó sob o mouse.
    ctx.globalAlpha = 1;
    const ring = (i, color, w) => {
      if (i < 0 || i >= sim.n) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(x[i] * k + ox, y[i] * k + oy, Math.max(1.6, radius(i) * k) + 3, 0, Math.PI * 2);
      ctx.stroke();
    };
    const curIndex = cur == null ? -1 : graph.nodes.findIndex((n) => n.id === cur);
    ring(curIndex, colors.accent, 2);
    if (matchCursor >= 0) ring(matches[matchCursor], colors.text, 1.5);
    if (focus) {
      ctx.globalAlpha = fe;
      ring(fn, colors.text, 1.5);
    }

    drawLabels({ x, y, k, ox, oy, focus, fn, fe, curIndex });
    ctx.globalAlpha = 1;
    if (!panel.hidden) zoomOut.textContent = `zoom atual ${k.toFixed(2)}×`;
  }

  // Rótulos (em coordenadas de tela, nítidos em qualquer zoom), sem sobreposição: entram por
  // prioridade e um rótulo que encostaria noutro já desenhado fica de fora. Com o grafo inteiro
  // na tela aparecem só os das notas mais ligadas; aproximar abre espaço para os demais.
  const LABEL_H = 14;
  const LABEL_GAP = 4;
  const GRID = 48;

  function labelText(i) {
    const label = graph.nodes[i].label;
    return label.length > 32 ? `${label.slice(0, 30)}…` : label;
  }

  function labelWidth(i) {
    if (labelW[i] < 0) labelW[i] = ctx.measureText(labelText(i)).width;
    return labelW[i];
  }

  function drawLabels({ x, y, k, ox, oy, focus, fn, fe, curIndex }) {
    ctx.font = "400 11px Poppins, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.strokeStyle = colors.bg;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    const grid = new Map();
    const rects = [];
    const fits = (r) => {
      for (let gx = Math.floor(r.x0 / GRID); gx <= Math.floor(r.x1 / GRID); gx++) {
        for (let gy = Math.floor(r.y0 / GRID); gy <= Math.floor(r.y1 / GRID); gy++) {
          for (const j of grid.get(gx * 100003 + gy) || []) {
            const o = rects[j];
            if (r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0) return false;
          }
        }
      }
      return true;
    };
    const take = (r) => {
      const id = rects.push(r) - 1;
      for (let gx = Math.floor(r.x0 / GRID); gx <= Math.floor(r.x1 / GRID); gx++) {
        for (let gy = Math.floor(r.y0 / GRID); gy <= Math.floor(r.y1 / GRID); gy++) {
          const key = gx * 100003 + gy;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(id);
        }
      }
    };
    const done = new Set();
    // force = desenha mesmo encostando (nó sob o mouse, nota atual, resultado selecionado).
    const place = (i, force, alpha) => {
      if (i < 0 || done.has(i)) return;
      const sx = x[i] * k + ox;
      const sy = y[i] * k + oy + Math.max(1.6, radius(i) * k) + 3;
      const w = labelWidth(i);
      if (sx + w / 2 < 0 || sx - w / 2 > width || sy > height || sy + LABEL_H < 0) return;
      const r = { x0: sx - w / 2 - LABEL_GAP, x1: sx + w / 2 + LABEL_GAP, y0: sy - 1, y1: sy + LABEL_H };
      if (!force && !fits(r)) return;
      done.add(i);
      take(r);
      ctx.globalAlpha = alpha;
      // Contorno da cor do fundo: o texto fica legível por cima de arestas e nós.
      ctx.strokeText(labelText(i), sx, sy);
      ctx.fillStyle = graph.nodes[i].kind === "tag" ? colors.tag : colors.text;
      ctx.fillText(labelText(i), sx, sy);
    };

    place(hover, true, 1);
    if (fn >= 0 && fn !== hover) place(fn, true, fe); // foco saindo: some junto com o resto
    place(curIndex, true, 1);
    if (matchCursor >= 0) place(matches[matchCursor], true, 1);
    if (matchSet) {
      for (const i of labelOrder) if (matchSet.has(i)) place(i, false, 0.9);
      return;
    }
    // Vizinhos do foco (os mais ligados primeiro), em qualquer zoom: foram pedidos pelo mouse.
    if (focus) for (const i of labelOrder) if (focus.has(i)) place(i, false, 0.95 * fe);
    // Demais rótulos só a partir do zoom configurado (painel), entrando aos poucos com o zoom
    // e cedendo lugar ao foco enquanto ele aparece.
    const z = opts.labelZoom;
    const a = 0.85 * Math.min(1, Math.max(0, (k - z) / (z * 0.3))) * (1 - fe);
    if (a < 0.02) return;
    for (const i of labelOrder) place(i, false, a);
  }

  // ---------- Busca ----------

  function applySearch() {
    const q = search.value.trim();
    matchCursor = -1;
    if (!q) {
      matches = [];
      matchSet = null;
      count.textContent = "";
      request();
      return;
    }
    let kind = null;
    let term = q;
    const m = /^(tag|type|tipo):\s*(.*)$/i.exec(q);
    if (m) (kind = m[1].toLowerCase() === "tag" ? "tag" : "type"), (term = m[2]);
    else if (q.startsWith("#")) (kind = "tag"), (term = q.slice(1));
    const f = fold(term);
    const typeLabel = (t) => NOTE_TYPES.find(([v]) => v === t)?.[1] || t;
    matches = [];
    graph.nodes.forEach((n, i) => {
      let hit;
      if (kind === "tag") hit = n.kind === "tag" && fold(n.label.slice(1)).startsWith(f);
      else if (kind === "type") hit = n.kind === "note" && !!n.type && (fold(n.type).startsWith(f) || fold(typeLabel(n.type)).startsWith(f));
      else hit = fold(n.label).includes(f);
      if (hit) matches.push(i);
    });
    // Tags: os vizinhos (notas com a tag) também acendem.
    matchSet = new Set(matches);
    if (kind === "tag") for (const i of matches) for (const j of adj[i]) matchSet.add(j);
    matches.sort((a, b) => graph.nodes[b].degree - graph.nodes[a].degree);
    count.textContent = matches.length ? `${matches.length}` : "0";
    request();
  }

  function focusMatch(delta) {
    if (!matches.length) return;
    matchCursor = (matchCursor + delta + matches.length) % matches.length;
    const i = matches[matchCursor];
    autoFit = false;
    animateTo({ x: sim.x[i], y: sim.y[i], k: Math.max(cam.k, 1.4) });
  }

  search.addEventListener("input", applySearch);
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      if (matchCursor >= 0 && e.ctrlKey) return activate(matches[matchCursor]);
      focusMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusMatch(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Escape") {
      if (search.value) {
        search.value = "";
        applySearch();
      } else search.blur();
    }
  });

  // ---------- Interação ----------

  function nodeAt(sx, sy) {
    if (!sim?.n) return -1;
    const p = toWorld(sx, sy);
    let best = -1;
    let bestD = Infinity;
    const slop = 4 / cam.k;
    for (let i = 0; i < sim.n; i++) {
      const dx = sim.x[i] - p.x;
      const dy = sim.y[i] - p.y;
      const d = dx * dx + dy * dy;
      const r = radius(i) + slop;
      if (d <= r * r && d < bestD) (best = i), (bestD = d);
    }
    return best;
  }

  function activate(i) {
    const n = graph.nodes[i];
    if (!n) return;
    if (n.kind === "note") cb.open(n.id);
    else if (n.kind === "tag") cb.openTag(n.label.slice(1));
    else cb.create(n.label);
  }

  let drag = null; // { kind: "node"|"pan", i, sx, sy, moved, cam }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const i = nodeAt(sx, sy);
    tween = null;
    drag = { kind: i >= 0 ? "node" : "pan", i, sx, sy, moved: false, cam: { ...cam } };
  });

  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (!drag) {
      const i = nodeAt(sx, sy);
      if (i !== hover) {
        canvas.style.cursor = i >= 0 ? "pointer" : "grab";
        canvas.title = i >= 0 ? graph.nodes[i].label : "";
        setHover(i);
      }
      return;
    }
    if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 4) return;
    drag.moved = true;
    autoFit = false;
    if (drag.kind === "pan") {
      cam = { ...cam, x: drag.cam.x - (sx - drag.sx) / cam.k, y: drag.cam.y - (sy - drag.sy) / cam.k };
      canvas.style.cursor = "grabbing";
    } else {
      const p = toWorld(sx, sy);
      sim.fixed[drag.i] = 1;
      sim.x[drag.i] = p.x;
      sim.y[drag.i] = p.y;
      sim.reheat(0.25);
    }
    request();
  });

  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === "node") sim.fixed[d.i] = 0;
    canvas.style.cursor = hover >= 0 ? "pointer" : "grab";
    if (!d.moved && d.kind === "node" && e.type === "pointerup") activate(d.i);
    request();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (hover >= 0 && !drag) setHover(-1);
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const before = toWorld(sx, sy);
      const k = Math.min(MAX_K, Math.max(MIN_K, cam.k * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018))));
      cam = { k, x: before.x - (sx - width / 2) / k, y: before.y - (sy - height / 2) / k };
      autoFit = false;
      tween = null;
      request();
    },
    { passive: false },
  );

  canvas.addEventListener("dblclick", (e) => {
    const r = canvas.getBoundingClientRect();
    if (nodeAt(e.clientX - r.left, e.clientY - r.top) < 0) animateTo(fitCamera());
  });

  fitBtn.addEventListener("click", () => animateTo(fitCamera()));
  shakeBtn.addEventListener("click", () => {
    for (const n of graph.nodes) memory.delete(n.key);
    sim = null;
    rebuild();
  });
  backBtn.addEventListener("click", () => cb.back());

  seg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b || b.dataset.mode === opts.mode) return;
    opts.mode = b.dataset.mode;
    if (opts.mode === "local" && center == null) center = cb.currentId();
    saveOpts(opts);
    rebuild();
  });
  depth.addEventListener("change", () => {
    opts.depth = Number(depth.value);
    saveOpts(opts);
    rebuild();
  });
  folder.addEventListener("change", () => {
    opts.folder = folder.value;
    saveOpts(opts);
    rebuild();
  });
  toggles.addEventListener("click", (e) => {
    const b = e.target.closest("[data-opt]");
    if (!b) return;
    opts[b.dataset.opt] = !opts[b.dataset.opt];
    saveOpts(opts);
    rebuild();
  });

  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      e.stopPropagation(); // Esc fecha o painel, não sai do grafo
      togglePanel(false);
      panelBtn.focus();
      return;
    }
    if (e.target === search) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      search.focus();
      search.select();
    }
  });

  new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    width = r.width;
    height = r.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (visible) draw();
  }).observe(stage);

  // ---------- Cromo ----------

  function renderChrome() {
    seg.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === opts.mode));
    depth.hidden = opts.mode !== "local";
    depth.value = String(opts.depth);
    folder.hidden = opts.mode === "local";
    const fs = cb.folders();
    if (opts.folder !== "all" && !fs.some((f) => String(f.id) === opts.folder)) opts.folder = "all";
    folder.replaceChildren(el("option", { value: "all" }, "Todas as pastas"), ...fs.map((f) => el("option", { value: String(f.id) }, f.name)));
    folder.value = opts.folder;
    toggles.querySelectorAll("[data-opt]").forEach((b) => b.classList.toggle("active", !!opts[b.dataset.opt]));
    toggles.querySelector('[data-opt="orphans"]').hidden = opts.mode === "local";
    const notes = graph.nodes.filter((n) => n.kind === "note").length;
    empty.hidden = graph.nodes.length > 0;
    empty.replaceChildren(
      icon("fa-solid fa-circle-nodes"),
      el("span", {}, opts.mode === "local" && center == null ? "Abra uma nota para ver o grafo local." : "Nenhuma nota para mostrar."),
      el("small", {}, "Ligue notas digitando [[ no texto e adicione tags nas propriedades."),
    );
    legend.dataset.count = `${notes} nota${notes === 1 ? "" : "s"} · ${graph.edges.length} ligaç${graph.edges.length === 1 ? "ão" : "ões"}`;
    renderLegend();
  }

  function renderLegend() {
    if (!colors) readColors();
    const dot = (color, label, cls = "") => el(`span.ng-leg${cls}`, {}, el("i", { style: `background:${color}` }), label);
    legend.replaceChildren(
      el("span.ng-leg-count", {}, legend.dataset.count || ""),
      ...NOTE_TYPES.map(([t, label]) => dot(colors.type[t], label)),
      opts.tags ? dot(colors.tag, "Tag", ".tag") : null,
    );
  }

  return {
    /** Mostra o grafo. `local` = centrado na nota atual. */
    show({ local = null } = {}) {
      visible = true;
      if (local !== null) opts.mode = local ? "local" : "global";
      if (opts.mode === "local") center = cb.currentId() ?? center;
      readColors();
      rebuild();
    },
    hide() {
      visible = false;
      sim?.positions();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      drag = null;
      resetFocus();
      panel.hidden = true;
    },
    /** Dados mudaram (nota editada/apagada) com o grafo aberto. */
    refresh() {
      if (visible) rebuild();
    },
    get visible() {
      return visible;
    },
    focusSearch() {
      search.focus();
    },
  };
}

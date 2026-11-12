import { el, icon } from "../utils/dom.js";
import { CHART_RANGES, niceScale } from "../utils/rabbitModel.js";

// Gráficos de série temporal do RabbitMQ (fila/exchange): eixo Y com grade, horários no eixo X,
// legenda com o valor atual e dica ao passar o mouse (valores do instante mais próximo).
// SVG desenhado na largura real do contêiner (ResizeObserver) para o texto não distorcer.

const H = 170;
const PAD = { top: 10, right: 12, bottom: 22, left: 52 };
const pad2 = (n) => String(n).padStart(2, "0");

function timeLabel(t, spanMs) {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (spanMs <= 10 * 60_000) return `${hm}:${pad2(d.getSeconds())}`;
  if (spanMs <= 8 * 3600_000) return hm;
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hm}`;
}

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/**
 * Cartão com um gráfico de linhas. `update(series)` redesenha; cada série = { label, cls, points: [{t, v}] }.
 * `fmt` formata os valores (eixo, legenda, dica).
 */
export function timeChart({ title, iconCls = "", fmt = String, empty = "Sem amostras neste intervalo." }) {
  let series = [];
  const titleEl = el("div.rmq-card-title", {}, iconCls ? icon(iconCls) : null, el("span", {}, title));
  const plot = el("div.rmq-tc-plot");
  const tip = el("div.rmq-tc-tip", { hidden: true });
  const legends = el("div.rmq-legends");
  const root = el("div.rmq-card.rmq-tc", {}, titleEl, plot, legends);
  plot.append(tip);
  let geo = null;

  function draw() {
    const W = Math.max(200, Math.floor(plot.clientWidth || 0));
    plot.querySelector("svg")?.remove();
    plot.querySelector(".rmq-tc-empty")?.remove();
    tip.hidden = true;
    const all = series.flatMap((s) => s.points);
    legends.innerHTML = "";
    for (const s of series) {
      const last = s.points[s.points.length - 1];
      legends.append(el("span", { class: `rmq-legend ${s.cls}` }, el("i"), `${s.label} `, el("b", {}, fmt(last ? last.v : 0))));
    }
    if (all.length < 2) {
      geo = null;
      plot.append(el("div.rmq-tc-empty", {}, empty));
      return;
    }
    const t0 = Math.min(...all.map((p) => p.t));
    const t1 = Math.max(...all.map((p) => p.t));
    const { max, step } = niceScale(Math.max(...all.map((p) => p.v)));
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const x = (t) => PAD.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * iw : iw);
    const y = (v) => PAD.top + ih - (v / max) * ih;
    const svg = svgEl("svg", { class: "rmq-tc-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}` });

    for (let v = 0; v <= max + 1e-9; v += step) {
      const yy = y(v).toFixed(1);
      svg.append(svgEl("line", { class: "rmq-tc-grid", x1: PAD.left, x2: W - PAD.right, y1: yy, y2: yy }));
      const lab = svgEl("text", { class: "rmq-tc-axis", x: PAD.left - 6, y: Number(yy) + 3.5, "text-anchor": "end" });
      lab.textContent = fmt(v);
      svg.append(lab);
    }
    const ticks = Math.max(2, Math.min(6, Math.floor(iw / 110)));
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + ((t1 - t0) * i) / ticks;
      const lab = svgEl("text", { class: "rmq-tc-axis", x: x(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle" });
      lab.textContent = timeLabel(t, t1 - t0);
      svg.append(lab);
    }
    // Ordem inversa: a 1ª série da legenda fica por cima (ex.: "Prontas" sobre "Total").
    for (const s of [...series].reverse()) {
      if (s.points.length < 2) continue;
      const pts = s.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
      // Área suave sob a linha (mesma cor) + a linha.
      svg.append(svgEl("polygon", { class: `rmq-tc-area ${s.cls}`, points: `${x(s.points[0].t).toFixed(1)},${y(0)} ${pts} ${x(s.points[s.points.length - 1].t).toFixed(1)},${y(0)}` }));
      svg.append(svgEl("polyline", { class: `rmq-spark-line ${s.cls}`, points: pts }));
    }
    const guide = svgEl("line", { class: "rmq-tc-guide", y1: PAD.top, y2: PAD.top + ih, x1: 0, x2: 0, visibility: "hidden" });
    svg.append(guide);
    const dots = series.map((s) => {
      const c = svgEl("circle", { class: `rmq-tc-dot ${s.cls}`, r: 3, cx: 0, cy: 0, visibility: "hidden" });
      svg.append(c);
      return c;
    });
    plot.prepend(svg);
    geo = { x, y, t0, t1, iw, W, guide, dots };
  }

  function hover(e) {
    if (!geo) return;
    const r = plot.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < PAD.left - 4 || px > geo.W - PAD.right + 4) return leave();
    const t = geo.t0 + ((px - PAD.left) / geo.iw) * (geo.t1 - geo.t0);
    // Ponto mais próximo de cada série nesse instante.
    const near = series.map((s) => s.points.reduce((best, p) => (!best || Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), null));
    const ref = near.find(Boolean);
    if (!ref) return leave();
    const gx = geo.x(ref.t);
    geo.guide.setAttribute("x1", gx);
    geo.guide.setAttribute("x2", gx);
    geo.guide.setAttribute("visibility", "visible");
    near.forEach((p, i) => {
      geo.dots[i].setAttribute("visibility", p ? "visible" : "hidden");
      if (p) {
        geo.dots[i].setAttribute("cx", geo.x(p.t));
        geo.dots[i].setAttribute("cy", geo.y(p.v));
      }
    });
    tip.innerHTML = "";
    tip.append(el("div.rmq-tc-tip-time", {}, timeLabel(ref.t, 0)));
    series.forEach((s, i) => near[i] && tip.append(el("div", { class: `rmq-legend ${s.cls}` }, el("i"), `${s.label} `, el("b", {}, fmt(near[i].v)))));
    tip.hidden = false;
    const left = gx + 12 + tip.offsetWidth > r.width ? gx - 12 - tip.offsetWidth : gx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${PAD.top}px`;
  }

  function leave() {
    tip.hidden = true;
    if (!geo) return;
    geo.guide.setAttribute("visibility", "hidden");
    geo.dots.forEach((d) => d.setAttribute("visibility", "hidden"));
  }

  plot.addEventListener("mousemove", hover);
  plot.addEventListener("mouseleave", leave);
  let lastW = 0;
  new ResizeObserver(() => {
    const w = plot.clientWidth;
    if (w && Math.abs(w - lastW) > 1) {
      lastW = w;
      draw();
    }
  }).observe(plot);

  return {
    root,
    update(next) {
      series = next || [];
      draw();
    },
  };
}

/** Seletor do intervalo (1 min … 1 dia). */
export function rangePicker(active, onPick) {
  const bar = el("div.rmq-tc-ranges", { role: "group", title: "Intervalo dos gráficos" });
  const paint = (id) => bar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.range === id));
  for (const r of CHART_RANGES) {
    bar.append(el("button.rmq-chip", { type: "button", dataset: { range: r.id }, onclick: () => (paint(r.id), onPick(r.id)) }, r.label));
  }
  paint(active);
  return bar;
}

// Diagramas Mermaid dos blocos de código das Notas: carrega a biblioteca sob demanda
// (src/vendor/mermaid, funciona offline), renderiza em fila e mostra o SVG com zoom, arrastar
// e tela cheia.

const SCRIPT = "vendor/mermaid/mermaid.min.js";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const PAD = 16;
const MIN_H = 140;
const MAX_H = 560;

let loading = null;
let queue = Promise.resolve();
let seq = 0;
let initializedTheme = null;
const cache = new Map(); // tema + fonte -> svg

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Não foi possível carregar a biblioteca Mermaid."));
    };
    document.head.append(script);
  });
  return loading;
}

const currentTheme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

// Tema claro próprio (base do Mermaid): nós brancos com borda âmbar suave, grupos quase
// brancos e linhas cinza, no lugar do lilás/amarelo do tema "default".
const LIGHT_VARS = {
  background: "#ffffff",
  primaryColor: "#ffffff",
  primaryBorderColor: "#d9c48f",
  primaryTextColor: "#1d1d1f",
  secondaryColor: "#f4f6fa",
  secondaryBorderColor: "#c9d2e0",
  secondaryTextColor: "#1d1d1f",
  tertiaryColor: "#fafafb",
  tertiaryBorderColor: "#e3e3e8",
  tertiaryTextColor: "#1d1d1f",
  mainBkg: "#ffffff",
  nodeBorder: "#d9c48f",
  clusterBkg: "#fafafb",
  clusterBorder: "#e3e3e8",
  titleColor: "#3a3a3c",
  lineColor: "#9a9aa2",
  textColor: "#1d1d1f",
  edgeLabelBackground: "#ffffff",
  noteBkgColor: "#fff8e1",
  noteBorderColor: "#e6cf8a",
  noteTextColor: "#3a3a3c",
  actorBkg: "#ffffff",
  actorBorder: "#d9c48f",
  signalColor: "#6e6e73",
  labelBoxBkgColor: "#fafafb",
  labelBoxBorderColor: "#e3e3e8",
};

/**
 * SVG do diagrama (as renderizações rodam uma por vez: o Mermaid não é reentrante).
 * theme: "light" | "dark"; por padrão o da interface (o PDF usa sempre "light").
 */
export function renderMermaidSvg(source, theme = currentTheme()) {
  const key = `${theme}\0${source}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    const fontFamily = getComputedStyle(document.body).fontFamily;
    // Os rótulos são medidos na renderização: com a fonte ainda carregando, saem cortados.
    await document.fonts?.load(`16px ${fontFamily}`).catch(() => {});
    if (initializedTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        ...(theme === "light" ? { theme: "base", themeVariables: { ...LIGHT_VARS, fontFamily } } : { theme: "dark" }),
        suppressErrorRendering: true,
        fontFamily,
      });
      initializedTheme = theme;
    }
    const id = `nt-mermaid-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return svg;
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => {});
  return job.then((svg) => {
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    cache.set(key, svg);
    return svg;
  });
}

/** Mensagem legível de um erro de sintaxe do Mermaid. */
export function mermaidErrorText(err) {
  const msg = String(err?.message || err || "Erro desconhecido");
  return msg.replace(/^Error:\s*/, "").trim();
}

/**
 * Área de visualização com zoom (Ctrl+roda, botões), arrastar e tela cheia.
 * Devolve { root, setSvg(svg), showError(text), setMessage(text, isError), fit(), exitFullscreen() }.
 * Com a classe "fill" no root a área ocupa a altura do pai (modo live) em vez de se dimensionar.
 */
export function createDiagramView() {
  const root = document.createElement("div");
  root.className = "nc-diagram";
  root.innerHTML = `
    <div class="nc-stage" title="Arraste para mover · Ctrl + roda para zoom · duplo clique para ajustar">
      <div class="nc-canvas"></div>
    </div>
    <div class="nc-msg" hidden></div>
    <div class="nc-zoom">
      <button type="button" data-zoom="out" title="Diminuir zoom"><i class="fa-solid fa-minus"></i></button>
      <button type="button" data-zoom="reset" class="nc-zoom-val" title="Tamanho real (100%)">100%</button>
      <button type="button" data-zoom="in" title="Aumentar zoom"><i class="fa-solid fa-plus"></i></button>
      <button type="button" data-zoom="fit" title="Ajustar ao espaço (duplo clique)"><i class="fa-solid fa-arrows-to-circle"></i></button>
      <span class="nc-zoom-sep"></span>
      <button type="button" data-zoom="full" title="Tela cheia"><i class="fa-solid fa-expand"></i></button>
    </div>`;
  const stage = root.querySelector(".nc-stage");
  const canvas = root.querySelector(".nc-canvas");
  const msg = root.querySelector(".nc-msg");
  const zoomBar = root.querySelector(".nc-zoom");
  const zoomVal = root.querySelector(".nc-zoom-val");
  const fullBtn = root.querySelector('[data-zoom="full"]');

  let w = 0; // tamanho natural do SVG
  let h = 0;
  let x = 0;
  let y = 0;
  let k = 1;
  let touched = false; // usuário moveu/zoom: não reajustar sozinho no resize
  let sized = false; // altura da área já calculada para a largura atual
  let full = null; // { overlay, home, next } enquanto em tela cheia

  function apply() {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    zoomVal.textContent = `${Math.round(k * 100)}%`;
  }

  function fit() {
    if (!w || !h) return;
    const W = stage.clientWidth;
    if (!W) return;
    if (!sized && !full && !root.classList.contains("fill")) {
      // Altura da área: o diagrama inteiro na largura disponível, dentro de limites.
      const kw = Math.min(1, (W - PAD * 2) / w);
      stage.style.height = `${Math.round(Math.min(MAX_H, Math.max(MIN_H, h * kw + PAD * 2)))}px`;
      sized = true;
    }
    const H = stage.clientHeight;
    // Na tela cheia o diagrama cresce até preencher; na nota, no máximo 100%.
    k = Math.min(full ? 3 : 1, (W - PAD * 2) / w, (H - PAD * 2) / h);
    k = Math.max(MIN_ZOOM, k);
    x = (W - w * k) / 2;
    y = (H - h * k) / 2;
    touched = false;
    apply();
  }

  function zoomAt(factor, px, py) {
    const k2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
    if (k2 === k) return;
    x = px - (px - x) * (k2 / k);
    y = py - (py - y) * (k2 / k);
    k = k2;
    touched = true;
    apply();
  }

  function zoomCenter(factor) {
    zoomAt(factor, stage.clientWidth / 2, stage.clientHeight / 2);
  }

  // ---------- Tela cheia (sobre a janela inteira do app) ----------

  function onFullKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    exitFullscreen();
  }

  function enterFullscreen() {
    if (full) return;
    const overlay = document.createElement("div");
    overlay.className = "nc-fullscreen";
    overlay.innerHTML = `
      <div class="nc-full-head">
        <span class="nc-full-title"><i class="fa-solid fa-diagram-project"></i> Diagrama</span>
        <span class="nc-full-hint">Arraste para mover · roda do mouse para zoom · Esc para sair</span>
        <button type="button" class="nc-full-close" title="Sair da tela cheia (Esc)"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
    overlay.querySelector(".nc-full-close").addEventListener("click", exitFullscreen);
    full = { overlay, home: root.parentElement, next: root.nextSibling };
    overlay.append(root);
    document.body.append(overlay);
    root.classList.add("full");
    fullBtn.title = "Sair da tela cheia (Esc)";
    fullBtn.firstElementChild.className = "fa-solid fa-compress";
    document.addEventListener("keydown", onFullKey, true);
    fit();
  }

  function exitFullscreen() {
    if (!full) return;
    const { overlay, home, next } = full;
    full = null;
    document.removeEventListener("keydown", onFullKey, true);
    root.classList.remove("full");
    fullBtn.title = "Tela cheia";
    fullBtn.firstElementChild.className = "fa-solid fa-expand";
    if (home?.isConnected) home.insertBefore(root, next?.parentNode === home ? next : null);
    else root.remove();
    overlay.remove();
    sized = false;
    fit();
  }

  // ---------- Interação ----------

  stage.addEventListener(
    "wheel",
    (e) => {
      // Na nota a roda sozinha rola o texto; na tela cheia ela dá zoom.
      if (!full && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );

  let drag = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !w) return;
    e.preventDefault();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x, y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    x = drag.x + e.clientX - drag.sx;
    y = drag.y + e.clientY - drag.sy;
    touched = true;
    apply();
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("dblclick", fit);

  zoomBar.addEventListener("mousedown", (e) => e.preventDefault());
  zoomBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-zoom]");
    if (!btn) return;
    const action = btn.dataset.zoom;
    if (action === "in") zoomCenter(1.25);
    else if (action === "out") zoomCenter(0.8);
    else if (action === "fit") fit();
    else if (action === "reset") zoomCenter(1 / k);
    else if (action === "full") (full ? exitFullscreen : enterFullscreen)();
  });

  let lastSize = "";
  new ResizeObserver(() => {
    const size = `${stage.clientWidth}x${full || root.classList.contains("fill") ? stage.clientHeight : ""}`;
    if (!stage.clientWidth || size === lastSize) return;
    lastSize = size;
    sized = false;
    if (!touched) fit();
  }).observe(stage);

  return {
    root,
    fit,
    exitFullscreen,
    setSvg(svg) {
      msg.hidden = true;
      msg.classList.remove("overlay");
      stage.hidden = false;
      zoomBar.hidden = false;
      canvas.innerHTML = svg;
      const el = canvas.querySelector("svg");
      if (!el) return;
      const vb = el.viewBox?.baseVal;
      w = vb?.width || parseFloat(el.getAttribute("width")) || 400;
      h = vb?.height || parseFloat(el.getAttribute("height")) || 200;
      el.removeAttribute("style");
      el.setAttribute("width", String(w));
      el.setAttribute("height", String(h));
      sized = false;
      // Re-render (live/edição) com zoom/posição do usuário: mantém a visão.
      if (touched) apply();
      else fit();
    },
    /** Erro de sintaxe: com um diagrama já desenhado, mostra o erro por cima e mantém o último. */
    showError(text) {
      if (!w) return this.setMessage(text, true);
      msg.hidden = false;
      msg.classList.add("error", "overlay");
      msg.textContent = text;
    },
    setMessage(text, isError = false) {
      w = h = 0;
      canvas.innerHTML = "";
      stage.hidden = true;
      zoomBar.hidden = true;
      msg.hidden = false;
      msg.classList.remove("overlay");
      msg.classList.toggle("error", isError);
      msg.textContent = text;
    },
  };
}

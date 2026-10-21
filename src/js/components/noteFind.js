import { el, icon } from "../utils/dom.js";
import { foldText, findAll } from "../utils/textFind.js";

// Ctrl+F dentro da nota (Notas, janela do .md e prévia do Espaço): barra flutuante no canto do
// editor, sem maiúsculas/acentos, com as ocorrências destacadas pela CSS Custom Highlight API
// (não mexe no DOM do editor, então não entra no histórico nem na gravação).

const editor = document.getElementById("nt-editor");
const scroller = document.getElementById("nt-editor-scroll");
const pane = scroller.closest(".nt-editor-pane");

// Fora da busca: cabeçalho e numeração dos blocos de código, diagramas e editores de código
// (textarea; o texto realçado por trás dele não é o que se lê).
const SKIP = ".nc-head, .nc-gutter, .nc-ell, .nc-diagram, .ce, svg, style, script";
const BLOCK = "p, h1, h2, h3, li, td, th, pre, blockquote, .nc-l, div";
const MAX_MATCHES = 5000;
const HL = typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";

let bar = null;
let input = null;
let countEl = null;
let ranges = [];
let current = -1;
let refreshTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => search({ reveal: false }), 150);
});

function build() {
  input = el("input.nt-find-input", { type: "text", placeholder: "Buscar na nota", spellcheck: "false", autocomplete: "off" });
  countEl = el("span.nt-find-count");
  const btn = (action, title, cls) => el("button.nt-find-btn", { type: "button", title, "data-find": action }, icon(cls));
  bar = el(
    "div.nt-find",
    { hidden: true, role: "search" },
    icon("fa-solid fa-magnifying-glass"),
    input,
    countEl,
    btn("prev", "Anterior (Shift+Enter)", "fa-solid fa-chevron-up"),
    btn("next", "Próxima (Enter)", "fa-solid fa-chevron-down"),
    btn("close", "Fechar (Esc)", "fa-solid fa-xmark"),
  );
  pane.append(bar);

  input.addEventListener("input", () => search());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "F3") {
      e.preventDefault();
      e.stopPropagation();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  });
  bar.addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
  bar.addEventListener("click", (e) => {
    const action = e.target.closest("[data-find]")?.dataset.find;
    if (action === "prev") step(-1);
    else if (action === "next") step(1);
    else if (action === "close") closeFind();
  });
  // Esc ou F3 com o foco no editor (antes do Esc das Notas, que volta para a lista na bandeja).
  pane.addEventListener("keydown", (e) => {
    if (bar.hidden || bar.contains(e.target)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      closeFind({ select: false });
    } else if (e.key === "F3") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });
}

export function isFindOpen() {
  return !!bar && !bar.hidden;
}

/** Abre (ou volta o foco para) a busca; a seleção de uma linha no editor vira o termo. */
export function openFind() {
  if (!bar) build();
  if (scroller.hidden) return;
  const sel = window.getSelection();
  const picked = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.toString() : "";
  if (picked && picked.length <= 200 && !picked.includes("\n")) input.value = picked.trim();
  bar.style.top = `${scroller.offsetTop + 8}px`;
  const wasOpen = !bar.hidden;
  bar.hidden = false;
  input.focus();
  input.select();
  if (!wasOpen) observer.observe(editor, { childList: true, subtree: true, characterData: true });
  search();
}

/** Fecha; com `select`, o editor editável fica com a ocorrência atual selecionada. */
export function closeFind({ select = true } = {}) {
  if (!isFindOpen()) return;
  const r = ranges[current];
  bar.hidden = true;
  observer.disconnect();
  clearTimeout(refreshTimer);
  ranges = [];
  current = -1;
  paint();
  if (select && r && editor.isContentEditable && editor.contains(r.startContainer)) {
    editor.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } else if (document.activeElement === input || !document.activeElement || document.activeElement === document.body) {
    scroller.focus({ preventScroll: true });
  }
}

/** Texto visível do editor numa string só, com "\n" entre blocos (nada casa de um bloco para outro). */
function collect() {
  const nodes = [];
  const starts = [];
  let hay = "";
  let lastBlock = null;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.data && !n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n; (n = walker.nextNode()); ) {
    const block = n.parentElement.closest(BLOCK);
    if (lastBlock && block !== lastBlock) hay += "\n";
    lastBlock = block;
    starts.push(hay.length);
    nodes.push(n);
    hay += n.data;
  }
  return { nodes, starts, hay };
}

/** Nó de texto que contém a posição `pos` (`end` = posição final de um trecho). */
function locate(starts, pos, end) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (end ? starts[mid] < pos : starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function search({ reveal = true } = {}) {
  if (!isFindOpen()) return;
  if (scroller.hidden) return closeFind({ select: false });
  const needle = foldText(input.value);
  const anchor = ranges[current] || null;
  ranges = [];
  if (needle) {
    const { nodes, starts, hay } = collect();
    for (const i of findAll(foldText(hay), needle, MAX_MATCHES)) {
      const a = locate(starts, i, false);
      const b = locate(starts, i + needle.length, true);
      const r = document.createRange();
      r.setStart(nodes[a], i - starts[a]);
      r.setEnd(nodes[b], i + needle.length - starts[b]);
      ranges.push(r);
    }
  }
  current = ranges.length ? pickCurrent(anchor) : -1;
  paint();
  if (reveal) revealCurrent();
}

/** Continua a partir da ocorrência anterior; sem ela, a primeira visível na tela. */
function pickCurrent(anchor) {
  if (anchor && editor.contains(anchor.startContainer)) {
    const i = ranges.findIndex((r) => r.compareBoundaryPoints(Range.START_TO_START, anchor) >= 0);
    if (i !== -1) return i;
  }
  const top = scroller.getBoundingClientRect().top;
  const i = ranges.findIndex((r) => r.getBoundingClientRect().bottom >= top);
  return i === -1 ? 0 : i;
}

function step(delta) {
  if (!ranges.length) return search();
  current = (current + delta + ranges.length) % ranges.length;
  paint();
  revealCurrent();
}

function paint() {
  if (countEl) {
    countEl.textContent = !input.value ? "" : ranges.length ? `${current + 1} de ${ranges.length}${ranges.length >= MAX_MATCHES ? "+" : ""}` : "Nenhum";
    bar.classList.toggle("empty", !!input.value && !ranges.length);
  }
  if (!HL) {
    // Sem a Highlight API (WebKitGTK antigo): só a ocorrência atual, como seleção.
    const sel = window.getSelection();
    if (ranges[current]) {
      sel.removeAllRanges();
      sel.addRange(ranges[current]);
    }
    return;
  }
  if (ranges.length) CSS.highlights.set("nt-find", new Highlight(...ranges));
  else CSS.highlights.delete("nt-find");
  if (ranges[current]) {
    const cur = new Highlight(ranges[current]);
    cur.priority = 1;
    CSS.highlights.set("nt-find-cur", cur);
  } else CSS.highlights.delete("nt-find-cur");
}

/** Rola até a ocorrência atual (também na horizontal dentro de um bloco de código). */
function revealCurrent() {
  const r = ranges[current];
  if (!r) return;
  const code = r.startContainer.parentElement?.closest(".nc-code");
  if (code) {
    const rect = r.getBoundingClientRect();
    const box = code.getBoundingClientRect();
    if (rect.left < box.left || rect.right > box.right) code.scrollLeft += rect.left - box.left - box.width / 3;
  }
  const rect = r.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.top < box.top + bar.offsetHeight + 16 || rect.bottom > box.bottom - 12) {
    scroller.scrollTop += rect.top - box.top - box.height / 3;
  }
}

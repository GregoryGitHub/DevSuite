import { el, icon } from "../utils/dom.js";
import { highlightCode, normalizeCodeLang } from "../utils/highlight.js";
import {
  diffLines, changedChunks, chunkWordRanges, foldSegments, revertChunk, endsWithEol, eolOf, splitLines,
  merge3, mergeResultText, conflictMarkers, resolveMarker,
} from "../utils/textDiff.js";
import { codeEditor } from "./codeEditor.js";
import { gitApi } from "../api.js";

// Visão de diff do controle de versão das Notas, no estilo das IDEs da JetBrains:
//  - lado a lado: dois painéis com as próprias linhas (sem linhas vazias de enchimento),
//    faixas curvas no meio ligando cada bloco alterado aos dois lados, azul = modificado,
//    verde = inserido, cinza = removido, palavras alteradas em tom mais forte, setas ≫ para
//    reverter o trecho (quando a direita é a cópia de trabalho) e rolagem sincronizada;
//  - unificado: uma coluna com as duas numerações;
//  - conflito de merge: Minha | Resultado (editável) | Deles.
// Trechos iguais longos ficam recolhidos ("N linhas inalteradas", clique abre).

const ROW_H = 20;
const OVERSCAN = 30;
const PREFS_KEY = "nt-diff-prefs";

function loadPrefs() {
  try {
    return { mode: "side", ignoreWs: false, collapse: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return { mode: "side", ignoreWs: false, collapse: true };
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {}
}

/** Linguagem do realce pelo nome do arquivo. */
function langOf(path) {
  const ext = /\.([^./\\]+)$/.exec(path || "")?.[1]?.toLowerCase() || "";
  if (["md", "markdown", "mdown", "mkd"].includes(ext)) return "markdown";
  return ext ? normalizeCodeLang(ext) : "text";
}

/** Envolve os trechos [s, e] (posições no texto) do HTML realçado em <span class=cls>. */
export function markRanges(html, ranges, cls) {
  if (!ranges?.length) return html;
  let out = "";
  let pos = 0; // posição no texto
  let ri = 0;
  let open = false;
  const inRange = () => {
    while (ri < ranges.length && pos >= ranges[ri][1]) ri++;
    return ri < ranges.length && pos >= ranges[ri][0];
  };
  for (let i = 0; i < html.length; ) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (open) out += "</span>";
      out += html.slice(i, end + 1);
      if (open) out += `<span class="${cls}">`;
      i = end + 1;
      continue;
    }
    let ch = html[i];
    let len = 1;
    if (ch === "&") {
      const semi = html.indexOf(";", i);
      if (semi > i && semi - i < 10) len = semi - i + 1;
    }
    ch = html.slice(i, i + len);
    const want = inRange();
    if (want && !open) {
      out += `<span class="${cls}">`;
      open = true;
    } else if (!want && open) {
      out += "</span>";
      open = false;
    }
    out += ch;
    pos++;
    i += len;
  }
  if (open) out += "</span>";
  return out;
}

// ---------- Painel virtualizado (linhas de altura fixa) ----------

/**
 * rows: [{ cls, n1, n2, html, fold, onClick }] (n2 só no unificado). markers: [{ row, cls }]
 * (linhas finas onde o outro lado inseriu/removeu algo).
 */
function createPane(className) {
  const scroll = el("div.gd-scroll", { tabindex: "-1" });
  const canvas = el("div.gd-canvas");
  scroll.append(canvas);
  const root = el(`div.gd-pane.${className}`, {}, scroll);
  let rows = [];
  let markers = [];
  let twoNumbers = false;
  let drawn = "";
  let onScroll = null;

  function draw(force = false) {
    const h = scroll.clientHeight || 600;
    const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((scroll.scrollTop + h) / ROW_H) + OVERSCAN);
    const key = `${first}:${last}`;
    if (!force && key === drawn) return;
    drawn = key;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const r = rows[i];
      const row = el(`div.gd-row${r.cls ? `.${r.cls}` : ""}`, { style: `top:${i * ROW_H}px` });
      if (r.fold) {
        row.append(el("span.gd-fold", { onclick: r.onClick }, icon("fa-solid fa-ellipsis"), r.fold));
      } else {
        row.append(el("span.gd-ln", {}, r.n1 ?? ""));
        if (twoNumbers) row.append(el("span.gd-ln", {}, r.n2 ?? ""));
        row.append(el("span.gd-code", { html: r.html || "" }));
      }
      frag.append(row);
    }
    for (const m of markers) frag.append(el(`div.gd-marker.${m.cls}`, { style: `top:${m.row * ROW_H - 1}px` }));
    canvas.replaceChildren(frag);
  }

  scroll.addEventListener("scroll", () => {
    draw();
    onScroll?.();
  }, { passive: true });
  new ResizeObserver(() => draw(true)).observe(scroll);

  return {
    root,
    scroll,
    set onScroll(fn) {
      onScroll = fn;
    },
    setRows(list, { marks = [], numbers2 = false, widthCh = 80 } = {}) {
      rows = list;
      markers = marks;
      twoNumbers = numbers2;
      root.classList.toggle("two-numbers", numbers2);
      canvas.style.height = `${Math.max(1, rows.length) * ROW_H}px`;
      canvas.style.minWidth = `calc(${widthCh}ch + ${numbers2 ? 110 : 64}px)`;
      draw(true);
    },
  };
}

// ---------- Visão ----------

/**
 * host: { toast(msg), beforeWrite(): Promise, afterWrite(path): Promise, close() }.
 * Devolve { open(spec), refresh(), close(), visible, path }.
 * spec: { kind: "pair", path, origPath?, rev?, title, subtitle } | { kind: "conflict", path, title }
 */
export function createDiffView(hostEl, host) {
  const prefs = loadPrefs();
  let spec = null;
  let data = null; // { pair, left, right, chunks, segs, lang }
  let expanded = new Set();
  let current = -1; // bloco alterado em foco (navegação)
  let seq = 0;
  let merge = null; // visão de conflito

  const titleEl = el("strong.gd-title");
  const subEl = el("span.gd-sub");
  const counterEl = el("span.gd-counter");
  const prevBtn = el("button.gd-btn", { type: "button", title: "Diferença anterior (Shift+F7)", onclick: () => go(-1) }, icon("fa-solid fa-arrow-up"));
  const nextBtn = el("button.gd-btn", { type: "button", title: "Próxima diferença (F7)", onclick: () => go(1) }, icon("fa-solid fa-arrow-down"));
  const modeBtn = el("button.gd-btn", { type: "button", onclick: () => setPref("mode", prefs.mode === "side" ? "unified" : "side") });
  const wsBtn = el("button.gd-btn.gd-toggle", { type: "button", title: "Ignorar espaços em branco", onclick: () => setPref("ignoreWs", !prefs.ignoreWs) }, icon("fa-solid fa-text-width"));
  const foldBtn = el("button.gd-btn.gd-toggle", { type: "button", title: "Recolher trechos inalterados", onclick: () => setPref("collapse", !prefs.collapse) }, icon("fa-solid fa-compress"));
  const closeBtn = el("button.gd-btn", { type: "button", title: "Fechar (Esc)", onclick: () => host.close() }, icon("fa-solid fa-xmark"));
  const navGroup = el("div.gd-group", {}, prevBtn, nextBtn, counterEl);
  const viewGroup = el("div.gd-group", {}, modeBtn, wsBtn, foldBtn);
  const bar = el("div.gd-bar", {}, el("div.gd-titles", {}, titleEl, subEl), navGroup, viewGroup, el("div.gd-spacer"), closeBtn);
  const body = el("div.gd-body");
  hostEl.replaceChildren(bar, body);
  hostEl.addEventListener("keydown", onKey);

  function setPref(k, v) {
    prefs[k] = v;
    savePrefs(prefs);
    if (k === "ignoreWs") rebuild();
    else render();
  }

  function onKey(e) {
    if (e.key === "F7") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape" && !e.defaultPrevented && !e.target.closest?.(".ce")) {
      e.preventDefault();
      e.stopPropagation();
      host.close();
    }
  }

  function syncButtons() {
    modeBtn.replaceChildren(icon(prefs.mode === "side" ? "fa-solid fa-table-columns" : "fa-solid fa-bars"));
    modeBtn.title = prefs.mode === "side" ? "Lado a lado (clique: unificado)" : "Unificado (clique: lado a lado)";
    wsBtn.classList.toggle("active", prefs.ignoreWs);
    foldBtn.classList.toggle("active", prefs.collapse);
    const isPair = spec?.kind === "pair" && data && !data.pair.binary;
    navGroup.hidden = !isPair;
    viewGroup.hidden = !isPair;
  }

  // ----- dados -----

  async function open(next) {
    spec = next;
    expanded = new Set();
    current = -1;
    merge = null;
    titleEl.textContent = spec.title || spec.path;
    subEl.textContent = spec.subtitle || "";
    subEl.title = spec.path;
    body.replaceChildren(el("div.gd-empty", {}, icon("fa-solid fa-spinner fa-spin"), " Carregando…"));
    hostEl.focus({ preventScroll: true });
    await refresh();
  }

  async function refresh() {
    if (!spec) return;
    const my = ++seq;
    try {
      if (spec.kind === "conflict") {
        const c = await gitApi.conflict(spec.path);
        if (my !== seq) return;
        data = null;
        renderConflict(c);
        return;
      }
      const pair = await gitApi.filePair(spec.path, spec.origPath || null, spec.rev || null);
      if (my !== seq) return;
      data = { pair, lang: langOf(spec.path) };
      rebuild();
    } catch (e) {
      if (my !== seq) return;
      body.replaceChildren(el("div.gd-empty", {}, icon("fa-solid fa-triangle-exclamation"), ` ${e}`));
      syncButtons();
    }
  }

  function rebuild() {
    if (!data) return;
    const { pair } = data;
    const r = diffLines(pair.left ?? "", pair.right ?? "", { ignoreWhitespace: prefs.ignoreWs });
    Object.assign(data, r, { hl: { a: new Map(), b: new Map() }, words: new Map() });
    render();
  }

  function hl(side, i) {
    const cache = data.hl[side];
    let h = cache.get(i);
    if (h === undefined) {
      const line = (side === "a" ? data.left : data.right)[i] ?? "";
      h = line.length > 4000 ? escapeText(line) : highlightCode(line, data.lang);
      cache.set(i, h);
    }
    return h;
  }

  function words(seg) {
    if (seg.type !== "modify") return null;
    if (!data.words.has(seg.a0)) data.words.set(seg.a0, chunkWordRanges(data.left, data.right, seg));
    return data.words.get(seg.a0);
  }

  // ----- lado a lado / unificado -----

  function render() {
    syncButtons();
    if (!data) return;
    const { pair } = data;
    const changes = changedChunks(data.chunks);
    counterEl.textContent = changes.length ? `${changes.length} diferença${changes.length === 1 ? "" : "s"}` : "Sem diferenças";
    if (pair.binary) {
      body.replaceChildren(el("div.gd-empty", {}, icon("fa-regular fa-file-image"), " Arquivo binário: sem comparação de texto."));
      return;
    }
    data.segs = foldSegments(data.chunks, { context: 3, enabled: prefs.collapse, expanded });
    if (prefs.mode === "unified") renderUnified();
    else renderSide();
  }

  function foldRow(seg) {
    const n = seg.a1 - seg.a0;
    return {
      cls: "fold",
      fold: ` ${n} linha${n === 1 ? "" : "s"} inalterada${n === 1 ? "" : "s"}`,
      onClick: () => {
        expanded.add(seg.a0);
        render();
      },
    };
  }

  function sideRows(side) {
    const rows = [];
    const marks = [];
    const lines = side === "a" ? data.left : data.right;
    let width = 20;
    for (const seg of data.segs) {
      const [s0, s1] = side === "a" ? [seg.a0, seg.a1] : [seg.b0, seg.b1];
      seg[side === "a" ? "row0" : "rowB0"] = rows.length;
      if (seg.type === "fold") {
        rows.push(foldRow(seg));
        continue;
      }
      if (s1 === s0) {
        if (seg.type !== "equal") marks.push({ row: rows.length, cls: seg.type });
        continue;
      }
      const w = words(seg);
      for (let i = s0; i < s1; i++) {
        let html = hl(side, i);
        if (w) html = markRanges(html, w[side][i - s0], "gd-w");
        width = Math.max(width, lines[i].length);
        rows.push({ cls: seg.type === "equal" ? "" : seg.type, n1: i + 1, html });
      }
    }
    return { rows, marks, width };
  }

  let side = null; // { left, right, gutter, svg }

  function renderSide() {
    const left = createPane("left");
    const right = createPane("right");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const gutter = el("div.gd-gutter", {}, svg);
    const head = (label, missing) => el("div.gd-phead", {}, el("span", {}, label), missing ? el("em", {}, missing) : null);
    const { pair } = data;
    const leftCol = el("div.gd-col", {}, head(pair.left_label, pair.left === null ? "(não existe)" : ""), left.root);
    const rightCol = el("div.gd-col", {}, head(pair.right_label, pair.right === null ? "(apagado)" : ""), right.root);
    body.replaceChildren(el("div.gd-side", {}, leftCol, el("div.gd-gcol", {}, el("div.gd-phead"), gutter), rightCol));
    const a = sideRows("a");
    const b = sideRows("b");
    const width = Math.max(a.width, b.width);
    left.setRows(a.rows, { marks: a.marks, widthCh: width });
    right.setRows(b.rows, { marks: b.marks, widthCh: width });
    side = { left, right, gutter, svg };
    let lock = null;
    left.onScroll = () => {
      if (lock === "b") return (lock = null);
      lock = "a";
      follow(left.scroll, right.scroll, "row0", "rowB0", "a", "b");
      drawGutter();
    };
    right.onScroll = () => {
      if (lock === "a") return (lock = null);
      lock = "b";
      follow(right.scroll, left.scroll, "rowB0", "row0", "b", "a");
      drawGutter();
    };
    new ResizeObserver(drawGutter).observe(gutter);
    requestAnimationFrame(() => {
      if (current < 0) go(1, { quiet: true });
      drawGutter();
    });
  }

  const rowCount = (seg, s) => (seg.type === "fold" ? 1 : s === "a" ? seg.a1 - seg.a0 : seg.b1 - seg.b0);

  /** Rola `to` para mostrar, no meio, o trecho correspondente ao meio de `from`. */
  function follow(from, to, kFrom, kTo, sFrom, sTo) {
    const segs = data.segs;
    const mid = (from.scrollTop + from.clientHeight / 2) / ROW_H;
    let seg = segs[0];
    for (const s of segs) {
      if (s[kFrom] <= mid) seg = s;
      else break;
    }
    if (!seg) return;
    const nFrom = rowCount(seg, sFrom);
    const nTo = rowCount(seg, sTo);
    const frac = nFrom ? Math.min(1, (mid - seg[kFrom]) / nFrom) : 0;
    const target = (seg[kTo] + frac * nTo) * ROW_H - to.clientHeight / 2;
    if (Math.abs(to.scrollTop - target) > 1) to.scrollTop = target;
    if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
  }

  function drawGutter() {
    if (!side || !side.gutter.isConnected) return;
    const { left, right, gutter, svg } = side;
    const w = gutter.clientWidth;
    const h = gutter.clientHeight;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    const ta = left.scroll.scrollTop;
    const tb = right.scroll.scrollTop;
    const parts = [];
    const buttons = [];
    for (const seg of data.segs) {
      if (seg.type === "equal" || seg.type === "fold") continue;
      const y0 = seg.row0 * ROW_H - ta;
      const y1 = (seg.row0 + (seg.a1 - seg.a0)) * ROW_H - ta;
      const z0 = seg.rowB0 * ROW_H - tb;
      const z1 = (seg.rowB0 + (seg.b1 - seg.b0)) * ROW_H - tb;
      if (Math.max(y1, z1) < -20 || Math.min(y0, z0) > h + 20) continue;
      const c = w / 2;
      const d = `M0,${y0} C${c},${y0} ${c},${z0} ${w},${z0} L${w},${z1} C${c},${z1} ${c},${y1} 0,${y1} Z`;
      parts.push(`<path class="gd-band ${seg.type}" d="${d}"/>`);
      if (data.pair.editable) {
        buttons.push(
          el("button.gd-revert", {
            type: "button",
            title: "Reverter este trecho (volta ao conteúdo da esquerda)",
            style: `top:${Math.max(0, y0) + 2}px`,
            onclick: () => revert(seg),
          }, icon("fa-solid fa-angles-right")),
        );
      }
    }
    svg.innerHTML = parts.join("");
    gutter.querySelectorAll(".gd-revert").forEach((b) => b.remove());
    gutter.append(...buttons);
  }

  function renderUnified() {
    side = null;
    const pane = createPane("unified");
    body.replaceChildren(el("div.gd-uni", {}, pane.root));
    const rows = [];
    let width = 20;
    for (const seg of data.segs) {
      seg.row0 = rows.length;
      if (seg.type === "fold") {
        rows.push(foldRow(seg));
        continue;
      }
      const w = words(seg);
      if (seg.type === "equal") {
        for (let i = seg.a0; i < seg.a1; i++) {
          rows.push({ n1: i + 1, n2: seg.b0 + (i - seg.a0) + 1, html: hl("a", i) });
          width = Math.max(width, data.left[i].length);
        }
        continue;
      }
      for (let i = seg.a0; i < seg.a1; i++) {
        rows.push({ cls: "del", n1: i + 1, html: markRanges(hl("a", i), w?.a[i - seg.a0], "gd-w") });
        width = Math.max(width, data.left[i].length);
      }
      for (let i = seg.b0; i < seg.b1; i++) {
        rows.push({ cls: "ins", n2: i + 1, html: markRanges(hl("b", i), w?.b[i - seg.b0], "gd-w") });
        width = Math.max(width, data.right[i].length);
      }
    }
    pane.setRows(rows, { numbers2: true, widthCh: width });
    side = null;
    data.unified = pane;
    requestAnimationFrame(() => current < 0 && go(1, { quiet: true }));
  }

  function changedSegs() {
    return (data?.segs || []).filter((s) => s.type !== "equal" && s.type !== "fold");
  }

  /** Próxima/anterior diferença (F7 / Shift+F7). */
  function go(delta, { quiet = false } = {}) {
    const list = changedSegs();
    if (!list.length) return;
    current = current < 0 ? (delta > 0 ? 0 : list.length - 1) : (current + delta + list.length) % list.length;
    const seg = list[current];
    if (!quiet) counterEl.textContent = `${current + 1} de ${list.length}`;
    if (side) {
      side.left.scroll.scrollTop = Math.max(0, seg.row0 * ROW_H - side.left.scroll.clientHeight / 3);
    } else if (data.unified) {
      data.unified.scroll.scrollTop = Math.max(0, seg.row0 * ROW_H - data.unified.scroll.clientHeight / 3);
    }
  }

  async function revert(seg) {
    const { pair } = data;
    const text = revertChunk(data.left, data.right, seg, eolOf(pair.right), endsWithEol(pair.right));
    try {
      await host.beforeWrite();
      // O arquivo pode ter sido regravado pelo autosave: confere de novo antes de escrever.
      const fresh = await gitApi.filePair(spec.path, spec.origPath || null, null);
      if (fresh.right !== pair.right) {
        host.toast("A nota mudou enquanto o diff estava aberto: o diff foi atualizado.");
        return refresh();
      }
      await gitApi.writeFile(spec.path, text, fresh.mtime ?? null);
      await host.afterWrite(spec.path);
      await refresh();
    } catch (e) {
      host.toast(`Não foi possível reverter: ${e}`);
    }
  }

  // ----- conflito (3 vias) -----

  function renderConflict(c) {
    syncButtons();
    if (c.binary) {
      body.replaceChildren(
        el("div.gd-empty", {}, icon("fa-regular fa-file-image"), " Arquivo binário em conflito."),
        el("div.gd-merge-actions", {},
          el("button.hx-btn", { type: "button", onclick: () => resolveWith(c.ours ?? null, "minha") }, "Usar a minha"),
          el("button.hx-btn", { type: "button", onclick: () => resolveWith(c.theirs ?? null, "deles") }, "Usar a deles")),
      );
      return;
    }
    const lang = langOf(spec.path);
    const blocks = merge3(c.base ?? "", c.ours ?? "", c.theirs ?? "");
    const eol = eolOf(c.ours || c.theirs || "");
    const ours = createPane("left");
    const theirs = createPane("right");
    const paneRows = (text) => {
      const changed = new Map();
      const r = diffLines(c.base ?? "", text);
      for (const ch of changedChunks(r.chunks)) for (let i = ch.b0; i < ch.b1; i++) changed.set(i, ch.type);
      return r.right.map((line, i) => ({ cls: changed.get(i) || "", n1: i + 1, html: highlightCode(line, lang) }));
    };
    const editor = codeEditor({ value: mergeResultText(blocks, eol), lang, fill: true, lineHeight: ROW_H, padY: 0, className: "gd-result", onInput: updateState });
    const state = el("span.gd-merge-state");
    const curEl = el("span.gd-merge-cur");
    let at = 0;
    const pick = (choice) => {
      const marks = conflictMarkers(editor.value);
      if (!marks.length) return;
      editor.setValue(resolveMarker(editor.value, Math.min(at, marks.length - 1), choice, eol));
      updateState();
    };
    function updateState() {
      armed = false;
      const n = conflictMarkers(editor.value).length;
      at = Math.min(at, Math.max(0, n - 1));
      state.textContent = n ? `${n} conflito${n === 1 ? "" : "s"} sem resolver` : "Tudo resolvido";
      state.classList.toggle("ok", !n);
      curEl.textContent = n ? `Conflito ${at + 1} de ${n}:` : "";
      for (const b of conflictBtns) b.disabled = !n;
    }
    const seek = (delta) => {
      const marks = conflictMarkers(editor.value);
      if (!marks.length) return;
      at = (at + delta + marks.length) % marks.length;
      const line = marks[at].start;
      const lines = splitLines(editor.value);
      let pos = 0;
      for (let i = 0; i < line; i++) pos += lines[i].length + 1;
      editor.input.focus();
      editor.input.setSelectionRange(pos, pos);
      editor.input.scrollTop = Math.max(0, line * ROW_H - editor.input.clientHeight / 3);
      updateState();
    };
    const conflictBtns = [
      el("button.gd-btn", { type: "button", title: "Conflito anterior", onclick: () => seek(-1) }, icon("fa-solid fa-arrow-up")),
      el("button.gd-btn", { type: "button", title: "Próximo conflito", onclick: () => seek(1) }, icon("fa-solid fa-arrow-down")),
      el("button.hx-btn", { type: "button", onclick: () => pick("ours") }, icon("fa-solid fa-angles-right"), " Minha"),
      el("button.hx-btn", { type: "button", onclick: () => pick("theirs") }, "Deles ", icon("fa-solid fa-angles-left")),
      el("button.hx-btn", { type: "button", onclick: () => pick("both") }, "Ambas"),
    ];
    const actions = el("div.gd-merge-actions", {},
      curEl, ...conflictBtns, el("div.gd-spacer"), state,
      el("button.hx-btn", { type: "button", title: "Descarta o resultado e fica com a minha versão inteira", onclick: () => editor.setValue(c.ours ?? "") || updateState() }, "Aceitar a minha"),
      el("button.hx-btn", { type: "button", title: "Descarta o resultado e fica com a versão do remoto inteira", onclick: () => editor.setValue(c.theirs ?? "") || updateState() }, "Aceitar a deles"),
      el("button.hx-btn.primary", { type: "button", onclick: () => apply() }, icon("fa-solid fa-check"), " Marcar como resolvido"));
    let armed = false;
    async function apply() {
      // Com marcadores ainda no texto, o primeiro clique só avisa.
      if (conflictMarkers(editor.value).length && !armed) {
        armed = true;
        state.textContent = "Ainda há conflitos: clique de novo para gravar assim mesmo";
        return;
      }
      await resolveWith(editor.value, null);
    }
    const head = (label) => el("div.gd-phead", {}, el("span", {}, label));
    body.replaceChildren(
      actions,
      el("div.gd-merge", {},
        el("div.gd-col", {}, head("Minha (local)"), ours.root),
        el("div.gd-col.gd-col-result", {}, head("Resultado"), editor.root),
        el("div.gd-col", {}, head("Deles (remoto)"), theirs.root)),
    );
    if (c.ours !== null) ours.setRows(paneRows(c.ours));
    else ours.setRows([{ cls: "fold", fold: " Apagada na minha versão" }]);
    if (c.theirs !== null) theirs.setRows(paneRows(c.theirs));
    else theirs.setRows([{ cls: "fold", fold: " Apagada na versão deles" }]);
    merge = { editor };
    updateState();
  }

  async function resolveWith(text, label) {
    try {
      await host.beforeWrite();
      await gitApi.resolve(spec.path, text);
      host.toast(label ? `Conflito resolvido com a versão ${label}.` : "Conflito resolvido.");
      await host.afterWrite(spec.path);
      host.close();
    } catch (e) {
      host.toast(`Não foi possível resolver: ${e}`);
    }
  }

  return {
    open,
    refresh,
    get path() {
      return spec?.path ?? null;
    },
    get spec() {
      return spec;
    },
    get dirty() {
      return !!merge;
    },
    reset() {
      spec = null;
      data = null;
      merge = null;
      side = null;
      seq++;
      body.replaceChildren();
    },
  };
}

function escapeText(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

import { state } from "../state.js";
import { formatJson } from "../utils/jsonRepair.js";
import { el } from "../utils/dom.js";
import { codeEditor } from "./codeEditor.js";
import { enterDesktopMode, exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";
import { registerApp } from "../appLifecycle.js";

// Formatter JSON: um único campo. "Formatar" diagnostica o texto (escapado, minificado,
// quebrado...), repara com o pipeline de utils/jsonRepair.js e substitui o conteúdo no lugar.

const LIVE_LIMIT = 150_000; // diagnóstico ao vivo enquanto digita/cola (acima: só ao formatar)
const PERSIST_LIMIT = 1_000_000;
const STORE_TEXT = "jf.text";
const STORE_OPTS = "jf.options";

const INDENTS = { 2: "  ", 4: "    ", tab: "\t" };

const appEl = document.getElementById("json-app");
const diagEl = document.getElementById("jf-diag");
const badgeEl = document.getElementById("jf-state");
const infoEl = document.getElementById("jf-info");
const cursorEl = document.getElementById("jf-cursor");
const popEl = document.getElementById("jf-pop");
const toastEl = document.getElementById("jf-toast");

const opts = { indent: "2", sortKeys: false, expand: false, formatOnPaste: true };
let cache = { key: null, result: null };
let lastFormatted = null; // texto produzido pelo último "Formatar"
let diagOpen = false;
let liveTimer = null;
let persistTimer = null;
let toastTimer = null;

const PLACEHOLDER = [
  "Cole aqui qualquer JSON:",
  "• minificado ou já formatado",
  '• escapado ({\\"a\\":1}) ou string dentro de string',
  "• com aspas simples, comentários, vírgulas sobrando",
  "• truncado, com acentos quebrados (Ã©), Base64, JWT...",
  "",
  "Ctrl+Enter formata.",
].join("\n");

const editor = codeEditor({
  lang: "json",
  fill: true,
  lineHeight: 20,
  padY: 12,
  hideGutterWhenEmpty: true,
  placeholder: PLACEHOLDER,
  indent: () => INDENTS[opts.indent],
  onInput: () => onTextChange(),
});
document.getElementById("jf-editor").append(editor.root);
const input = editor.input;

// ---------- Storage (só conveniência local) ----------

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* sem storage: segue sem persistir */
  }
}

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    writeStore(STORE_TEXT, input.value.length <= PERSIST_LIMIT ? input.value : null);
  }, 500);
}

// ---------- Pipeline ----------

const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 600 }) : setTimeout(fn, 0));

const cacheKey = (text) => `${opts.indent}|${opts.sortKeys}|${opts.expand}|${text}`;

function analyze(text = input.value) {
  const key = cacheKey(text);
  if (cache.key !== key) {
    cache = { key, result: formatJson(text, { indent: INDENTS[opts.indent], sortKeys: opts.sortKeys, expand: opts.expand }) };
  }
  return cache.result;
}

/** Substitui todo o conteúdo mantendo o Ctrl+Z nativo. */
function replaceAll(text) {
  input.focus();
  input.select();
  const ok = input.value.length < 2_000_000 && document.execCommand("insertText", false, text);
  if (!ok || input.value !== text) input.value = text;
  input.setSelectionRange(0, 0);
  input.scrollTop = 0;
  input.scrollLeft = 0;
  onTextChange({ live: false });
}

function format({ quiet = false } = {}) {
  closePop();
  const text = input.value;
  if (!text.trim()) {
    if (!quiet) toast("Cole um JSON para formatar");
    input.focus();
    return;
  }
  const t0 = performance.now();
  const r = analyze(text);
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) {
    renderDiagnosis(r, { open: true });
    toast(r.error);
    return;
  }
  lastFormatted = r.pretty;
  if (r.pretty !== text) {
    // O texto formatado gera a mesma AST: reaproveita o resultado para os botões de copiar.
    cache = { key: cacheKey(r.pretty), result: r };
    replaceAll(r.pretty);
  }
  // Na bandeja o espaço é curto: a lista só abre sozinha no desktop (o badge resume o diagnóstico).
  renderDiagnosis(r, { open: state.desktopMode ? r.steps.length > 0 : diagOpen });
  renderInfo(r, ms);
}

async function copyResult(kind) {
  const text = input.value;
  if (!text.trim()) return toast("Nada para copiar");
  const r = analyze(text);
  if (!r.ok) {
    renderDiagnosis(r, { open: true });
    return toast(`Não foi possível copiar: ${r.error}`);
  }
  const out = kind === "min" ? r.minified : r.pretty;
  try {
    await navigator.clipboard.writeText(out);
    toast(kind === "min" ? `Minificado copiado · ${formatBytes(byteLength(out))}` : `Formatado copiado · ${formatBytes(byteLength(out))}`);
  } catch {
    toast("Não foi possível acessar a área de transferência");
  }
}

function clearAll() {
  closePop();
  if (!input.value) return;
  replaceAll("");
  lastFormatted = null;
  renderDiagnosis(null);
  input.focus();
}

// ---------- Render ----------

const byteLength = (s) => (s.length < 50_000 ? new TextEncoder().encode(s).length : Math.round(s.length * 1.02));

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(n / 1024 / 1024).toFixed(2).replace(".", ",")} MB`;
}

const plural = (n, one, many) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;

function renderInfo(r, ms) {
  const text = input.value;
  const parts = [];
  if (r?.ok && r.stats) {
    const st = r.stats;
    if (st.root === "objeto") parts.push(plural(st.keys, "chave", "chaves"));
    else if (st.root === "array") parts.push(plural(r.ast.e.length, "item", "itens"));
    if (st.depth) parts.push(`prof. ${st.depth}`);
  }
  if (text) parts.push(formatBytes(byteLength(text)));
  if (ms !== undefined && ms > 0) parts.push(`${ms} ms`);
  infoEl.textContent = parts.join(" · ");
}

const STEP_ICON = { info: "fa-solid fa-magnifying-glass", fix: "fa-solid fa-wrench", warn: "fa-solid fa-triangle-exclamation" };
const TONE_ICON = { ok: "fa-solid fa-circle-check", info: "fa-solid fa-circle-info", warn: "fa-solid fa-screwdriver-wrench", bad: "fa-solid fa-circle-xmark", idle: "fa-regular fa-circle" };

/** Badge de estado + lista de diagnóstico. `r` nulo limpa tudo. */
function renderDiagnosis(r, { open } = {}) {
  if (!r) {
    badgeEl.hidden = true;
    diagEl.hidden = true;
    diagEl.innerHTML = "";
    diagOpen = false;
    return;
  }
  const steps = r.steps || [];
  const fixes = steps.filter((s) => s.kind !== "info").length;
  const tone = r.state.tone;
  badgeEl.hidden = false;
  badgeEl.className = `jf-badge tone-${tone}`;
  badgeEl.innerHTML = "";
  badgeEl.append(el("i", { class: TONE_ICON[tone] || TONE_ICON.idle }), el("span", {}, r.state.label));
  if (steps.length && r.ok) badgeEl.append(el("span.jf-badge-count", {}, fixes ? plural(fixes, "ajuste", "ajustes") : plural(steps.length, "detalhe", "detalhes")));
  if (steps.length || !r.ok) badgeEl.append(el("i", { class: "fa-solid fa-chevron-up jf-badge-caret" }));
  badgeEl.disabled = !steps.length && r.ok;
  badgeEl.title = badgeEl.disabled ? "" : "Mostrar/ocultar diagnóstico";

  diagEl.innerHTML = "";
  if (!r.ok) {
    diagEl.append(el("div.jf-step.kind-bad", {}, el("i", { class: "fa-solid fa-circle-xmark" }), el("span", {}, r.error)));
  }
  for (const s of steps) {
    diagEl.append(
      el(`div.jf-step.kind-${s.kind}`, {}, el("i", { class: STEP_ICON[s.kind] }), el("span", {}, s.label), s.count > 1 ? el("span.jf-step-count", {}, `×${s.count}`) : null),
    );
  }
  if (open !== undefined) diagOpen = open && (steps.length > 0 || !r.ok);
  diagEl.hidden = !diagOpen || !diagEl.childElementCount;
  badgeEl.classList.toggle("open", !diagEl.hidden);
}

/** Diagnóstico ao vivo (sem alterar o texto) enquanto o usuário cola/edita. */
function liveDiagnose() {
  clearTimeout(liveTimer);
  const text = input.value;
  if (!text.trim()) {
    renderDiagnosis(null);
    renderInfo(null);
    return;
  }
  if (text === lastFormatted) return;
  if (text.length > LIVE_LIMIT) {
    badgeEl.hidden = false;
    badgeEl.className = "jf-badge tone-idle";
    badgeEl.innerHTML = `<i class="${TONE_ICON.idle}"></i><span>Pronto para formatar</span>`;
    badgeEl.disabled = true;
    diagEl.hidden = true;
    renderInfo(null);
    return;
  }
  // Espera uma pausa na digitação e um momento ocioso para não disputar frames com o editor.
  liveTimer = setTimeout(() => idle(() => {
    if (input.value !== text) return;
    const r = analyze(text);
    const label = r.ok && r.state.tone === "ok" && r.pretty === text ? "Válido · formatado" : r.state.label;
    renderDiagnosis({ ok: r.ok, steps: r.steps, error: r.error, state: { ...r.state, label } }, { open: diagOpen });
    renderInfo(r);
  }), 250);
}

function scheduleRender() {
  editor.refresh();
  updateCursor();
}

function updateCursor() {
  if (!input.value) {
    cursorEl.textContent = "";
    return;
  }
  const { line, col } = editor.position(input.selectionStart);
  const sel = Math.abs(input.selectionEnd - input.selectionStart);
  cursorEl.textContent = `Ln ${line}, Col ${col}${sel ? ` (${sel} sel.)` : ""}`;
}

function onTextChange({ live = true } = {}) {
  scheduleRender();
  persistSoon();
  if (live) liveDiagnose();
}

// ---------- Toast ----------

function toast(message) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.append(el("span", {}, message));
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

// ---------- Opções ----------

function saveOptions() {
  writeStore(STORE_OPTS, JSON.stringify(opts));
}

function loadOptions() {
  try {
    Object.assign(opts, JSON.parse(readStore(STORE_OPTS) || "{}"));
  } catch {
    /* padrão */
  }
  if (!INDENTS[opts.indent]) opts.indent = "2";
}

function setOption(key, value) {
  opts[key] = value;
  saveOptions();
  renderPop();
  // Se o texto atual é o resultado de um "Formatar", aplica a opção na hora.
  if (input.value && input.value === lastFormatted) format({ quiet: true });
  else liveDiagnose();
}

function switchRow(label, hint, key) {
  const box = el("input", { type: "checkbox", checked: !!opts[key], onchange: () => setOption(key, box.checked) });
  return el("label.jf-pop-row", {}, el("span.jf-pop-text", {}, el("span", {}, label), el("small", {}, hint)), el("span.toggle-switch.jf-toggle", {}, box, el("span.slider")));
}

function renderPop() {
  popEl.innerHTML = "";
  const seg = el("div.jf-seg");
  for (const [id, label] of [["2", "2 espaços"], ["4", "4 espaços"], ["tab", "Tab"]]) {
    seg.append(el("button", { type: "button", class: opts.indent === id ? "active" : "", onclick: () => setOption("indent", id) }, label));
  }
  popEl.append(
    el("div.jf-pop-label", {}, "Indentação"),
    seg,
    el("div.jf-pop-sep"),
    switchRow("Ordenar chaves", "A–Z, em todos os níveis", "sortKeys"),
    switchRow("Expandir JSON em strings", "\"{\\\"a\\\":1}\" dentro de valores vira objeto", "expand"),
    switchRow("Formatar ao colar", "Ao colar em um campo vazio", "formatOnPaste"),
  );
}

function togglePop() {
  if (!popEl.hidden) return closePop();
  renderPop();
  popEl.hidden = false;
  const btn = appEl.querySelector('[data-action="options"]');
  const a = btn.getBoundingClientRect();
  const host = appEl.getBoundingClientRect();
  popEl.style.top = `${a.bottom - host.top + 6}px`;
  popEl.style.right = `${Math.max(8, host.right - a.right)}px`;
  btn.classList.add("active");
}

function closePop() {
  popEl.hidden = true;
  appEl.querySelector('[data-action="options"]')?.classList.remove("active");
}

function handleGlobalKeydown(e) {
  if (state.activeMainView !== "json") return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape" && !popEl.hidden) {
    closePop();
    return;
  }
  if ((mod && e.key === "Enter") || (e.altKey && e.shiftKey && key === "f") || (mod && e.shiftKey && key === "f")) {
    e.preventDefault();
    format();
  } else if (mod && e.shiftKey && key === "c") {
    e.preventDefault();
    copyResult("pretty");
  } else if (mod && e.shiftKey && key === "m") {
    e.preventDefault();
    copyResult("min");
  }
}

// ---------- Init ----------

const actions = {
  format: () => format(),
  "copy-pretty": () => copyResult("pretty"),
  "copy-min": () => copyResult("min"),
  clear: clearAll,
  options: togglePop,
  "toggle-diag": () => {
    diagOpen = diagEl.hidden;
    diagEl.hidden = !diagOpen || !diagEl.childElementCount;
    badgeEl.classList.toggle("open", !diagEl.hidden);
  },
  desktop: () => enterDesktopMode(),
  tray: () => exitDesktopMode(),
  "close-desktop": () => exitDesktopMode({ visible: false }),
  minimize: minimizeWindow,
  maximize: toggleMaximize,
};

export function initJsonFormatter() {
  loadOptions();
  const saved = readStore(STORE_TEXT);
  if (saved) editor.setValue(saved);

  appEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn && actions[btn.dataset.action]) actions[btn.dataset.action]();
    else if (!popEl.hidden && !e.target.closest("#jf-pop")) closePop();
  });
  document.addEventListener("mousedown", (e) => {
    if (!popEl.hidden && !e.target.closest("#jf-pop") && !e.target.closest('[data-action="options"]')) closePop();
  });

  input.addEventListener("keyup", updateCursor);
  input.addEventListener("click", updateCursor);
  input.addEventListener("select", updateCursor);
  input.addEventListener("paste", (e) => {
    if (!opts.formatOnPaste || input.value.trim()) return;
    const text = (e.clipboardData?.getData("text") || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    // Deixa o paste nativo acontecer (fica no histórico de desfazer) e formata em seguida.
    setTimeout(() => {
      if (input.value.replace(/\r\n?/g, "\n").trim() === text) format({ quiet: true });
    }, 0);
  });

  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("mainviewchange", () => {
    if (state.activeMainView !== "json") {
      closePop();
      return;
    }
    scheduleRender();
    if (!state.desktopMode || document.activeElement === document.body) requestAnimationFrame(() => input.focus({ preventScroll: true }));
  });
  document.addEventListener("windowmodechange", () => {
    closePop();
    scheduleRender();
  });

  scheduleRender();
  liveDiagnose();

  // O texto e as opções ficam no localStorage, que as janelas compartilham.
  registerApp("json", {
    flush: () => {
      if (!persistTimer) return;
      clearTimeout(persistTimer);
      persistTimer = 0;
      writeStore(STORE_TEXT, input.value.length <= PERSIST_LIMIT ? input.value : null);
    },
    reload: () => {
      loadOptions();
      editor.setValue(readStore(STORE_TEXT) || "");
      scheduleRender();
      liveDiagnose();
    },
  });
}

import { sanitizeHtml, escapeHtml, imageHtml } from "../utils/noteContent.js";
import { storeImageBlob, storeDataImages, resolveMarkdownImages } from "../utils/noteImages.js";
import { markdownKind, markdownToHtml, inlineMarkdown } from "../utils/markdown.js";
import { openHistory, recordHistory, amendHistory, recordSelection, sealHistory, stepHistory } from "./noteHistory.js";
import {
  initCodeBlocks, hydrateCodeBlocks, serializeEditorHtml, serializeRange, createCodeBlock, startEdit as editCodeBlock,
  isCodeBlock, codeBlockOf, preText, lastCodeLang,
} from "./noteCode.js";
import { initNoteMenus } from "./noteMenus.js";
import { hydrateLinks, followLink, chipFor, initLinkPeek } from "./noteLinks.js";
import { splitLinkText } from "../utils/zettel.js";
import { guessCodeLang } from "../utils/codeBlock.js";
import { normalizeCodeLang } from "../utils/highlight.js";

// Rich-text editor (contenteditable) modeled on the macOS Notes app.

const editor = document.getElementById("nt-editor");
const tableTools = document.getElementById("nt-table-tools");
const scroller = document.getElementById("nt-editor-scroll");

const BLOCK_TAGS = new Set(["H1", "H2", "H3", "P", "DIV", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE"]);
const STYLE_TAGS = { title: "h1", heading: "h2", subheading: "h3", body: "p", mono: "pre" };
const AUTO_LISTS = { "-": "dash", "–": "dash", "*": "bullet", "+": "bullet", "•": "bullet", "1.": "number", "1)": "number", "[]": "check", "[ ]": "check" };
const BLOCK_MARKDOWN = { "#": "title", "##": "heading", "###": "subheading", ">": "quote", "```": "code" };
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

let onChange = () => {};
let onSelectionState = () => {};
let loadSeq = 0; // bumps on every loadEditor (async pastes check it before inserting)
let lastTyped = "";
let plainPaste = false; // Ctrl+Shift+V: pastes the text as is (no Markdown conversion)
let menus = { onKeydown: () => false, onInput: () => {}, close: () => {}, openLink: () => {} }; // noteMenus.js
let peek = null; // link preview on hover (noteLinks.js)

function exec(cmd, value = null) {
  document.execCommand(cmd, false, value);
}

function selectionRange() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  // Dentro de um bloco de código (textarea, visualização) não é seleção do texto rico.
  return editor.contains(range.commonAncestorContainer) && !codeBlockOf(range.commonAncestorContainer) ? range : null;
}

function closestInEditor(selector) {
  const range = selectionRange();
  if (!range) return null;
  let node = range.startContainer;
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  const found = node?.closest(selector);
  return found && editor.contains(found) && found !== editor ? found : null;
}

function placeCaret(el, atEnd = false) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** kind/wordStart group typing into undo steps (see noteHistory.js). */
function changed(kind = "cmd", wordStart = false) {
  hydrateCodeBlocks(editor); // <pre data-lang> colado ou inserido
  hydrateLinks(editor); // links [[ ]] colados ou inseridos
  fixBlockNesting();
  const html = editorHtml();
  recordHistory(html, kind, wordStart);
  onChange(html);
  updateTableTools();
  emitSelectionState();
}

/** HTML salvo da nota (blocos de código como <pre data-lang>). */
function editorHtml() {
  const html = serializeEditorHtml(editor);
  return html.includes(ZWSP) ? html.replaceAll(ZWSP, "") : html; // caret helper of inline Markdown
}

/** Troca o conteúdo do editor (carregar nota, desfazer/refazer). */
function setEditorHtml(html) {
  editor.innerHTML = html;
  hydrateCodeBlocks(editor);
  return hydrateLinks(editor, true);
}

// ---------- Undo / redo ----------

/** Caret position as (element path, text offset): survives an innerHTML round-trip. */
function serializePoint(node, offset) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el || !editor.contains(el)) return null;
  const probe = document.createRange();
  probe.setStart(el, 0);
  probe.setEnd(node, offset);
  const path = [];
  for (let n = el; n !== editor; n = n.parentElement) path.push(Array.prototype.indexOf.call(n.parentElement.children, n));
  path.reverse();
  return { path, text: probe.toString().length, child: node === el ? offset : -1 };
}

function deserializePoint(p) {
  let el = editor;
  for (const i of p.path) {
    const c = el.children[i];
    if (!c) break;
    el = c;
  }
  if (p.child >= 0 && p.child <= el.childNodes.length) return [el, p.child];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let rem = p.text;
  let n;
  while ((n = walker.nextNode())) {
    if (rem <= n.length) return [n, rem];
    rem -= n.length;
  }
  return [el, el.childNodes.length];
}

function serializeSelection() {
  const range = selectionRange();
  if (!range) return null;
  const start = serializePoint(range.startContainer, range.startOffset);
  return start && { start, end: range.collapsed ? null : serializePoint(range.endContainer, range.endOffset) };
}

function restoreSelection(saved) {
  editor.focus({ preventScroll: true });
  if (!saved) {
    placeCaret(editor.lastElementChild || editor, true);
    return;
  }
  const range = document.createRange();
  range.setStart(...deserializePoint(saved.start));
  if (saved.end) range.setEnd(...deserializePoint(saved.end));
  else range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const target = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  target?.scrollIntoView({ block: "nearest" });
}

function applyHistory(delta) {
  const entry = stepHistory(delta);
  if (!entry) return;
  setEditorHtml(entry.html);
  restoreSelection(entry.sel);
  onChange(entry.html);
  updateTableTools();
  emitSelectionState();
}

/** Keeps every top-level node inside a block (typing into an empty editor creates bare text). */
function normalizeTopLevel() {
  if (!editor.firstChild) {
    editor.innerHTML = "<h1><br></h1>";
    placeCaret(editor.firstChild);
    return;
  }
  const sel = window.getSelection();
  const anchor = sel.anchorNode;
  const offset = sel.anchorOffset;
  let wrap = null;
  let moved = false;
  for (const node of [...editor.childNodes]) {
    const isBlock = node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName);
    if (isBlock) {
      wrap = null;
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim() && node !== anchor) {
      node.remove();
      continue;
    }
    if (!wrap) {
      wrap = document.createElement(node === editor.firstChild ? "h1" : "p");
      editor.insertBefore(wrap, node);
    }
    wrap.appendChild(node);
    moved = true;
  }
  if (moved && anchor && editor.contains(anchor)) sel.collapse(anchor, offset);
}

/** Chrome sometimes nests lists/tables inside <p> or headings; lift them back out. */
function fixBlockNesting() {
  const bad = () => editor.querySelector(":is(p,h1,h2,h3,pre) > :is(ul,ol,table,p,h1,h2,h3,pre,blockquote)");
  if (!bad()) return;
  const sel = window.getSelection();
  const anchor = sel.anchorNode;
  const offset = sel.anchorOffset;
  let el;
  while ((el = bad())) {
    const parent = el.parentElement;
    const rest = [...parent.childNodes];
    const meaningful = rest.filter((n) => n !== el && !(n.nodeName === "BR" || (n.nodeType === Node.TEXT_NODE && !n.textContent.trim())));
    if (!meaningful.length) {
      parent.replaceWith(...rest.filter((n) => n.nodeName !== "BR"));
    } else {
      // Move the block (and anything after it) out, after the paragraph.
      const idx = rest.indexOf(el);
      parent.after(...rest.slice(idx));
    }
  }
  if (anchor && editor.contains(anchor)) sel.collapse(anchor, Math.min(offset, anchor.length ?? anchor.childNodes.length));
}

// ---------- Block styles ----------

function currentBlock() {
  return closestInEditor("h1,h2,h3,p,pre,li,td,th,div,blockquote");
}

function setBlockStyle(style) {
  const tag = STYLE_TAGS[style];
  if (!tag) return;
  const list = closestInEditor("ul,ol");
  if (list && tag !== "p") {
    // A heading cannot live inside a list item: leave the list first.
    exec(list.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
  }
  exec("formatBlock", `<${tag}>`);
}

function toggleQuote() {
  const quote = closestInEditor("blockquote");
  if (quote) {
    const range = selectionRange();
    const marker = range?.startContainer;
    const offset = range?.startOffset;
    const children = [...quote.childNodes];
    if (!children.some((c) => c.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(c.tagName))) {
      const p = document.createElement("p");
      p.append(...children);
      quote.replaceWith(p);
    } else {
      quote.replaceWith(...children);
    }
    if (marker && editor.contains(marker)) window.getSelection().collapse(marker, offset);
    changed();
    return;
  }
  exec("formatBlock", "<blockquote>");
}

// ---------- Lists ----------

function listKind(list) {
  if (list.tagName === "OL") return "number";
  if (list.classList.contains("checklist")) return "check";
  if (list.classList.contains("dashed")) return "dash";
  return "bullet";
}

function setListKind(list, kind) {
  list.classList.toggle("checklist", kind === "check");
  list.classList.toggle("dashed", kind === "dash");
  if (!list.className) list.removeAttribute("class");
  if (kind !== "check") list.querySelectorAll(":scope > li.checked").forEach((li) => li.classList.remove("checked"));
}

function applyList(kind) {
  const wantsOl = kind === "number";
  const cmd = wantsOl ? "insertOrderedList" : "insertUnorderedList";
  const list = closestInEditor("ul,ol");

  if (list) {
    if (listKind(list) === kind) {
      exec(cmd); // same style again = remove the list
      changed();
      return;
    }
    if ((list.tagName === "OL") !== wantsOl) exec(cmd);
  } else {
    const block = closestInEditor("h1,h2,h3,pre");
    if (block) exec("formatBlock", "<p>");
    exec(cmd);
  }

  const newList = closestInEditor("ul,ol");
  if (newList) setListKind(newList, kind);
  changed();
}

// ---------- Tables ----------

function makeTable(rows, cols) {
  const table = document.createElement("table");
  table.className = "nt-table";
  const tbody = document.createElement("tbody");
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement("tr");
    for (let c = 0; c < cols; c++) {
      const td = document.createElement("td");
      td.innerHTML = "<br>";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function insertTable() {
  if (closestInEditor("table")) return;
  editor.focus();
  let block = selectionRange() ? closestInEditor("h1,h2,h3,p,pre,div,ul,ol,blockquote") : null;
  while (block && block.parentElement !== editor) block = block.parentElement;

  const table = makeTable(3, 3);
  const isEmpty = block && !block.textContent.trim() && block !== editor.firstElementChild;
  if (isEmpty) block.replaceWith(table);
  else if (block) block.after(table);
  else editor.appendChild(table);

  if (!table.nextElementSibling) {
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    table.after(p);
  }
  placeCaret(table.querySelector("td"));
  changed();
}

function cellPosition(cell) {
  const row = cell.parentElement;
  const table = cell.closest("table");
  return { table, row, rows: [...table.rows], col: cell.cellIndex };
}

function newCell(tag = "td") {
  const c = document.createElement(tag);
  c.innerHTML = "<br>";
  return c;
}

function addRow(cell, after = true) {
  const { row } = cellPosition(cell);
  const tr = document.createElement("tr");
  for (let i = 0; i < row.cells.length; i++) tr.appendChild(newCell());
  if (after) row.after(tr);
  else row.before(tr);
  return tr;
}

function addColumn(cell, after = true) {
  const { rows, col } = cellPosition(cell);
  for (const r of rows) {
    const ref = r.cells[col];
    const c = newCell(ref?.tagName === "TH" ? "th" : "td");
    if (!ref) r.appendChild(c);
    else if (after) ref.after(c);
    else ref.before(c);
  }
}

function removeTable(table) {
  const next = table.nextElementSibling || table.previousElementSibling;
  table.remove();
  if (next) placeCaret(next, true);
  else normalizeTopLevel();
}

function deleteRow(cell) {
  const { table, row, rows, col } = cellPosition(cell);
  if (rows.length <= 1) return removeTable(table);
  const target = row.nextElementSibling || row.previousElementSibling;
  row.remove();
  placeCaret(target.cells[Math.min(col, target.cells.length - 1)]);
}

function deleteColumn(cell) {
  const { table, row, rows, col } = cellPosition(cell);
  if (row.cells.length <= 1) return removeTable(table);
  for (const r of rows) r.cells[col]?.remove();
  placeCaret(row.cells[Math.min(col, row.cells.length - 1)]);
}

function tableAction(action) {
  const cell = closestInEditor("td,th");
  if (!cell) return;
  const table = cell.closest("table");
  switch (action) {
    case "row-above": placeCaret(addRow(cell, false).cells[cell.cellIndex]); break;
    case "row-below": placeCaret(addRow(cell, true).cells[cell.cellIndex]); break;
    case "col-left": addColumn(cell, false); placeCaret(cell.previousElementSibling); break;
    case "col-right": addColumn(cell, true); placeCaret(cell.nextElementSibling); break;
    case "del-row": deleteRow(cell); break;
    case "del-col": deleteColumn(cell); break;
    case "del-table": removeTable(table); break;
    case "header-row": {
      const first = table.rows[0];
      const toTh = first.cells[0].tagName === "TD";
      for (const c of [...first.cells]) {
        const repl = document.createElement(toTh ? "th" : "td");
        repl.append(...c.childNodes);
        c.replaceWith(repl);
      }
      placeCaret(first.cells[0], true);
      break;
    }
  }
  changed();
}

function moveCell(cell, backwards) {
  const cells = [...cell.closest("table").querySelectorAll("td,th")];
  const idx = cells.indexOf(cell);
  if (backwards) {
    if (idx > 0) placeCaret(cells[idx - 1], true);
    return;
  }
  if (idx < cells.length - 1) {
    placeCaret(cells[idx + 1], true);
  } else {
    const tr = addRow(cell, true);
    placeCaret(tr.cells[0]);
    changed();
  }
}

function moveCellDown(cell) {
  const { row, col } = cellPosition(cell);
  let next = row.nextElementSibling;
  if (!next) {
    next = addRow(cell, true);
    changed();
  }
  placeCaret(next.cells[Math.min(col, next.cells.length - 1)], true);
}

function updateTableTools() {
  const cell = closestInEditor("td,th");
  if (!cell || editor.contentEditable !== "true") {
    tableTools.hidden = true;
    return;
  }
  const table = cell.closest("table");
  const tRect = table.getBoundingClientRect();
  const sRect = scroller.getBoundingClientRect();
  tableTools.hidden = false;
  const maxLeft = scroller.clientWidth - tableTools.offsetWidth - 4;
  tableTools.style.top = `${tRect.bottom - sRect.top + scroller.scrollTop + 6}px`;
  tableTools.style.left = `${Math.max(4, Math.min(maxLeft, tRect.left - sRect.left + scroller.scrollLeft))}px`;
}

// ---------- Code blocks (noteCode.js) ----------

/** Child of the editor that holds the caret. */
function topLevelBlock() {
  const range = selectionRange();
  let n = range?.startContainer;
  while (n && n.parentNode !== editor) n = n.parentNode;
  return n?.nodeType === Node.ELEMENT_NODE ? n : null;
}

function newParagraph() {
  const p = document.createElement("p");
  p.innerHTML = "<br>";
  return p;
}

/** Caret collapsed at the very start (or end) of the block's content. */
function caretAtEdge(block, end) {
  const range = selectionRange();
  if (!range?.collapsed) return false;
  const probe = document.createRange();
  probe.selectNodeContents(block);
  if (end) probe.setStart(range.endContainer, range.endOffset);
  else probe.setEnd(range.startContainer, range.startOffset);
  return !probe.toString().length && !probe.cloneContents().querySelector("img,table");
}

/** Caret on the first (or last) visual line of the block. */
function caretOnEdgeLine(block, end) {
  const range = selectionRange();
  if (!range?.collapsed) return false;
  if (!block.textContent) return true;
  const r = range.getClientRects()[0] || (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer.getBoundingClientRect() : null);
  if (!r) return caretAtEdge(block, end);
  const b = block.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(block).lineHeight) || 21;
  return end ? r.bottom > b.bottom - lh : r.top < b.top + lh;
}

/** Inserts a code block at the caret (selection/mono paragraph become its content). */
function insertCodeBlock(lang = null) {
  if (editor.contentEditable !== "true") return;
  if (!selectionRange()) {
    editor.focus();
    placeCaret(editor.lastElementChild || editor, true);
  }
  let text = "";
  if (!selectionRange().collapsed) {
    text = window.getSelection().toString();
    exec("delete");
  }
  const block = currentBlock();
  if (block?.tagName === "PRE" && !text) text = preText(block);
  let top = block;
  while (top && top.parentElement !== editor) top = top.parentElement;

  const w = createCodeBlock(text, lang ? normalizeCodeLang(lang) : guessCodeLang(text) || lastCodeLang(), { mode: "code" });
  const empty = top && !top.textContent.trim() && !top.querySelector("img,table");
  if (top && top === block && top !== editor.firstElementChild && (top.tagName === "PRE" || empty)) top.replaceWith(w);
  else if (top) top.after(w);
  else editor.appendChild(w);
  if (!w.nextElementSibling) w.after(newParagraph());
  changed();
  editCodeBlock(w, "end");
}

/** Leaves a code block with the keyboard: caret goes to the block before/after it. */
function exitCodeBlock(w, where) {
  const before = where === "before";
  let target = before ? w.previousElementSibling : w.nextElementSibling;
  const added = !target || isCodeBlock(target);
  if (added) {
    target = newParagraph();
    if (before) w.before(target);
    else w.after(target);
  }
  editor.focus({ preventScroll: true });
  placeCaret(target, before);
  target.scrollIntoView({ block: "nearest" });
  if (added) changed();
}

function removeCodeBlock(w) {
  const p = newParagraph();
  w.replaceWith(p);
  editor.focus({ preventScroll: true });
  placeCaret(p);
  changed();
}

/** Arrows/Backspace/Delete next to a code block enter it instead of skipping or deleting it. */
function handleCodeAdjacency(e) {
  const k = e.key;
  const back = k === "Backspace" || k === "ArrowUp" || k === "ArrowLeft";
  const fwd = k === "Delete" || k === "ArrowDown" || k === "ArrowRight";
  if (!back && !fwd) return false;
  const block = topLevelBlock();
  if (!block) return false;
  const w = back ? block.previousElementSibling : block.nextElementSibling;
  if (!isCodeBlock(w)) return false;
  const vertical = k === "ArrowUp" || k === "ArrowDown";
  if (!(vertical ? caretOnEdgeLine(block, fwd) : caretAtEdge(block, fwd))) return false;
  e.preventDefault();
  if ((k === "Backspace" || k === "Delete") && block !== editor.firstElementChild && !block.textContent.trim() && !block.querySelector("img,table")) {
    block.remove();
    changed();
  }
  editCodeBlock(w, back ? "end" : "start");
  return true;
}

/**
 * Pastes HTML that carries code blocks as whole blocks after the caret's block
 * (insertHTML would merge the first code line into the current paragraph).
 */
function insertBlocks(html) {
  if (!selectionRange()?.collapsed) exec("delete");
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  hydrateCodeBlocks(tpl.content);
  const nodes = [];
  let run = null;
  for (const n of [...tpl.content.childNodes]) {
    if (n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(n.tagName)) {
      nodes.push(n);
      run = null;
    } else if (n.nodeType === Node.ELEMENT_NODE || n.textContent.trim()) {
      if (!run) nodes.push((run = document.createElement("p")));
      run.appendChild(n);
    }
  }
  if (!nodes.length) return;
  const top = topLevelBlock();
  const empty = top && top !== editor.firstElementChild && !top.textContent.trim() && !top.querySelector("img,table");
  if (empty) top.replaceWith(...nodes);
  else if (top) top.after(...nodes);
  else editor.append(...nodes);
  let last = nodes[nodes.length - 1];
  if (isCodeBlock(last)) {
    if (!last.nextElementSibling || isCodeBlock(last.nextElementSibling)) last.after(newParagraph());
    last = last.nextElementSibling;
    placeCaret(last);
  } else placeCaret(last, true);
}

/** Copy/cut of a selection that crosses code blocks: copy their source, not the widget UI. */
function handleCopy(e) {
  const range = selectionRange();
  if (!range || range.collapsed) return;
  const out = serializeRange(range, editor);
  if (!out) return;
  e.preventDefault();
  e.clipboardData.setData("text/html", out.html);
  e.clipboardData.setData("text/plain", out.text);
  if (e.type === "cut" && editor.contentEditable === "true") {
    exec("delete");
    changed();
  }
}

// ---------- Click on empty space ----------

const TEXT_BLOCKS = new Set(["P", "H1", "H2", "H3", "BLOCKQUOTE", "UL", "OL"]);

/**
 * Clicks that land on empty space instead of on text:
 *  - between the title and the next block (where the properties panel opens a gap): caret at
 *    the start of that block;
 *  - below the last block: caret at its end, or on a new line when that block is the title or
 *    not text (code, table, image) — like pressing Enter after the title.
 */
function handleClickBelow(e) {
  if (e.button !== 0 || e.detail > 1 || editor.contentEditable !== "true") return;
  if (e.target !== editor && e.target !== scroller) return;
  const blocks = [...editor.children].filter((b) => !b.hidden);
  const first = blocks[0];
  if (!first) return;
  const y = e.clientY;
  if (y <= first.getBoundingClientRect().bottom) return; // title line: native behavior
  const last = blocks[blocks.length - 1];

  if (y <= last.getBoundingClientRect().bottom) {
    const second = blocks[1];
    if (!second || y >= second.getBoundingClientRect().top || !TEXT_BLOCKS.has(second.tagName)) return;
    e.preventDefault();
    editor.focus({ preventScroll: true });
    placeCaret(second.matches("ul,ol") ? second.querySelector("li") || second : second);
    return;
  }

  e.preventDefault();
  editor.focus({ preventScroll: true });
  if (last !== first && TEXT_BLOCKS.has(last.tagName) && !last.querySelector("img,table")) {
    placeCaret(last.matches("ul,ol") ? last.querySelector(":scope > li:last-child") || last : last, true);
    return;
  }
  sealHistory();
  const p = newParagraph();
  last.after(p);
  placeCaret(p);
  changed();
}

// ---------- Checklist ----------

function handleChecklistClick(e) {
  const li = e.target.closest?.("ul.checklist > li");
  if (!li || !editor.contains(li) || editor.contentEditable !== "true") return;
  const rect = li.getBoundingClientRect();
  if (e.clientX >= rect.left) return;
  e.preventDefault();
  li.classList.toggle("checked");
  changed();
}

// ---------- Key handling ----------

/** Markdown typed at the start of a block, then Space: "#", "##", "###", ">", "```", lists. */
function tryAutoFormat(e) {
  const range = selectionRange();
  if (!range || !range.collapsed) return false;
  const block = closestInEditor("p,div,h1,h2,h3");
  if (!block || block.closest("li,td,th,pre,blockquote")) return false;
  const text = block.textContent;
  const style = BLOCK_MARKDOWN[text];
  const kind = AUTO_LISTS[text];
  if (!style && !kind) return false;
  // Caret must be right after the marker.
  const probe = document.createRange();
  probe.selectNodeContents(block);
  probe.setEnd(range.startContainer, range.startOffset);
  if (probe.toString() !== text) return false;

  e.preventDefault();
  sealHistory();
  block.innerHTML = "<br>";
  placeCaret(block);
  if (kind) applyList(kind);
  else if (style === "quote") toggleQuote();
  else if (style === "code") insertCodeBlock();
  else {
    setBlockStyle(style);
    changed();
  }
  return true;
}

// ---------- Inline Markdown (**bold**, *italic*, `code`, ~~strike~~) ----------

const INLINE_MARKDOWN = [
  [/(^|[\s([{"'])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, "b"],
  [/(^|[\s([{"'])__([^_\s](?:[^_]*[^_\s])?)__$/, "b"],
  [/(^|[\s([{"'])\*([^*\s](?:[^*]*[^*\s])?)\*$/, "i"],
  [/(^|[\s([{"'])_([^_\s](?:[^_]*[^_\s])?)_$/, "i"],
  [/(^|[\s([{"'])~~([^~\s](?:[^~]*[^~\s])?)~~$/, "s"],
  [/(^|[\s([{"'])`([^`]+)`$/, "code"],
];
const ZWSP = "​";

/**
 * After typing a closing marker, turns the Markdown run before the caret into the element.
 * The caret goes after a zero-width space: otherwise Chrome keeps typing inside the element.
 * The ZWSP is dropped on the next keystroke and never saved (editorHtml).
 * Dead keys (` and ~ on ABNT2) insert the marker together with the next character ("`,"):
 * then the marker is the first character and the rest stays after the element.
 */
function tryInlineMarkdown(data) {
  if (!data) return false;
  let tail = 0;
  if (!"*_~`".includes(data.slice(-1))) {
    if (data.length !== 2 || !"~`".includes(data[0])) return false;
    tail = 1;
  }
  const sel = window.getSelection();
  const node = sel.anchorNode;
  if (!sel.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !selectionRange()) return false;
  if (node.parentElement.closest("pre,code")) return false;
  const end = sel.anchorOffset - tail;
  if (end < 1) return false;
  const before = node.data.slice(0, end);
  for (const [re, tag] of INLINE_MARKDOWN) {
    const m = re.exec(before);
    if (!m) continue;
    const range = document.createRange();
    range.setStart(node, m.index + m[1].length);
    range.setEnd(node, end);
    range.deleteContents();
    const el = document.createElement(tag);
    el.textContent = m[2];
    if (tail) {
      range.insertNode(el); // splits the text node: the typed tail starts the next one
      sel.collapse(el.nextSibling, tail);
    } else {
      const gap = document.createTextNode(ZWSP);
      range.insertNode(gap);
      range.insertNode(el);
      sel.collapse(gap, 1);
    }
    return true;
  }
  return false;
}

/** "[[Título]]" or "[[Título|texto]]" typed by hand: the closing "]]" turns it into a note link. */
function tryWikiLink(data) {
  if (data !== "]") return false;
  const sel = window.getSelection();
  const node = sel.anchorNode;
  if (!sel.isCollapsed || node?.nodeType !== Node.TEXT_NODE || !selectionRange()) return false;
  if (node.parentElement.closest("pre,code")) return false;
  const end = sel.anchorOffset;
  const m = /\[\[([^[\]\n]+)\]\]$/.exec(node.data.slice(0, end));
  if (!m) return false;
  const { title, alias } = splitLinkText(m[1]);
  if (!title) return false;
  const range = document.createRange();
  range.setStart(node, m.index);
  range.setEnd(node, end);
  range.deleteContents();
  const tpl = document.createElement("template");
  tpl.innerHTML = chipFor(title, alias);
  const gap = document.createTextNode(ZWSP);
  range.insertNode(gap);
  range.insertNode(tpl.content.firstChild);
  sel.collapse(gap, 1);
  return true;
}

/** "Link para nota": the selected text becomes a link; otherwise "[[" opens the note picker. */
function insertNoteLink() {
  const range = selectionRange();
  const text = range?.toString().trim() || "";
  if (text && !text.includes("\n") && text.length <= 120) {
    exec("insertHTML", chipFor(text.replace(/[[\]|]/g, "")) + ZWSP);
    changed();
    return;
  }
  exec("insertText", "[[");
  menus.openLink();
}

/** Drops the caret's ZWSP once real text was typed next to it. */
function dropTypedZwsp() {
  const sel = window.getSelection();
  const node = sel.anchorNode;
  if (node?.nodeType !== Node.TEXT_NODE || node.length < 2) return;
  const i = node.data.indexOf(ZWSP);
  if (i < 0) return;
  const offset = sel.anchorOffset;
  node.deleteData(i, 1);
  sel.collapse(node, offset > i ? offset - 1 : offset);
}

// ---------- Images ----------

/** File picker for the "/" menu: images go in at the caret, stored like pasted ones. */
function pickImages() {
  const range = selectionRange()?.cloneRange();
  if (!range) return;
  const seq = loadSeq;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.hidden = true;
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    const files = [...input.files].filter((f) => f.type.startsWith("image/"));
    input.remove();
    if (!files.length) return;
    insertLater(range, seq, async () => {
      const stored = await Promise.all(files.map(storeImageBlob));
      return stored.map((img) => imageHtml(img.src, img.width, img.height)).join("");
    });
  });
  input.click();
}

/** Toggles inline <code> on the selection (single block). */
function toggleInlineCode() {
  const code = closestInEditor("code");
  if (code) {
    code.replaceWith(...code.childNodes);
    changed();
    return;
  }
  const range = selectionRange();
  const text = range?.toString() || "";
  if (!text || text.includes("\n")) return;
  exec("insertHTML", `<code>${escapeHtml(text)}</code>`);
  changed();
}

const SHORTCUTS = {
  T: () => setBlockStyle("title"),
  H: () => setBlockStyle("heading"),
  J: () => setBlockStyle("subheading"),
  B: () => setBlockStyle("body"),
  M: () => setBlockStyle("mono"),
  L: () => applyList("check"),
  K: () => insertCodeBlock(),
  "&": () => applyList("number"),
  7: () => applyList("number"),
  8: () => applyList("bullet"),
};

function handleKeydown(e) {
  if (editor.contentEditable !== "true" || codeBlockOf(e.target)) return;
  if (menus.onKeydown(e)) return; // "/" menu navigation, Esc on the selection toolbar
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "v") plainPaste = e.shiftKey;

  const lower = e.key.toLowerCase();
  if (mod && !e.altKey && (lower === "z" || lower === "y")) {
    e.preventDefault();
    applyHistory(lower === "y" || e.shiftKey ? 1 : -1);
    return;
  }
  if (NAV_KEYS.has(e.key)) sealHistory();

  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (mod && e.shiftKey && SHORTCUTS[key]) {
    e.preventDefault();
    SHORTCUTS[key]();
    changed();
    return;
  }
  if (mod && e.altKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    insertTable();
    return;
  }
  if (mod && !e.shiftKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    exec("strikeThrough");
    changed();
    return;
  }

  if (!mod && !e.altKey && !e.shiftKey && handleCodeAdjacency(e)) return;

  // Enter on an empty line of a quote leaves it (like lists).
  if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) {
    const quote = closestInEditor("blockquote");
    const line = quote && (closestInEditor("p,div,h1,h2,h3") || quote);
    if (quote && !line.closest("li,td,th") && !line.textContent.trim() && !line.querySelector("img")) {
      e.preventDefault();
      const p = newParagraph();
      if (line === quote) quote.replaceWith(p);
      else {
        quote.after(p);
        line.remove();
        if (!quote.textContent.trim() && !quote.querySelector("img")) quote.remove();
      }
      placeCaret(p);
      changed();
      return;
    }
  }

  // ```lang + Enter in an empty paragraph creates a code block.
  if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) {
    const block = closestInEditor("p,div");
    const fence = block && !block.closest("li,td,th,blockquote") && /^```\s*([\w+#.-]*)\s*$/.exec(block.textContent);
    if (fence && caretAtEdge(block, true)) {
      e.preventDefault();
      block.innerHTML = "<br>";
      placeCaret(block);
      insertCodeBlock(fence[1] || null);
      return;
    }
  }

  const cell = closestInEditor("td,th");
  if (cell) {
    if (e.key === "Tab") {
      e.preventDefault();
      moveCell(cell, e.shiftKey);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      moveCellDown(cell);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      exec("insertLineBreak");
      return;
    }
  }

  if (e.key === "Tab" && closestInEditor("li")) {
    e.preventDefault();
    exec(e.shiftKey ? "outdent" : "indent");
    const list = closestInEditor("ul,ol");
    const parent = list?.parentElement?.closest("ul,ol");
    if (list && parent) setListKind(list, listKind(parent));
    changed();
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    exec("insertText", "\t");
    return;
  }

  if (e.key === " " && tryAutoFormat(e)) return;

  if (e.key === "Enter" && closestInEditor("ul.checklist > li")) {
    // The browser clones the "checked" class onto the new item.
    setTimeout(() => {
      const li = closestInEditor("ul.checklist > li.checked");
      if (!li) return;
      li.classList.remove("checked");
      const html = editorHtml();
      amendHistory(html);
      onChange(html);
    });
  }
}

function htmlHasText(html) {
  if (!html) return false;
  return !!new DOMParser().parseFromString(html, "text/html").body.textContent.trim();
}

/** Inserts HTML produced asynchronously at the caret saved when the paste started. */
function insertLater(range, seq, makeHtml) {
  makeHtml()
    .then((html) => {
      if (!html || seq !== loadSeq || !editor.contains(range.startContainer)) return;
      editor.focus({ preventScroll: true });
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      exec("insertHTML", html);
      normalizeTopLevel();
      changed();
    })
    .catch((err) => console.error("paste failed", err));
}

/** HTML without any formatting (e.g. VS Code: colored divs/spans): its plain text is what counts. */
function isUnformattedHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return !tpl.content.querySelector("h1,h2,h3,h4,h5,h6,ul,ol,table,b,strong,i,em,u,s,del,code,pre,blockquote,img,a");
}

/** Converted Markdown as blocks; into an empty note it becomes the whole note (first line = title). */
function insertMarkdownBlocks(html) {
  if (!html) return;
  if (!editor.textContent.trim() && !editor.querySelector("img,table")) {
    editor.replaceChildren();
    placeCaret(editor);
  }
  insertBlocks(html);
}

/** Pasted Markdown text: one line stays inline (`code`, **bold**), more lines become blocks. */
function pasteMarkdown(text, kind, range) {
  const html = kind === "inline" ? inlineMarkdown(text) : markdownToHtml(text);
  if (!html.includes("<img")) {
    if (kind === "inline") exec("insertHTML", sanitizeHtml(html));
    else insertMarkdownBlocks(sanitizeHtml(html));
    return;
  }
  // Images: data: URLs and absolute paths become stored files; relative paths keep the alt text.
  const seq = loadSeq;
  resolveMarkdownImages(kind === "inline" ? `<p>${html}</p>` : html, "")
    .then((resolved) => {
      if (seq !== loadSeq || !range || !editor.contains(range.startContainer)) return;
      editor.focus({ preventScroll: true });
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      insertMarkdownBlocks(sanitizeHtml(resolved));
      normalizeTopLevel();
      changed();
    })
    .catch((err) => console.error("markdown paste failed", err));
}

function handlePaste(e) {
  const plain = plainPaste;
  plainPaste = false;
  if (codeBlockOf(e.target)) return; // the code editor's textarea pastes plain text natively
  e.preventDefault();
  if (editor.contentEditable !== "true") return;
  const html = plain ? "" : e.clipboardData.getData("text/html");
  const text = e.clipboardData.getData("text/plain");
  const images = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
  const range = selectionRange()?.cloneRange();

  // Markdown copied as text (editor, terminal, .md file): converted to formatting.
  const md = !plain && text && !closestInEditor("pre,td,th") && (!html || isUnformattedHtml(html)) && markdownKind(text);
  if (md) {
    sealHistory();
    pasteMarkdown(text, md, range);
    normalizeTopLevel();
    changed();
    return;
  }

  // Screenshots / "Copy image": the file wins unless the HTML also carries text.
  if (images.length && range && !htmlHasText(html)) {
    insertLater(range, loadSeq, async () => {
      const stored = await Promise.all(images.map(storeImageBlob));
      return stored.map((img) => imageHtml(img.src, img.width, img.height)).join("");
    });
    return;
  }
  if (html) {
    const clean = sanitizeHtml(html);
    if (clean.includes("data:image/") && range) {
      insertLater(range, loadSeq, () => storeDataImages(clean));
      return;
    }
    if (/<pre data-lang=/.test(clean)) insertBlocks(clean);
    else exec("insertHTML", clean);
  } else if (text) {
    if (closestInEditor("pre,td,th") || !text.includes("\n")) {
      exec("insertText", text);
    } else {
      const paragraphs = text.split(/\r?\n/).map((l) => (l ? `<p>${escapeHtml(l)}</p>` : "<p><br></p>"));
      exec("insertHTML", paragraphs.join(""));
    }
  }
  normalizeTopLevel();
  changed();
}

// ---------- Selection state (toolbar highlighting) ----------

export function getSelectionState() {
  if (!selectionRange()) return null;
  const block = currentBlock();
  const list = closestInEditor("ul,ol");
  const tag = block?.tagName;
  const style = { H1: "title", H2: "heading", H3: "subheading", PRE: "mono" }[tag] || "body";
  return {
    style,
    list: list ? listKind(list) : null,
    quote: !!closestInEditor("blockquote"),
    table: !!closestInEditor("table"),
    // Headings are bold by style; only explicit <b>/<strong> counts as "Bold".
    bold: !!closestInEditor("b,strong"),
    italic: document.queryCommandState("italic"),
    underline: document.queryCommandState("underline"),
    strike: document.queryCommandState("strikeThrough"),
    code: !!closestInEditor("code"),
  };
}

function emitSelectionState() {
  onSelectionState(getSelectionState());
}

// ---------- Public API ----------

/** Runs a toolbar command ("title", "bullet", "check", "table", "bold"...). */
export function runCommand(cmd) {
  if (editor.contentEditable !== "true") return;
  if (!selectionRange()) {
    editor.focus();
    placeCaret(editor.lastElementChild || editor, true);
  }
  switch (cmd) {
    case "title":
    case "heading":
    case "subheading":
    case "body":
    case "mono":
      setBlockStyle(cmd);
      break;
    case "quote":
      toggleQuote();
      return;
    case "bullet":
    case "dash":
    case "number":
    case "check":
      applyList(cmd);
      return;
    case "table":
      insertTable();
      return;
    case "code":
      insertCodeBlock();
      return;
    case "mermaid":
      insertCodeBlock("mermaid");
      return;
    case "image":
      changed(); // the "/" menu already removed its text: save that even if the picker is cancelled
      pickImages();
      return;
    case "inline-code":
      toggleInlineCode();
      return;
    case "link":
      insertNoteLink();
      return;
    case "clear":
      exec("removeFormat");
      editor.querySelectorAll("code").forEach((c) => window.getSelection().containsNode(c, true) && c.replaceWith(...c.childNodes));
      break;
    case "bold":
    case "italic":
    case "underline":
      exec(cmd);
      break;
    case "strike":
      exec("strikeThrough");
      break;
    case "indent":
    case "outdent":
      exec(cmd);
      break;
    default:
      if (cmd.startsWith("tbl:")) return tableAction(cmd.slice(4));
      return;
  }
  changed();
}

/**
 * key identifies the note so its undo history survives switching notes.
 * Returns the HTML when opening it updated note links (renamed/new targets), else null.
 */
export function loadEditor(html, { readOnly = false, focus = false, key = null } = {}) {
  loadSeq++;
  lastTyped = "";
  menus.close();
  peek?.hide();
  editor.contentEditable = readOnly ? "false" : "true";
  const linksChanged = setEditorHtml(html || "<h1><br></h1>");
  const current = editorHtml();
  openHistory(readOnly ? null : key, current);
  tableTools.hidden = true;
  scroller.scrollTop = 0;
  if (focus && !readOnly) {
    editor.focus();
    placeCaret(editor.lastElementChild || editor, true);
  }
  return linksChanged && !readOnly ? current : null;
}

export function focusEditorEnd() {
  if (editor.contentEditable !== "true") return;
  editor.focus();
  placeCaret(editor.lastElementChild || editor, true);
}

export function initEditor({ onInput, onSelection }) {
  onChange = onInput;
  onSelectionState = onSelection;

  exec("defaultParagraphSeparator", "p");
  exec("styleWithCSS", false);

  initCodeBlocks({
    changed: () => changed(),
    exit: exitCodeBlock,
    remove: removeCodeBlock,
    readOnly: () => editor.contentEditable !== "true",
  });
  menus = initNoteMenus({
    editor,
    scroller,
    runCommand,
    getSelectionState,
    selectionRange,
    editable: () => editor.contentEditable === "true",
    inserted: () => {
      sealHistory();
      changed();
    },
  });
  peek = initLinkPeek(editor, scroller);
  scroller.addEventListener("mousedown", handleClickBelow);

  // Note links are atomic chips: a click opens the note (also in read-only notes).
  editor.addEventListener("mousedown", (e) => {
    if (e.button === 0 && e.target.closest?.("a.nt-link")) e.preventDefault();
  });
  editor.addEventListener("click", (e) => {
    const a = e.target.closest?.("a.nt-link");
    if (!a || !editor.contains(a)) return;
    e.preventDefault();
    followLink(a, () => editor.contentEditable === "true" && changed());
  });

  editor.addEventListener("input", (e) => {
    normalizeTopLevel();
    const type = e.inputType || "";
    if (type === "insertText" || type === "insertCompositionText") {
      if (!codeBlockOf(e.target)) dropTypedZwsp();
      // A new word starts a new undo step (the space stays with the previous word).
      const wordStart = /\S/.test(e.data || "") && /\s$/.test(lastTyped);
      lastTyped = e.data || "";
      changed("type", wordStart);
      // **bold** etc.: the raw text stays one undo step behind the formatted one.
      // While composing (dead keys on Linux) the DOM must not change: see compositionend.
      if (!e.isComposing && !codeBlockOf(e.target) && (tryInlineMarkdown(e.data) || tryWikiLink(e.data))) {
        sealHistory();
        changed();
      }
      menus.onInput(e);
      return;
    }
    lastTyped = "";
    changed(/^delete(Content|Word|SoftLine|HardLine)/.test(type) ? "delete" : "cmd");
  });
  editor.addEventListener("compositionend", (e) => {
    if (editor.contentEditable !== "true" || codeBlockOf(e.target)) return;
    if (tryInlineMarkdown(e.data)) {
      sealHistory();
      changed();
    }
  });
  // Undo/Redo from the context menu.
  editor.addEventListener("beforeinput", (e) => {
    if (codeBlockOf(e.target)) return; // the code editor keeps its native undo
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      applyHistory(e.inputType === "historyUndo" ? -1 : 1);
    }
  });
  editor.addEventListener("mousedown", sealHistory);
  editor.addEventListener("keydown", handleKeydown);
  editor.addEventListener("paste", handlePaste);
  editor.addEventListener("copy", handleCopy);
  editor.addEventListener("cut", handleCopy);
  editor.addEventListener("mousedown", handleChecklistClick);
  editor.addEventListener("drop", (e) => e.preventDefault());

  document.addEventListener("selectionchange", () => {
    if (!selectionRange()) return;
    recordSelection(serializeSelection);
    updateTableTools();
    emitSelectionState();
  });
  scroller.addEventListener("scroll", updateTableTools);
  window.addEventListener("resize", updateTableTools);

  // Table toolbar buttons must not steal the caret from the cell.
  tableTools.addEventListener("mousedown", (e) => e.preventDefault());
  tableTools.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tbl]");
    if (btn) tableAction(btn.dataset.tbl);
  });
}

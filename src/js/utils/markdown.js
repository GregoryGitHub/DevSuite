import { escapeHtml } from "./noteContent.js";
import { normalizeCodeLang } from "./highlight.js";
import { linkHtml, splitLinkText, splitFrontMatter } from "./zettel.js";

// Markdown <-> note HTML (the subset the note editor produces, see noteContent.js).
// Export: h1-h3, p, b/i/s/u, code, pre, blockquote, lists (bullet/numbered/checklist,
// nested), GFM tables and images. Import: CommonMark/GFM blocks plus inline emphasis,
// code, links and images; each source line becomes its own paragraph, like in the editor.

// ======================= HTML -> Markdown =======================

const BLOCK_EL = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "DIV", "PRE", "BLOCKQUOTE", "UL", "OL", "TABLE", "LI"]);

function escapeText(text) {
  return text
    .replace(/ /g, " ")
    .replace(/[\\`*[\]<]/g, "\\$&")
    .replace(/~~/g, "\\~\\~")
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace("_", "\\_"));
}

/** Escapes what would turn a paragraph line into another block (heading, list, quote). */
function escapeLineStart(line) {
  return line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s|=+\s*$|-{3,}\s*$)/, (m, sp, mark) => {
    if (/^\d/.test(mark)) return sp + mark.replace(/([.)])/, "\\$1");
    return `${sp}\\${mark}`;
  });
}

function wrapMark(inner, mark, close = mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? `${m[1]}${mark}${m[2]}${close}${m[3]}` : inner;
}

function codeSpan(text) {
  const runs = text.match(/`+/g) || [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function destination(src) {
  return /[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, encodeURIComponent)}>` : src;
}

/** Inline Markdown of a node's children. Block children become separate lines. */
function inline(node, ctx) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeText(child.textContent);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName;
    if (BLOCK_EL.has(tag) && out && !out.endsWith("\n")) out += "\n";
    switch (tag) {
      case "BR":
        out += "\n";
        break;
      case "B":
      case "STRONG":
        out += wrapMark(inline(child, ctx), "**");
        break;
      case "I":
      case "EM":
        out += wrapMark(inline(child, ctx), "*");
        break;
      case "S":
      case "STRIKE":
      case "DEL":
        out += wrapMark(inline(child, ctx), "~~");
        break;
      case "U":
        out += wrapMark(inline(child, ctx), "<u>", "</u>");
        break;
      case "CODE":
        out += codeSpan(child.textContent);
        break;
      case "A":
        if (child.classList.contains("nt-link")) {
          const clean = (t) => t.replace(/[[\]|]/g, "").trim();
          const title = clean(ctx.linkTitle(child) || child.getAttribute("data-target") || child.textContent);
          const alias = child.hasAttribute("data-alias") ? clean(child.textContent) : "";
          out += alias && alias !== title ? `[[${title}|${alias}]]` : `[[${title}]]`;
        } else out += inline(child, ctx);
        break;
      case "IMG": {
        const src = ctx.imageSrc(child.getAttribute("src") || "");
        if (src) out += `![${escapeText(child.getAttribute("alt") || "")}](${destination(src)})`;
        break;
      }
      default:
        out += inline(child, ctx);
    }
    if (BLOCK_EL.has(tag) && !out.endsWith("\n")) out += "\n";
  }
  return out;
}

function inlineLines(node, ctx) {
  return inline(node, ctx)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
}

/** Leading spaces/tabs would turn the line into a code block: keep them as NBSP. */
function keepIndent(line) {
  return line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    ").replace(/ /g, "\u00a0"));
}

/** A paragraph: line breaks become Markdown hard breaks. */
function paragraph(node, ctx) {
  const lines = inlineLines(node, ctx);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return null;
  return lines.map((l) => escapeLineStart(keepIndent(l))).join("  \n");
}

function listMarkdown(list, indent, ctx) {
  const ordered = list.tagName === "OL";
  const check = list.classList.contains("checklist");
  const pad = " ".repeat(indent);
  const lines = [];
  let n = 1;
  let lastWidth = 2;
  for (const child of list.children) {
    if (child.tagName === "UL" || child.tagName === "OL") {
      // Chrome nests indented lists directly inside the list.
      lines.push(listMarkdown(child, indent + lastWidth, ctx));
      continue;
    }
    if (child.tagName !== "LI") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    lastWidth = marker.length;
    const task = check ? `[${child.classList.contains("checked") ? "x" : " "}] ` : "";
    const nested = [];
    const own = document.createElement("div");
    for (const node of child.childNodes) {
      if (node.nodeName === "UL" || node.nodeName === "OL") nested.push(node);
      else own.appendChild(node.cloneNode(true));
    }
    const text = inlineLines(own, ctx).filter((l) => l.trim());
    const cont = "\n" + pad + " ".repeat(marker.length);
    lines.push(pad + marker + task + text.join("  " + cont));
    for (const sub of nested) lines.push(listMarkdown(sub, indent + marker.length, ctx));
  }
  return lines.join("\n");
}

function tableMarkdown(table, ctx) {
  const rows = [...table.rows].map((r) =>
    [...r.cells].map((c) =>
      inlineLines(c, ctx)
        .filter((l) => l.trim())
        .join("<br>")
        .replace(/\|/g, "\\|")
        .trim(),
    ),
  );
  if (!rows.length) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (cells) => `| ${Array.from({ length: cols }, (_, i) => cells[i] || "").join(" | ")} |`;
  return [line(rows[0]), line(Array(cols).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

function preMarkdown(pre) {
  const text = pre.textContent.replace(/\n$/, "");
  const runs = text.match(/^(`{3,}|~{3,})/gm) || [];
  const fence = "`".repeat(Math.max(2, ...runs.map((r) => r.length)) + 1);
  const lang = pre.dataset.lang && pre.dataset.lang !== "text" ? pre.dataset.lang : "";
  return `${fence}${lang}\n${text}\n${fence}`;
}

function blocks(parent, ctx) {
  const out = [];
  let run = document.createElement("p");
  const flush = () => {
    if (!run.childNodes.length) return;
    const p = paragraph(run, ctx);
    if (p) out.push(p);
    run = document.createElement("p");
  };
  for (const node of parent.childNodes) {
    const tag = node.nodeType === Node.ELEMENT_NODE ? node.tagName : null;
    if (!tag || !BLOCK_EL.has(tag)) {
      run.appendChild(node.cloneNode(true));
      continue;
    }
    flush();
    let md = null;
    if (/^H[1-6]$/.test(tag)) {
      const text = inlineLines(node, ctx).filter((l) => l.trim()).join(" ");
      if (text) md = `${"#".repeat(Math.min(3, Number(tag[1])))} ${text}`;
    } else if (tag === "PRE") {
      md = preMarkdown(node);
    } else if (tag === "BLOCKQUOTE") {
      const inner = blocks(node, ctx);
      if (inner) md = inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    } else if (tag === "UL" || tag === "OL") {
      md = listMarkdown(node, 0, ctx);
    } else if (tag === "TABLE") {
      md = tableMarkdown(node, ctx);
    } else if ([...node.children].some((c) => BLOCK_EL.has(c.tagName))) {
      md = blocks(node, ctx);
    } else {
      md = paragraph(node, ctx);
    }
    if (md) out.push(md);
  }
  flush();
  return out.join("\n\n");
}

/**
 * Converts note HTML to Markdown.
 * imageSrc maps each <img> src to the path written in the Markdown ("" drops the image).
 * linkTitle gives the current title of a note link (<a class="nt-link">), written as [[Title]].
 */
export function htmlToMarkdown(html, { imageSrc = (src) => src, linkTitle = () => "" } = {}) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return blocks(tpl.content, { imageSrc, linkTitle }).trim() + "\n";
}

// ======================= Markdown -> HTML =======================

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+(.*))?$/;
const TABLE_SEP_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const RAW_INLINE_RE = /<\/?(?:u|b|i|s|strong|em|del|strike|br)\s*\/?>/gi;

function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

function stripIndent(line, count) {
  let i = 0;
  let n = 0;
  while (i < line.length && n < count && (line[i] === " " || line[i] === "\t")) {
    n += line[i] === "\t" ? 4 - (n % 4) : 1;
    i++;
  }
  return line.slice(i);
}

function unwrapDestination(dest) {
  const d = dest.trim();
  return d.startsWith("<") && d.endsWith(">") ? d.slice(1, -1) : d;
}

const EMBED_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** Inline Markdown -> HTML. */
export function inlineMarkdown(text) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = text
    // Code spans first: nothing inside them is Markdown.
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHtml(code.replace(/^ (.*) $/, "$1"))}</code>`))
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, ch) => hold(escapeHtml(ch)))
    // Obsidian embeds: ![[image.png|300]] is an image (path resolved by the importer);
    // ![[Note]] embeds a note, kept as a link to it.
    .replace(/!\[\[([^[\]\n|]+?)(?:\|([^[\]\n]*))?\]\]/g, (m, target, label) => {
      const t = target.trim();
      if (EMBED_IMAGE_RE.test(t)) return hold(`<img src="${escapeHtml(t)}" alt="">`);
      const { title, alias } = splitLinkText(label ? `${t}|${label}` : t);
      return title ? hold(linkHtml(title, alias)) : m;
    })
    // Links between notes: [[Title]] / [[Title|label]] (the caller resolves titles to ids).
    .replace(/\[\[([^[\]\n]+)\]\]/g, (m, inner) => {
      const { title, alias } = splitLinkText(inner);
      return title ? hold(linkHtml(title, alias)) : m;
    })
    // Spaces in unbracketed paths aren't CommonMark, but Obsidian/Typora write them.
    .replace(/!\[([^\]]*)\]\(\s*(<[^>]*>|[^)]+?)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, (_, alt, dest) =>
      hold(`<img src="${escapeHtml(unwrapDestination(dest))}" alt="${escapeHtml(alt)}">`),
    )
    // The editor has no links: keep the label and the address.
    .replace(/\[([^\]]+)\]\(\s*(<[^>]*>|[^)]+?)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, (_, label, dest) => {
      const url = unwrapDestination(dest);
      return label.trim() === url ? hold(escapeHtml(url)) : `${label} (${hold(escapeHtml(url))})`;
    })
    .replace(/<((?:https?|mailto):[^\s>]+)>/g, (_, url) => hold(escapeHtml(url)))
    .replace(RAW_INLINE_RE, (tag) => hold(tag));

  // Like escapeHtml, but entities already in the source (&amp; &#169;) stay entities.
  s = s
    .replace(/&(?![a-z][a-z0-9]*;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<b>$2</b>")
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "<i>$1</i>")
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>");

  // Placeholders may nest (e.g. code inside a link label).
  while (s.includes("\u0000")) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
  return s;
}

function lineParagraph(line) {
  // Only ASCII whitespace: leading NBSPs are indentation kept by the export.
  const text = line.replace(/^[ \t]+|[ \t]+$/g, "").replace(/\\$/, "");
  return text ? `<p>${inlineMarkdown(text)}</p>` : "";
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((c) => c.trim());
}

function isBlockStart(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
  );
}

function parseList(lines, start) {
  const first = LIST_RE.exec(lines[start]);
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  let item = null;

  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_RE.exec(line);
    if (m && indentOf(m[1]) === baseIndent && /\d/.test(m[2]) === ordered) {
      item = { text: m[4] || "", lines: [], indent: baseIndent + m[2].length + (m[3] ? Math.min(4, m[3].length - (m[4] || "").length) : 1) };
      items.push(item);
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the list unless more of it follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const next = LIST_RE.exec(lines[j]);
      const continues = indentOf(lines[j]) > baseIndent || (next && indentOf(next[1]) === baseIndent && /\d/.test(next[2]) === ordered);
      if (!continues) break;
      i = j;
      continue;
    }
    if (item && indentOf(line) > baseIndent) {
      item.lines.push(stripIndent(line, item.indent));
      i++;
      continue;
    }
    if (item && !isBlockStart(lines, i) && !item.lines.length) {
      item.text += " " + line.trim(); // lazy continuation
      i++;
      continue;
    }
    break;
  }

  const tasks = items.map((it) => /^\[([ xX])\][ \t]+/.exec(it.text));
  const isChecklist = !ordered && tasks.some(Boolean);
  const tag = ordered ? "ol" : "ul";
  const html = items
    .map((it, k) => {
      const task = tasks[k];
      const text = task ? it.text.slice(task[0].length) : it.text;
      const cls = isChecklist && task && task[1].toLowerCase() === "x" ? ' class="checked"' : "";
      const body = text.trim() ? inlineMarkdown(text.trim()) : "<br>";
      return `<li${cls}>${body}${it.lines.length ? parseBlocks(it.lines) : ""}</li>`;
    })
    .join("");
  return { html: `<${tag}${isChecklist ? ' class="checklist"' : ""}>${html}</${tag}>`, next: i };
}

function parseBlocks(lines) {
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const mark = fence[1];
      const indent = indentOf(line);
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`).test(lines[i])) {
        code.push(stripIndent(lines[i], indent));
        i++;
      }
      i++;
      // Fenced code = code block of the editor (language from the info string).
      const lang = normalizeCodeLang(fence[2].trim().split(/\s+/)[0]);
      out += `<pre data-lang="${escapeHtml(lang)}">${escapeHtml(code.join("\n"))}</pre>`;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      out += `<h${level}>${inlineMarkdown(heading[2] || "") || "<br>"}</h${level}>`;
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out += "<p><br></p>";
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && lines[i].trim()) {
        const q = QUOTE_RE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (inner.length && !isBlockStart(lines, i)) inner.push(lines[i]);
        else break;
        i++;
      }
      out += `<blockquote>${parseBlocks(inner)}</blockquote>`;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cols = head.length;
      const cell = (tag, text) => `<${tag}>${text ? inlineMarkdown(text) : "<br>"}</${tag}>`;
      const tr = (cells, tag) => `<tr>${Array.from({ length: cols }, (_, k) => cell(tag, cells[k] || "")).join("")}</tr>`;
      out += `<table class="nt-table"><tbody>${tr(head, "th")}${rows.map((r) => tr(r, "td")).join("")}</tbody></table>`;
      continue;
    }

    if (LIST_RE.test(line) && LIST_RE.exec(line)[4] !== undefined) {
      const list = parseList(lines, i);
      out += list.html;
      i = list.next;
      continue;
    }

    // Setext heading: a line followed by === or ---.
    if (i + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1]) && !isBlockStart(lines, i)) {
      const level = lines[i + 1].trim()[0] === "=" ? 1 : 2;
      out += `<h${level}>${inlineMarkdown(line.trim())}</h${level}>`;
      i += 2;
      continue;
    }

    // Paragraph: one editor line per source line.
    out += lineParagraph(line);
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
      out += lineParagraph(lines[i]);
      i++;
    }
  }
  return out;
}

const MD_BLOCK_HINTS = [
  /^ {0,3}#{1,6}[ \t]+\S/, // heading
  /^ {0,3}(`{3,}|~{3,})/, // fence
  /^ {0,3}> ?\S/, // quote
  /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]/, // task list
  TABLE_SEP_RE,
];
const MD_LIST_HINT = /^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+\S/;
const MD_INLINE_HINT = /\[\[[^[\]\n]+\]\]|`[^`\n]+`|\*\*\S(?:[^*\n]*\S)?\*\*|~~\S(?:[^~\n]*\S)?~~|!?\[[^\]\n]+\]\([^)\s]+\)/;

/**
 * Pasted plain text that is worth converting from Markdown: "block" (headings, fences, quotes,
 * tables, lists) | "inline" (one line with `code`, **bold**, ~~strike~~ or links) | null.
 * Plain prose (and a lone "*" or "_") stays as text.
 */
export function markdownKind(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const filled = lines.filter((l) => l.trim());
  if (!filled.length) return null;
  if (filled.length > 1) {
    if (lines.some((l) => MD_BLOCK_HINTS.some((re) => re.test(l)))) return "block";
    if (filled.filter((l) => MD_LIST_HINT.test(l)).length >= 2) return "block";
  }
  return MD_INLINE_HINT.test(text) ? (filled.length > 1 ? "block" : "inline") : null;
}

/** Converts Markdown to (unsanitized) note HTML. Image src values are left as written. */
export function markdownToHtml(md) {
  // Front matter (YAML) is metadata, not content (see splitFrontMatter / yamlToProps).
  return parseBlocks(splitFrontMatter(md).body.split("\n"));
}

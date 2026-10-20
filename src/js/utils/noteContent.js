// Helpers for the rich-text HTML stored in each note.

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const HTML_START = /^\s*<(h[1-6]|p|div|ul|ol|table|pre|blockquote|br)[\s>/]/i;

// Tags kept on paste; any other element is replaced by its content.
const ALLOWED_TAGS = new Set([
  "H1", "H2", "H3", "P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE",
  "UL", "OL", "LI", "PRE", "CODE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "IMG",
]);
const DROP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "HEAD", "IFRAME", "OBJECT", "SVG", "VIDEO", "AUDIO", "CANVAS", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "TEMPLATE"]);
const HEADING_MAP = { H4: "H3", H5: "H3", H6: "H3" };
const LEAF_BLOCKS = "h1,h2,h3,p,li,pre,td,th,div,blockquote";

// ---------- Images ----------
// Images are files kept by the Rust side (src-tauri/src/note_images.rs) and served by the
// "noteimg" protocol; the note HTML only stores the URL, so notes.json stays small.
// WebView2 (Windows) exposes custom protocols as http://<scheme>.localhost/.

const IMG_BASE = /Windows|Android/i.test(navigator.userAgent) ? "http://noteimg.localhost/" : "noteimg://localhost/";
const IMG_URL_RE = /(?:noteimg:\/\/localhost\/|http:\/\/noteimg\.localhost\/)([a-z0-9]+\.[a-z0-9]+)/gi;

export function noteImageUrl(name) {
  return IMG_BASE + name;
}

// Notes in a vault (notes_vault.rs): any file of the vault is served as
// noteimg://localhost/v/<relative path, URL-encoded per segment>.
const VAULT_URL_RE = /^(?:noteimg:\/\/localhost\/|http:\/\/noteimg\.localhost\/)v\/(.+)$/i;

export function vaultImageUrl(rel) {
  return `${IMG_BASE}v/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** Vault-relative path of a vault image URL, or null. */
export function vaultImageRel(src) {
  const m = VAULT_URL_RE.exec(src || "");
  if (!m) return null;
  try {
    return m[1].split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

/** File name of an image stored by the app, or null for remote/data URLs. */
export function localImageName(src) {
  const m = /^(?:noteimg:\/\/localhost\/|http:\/\/noteimg\.localhost\/)([a-z0-9]+\.[a-z0-9]+)$/i.exec(src || "");
  return m ? m[1] : null;
}

/** Names of all stored images referenced by a note's HTML. */
export function noteImageNames(html) {
  if (!html.includes("noteimg")) return [];
  return [...html.matchAll(IMG_URL_RE)].map((m) => m[1]);
}

function isAllowedImageSrc(src) {
  return !!localImageName(src) || !!vaultImageRel(src) || /^https?:\/\//i.test(src) || /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,/i.test(src);
}

/** HTML for an image; width/height keep the layout stable while the file loads. */
export function imageHtml(src, width = 0, height = 0, alt = "") {
  const size = width > 0 && height > 0 ? ` width="${Math.round(width)}" height="${Math.round(height)}"` : "";
  return `<img src="${escapeHtml(src)}"${size}${alt ? ` alt="${escapeHtml(alt)}"` : ""} loading="lazy" decoding="async">`;
}

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Converts a pre-rich-text note (separate title + plain text) to HTML. */
function legacyToHtml(title, content) {
  const lines = (content || "").split(/\r?\n/);
  const body = lines.map((l) => (l.trim() ? `<p>${escapeHtml(l)}</p>` : "<p><br></p>")).join("");
  return `<h1>${title ? escapeHtml(title) : "<br>"}</h1>${content ? body : ""}`;
}

/** Notes copied from another OS carry the other WebView's image URL form. */
export function normalizeNoteHtml(html) {
  return html.includes("noteimg") ? html.replace(IMG_URL_RE, (_, name) => IMG_BASE + name) : html;
}

/** Fills in fields added after v0.2 and migrates plain-text notes (notes.json import). */
export function normalizeNote(n) {
  const content = n.content || "";
  const isHtml = HTML_START.test(content);
  const html = isHtml ? normalizeNoteHtml(content) : content;
  const ts = Number.isFinite(n.updated_at) && n.updated_at > 0 ? n.updated_at : Math.floor(Number(n.id)) || Date.now();
  return {
    id: Math.floor(Number(n.id)) || Date.now(),
    title: n.title || "",
    content: isHtml ? html : legacyToHtml(n.title === "Sem título" ? "" : n.title, content),
    created_at: n.created_at || new Date(ts).toISOString(),
    updated_at: Math.floor(ts),
    pinned: !!n.pinned,
    folder_id: Math.floor(Number(n.folder_id)) || 0,
    deleted_at: n.deleted_at ? Math.floor(n.deleted_at) : null,
  };
}

/** Drops notes that have been in "Recently Deleted" for more than 30 days. */
export function purgeExpiredTrash(notes) {
  const limit = Date.now() - TRASH_RETENTION_MS;
  return notes.filter((n) => !n.deleted_at || n.deleted_at > limit);
}

const linesCache = new Map();

/** Non-empty text lines of a note, in document order (first = title). */
export function noteLines(html) {
  if (linesCache.has(html)) return linesCache.get(html);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const lines = [];
  for (const node of tpl.content.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent.trim()) lines.push(node.textContent.trim());
    }
  }
  for (const el of tpl.content.querySelectorAll(LEAF_BLOCKS)) {
    if (el.querySelector(LEAF_BLOCKS)) continue;
    for (const line of el.textContent.split("\n")) {
      const t = line.replace(/\s+/g, " ").trim();
      if (t) lines.push(t);
    }
  }
  if (linesCache.size > 500) linesCache.clear();
  linesCache.set(html, lines);
  return lines;
}

export function noteTitle(note) {
  return noteLines(note.content)[0] || "Nova Nota";
}

export function notePreview(note) {
  const lines = noteLines(note.content);
  return lines.slice(1).join(" ") || "Nenhum texto adicional";
}

export function noteHasTable(html) {
  return /<table[\s>]/i.test(html);
}

export function noteIsEmpty(note) {
  return noteLines(note.content).length === 0 && !noteHasTable(note.content) && !/<img[\s>]/i.test(note.content);
}

export function noteMatches(note, query) {
  const q = query.toLowerCase();
  return noteLines(note.content).some((l) => l.toLowerCase().includes(q));
}

function cleanNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    if (DROP_TAGS.has(child.tagName)) {
      child.remove();
      continue;
    }

    // Language of a pasted code block (ours: data-lang; web pages: class="language-x").
    const lang =
      child.tagName === "PRE"
        ? (child.getAttribute("data-lang") ?? /\b(?:language|lang)-([\w+#.-]+)/.exec(`${child.className} ${child.querySelector("code")?.className || ""}`)?.[1] ?? null)
        : null;

    cleanNode(child);

    let el = child;
    const mapped = HEADING_MAP[el.tagName];
    if (mapped) {
      const repl = document.createElement(mapped);
      repl.append(...el.childNodes);
      el.replaceWith(repl);
      el = repl;
    }

    // Link entre notas ([[ ]]): só os atributos do link, texto puro dentro.
    if (el.tagName === "A" && el.classList.contains("nt-link")) {
      const id = el.getAttribute("data-note");
      const target = el.getAttribute("data-target");
      const alias = el.hasAttribute("data-alias");
      const text = el.textContent;
      for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
      el.className = "nt-link";
      el.setAttribute("contenteditable", "false");
      if (id && /^\d+$/.test(id)) el.setAttribute("data-note", id);
      else if (target?.trim()) el.setAttribute("data-target", target.trim());
      else {
        el.replaceWith(text);
        continue;
      }
      if (alias) el.setAttribute("data-alias", "");
      el.textContent = text;
      continue;
    }

    if (!ALLOWED_TAGS.has(el.tagName)) {
      el.replaceWith(...el.childNodes);
      continue;
    }

    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") || "";
      if (!isAllowedImageSrc(src)) {
        el.remove();
        continue;
      }
      const tpl = document.createElement("template");
      tpl.innerHTML = imageHtml(src, +el.getAttribute("width") || 0, +el.getAttribute("height") || 0, el.getAttribute("alt") || "");
      el.replaceWith(tpl.content);
      continue;
    }

    const keepClass =
      (el.tagName === "UL" && ["checklist", "dashed"].find((c) => el.classList.contains(c))) ||
      (el.tagName === "LI" && el.classList.contains("checked") && "checked") ||
      (el.tagName === "TABLE" && "nt-table");
    for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
    if (keepClass) el.className = keepClass;
    if (lang !== null && /^[\w+#.-]{0,24}$/.test(lang)) el.setAttribute("data-lang", lang.toLowerCase() || "text");
  }
}

/** Sanitizes pasted HTML down to the formatting the editor supports. */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  cleanNode(doc.body);
  return doc.body.innerHTML;
}

// Importação de uma pasta de Markdown (vault do Obsidian, repositório de docs...), sem DOM.
// A pasta vem de `notes_scan_dir`: { name, notes: [{ rel, path, text, modified }], files: [{ rel, path }] },
// com `rel` relativo à pasta escolhida e separado por "/".

import { fold } from "./zettel.js";

const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Como safeFileName (notes.js): o export tira do nome os caracteres proibidos em arquivos.
const fileSafe = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * O nome do arquivo é o título da nota: se o 1º bloco já é um título com esse texto, ele vira
 * a linha de título (h1); senão o nome entra como h1 acima do conteúdo (o "### Seção" do
 * início continua como seção).
 */
export function applyFileTitle(html, stem) {
  const heading = /^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i.exec(html);
  if (heading) {
    const text = heading[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    if (fold(text) === fold(stem) || fold(fileSafe(text)) === fold(stem)) return `<h1>${heading[2]}</h1>${html.slice(heading[0].length)}`;
  }
  return `<h1>${escapeHtml(stem)}</h1>${html}`;
}

/** Pastas do arquivo: "a/b/nota.md" -> ["a", "b"]. */
export function relDirs(rel) {
  return rel.split("/").slice(0, -1).filter(Boolean);
}

/** Nome do arquivo sem extensão: "a/b/nota.md" -> "nota". */
export function relStem(rel) {
  const file = rel.split("/").pop() || rel;
  return file.replace(/\.[^.]+$/, "") || file;
}

/** Junta `dir` (relativo, "/") e `path`, resolvendo "." e ".."; null se sair da raiz. */
export function joinRel(dir, path) {
  const out = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of path.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const lower = (s) => s.toLowerCase();

/** Índices da pasta: arquivos por caminho e por nome; notas por caminho (sem extensão) e por nome. */
export function vaultIndex(scan) {
  const files = new Map();
  const byName = new Map();
  for (const f of scan.files || []) {
    files.set(lower(f.rel), f.path);
    const name = lower(f.rel.split("/").pop());
    // Como o Obsidian: com nomes repetidos, vale o de caminho mais curto.
    const prev = byName.get(name);
    if (!prev || f.rel.length < prev.rel.length) byName.set(name, f);
  }
  const notePaths = new Set();
  const noteStems = new Set();
  for (const n of scan.notes || []) {
    notePaths.add(lower(n.rel.replace(MD_EXT_RE, "")));
    noteStems.add(lower(relStem(n.rel)));
  }
  return { files, byName, notePaths, noteStems };
}

/**
 * Resolve o `src` de uma imagem da nota `noteRel` para um arquivo da pasta: relativo à
 * nota, relativo à raiz ou só pelo nome (`![[x.png]]`). null = deixa o importador tentar.
 */
export function vaultImageLookup(index, noteRel) {
  const dir = relDirs(noteRel).join("/");
  return (src) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(src) || /^[a-z]:[\\/]/i.test(src)) return null; // URL ou absoluto
    let path = src.split(/[?#]/)[0];
    try {
      path = decodeURI(path);
    } catch {}
    for (const rel of [joinRel(dir, path), joinRel("", path)]) {
      const hit = rel && index.files.get(lower(rel));
      if (hit) return hit;
    }
    return index.byName.get(lower(path.split(/[\\/]/).pop()))?.path || null;
  };
}

/**
 * Links do Obsidian para o formato das notas: `[[pasta/Nota.md#Seção|texto]]` vira
 * `[[Nota|texto]]` quando "pasta/Nota" é uma nota da pasta importada (o título "CI/CD" fica
 * como está); `.md` sai e `[[#Seção]]` (link para a própria nota) vira texto. Imagens
 * (`![[x.png]]`) não mudam.
 */
export function normalizeVaultLinks(md, index) {
  return md.replace(/(!?)\[\[([^[\]\n|]*?)(\|[^[\]\n]*)?\]\]/g, (m, bang, target, label = "") => {
    let t = target.trim();
    if (bang && /\.[a-z0-9]{2,5}$/i.test(t) && !MD_EXT_RE.test(t)) return m; // imagem/anexo
    if (t.startsWith("#") || t.startsWith("^")) return label ? label.slice(1) : t.replace(/^[#^]+/, "");
    const hash = t.search(/#|\^/);
    if (hash > 0) {
      const base = t.slice(0, hash).trim();
      if (isKnown(index, base)) t = base;
    }
    t = t.replace(MD_EXT_RE, "");
    if (t.includes("/") && index.notePaths.has(lower(t.replace(/^\.?\//, "")))) t = t.split("/").pop();
    return `${bang}[[${t}${label}]]`;
  });
}

function isKnown(index, target) {
  const t = lower(target.replace(MD_EXT_RE, ""));
  return index.noteStems.has(t) || index.notePaths.has(t.replace(/^\.?\//, ""));
}

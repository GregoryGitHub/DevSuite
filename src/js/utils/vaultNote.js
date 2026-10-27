// Notas num cofre (pasta de Markdown, como o Obsidian; src-tauri/src/notes_vault.rs):
// HTML da nota <-> arquivo .md. O Rust só lê e grava texto; a conversão é a mesma da
// importação/exportação de Markdown.
//
// Formato: o nome do arquivo é o título (a 1ª linha não se repete no corpo quando o nome
// consegue representá-la), front-matter YAML (propsToYaml, sempre com `created:`), links
// [[Título]] e imagens por caminho relativo à nota (as coladas ficam em attachments/).

import { htmlToMarkdown, markdownToHtml } from "./markdown.js";
import { applyFileTitle, joinRel, relDirs, relStem, vaultIndex, vaultImageLookup, normalizeVaultLinks } from "./mdImport.js";
import { propsToYaml, splitFrontMatter, parseFrontMatter, propsEmpty } from "./zettel.js";
import { folderChain } from "./folderTree.js";
import { localImageName, vaultImageRel, vaultImageUrl, sanitizeHtml } from "./noteContent.js";

export const ATTACHMENTS_DIR = "attachments";
export const TRASH_DIR = ".trash";

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Nome de arquivo/pasta seguro (igual a `safe_name` do notes_vault.rs). */
export function safeName(name, fallback) {
  let s = String(name ?? "")
    .replace(/\s/g, " ")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  s = [...s].slice(0, 80).join("").replace(/[. ]+$/, "").replace(/^\.+/, "");
  if (!s) return fallback;
  return RESERVED.test(s.split(".")[0]) ? `${s}_` : s;
}

// ---------- Lista de cofres (AppSettings.vaults) ----------

const trimSep = (p) => String(p || "").trim().replace(/[\\/]+$/, "");

/** Mesmo cofre? (sem diferenciar maiúsculas nem a barra final) */
export function sameVaultPath(a, b) {
  return trimSep(a).toLowerCase() === trimSep(b).toLowerCase();
}

/** Nome do cofre = nome da pasta. */
export function vaultName(path) {
  return trimSep(path).split(/[\\/]/).filter(Boolean).pop() || trimSep(path);
}

/** Lista com `path` no início (sem repetir). */
export function addVaultPath(list, path) {
  const p = trimSep(path);
  if (!p) return [...(list || [])];
  return [p, ...(list || []).filter((x) => !sameVaultPath(x, p))];
}

/** Cofres conhecidos: a lista salva + o cofre atual (configurações de versões anteriores). */
export function knownVaults(settings) {
  const list = Array.isArray(settings.vaults) ? settings.vaults : [];
  return settings.vault_path && !list.some((x) => sameVaultPath(x, settings.vault_path)) ? [...list, trimSep(settings.vault_path)] : list;
}

/** Rótulos para um menu: o nome da pasta, ou o caminho quando dois cofres têm o mesmo nome. */
export function vaultLabels(paths) {
  const count = new Map();
  for (const p of paths) count.set(vaultName(p).toLowerCase(), (count.get(vaultName(p).toLowerCase()) || 0) + 1);
  return paths.map((p) => (count.get(vaultName(p).toLowerCase()) > 1 ? trimSep(p) : vaultName(p)));
}

/** Diretório (relativo ao cofre) de uma pasta do app: nomes da árvore como no disco. */
export function folderDir(folders, folderId) {
  return folderChain(folders, folderId)
    .map((f) => safeName(f.name, "Pasta"))
    .join("/");
}

/** Diretório de um caminho relativo ("a/b/Nota.md" -> "a/b"). */
export function dirOf(rel) {
  return relDirs(rel || "").join("/");
}

/** Caminho de `toRel` visto de `fromDir` (ambos relativos ao cofre, com "/"). */
export function relPath(fromDir, toRel) {
  const from = fromDir ? fromDir.split("/").filter(Boolean) : [];
  const to = toRel.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

/** Índice para resolver imagens (`![[x.png]]`, caminhos relativos) e links com pasta. */
export function vaultLookupIndex(files, noteRels = []) {
  return vaultIndex({ files: files.map((rel) => ({ rel, path: rel })), notes: noteRels.map((rel) => ({ rel })) });
}

/**
 * HTML da nota -> conteúdo do arquivo .md. `dir` = diretório da nota no cofre (caminhos das
 * imagens); `linkTitle(a)` = título atual de um link [[ ]].
 */
export function noteToMarkdown(html, { title = "", props = null, created = null, pinned = 0, dir = "", linkTitle = () => "" } = {}) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const first = tpl.content.firstElementChild;
  if (first && /^(H[1-6]|P|DIV)$/.test(first.tagName) && first.textContent.replace(/\s+/g, " ").trim() === title.trim()) {
    if (title.trim() && safeName(title, "") === title.trim()) {
      first.remove(); // o nome do arquivo já é o título
    } else {
      // O nome não consegue representar o título (caracteres proibidos, longo demais): fica
      // como "# Título" no corpo e volta a ser a linha de título ao abrir (applyFileTitle).
      const h1 = document.createElement("h1");
      h1.append(...first.childNodes);
      first.replaceWith(h1);
    }
  }
  const body = htmlToMarkdown(tpl.innerHTML, {
    imageSrc: (src) => {
      const name = localImageName(src);
      if (name) return relPath(dir, `${ATTACHMENTS_DIR}/${name}`);
      const rel = vaultImageRel(src);
      return rel ? relPath(dir, rel) : src;
    },
    linkTitle,
  });
  return propsToYaml(props, { created, pinned }) + (body.trim() ? body : "");
}

/**
 * Arquivo .md do cofre -> { html, props, created }. `rel` = caminho da nota no cofre;
 * `index` = vaultLookupIndex (imagens pelo nome, links com pasta).
 */
export function markdownToNote(md, rel, index = null) {
  const dir = dirOf(rel);
  const html = markdownToHtml(index ? normalizeVaultLinks(md, index) : md);
  const lookup = index ? vaultImageLookup(index, rel) : null;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const img of tpl.content.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(src) && !/^file:/i.test(src)) continue; // URL (http, data, noteimg)
    let path = src.split(/[?#]/)[0];
    try {
      path = decodeURI(path);
    } catch {}
    const found = lookup?.(src) || joinRel(dir, path);
    if (found) img.setAttribute("src", vaultImageUrl(found));
    else img.replaceWith(img.getAttribute("alt") || "");
  }
  const { yaml } = splitFrontMatter(md);
  const parsed = yaml ? parseFrontMatter(yaml) : { props: null, created: null };
  return {
    html: applyFileTitle(sanitizeHtml(tpl.innerHTML), relStem(rel)),
    props: parsed.props && !propsEmpty(parsed.props) ? parsed.props : null,
    created: parsed.created,
  };
}

/** Metadados vindos do cofre: o front-matter cru vira `props`, `created_at` e `pinned` (vale para todos). */
export function vaultMeta(m) {
  const { props, created, pinned } = m.front_matter ? parseFrontMatter(m.front_matter) : { props: null, created: null, pinned: 0 };
  return {
    ...m,
    pinned,
    props: props && !propsEmpty(props) ? props : null,
    created_at: created !== null ? new Date(created).toISOString() : m.created_at,
  };
}

// Arquivo .md aberto fora das Notas (janela de arquivo e prévia; ver src-tauri/src/md_files.rs):
// texto do arquivo <-> HTML do editor. Diferente do cofre, o arquivo não ganha título nem
// `created:`: o front-matter, a quebra de linha (CRLF/LF) e o BOM voltam como estavam, e as
// imagens continuam com o caminho relativo escrito no arquivo.

import { htmlToMarkdown, markdownToHtml } from "./markdown.js";
import { splitFrontMatter } from "./zettel.js";
import { fileImageUrl, fileImageRel, sanitizeHtml } from "./noteContent.js";

/** Separa o texto do arquivo: { body (LF), yaml (cru ou null), eol, bom }. Sem DOM. */
export function readMdText(text) {
  const raw = String(text ?? "");
  const bom = raw.startsWith("﻿");
  const eol = /\r\n/.test(raw) ? "\r\n" : "\n";
  const { yaml, body } = splitFrontMatter(raw);
  return { body, yaml, eol, bom };
}

/** Monta o texto do arquivo de volta (inverso de readMdText). Sem DOM. */
export function writeMdText(body, { yaml = null, eol = "\n", bom = false } = {}) {
  let out = yaml !== null ? `---\n${yaml}\n---\n${body}` : body;
  if (!out.endsWith("\n")) out += "\n";
  if (eol !== "\n") out = out.replace(/\n/g, eol);
  return (bom ? "﻿" : "") + out;
}

/** Caminho relativo escrito no Markdown (não é URL, data:, caminho absoluto ou noteimg). */
export function isRelativeSrc(src) {
  return !!src && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i.test(src) && !/^[a-z]:[\\/]/i.test(src);
}

/** Texto do arquivo -> { html, meta } para o editor. `token` = pasta do arquivo (md_file_read). */
export function mdFileToHtml(text, token) {
  const meta = readMdText(text);
  const tpl = document.createElement("template");
  tpl.innerHTML = markdownToHtml(meta.body);
  for (const img of tpl.content.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (!isRelativeSrc(src)) continue;
    let rel = src.split(/[?#]/)[0].replace(/\\/g, "/").replace(/^\.\//, "");
    try {
      rel = decodeURI(rel);
    } catch {}
    img.setAttribute("src", fileImageUrl(token, rel));
  }
  return { html: sanitizeHtml(tpl.innerHTML), meta };
}

/** HTML do editor -> texto do arquivo, com o front-matter/EOL/BOM de `meta`. */
export function htmlToMdFile(html, meta) {
  // Caminho com espaço sai como <a b.png> (destination() do markdown.js).
  const body = htmlToMarkdown(html, { imageSrc: (src) => fileImageRel(src) ?? src });
  return writeMdText(body, meta);
}

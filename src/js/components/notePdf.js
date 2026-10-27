// Exportar nota em PDF: monta a nota num contêiner (#note-print) que só aparece na mídia print,
// com as mesmas regras de .nt-editor (tipografia, listas, checklist, tabelas, código inline), e
// pede ao Rust para imprimir a webview direto no arquivo (notes_print_pdf). O PDF sai sempre no
// tema claro: os tokens de :root[data-theme="light"] são copiados para @media print.

import { notesPrintPdfApi } from "../api.js";
import { highlightCode, normalizeCodeLang, CODE_LANGS } from "../utils/highlight.js";
import { escapeHtml } from "../utils/noteContent.js";
import { renderMermaidSvg, mermaidErrorText } from "./mermaidView.js";

const LANG_LABEL = Object.fromEntries(CODE_LANGS);
let busy = false;

/** Tokens do tema claro valendo só na impressão (vazio se a folha não puder ser lida). */
function lightTokensForPrint() {
  const decls = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // folhas de outra origem (CDN)
    }
    for (const rule of rules) {
      if (rule.selectorText === ':root[data-theme="light"]') decls.push(rule.style.cssText);
    }
  }
  return decls.length ? `@media print { :root { ${decls.join(" ")} } }` : "";
}

async function codeBlockHtml(pre) {
  const lang = normalizeCodeLang(pre.getAttribute("data-lang"));
  const source = pre.textContent.replace(/\n$/, "");
  if (lang === "mermaid") {
    try {
      const svg = await renderMermaidSvg(source, "light");
      return `<div class="np-diagram">${svg}</div>`;
    } catch (e) {
      return `<div class="np-code"><div class="np-code-err">${escapeHtml(mermaidErrorText(e))}</div><pre>${escapeHtml(source)}</pre></div>`;
    }
  }
  const label = lang !== "text" ? `<div class="np-code-lang">${escapeHtml(LANG_LABEL[lang] || lang)}</div>` : "";
  const code = highlightCode(source, lang === "html" ? "xml" : lang);
  return `<div class="np-code">${label}<pre>${code}</pre></div>`;
}

/** Converte o HTML salvo da nota no conteúdo impresso (código realçado, diagramas, imagens carregadas). */
async function buildPrintRoot(html) {
  const root = document.createElement("article");
  root.id = "note-print";
  root.className = "nt-editor";
  root.innerHTML = html;
  await Promise.all(
    [...root.querySelectorAll("pre[data-lang]")].map(async (pre) => {
      const tpl = document.createElement("template");
      tpl.innerHTML = await codeBlockHtml(pre);
      pre.replaceWith(tpl.content);
    }),
  );
  const imgs = [...root.querySelectorAll("img")];
  for (const img of imgs) img.removeAttribute("loading"); // lazy nunca carrega num contêiner oculto
  return { root, imgs };
}

/** Gera o PDF da nota (HTML salvo) em `path`. */
export async function exportNotePdf(html, path, title) {
  if (busy) throw new Error("Já existe uma exportação em andamento.");
  busy = true;
  const style = document.createElement("style");
  style.textContent = lightTokensForPrint();
  const prevTitle = document.title;
  let root = null;
  try {
    const built = await buildPrintRoot(html);
    root = built.root;
    document.head.append(style);
    document.body.append(root);
    await Promise.all(built.imgs.map((img) => img.decode().catch(() => {})));
    await document.fonts?.ready;
    document.title = title || prevTitle; // vira o título do documento PDF
    await notesPrintPdfApi(path);
  } finally {
    document.title = prevTitle;
    root?.remove();
    style.remove();
    busy = false;
  }
}

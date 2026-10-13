// Menus flutuantes do editor de notas:
//  - barra de formatação que aparece abaixo do texto selecionado;
//  - menu "/" (estilo Notion) para inserir/transformar o bloco, filtrado pelo que se digita.
//  - menu "[[" com as notas para linkar (títulos e apelidos, ou "Criar nota").
// Os comandos são os mesmos da barra de ferramentas (runCommand do noteEditor.js).

import { linkProvider } from "./noteLinks.js";
import { linkHtml, splitLinkText } from "../utils/zettel.js";
import { escapeHtml } from "../utils/noteContent.js";

const SLASH_ITEMS = [
  { cmd: "body", label: "Texto", desc: "Parágrafo comum", icon: "fa-solid fa-paragraph", keys: "texto paragrafo corpo body p" },
  { cmd: "title", label: "Título", desc: "Título grande", glyph: "H1", hint: "#", keys: "titulo title h1 heading" },
  { cmd: "heading", label: "Cabeçalho", desc: "Título de seção", glyph: "H2", hint: "##", keys: "cabecalho subtitulo heading h2" },
  { cmd: "subheading", label: "Subcabeçalho", desc: "Título menor", glyph: "H3", hint: "###", keys: "subcabecalho subtitulo subheading h3" },
  { cmd: "bullet", label: "Lista com marcadores", icon: "fa-solid fa-list-ul", hint: "*", keys: "lista marcadores bullet ul" },
  { cmd: "dash", label: "Lista com traços", icon: "fa-solid fa-minus", hint: "-", keys: "lista tracos dash" },
  { cmd: "number", label: "Lista numerada", icon: "fa-solid fa-list-ol", hint: "1.", keys: "lista numerada ordenada number ol" },
  { cmd: "check", label: "Lista de verificação", icon: "fa-solid fa-list-check", hint: "[ ]", keys: "lista verificacao checklist tarefas todo check" },
  { cmd: "quote", label: "Citação", icon: "fa-solid fa-quote-left", hint: ">", keys: "citacao quote blockquote" },
  { cmd: "mono", label: "Monoespaçado", icon: "fa-solid fa-terminal", keys: "monoespacado mono fixo" },
  { group: "Inserir", cmd: "code", label: "Código", desc: "Bloco com realce e linhas numeradas", icon: "fa-solid fa-code", hint: "```", keys: "codigo code bloco snippet" },
  { cmd: "mermaid", label: "Diagrama Mermaid", desc: "Fluxograma, sequência, gantt...", icon: "fa-solid fa-diagram-project", keys: "mermaid diagrama fluxograma graph sequencia" },
  { cmd: "table", label: "Tabela", icon: "fa-solid fa-table-cells", keys: "tabela table grade" },
  { cmd: "image", label: "Imagem", desc: "Escolher arquivo", icon: "fa-regular fa-image", keys: "imagem image foto figura" },
  { cmd: "link", label: "Link para nota", desc: "Referência a outra nota", icon: "fa-solid fa-link", hint: "[[", keys: "link nota referencia wiki zettel ligar" },
];
const IN_CELL_SKIP = new Set(["table", "code", "mermaid", "title", "heading", "subheading", "quote", "mono"]);

const BUBBLE = [
  ["bold", "fa-solid fa-bold", "Negrito (Ctrl+B)"],
  ["italic", "fa-solid fa-italic", "Itálico (Ctrl+I)"],
  ["underline", "fa-solid fa-underline", "Sublinhado (Ctrl+U)"],
  ["strike", "fa-solid fa-strikethrough", "Tachado (Ctrl+D)"],
  ["inline-code", "fa-solid fa-code", "Código inline (`texto`)"],
  ["link", "fa-solid fa-link", "Link para nota ([[ ]])"],
  "sep",
  ["title", "H1", "Título (#)"],
  ["heading", "H2", "Cabeçalho (##)"],
  ["subheading", "H3", "Subcabeçalho (###)"],
  "sep",
  ["bullet", "fa-solid fa-list-ul", "Lista com marcadores"],
  ["check", "fa-solid fa-list-check", "Lista de verificação"],
  ["quote", "fa-solid fa-quote-left", "Citação"],
  ["code", "fa-solid fa-file-code", "Bloco de código"],
  "sep",
  ["clear", "fa-solid fa-eraser", "Limpar formatação"],
];

const fold = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function initNoteMenus(api) {
  const { editor, scroller } = api;

  // ---------- Posicionamento (dentro da área rolável, como a barra de tabela) ----------

  function place(el, rect, below = true) {
    const s = scroller.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const roomBelow = s.bottom - rect.bottom;
    const up = !below || (roomBelow < h + 12 && rect.top - s.top > roomBelow);
    const top = (up ? rect.top - h - 8 : rect.bottom + 8) - s.top + scroller.scrollTop;
    const center = el.classList.contains("nt-bubble") ? rect.left + rect.width / 2 - w / 2 : rect.left;
    const left = Math.max(4, Math.min(scroller.clientWidth - w - 4, center - s.left + scroller.scrollLeft));
    el.style.top = `${Math.max(scroller.scrollTop + 4, top)}px`;
    el.style.left = `${left}px`;
  }

  /** Retângulo do cursor (colapsado) ou da seleção. */
  function rangeRect(range) {
    const rects = range.getClientRects();
    if (rects.length) return range.collapsed ? rects[0] : range.getBoundingClientRect();
    const el = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    return el.getBoundingClientRect();
  }

  // ---------- Barra da seleção ----------

  const bubble = document.createElement("div");
  bubble.className = "nt-bubble";
  bubble.hidden = true;
  bubble.innerHTML = BUBBLE.map((b) =>
    b === "sep"
      ? `<span class="nt-bubble-sep"></span>`
      : `<button type="button" data-bcmd="${b[0]}" title="${b[2]}">${b[1].startsWith("fa-") ? `<i class="${b[1]}"></i>` : `<span class="nt-bubble-glyph">${b[1]}</span>`}</button>`,
  ).join("");
  scroller.appendChild(bubble);

  let pointerDown = false;
  let bubbleFrame = 0;

  function hideBubble() {
    bubble.hidden = true;
  }

  function updateBubble() {
    bubbleFrame = 0;
    const range = api.selectionRange();
    if (pointerDown || slash || link || !api.editable() || !range || range.collapsed || !range.toString().trim()) return hideBubble();
    const st = api.getSelectionState() || {};
    for (const btn of bubble.querySelectorAll("[data-bcmd]")) {
      const cmd = btn.dataset.bcmd;
      const on =
        (["bold", "italic", "underline", "strike"].includes(cmd) && st[cmd]) ||
        (cmd === "inline-code" && st.code) ||
        (["title", "heading", "subheading"].includes(cmd) && st.style === cmd && !st.list) ||
        (["bullet", "check"].includes(cmd) && st.list === cmd) ||
        (cmd === "quote" && st.quote);
      btn.classList.toggle("active", !!on);
    }
    const wasHidden = bubble.hidden;
    bubble.hidden = false;
    place(bubble, rangeRect(range));
    if (wasHidden) bubble.classList.remove("nt-pop"), void bubble.offsetWidth, bubble.classList.add("nt-pop");
  }

  function scheduleBubble() {
    if (!bubbleFrame) bubbleFrame = requestAnimationFrame(updateBubble);
  }

  bubble.addEventListener("mousedown", (e) => e.preventDefault()); // mantém a seleção
  bubble.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-bcmd]");
    if (!btn) return;
    api.runCommand(btn.dataset.bcmd);
    if (btn.dataset.bcmd === "code") hideBubble();
    else scheduleBubble();
  });

  editor.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      pointerDown = true;
      hideBubble();
    }
  });
  document.addEventListener("mouseup", () => {
    if (!pointerDown) return;
    pointerDown = false;
    scheduleBubble();
  });

  // ---------- Menu "/" ----------

  const menu = document.createElement("div");
  menu.className = "nt-slash";
  menu.hidden = true;
  scroller.appendChild(menu);

  let slash = null; // { node, offset, query, items, index }

  function closeSlash() {
    slash = null;
    menu.hidden = true;
  }

  function filtered(query) {
    const inCell = !!api.selectionRange()?.startContainer.parentElement?.closest("td,th");
    const words = fold(query).split(/\s+/).filter(Boolean);
    return SLASH_ITEMS.filter((it) => {
      if (inCell && IN_CELL_SKIP.has(it.cmd)) return false;
      const hay = fold(`${it.label} ${it.keys} ${it.hint || ""}`);
      return words.every((w) => hay.includes(w));
    });
  }

  function renderSlash() {
    const { items, index } = slash;
    if (!items.length) {
      menu.innerHTML = `<div class="nt-slash-empty">Nenhum resultado</div>`;
    } else {
      let html = "";
      let group = "Blocos básicos";
      html += `<div class="nt-slash-group">${slash.query ? "Resultados" : group}</div>`;
      items.forEach((it, i) => {
        if (!slash.query && it.group && it.group !== group) {
          group = it.group;
          html += `<div class="nt-slash-group">${group}</div>`;
        }
        const icon = it.glyph ? `<span class="nt-slash-glyph">${it.glyph}</span>` : `<i class="${it.icon}"></i>`;
        html +=
          `<button type="button" class="nt-slash-item${i === index ? " active" : ""}" data-i="${i}">` +
          `<span class="nt-slash-icon">${icon}</span>` +
          `<span class="nt-slash-text"><span class="nt-slash-label">${it.label}</span>${it.desc ? `<span class="nt-slash-desc">${it.desc}</span>` : ""}</span>` +
          `${it.hint ? `<kbd>${it.hint}</kbd>` : ""}</button>`;
      });
      menu.innerHTML = html;
    }
    menu.hidden = false;
    const range = api.selectionRange();
    if (range) place(menu, rangeRect(range));
    menu.querySelector(".nt-slash-item.active")?.scrollIntoView({ block: "nearest" });
  }

  function openSlash() {
    const sel = window.getSelection();
    const node = sel.anchorNode;
    const range = api.selectionRange();
    if (!range || !sel.isCollapsed || node?.nodeType !== Node.TEXT_NODE) return;
    const offset = sel.anchorOffset - 1;
    if (node.data[offset] !== "/" || (offset > 0 && !/\s/.test(node.data[offset - 1]))) return;
    if (node.parentElement.closest("pre,code")) return;
    hideBubble();
    slash = { node, offset, query: "", items: filtered(""), index: 0 };
    renderSlash();
  }

  /** Acompanha o texto digitado depois da "/" (ou fecha se o cursor saiu dela). */
  function updateSlash() {
    if (!slash) return;
    const sel = window.getSelection();
    const { node, offset } = slash;
    if (!sel.isCollapsed || sel.anchorNode !== node || sel.anchorOffset <= offset || node.data[offset] !== "/") return closeSlash();
    const query = node.data.slice(offset + 1, sel.anchorOffset);
    if (/^\s/.test(query) || query.length > 30) return closeSlash();
    if (query === slash.query) return;
    const items = filtered(query);
    // Sem resultados e já com espaço digitado: era só uma barra no texto.
    if (!items.length && /\s$/.test(query)) return closeSlash();
    slash = { ...slash, query, items, index: 0 };
    renderSlash();
  }

  function chooseSlash(item) {
    const { node, offset } = slash;
    const sel = window.getSelection();
    const end = sel.anchorNode === node ? sel.anchorOffset : offset + 1 + slash.query.length;
    closeSlash();
    // Apaga "/consulta" e aplica o comando no bloco do cursor.
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(end, node.length));
    range.deleteContents();
    const block = node.parentElement?.closest("p,div,h1,h2,h3,li,td,th,blockquote,pre");
    if (block && editor.contains(block) && !block.textContent && !block.querySelector("img,br")) block.innerHTML = "<br>";
    if (block && !block.textContent) range.selectNodeContents(block);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    api.runCommand(item.cmd);
  }

  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest(".nt-slash-item");
    if (btn && slash) chooseSlash(slash.items[Number(btn.dataset.i)]);
  });
  menu.addEventListener("mousemove", (e) => {
    const btn = e.target.closest(".nt-slash-item");
    if (!btn || !slash || Number(btn.dataset.i) === slash.index) return;
    slash.index = Number(btn.dataset.i);
    menu.querySelectorAll(".nt-slash-item").forEach((b) => b.classList.toggle("active", b === btn));
  });

  // ---------- Menu "[[" (links entre notas) ----------

  const linkMenu = document.createElement("div");
  linkMenu.className = "nt-slash nt-linkmenu";
  linkMenu.hidden = true;
  scroller.appendChild(linkMenu);

  let link = null; // { node, offset (do 1º "["), query, items, index }

  function closeLink() {
    link = null;
    linkMenu.hidden = true;
  }

  function linkItems(query) {
    const p = linkProvider();
    const { title } = splitLinkText(query);
    const items = (p.index()?.suggest(title, 8, p.currentId()) || []).map((s) => ({
      id: s.note.id,
      label: p.titleOf(s.note.id) || s.label,
      alias: s.alias,
      folder: p.folderOf?.(s.note.id) || "",
    }));
    const exact = items.some((it) => fold(it.label) === fold(title) || (it.alias && fold(it.alias) === fold(title)));
    if (title && !exact) items.push({ create: true, label: title });
    return items;
  }

  function renderLink() {
    const { items, index } = link;
    if (!items.length) {
      linkMenu.innerHTML = `<div class="nt-slash-empty">Digite o título de uma nota</div>`;
    } else {
      linkMenu.innerHTML =
        `<div class="nt-slash-group">Link para nota</div>` +
        items
          .map((it, i) => {
            const icon = it.create ? "fa-solid fa-plus" : "fa-regular fa-note-sticky";
            const desc = it.create ? "Nova nota com esse título" : [it.alias ? `apelido: ${it.alias}` : "", it.folder].filter(Boolean).join(" · ");
            const label = it.create ? `Criar “${escapeHtml(it.label)}”` : escapeHtml(it.label);
            return (
              `<button type="button" class="nt-slash-item${i === index ? " active" : ""}" data-i="${i}">` +
              `<span class="nt-slash-icon"><i class="${icon}"></i></span>` +
              `<span class="nt-slash-text"><span class="nt-slash-label">${label}</span>` +
              `${desc ? `<span class="nt-slash-desc">${escapeHtml(desc)}</span>` : ""}</span></button>`
            );
          })
          .join("");
    }
    linkMenu.hidden = false;
    const range = api.selectionRange();
    if (range) place(linkMenu, rangeRect(range));
    linkMenu.querySelector(".nt-slash-item.active")?.scrollIntoView({ block: "nearest" });
  }

  /** Abre o menu se o texto antes do cursor termina em "[[". */
  function openLink() {
    const sel = window.getSelection();
    const node = sel.anchorNode;
    if (!api.selectionRange() || !sel.isCollapsed || node?.nodeType !== Node.TEXT_NODE) return;
    const offset = sel.anchorOffset - 2;
    if (offset < 0 || node.data.slice(offset, offset + 2) !== "[[" || node.data[offset - 1] === "[") return;
    if (node.parentElement.closest("pre,code")) return;
    hideBubble();
    closeSlash();
    link = { node, offset, query: "", items: linkItems(""), index: 0 };
    renderLink();
  }

  /** Acompanha o texto depois do "[[" (fecha com "]", quebra de linha ou cursor fora). */
  function updateLink() {
    if (!link) return;
    const sel = window.getSelection();
    const { node, offset } = link;
    if (!sel.isCollapsed || sel.anchorNode !== node || sel.anchorOffset < offset + 2 || node.data.slice(offset, offset + 2) !== "[[") return closeLink();
    const query = node.data.slice(offset + 2, sel.anchorOffset);
    if (/[[\]\n]/.test(query) || query.length > 120) return closeLink();
    if (query === link.query) return;
    link = { ...link, query, items: linkItems(query), index: 0 };
    renderLink();
  }

  function chooseLink(item) {
    const { node, offset, query } = link;
    const sel = window.getSelection();
    const end = sel.anchorNode === node ? sel.anchorOffset : offset + 2 + query.length;
    closeLink();
    const { alias } = splitLinkText(query);
    const id = item.create ? linkProvider().create(item.label) : item.id;
    const tpl = document.createElement("template");
    tpl.innerHTML = linkHtml(id == null ? item.label : { id, title: item.label }, alias);
    const chip = tpl.content.firstChild;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(end, node.length));
    range.deleteContents();
    // O cursor fica depois de um ZWSP (some na próxima tecla); colado no chip o Chrome o esconde.
    const gap = document.createTextNode("​");
    range.insertNode(gap);
    range.insertNode(chip);
    sel.collapse(gap, 1);
    api.inserted();
  }

  linkMenu.addEventListener("mousedown", (e) => e.preventDefault());
  linkMenu.addEventListener("click", (e) => {
    const btn = e.target.closest(".nt-slash-item");
    if (btn && link) chooseLink(link.items[Number(btn.dataset.i)]);
  });
  linkMenu.addEventListener("mousemove", (e) => {
    const btn = e.target.closest(".nt-slash-item");
    if (!btn || !link || Number(btn.dataset.i) === link.index) return;
    link.index = Number(btn.dataset.i);
    linkMenu.querySelectorAll(".nt-slash-item").forEach((b) => b.classList.toggle("active", b === btn));
  });

  // ---------- Eventos gerais ----------

  document.addEventListener("selectionchange", () => {
    if (link) updateLink();
    if (slash) updateSlash();
    if (!pointerDown) scheduleBubble();
  });
  scroller.addEventListener("scroll", () => {
    if (!bubble.hidden) scheduleBubble();
    if (slash) renderSlash();
    if (link) renderLink();
  });
  editor.addEventListener("focusout", (e) => {
    if (bubble.contains(e.relatedTarget) || menu.contains(e.relatedTarget) || linkMenu.contains(e.relatedTarget)) return;
    closeSlash();
    closeLink();
    hideBubble();
  });

  return {
    onInput(e) {
      if (e.data === "/") openSlash();
      else updateSlash();
      if (e.data?.endsWith("[")) openLink();
      else updateLink();
    },
    /** Abre o menu de links logo depois de um "[[" inserido por comando. */
    openLink,
    /** true quando a tecla foi consumida pelos menus (não chega aos atalhos globais das Notas). */
    onKeydown(e) {
      const used = consume(e);
      if (used) e.stopPropagation();
      return used;
    },
    close() {
      closeSlash();
      closeLink();
      hideBubble();
    },
  };

  /** Teclas usadas pelo menu "/" aberto ou pela barra da seleção visível. */
  function consume(e) {
    if (link) {
      const n = link.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) {
          link.index = (link.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
          renderLink();
        }
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && n && !e.shiftKey) {
        e.preventDefault();
        chooseLink(link.items[link.index]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeLink();
        return true;
      }
    }
    if (slash) {
      const n = slash.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) {
          slash.index = (slash.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
          renderSlash();
        }
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && n && !e.shiftKey) {
        e.preventDefault();
        chooseSlash(slash.items[slash.index]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlash();
        return true;
      }
    }
    if (e.key === "Escape" && !bubble.hidden) {
      e.preventDefault();
      hideBubble();
      return true;
    }
    return false;
  }
}

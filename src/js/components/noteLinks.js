import { linkHtml } from "../utils/zettel.js";
import { escapeHtml } from "../utils/noteContent.js";

// Links [[ ]] no editor das Notas: chips <a class="nt-link" contenteditable="false">.
// Os dados (títulos, abrir/criar nota) vêm de notes.js por setLinkProvider; aqui só o DOM:
// hidratar (texto = título atual, resolver títulos pendentes), clicar e a prévia ao passar o mouse.

const noop = () => null;
let provider = {
  index: () => null, // TitleIndex atual
  titleOf: noop, // id -> título (null se a nota não existe ou está na lixeira)
  peek: noop, // id -> { title, folder, preview, tags }
  open: noop, // id -> abre a nota
  create: noop, // título -> id da nova nota (gravada, sem abrir)
  currentId: noop,
};

export function setLinkProvider(p) {
  provider = { ...provider, ...p };
}

export function linkProvider() {
  return provider;
}

const HYDRATED = Symbol("nt-link");

/**
 * Prepara os links do HTML carregado/colado: chip atômico, texto com o título atual,
 * `data-target` resolvido para `data-note` quando o título já existe e nota apagada vira
 * pendente. `all` = revisita também os já preparados (ao abrir a nota).
 * Devolve true se o HTML salvo mudou.
 */
export function hydrateLinks(root, all = false) {
  let changed = false;
  const index = provider.index();
  for (const a of root.querySelectorAll("a.nt-link")) {
    if (a[HYDRATED] && !all) continue;
    a[HYDRATED] = true;
    a.contentEditable = "false";
    const alias = a.hasAttribute("data-alias");
    const id = a.getAttribute("data-note");
    if (id) {
      const title = provider.titleOf(Number(id));
      if (title === null) {
        // A nota alvo sumiu: o link volta a ser só o título.
        a.removeAttribute("data-note");
        a.setAttribute("data-target", alias ? a.textContent : a.textContent || "Sem título");
        changed = true;
      } else if (!alias && title && a.textContent !== title) {
        a.textContent = title;
        changed = true;
      }
      continue;
    }
    const target = a.getAttribute("data-target") || "";
    const note = index?.resolve(target);
    if (note) {
      a.removeAttribute("data-target");
      a.setAttribute("data-note", String(note.id));
      if (!alias) a.textContent = provider.titleOf(note.id) || target;
      changed = true;
    }
  }
  return changed;
}

/** HTML do chip para uma nota existente (pelo id) ou para um título sem nota. */
export function chipFor(title, alias = "") {
  const note = provider.index()?.resolve(title);
  return linkHtml(note ? { id: note.id, title: provider.titleOf(note.id) || title } : title, alias);
}

/**
 * Abre a nota do link. O pendente cria a nota com esse título antes; o link passa a apontar
 * para ela e `changed` grava a nota atual antes de sair dela.
 */
export function followLink(a, changed = () => {}) {
  const id = a.getAttribute("data-note");
  if (id) return provider.open(Number(id));
  const title = (a.getAttribute("data-target") || a.textContent).trim();
  if (!title) return;
  const existing = provider.index()?.resolve(title);
  const newId = existing ? existing.id : provider.create(title);
  if (newId == null) return;
  a.removeAttribute("data-target");
  a.setAttribute("data-note", String(newId));
  changed();
  provider.open(newId);
}

// ---------- Prévia ao passar o mouse ----------

export function initLinkPeek(editor, scroller) {
  const peek = document.createElement("div");
  peek.className = "nt-link-peek";
  peek.hidden = true;
  scroller.appendChild(peek);
  let timer = 0;
  let current = null;

  function hide() {
    clearTimeout(timer);
    current = null;
    peek.hidden = true;
  }

  function show(a) {
    const id = a.getAttribute("data-note");
    const info = id ? provider.peek(Number(id)) : null;
    if (info) {
      const tags = info.tags?.length ? `<div class="nt-link-peek-tags">${info.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join("")}</div>` : "";
      peek.innerHTML =
        `<div class="nt-link-peek-title">${escapeHtml(info.title)}</div>` +
        `<div class="nt-link-peek-folder"><i class="fa-regular fa-folder"></i> ${escapeHtml(info.folder)}</div>` +
        `<div class="nt-link-peek-text">${escapeHtml(info.preview || "Nenhum texto adicional")}</div>${tags}`;
    } else {
      peek.innerHTML = `<div class="nt-link-peek-title">${escapeHtml(a.getAttribute("data-target") || a.textContent)}</div><div class="nt-link-peek-text">Nota ainda não criada — clique para criar.</div>`;
    }
    peek.hidden = false;
    const r = a.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const w = peek.offsetWidth;
    const h = peek.offsetHeight;
    const below = s.bottom - r.bottom > h + 12 || r.top - s.top < h + 12;
    peek.style.top = `${(below ? r.bottom + 6 : r.top - h - 6) - s.top + scroller.scrollTop}px`;
    peek.style.left = `${Math.max(4, Math.min(scroller.clientWidth - w - 4, r.left - s.left + scroller.scrollLeft))}px`;
  }

  editor.addEventListener("mouseover", (e) => {
    const a = e.target.closest?.("a.nt-link");
    if (a === current) return;
    hide();
    if (!a || !editor.contains(a)) return;
    current = a;
    timer = setTimeout(() => current === a && a.isConnected && show(a), 350);
  });
  editor.addEventListener("mouseleave", hide);
  editor.addEventListener("mousedown", hide);
  editor.addEventListener("keydown", hide);
  scroller.addEventListener("scroll", hide);
  return { hide };
}

import { el, icon } from "../utils/dom.js";
import { normalizeProps, normalizeTag, fold, NOTE_TYPES, NOTE_STATUSES } from "../utils/zettel.js";

// Painel de propriedades (front-matter) do modo Zettelkasten, acima do texto da nota.
// Fica fora do contenteditable: as propriedades são salvas à parte do HTML (coluna props).

const COLLAPSED_KEY = "nt-props-collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * host: elemento do painel. opts: { editor, onChange(note), tags() -> [{tag, count}], onTagClick(tag) }.
 * Devolve { render(note, readOnly), hide(), place() }.
 *
 * O painel fica logo abaixo do título (1º bloco do editor), mas fora do contenteditable para
 * não entrar no HTML da nota: é posicionado por cima e o 1º bloco ganha uma margem do tamanho
 * dele via CSS (--nt-props-h em .nt-editor.has-props > :first-child), sem mexer no DOM do editor.
 */
export function createPropsPanel(host, { editor, onChange, tags, onTagClick }) {
  let note = null;
  let readOnly = false;
  let collapsed = readCollapsed();
  let placeFrame = 0;

  function place() {
    placeFrame = 0;
    if (host.hidden) return;
    editor.style.setProperty("--nt-props-h", `${host.offsetHeight}px`);
    const first = editor.firstElementChild;
    const scroller = host.offsetParent;
    if (!scroller) return;
    const s = scroller.getBoundingClientRect();
    const e = editor.getBoundingClientRect();
    const bottom = first ? first.getBoundingClientRect().bottom : e.top;
    host.style.top = `${bottom - s.top + scroller.scrollTop + 4}px`;
    host.style.left = `${e.left - s.left + scroller.scrollLeft}px`;
    host.style.width = `${e.width}px`;
  }

  function schedulePlace() {
    if (!placeFrame) placeFrame = requestAnimationFrame(place);
  }

  // Título que quebra linha, painel recolhido/expandido, janela redimensionada.
  const ro = new ResizeObserver(schedulePlace);
  ro.observe(host);
  ro.observe(editor);
  editor.addEventListener("input", schedulePlace);
  const tagList = el("datalist", { id: "nt-props-tags" });
  document.body.appendChild(tagList);

  function commit(mutate, rerender = true) {
    if (!note || readOnly) return;
    const props = normalizeProps(note.props);
    mutate(props);
    note.props = normalizeProps(props);
    onChange(note);
    if (rerender) render(note, readOnly, true);
  }

  function chips(kind, values, placeholder, normalize) {
    const wrap = el("div.nt-props-chips");
    values.forEach((v, i) => {
      const chip = el(
        `span.nt-chip.${kind}`,
        { title: kind === "tag" ? `Buscar notas com #${v}` : v },
        kind === "tag" ? `#${v}` : v,
        readOnly
          ? null
          : el(
              "button.nt-chip-x",
              {
                type: "button",
                title: "Remover",
                onclick: (e) => {
                  e.stopPropagation();
                  commit((p) => p[kind === "tag" ? "tags" : "aliases"].splice(i, 1));
                },
              },
              icon("fa-solid fa-xmark"),
            ),
      );
      if (kind === "tag") chip.addEventListener("click", () => onTagClick(v));
      wrap.appendChild(chip);
    });
    if (!readOnly) {
      const input = el("input.nt-props-input", { placeholder, spellcheck: false, list: kind === "tag" ? "nt-props-tags" : null });
      const add = () => {
        const parts = input.value.split(kind === "tag" ? /[,\s]+/ : /,/).map(normalize).filter(Boolean);
        if (!parts.length) return false;
        input.value = "";
        commit((p) => p[kind === "tag" ? "tags" : "aliases"].push(...parts));
        host.querySelector(`.nt-props-row.${kind} .nt-props-input`)?.focus();
        return true;
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "," || (e.key === "Tab" && input.value.trim())) {
          if (add()) e.preventDefault();
          else if (e.key !== "Tab") e.preventDefault();
        } else if (e.key === "Backspace" && !input.value && values.length) {
          commit((p) => p[kind === "tag" ? "tags" : "aliases"].pop());
          host.querySelector(`.nt-props-row.${kind} .nt-props-input`)?.focus();
        } else if (e.key === "Escape") input.blur();
      });
      // Escolher uma tag da lista do datalist dispara "input" sem tecla.
      input.addEventListener("input", (e) => {
        if (kind === "tag" && e.inputType === "insertReplacementText") add();
      });
      input.addEventListener("blur", () => input.value.trim() && add());
      wrap.appendChild(input);
    }
    wrap.addEventListener("click", (e) => e.target === wrap && wrap.querySelector("input")?.focus());
    return wrap;
  }

  function select(field, options, value) {
    const s = el("select.nt-props-select", { disabled: readOnly });
    s.append(el("option", { value: "" }, "—"));
    for (const [v, label] of options) s.append(el("option", { value: v }, label));
    if (value && !options.some(([v]) => v === value)) s.append(el("option", { value }, value));
    s.value = value;
    s.addEventListener("change", () => commit((p) => (p[field] = s.value)));
    return s;
  }

  function text(field, value, placeholder, get = (p) => p[field], set = (p, v) => (p[field] = v)) {
    const input = el("input.nt-props-input.wide", { value, placeholder, spellcheck: false, readOnly });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Escape") input.blur();
    });
    input.addEventListener("change", () => commit((p) => set(p, input.value.trim()), false));
    return input;
  }

  function row(cls, iconCls, label, ...content) {
    return el(`div.nt-props-row.${cls}`, {}, el("div.nt-props-key", {}, icon(iconCls), el("span", {}, label)), el("div.nt-props-val", {}, ...content));
  }

  function extraRow(key, value) {
    const keyInput = el("input.nt-props-input.key", { value: key, placeholder: "nome", spellcheck: false, readOnly });
    const valInput = el("input.nt-props-input.wide", { value, placeholder: "valor", spellcheck: false, readOnly });
    const save = () =>
      commit((p) => {
        const entries = Object.entries(p.extra);
        const i = entries.findIndex(([k]) => k === key);
        const next = [keyInput.value.trim(), valInput.value.trim()];
        if (i < 0) entries.push(next);
        else entries[i] = next;
        p.extra = Object.fromEntries(entries.filter(([k]) => k));
      }, false);
    for (const input of [keyInput, valInput]) {
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") input.blur();
      });
      input.addEventListener("change", save);
    }
    return el(
      "div.nt-props-row.extra",
      {},
      el("div.nt-props-key", {}, icon("fa-solid fa-bars-staggered"), keyInput),
      el(
        "div.nt-props-val",
        {},
        valInput,
        readOnly
          ? null
          : el(
              "button.nt-props-del",
              {
                type: "button",
                title: "Remover propriedade",
                onclick: () =>
                  commit((p) => {
                    delete p.extra[key];
                  }),
              },
              icon("fa-solid fa-xmark"),
            ),
      ),
    );
  }

  function render(n, ro = false, keepFocus = false) {
    note = n;
    readOnly = ro;
    if (!n) return hide();
    const p = normalizeProps(n.props);
    tagList.replaceChildren(...tags().map((t) => el("option", { value: t.tag }, `${t.count}`)));

    const active = keepFocus ? document.activeElement : null;
    const activeRow = active && host.contains(active) ? [...host.querySelectorAll("input,select")].indexOf(active) : -1;

    const head = el(
      "button.nt-props-head",
      {
        type: "button",
        title: collapsed ? "Mostrar propriedades" : "Ocultar propriedades",
        onclick: () => {
          collapsed = !collapsed;
          try {
            localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
          } catch {}
          render(note, readOnly);
        },
      },
      icon(`fa-solid fa-chevron-${collapsed ? "right" : "down"} nt-props-chev`),
      el("span", {}, "Propriedades"),
      p.zid ? el("span.nt-props-zid", { title: "Id Zettelkasten" }, p.zid) : null,
      collapsed && p.tags.length ? el("span.nt-props-summary", {}, p.tags.map((t) => `#${t}`).join(" ")) : null,
    );

    const body = collapsed
      ? null
      : el(
          "div.nt-props-body",
          {},
          row("tag", "fa-solid fa-hashtag", "Tags", chips("tag", p.tags, p.tags.length ? "" : "Adicionar tag", normalizeTag)),
          row("alias", "fa-solid fa-signature", "Apelidos", chips("alias", p.aliases, p.aliases.length ? "" : "Outros nomes para [[ ]]", (s) => s.trim().replace(/[[\]|]/g, ""))),
          row("type", "fa-solid fa-layer-group", "Tipo", select("type", NOTE_TYPES, p.type)),
          row("status", "fa-solid fa-circle-half-stroke", "Status", select("status", NOTE_STATUSES, p.status)),
          row("source", "fa-solid fa-link", "Fonte", text("source", p.source, "URL ou referência")),
          row("author", "fa-regular fa-user", "Autor", text("author", p.author, "Nome ou e-mail (opcional)")),
          ...Object.entries(p.extra).map(([k, v]) => extraRow(k, v)),
          readOnly
            ? null
            : el(
                "button.nt-props-add",
                {
                  type: "button",
                  onclick: () => {
                    let name = "campo";
                    for (let i = 2; Object.keys(p.extra).some((k) => fold(k) === fold(name)); i++) name = `campo ${i}`;
                    commit((q) => (q.extra[name] = ""));
                    const keys = host.querySelectorAll(".nt-props-row.extra .key");
                    keys[keys.length - 1]?.select();
                  },
                },
                icon("fa-solid fa-plus"),
                "Adicionar propriedade",
              ),
        );
    host.replaceChildren(head, ...(body ? [body] : []));
    host.classList.toggle("collapsed", collapsed);
    host.hidden = false;
    editor.classList.add("has-props");
    place();
    if (activeRow >= 0) {
      const inputs = host.querySelectorAll("input,select");
      inputs[Math.min(activeRow, inputs.length - 1)]?.focus();
    }
  }

  function hide() {
    note = null;
    host.hidden = true;
    host.replaceChildren();
    editor.classList.remove("has-props");
  }

  return { render, hide, place: schedulePlace };
}

import { el, icon } from "../utils/dom.js";

// Rodapé da nota: "Links" (para onde ela aponta) e "Mencionada em" (backlinks).
// Os dados vêm prontos de notes.js (metadados em memória, sem carregar o HTML de outras notas).

/**
 * host: elemento do painel. open(id) abre uma nota; create(title) cria e abre a pendente.
 * render({ outgoing: [{ id?, title, folder? }], backlinks: [{ id, title, folder, preview }] }).
 */
export function createLinksPanel(host, { open, create }) {
  function item({ id, title, folder, preview, missing }) {
    return el(
      `button.nt-bl-item${missing ? ".missing" : ""}`,
      {
        type: "button",
        title: missing ? "Nota ainda não criada — clique para criar" : title,
        onclick: () => (missing ? create(title) : open(id)),
      },
      icon(missing ? "fa-regular fa-file" : "fa-regular fa-note-sticky"),
      el(
        "span.nt-bl-text",
        {},
        el("span.nt-bl-title", {}, title),
        preview || folder ? el("span.nt-bl-sub", {}, [folder, preview].filter(Boolean).join(" · ")) : null,
      ),
    );
  }

  function section(label, iconCls, items) {
    return el(
      "div.nt-bl-section",
      {},
      el("div.nt-bl-label", {}, icon(iconCls), `${label} `, el("span.nt-bl-count", {}, String(items.length))),
      el("div.nt-bl-list", {}, ...items.map(item)),
    );
  }

  function render({ outgoing = [], backlinks = [] } = {}) {
    if (!outgoing.length && !backlinks.length) return hide();
    host.replaceChildren(
      ...(backlinks.length ? [section("Mencionada em", "fa-solid fa-arrow-turn-down fa-flip-horizontal", backlinks)] : []),
      ...(outgoing.length ? [section("Links", "fa-solid fa-link", outgoing)] : []),
    );
    host.hidden = false;
  }

  function hide() {
    host.hidden = true;
    host.replaceChildren();
  }

  return { render, hide };
}

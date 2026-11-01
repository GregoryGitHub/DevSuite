// Navegação do app Notas (notes.html): sem barra de abas e sem seletor de apps (um app só).
// Como no Notas do iOS/macOS: engrenagem no topo das pastas (celular) ou na barra de
// ferramentas (desktop), e "‹ Notas" para voltar das Configurações.

import { state } from "../state.js";
import { showMainView } from "../navigation.js";

const gearButton = (cls) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.dataset.notasGo = "settings";
  b.title = "Configurações";
  b.innerHTML = '<i class="fa-solid fa-gear"></i>';
  return b;
};

const backButton = () => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "nt-back";
  b.dataset.notasGo = "notes";
  b.innerHTML = '<i class="fa-solid fa-chevron-left"></i> <span>Notas</span>';
  return b;
};

export function initNotasShell() {
  // Desktop: a engrenagem no lugar do seletor de apps (barra das Notas) e "‹ Notas" nas Configurações.
  document.querySelector("#view-notes .nt-tb-sidebar .app-switch")?.replaceWith(gearButton("nt-tb-btn notas-gear"));
  document.querySelector("#view-settings .app-switch")?.replaceWith(backButton());
  const subtitle = document.querySelector("#view-settings .settings-toolbar .nt-tb-title span");
  if (subtitle) subtitle.textContent = window.__TAURI__ ? "Conta, sincronização, aparência e inicialização" : "Conta, sincronização e aparência";

  // Celular / bandeja: engrenagem no topo das pastas (à esquerda do "abrir no modo desktop").
  const nav = document.querySelector("#view-notes .nt-sidebar > .nt-nav");
  if (nav) {
    const actions = document.createElement("div");
    actions.className = "nt-nav-actions";
    actions.append(gearButton("nt-icon-btn"), ...nav.querySelectorAll("button"));
    nav.append(actions);
  }

  // Cabeçalho das Configurações no celular: "‹ Notas" + título grande, como as outras telas.
  const header = document.querySelector("#view-settings .app-header.compact-only");
  if (header) {
    const title = document.createElement("h2");
    title.className = "nt-large-title";
    title.textContent = "Configurações";
    const top = document.createElement("div");
    top.className = "nt-nav";
    top.append(backButton());
    header.replaceChildren(top, title);
    header.classList.add("notas-settings-head");
  }

  document.addEventListener("click", (e) => {
    const go = e.target.closest("[data-notas-go]")?.dataset.notasGo;
    if (go && go !== state.activeMainView) showMainView(go);
  });
  // Esc nas Configurações volta para as notas.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.activeMainView === "settings" && !document.querySelector(".hx-modal-overlay:not([hidden])")) showMainView("notes");
  });
}

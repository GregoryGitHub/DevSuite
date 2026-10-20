import { state } from "../state.js";
import { setDesktopModeApi, minimizeWindowApi, toggleMaximizeApi } from "../api.js";
import { showMainView } from "../navigation.js";
import { SOLO_APP, isSolo } from "../windowContext.js";
import { reattachSelf } from "./detach.js";

// Tray mode (compact window by the tray) <-> desktop mode (large Tasks/Notes/HTTP/JSON/DB/RabbitMQ window).

/** Views reachable from the desktop toolbar switcher (in order). */
const DESKTOP_VIEWS = [
  { view: "tasks", title: "Tarefas", icon: "fa-solid fa-list-check" },
  { view: "notes", title: "Notas", icon: "fa-solid fa-note-sticky" },
  { view: "http", title: "HTTP", icon: "fa-solid fa-paper-plane" },
  { view: "json", title: "Formatter JSON", icon: "fa-solid fa-code" },
  { view: "db", title: "Banco de dados", icon: "fa-solid fa-database" },
  { view: "rabbit", title: "RabbitMQ", icon: "fa-solid fa-envelopes-bulk" },
  { view: "settings", title: "Configurações", icon: "fa-solid fa-gear" },
];

function notifyChange() {
  document.dispatchEvent(new CustomEvent("windowmodechange", { detail: { desktop: state.desktopMode } }));
}

function updateMaximizedClass() {
  const maximized =
    state.desktopMode &&
    window.outerWidth >= window.screen.availWidth - 2 &&
    window.outerHeight >= window.screen.availHeight - 2;
  document.body.classList.toggle("maximized", maximized);
}

/** Opens the large window on the current view. */
export async function enterDesktopMode() {
  if (state.desktopMode || isSolo) return;
  state.desktopMode = true;
  document.body.classList.add("desktop-mode");
  showMainView(DESKTOP_VIEWS.some((v) => v.view === state.activeMainView) ? state.activeMainView : "tasks");
  notifyChange();
  await setDesktopModeApi(true, true);
}

/** Back to the compact tray window; `visible: false` also hides it (red button). */
export async function exitDesktopMode({ visible = true } = {}) {
  // Janela desatachada: fechar devolve o app à janela principal.
  if (isSolo) return reattachSelf();
  if (!state.desktopMode) return;
  state.desktopMode = false;
  await setDesktopModeApi(false, visible);
  document.body.classList.remove("desktop-mode", "maximized");
  notifyChange();
}

export function minimizeWindow() {
  minimizeWindowApi();
}

export async function toggleMaximize() {
  await toggleMaximizeApi();
  updateMaximizedClass();
}

function renderSwitchers() {
  document.querySelectorAll(".app-switch").forEach((box) => {
    box.innerHTML = DESKTOP_VIEWS.map((v) => `<button data-switch-view="${v.view}" title="${v.title}"><i class="${v.icon}"></i></button>`).join("");
  });
}

export function initWindowMode() {
  if (isSolo) {
    // Janela de um app só: sempre no layout desktop, sem seletor nem modo bandeja.
    state.desktopMode = true;
    document.body.classList.add("desktop-mode", "solo-window");
    showMainView(SOLO_APP);
    notifyChange();
  }
  renderSwitchers();
  window.addEventListener("resize", updateMaximizedClass);

  // Desktop toolbar switcher between Tasks, Notes, HTTP and JSON.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-switch-view]");
    if (btn && btn.dataset.switchView !== state.activeMainView) showMainView(btn.dataset.switchView);
  });
  document.addEventListener("mainviewchange", () => {
    document.querySelectorAll("[data-switch-view]").forEach((b) => b.classList.toggle("active", b.dataset.switchView === state.activeMainView));
  });
}

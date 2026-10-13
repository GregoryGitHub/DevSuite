import { state } from "./state.js";

const PANELS = {
  tasks: document.getElementById("view-tasks"),
  notes: document.getElementById("view-notes"),
  http: document.getElementById("view-http"),
  json: document.getElementById("view-json"),
  db: document.getElementById("view-db"),
  rabbit: document.getElementById("view-rabbit"),
  settings: document.getElementById("view-settings"),
};

/** Shows one of the main views and notifies listeners via the "mainviewchange" event. */
export function showMainView(view) {
  if (!PANELS[view]) return;
  state.activeMainView = view;

  document.querySelectorAll(".bottom-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  for (const [name, el] of Object.entries(PANELS)) el.hidden = name !== view;

  document.dispatchEvent(new CustomEvent("mainviewchange", { detail: { view } }));
}

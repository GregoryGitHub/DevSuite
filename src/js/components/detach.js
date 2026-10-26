import { state } from "../state.js";
import { showMainView } from "../navigation.js";
import { DETACHABLE, SOLO_APP, isSolo } from "../windowContext.js";
import { detachBlocker, flushAll, flushApp, reloadApp } from "../appLifecycle.js";
import { el } from "../utils/dom.js";

// Apps desatachados: cada app da suíte pode sair da janela principal para uma janela própria
// (botão e ícone próprios na barra de tarefas; ver src-tauri/src/app_windows.rs).
// - Principal: "Abrir em janela própria" grava as pendências do app e pede a janela ao Rust;
//   o app some das abas (o seletor mostra ↗ e foca a janela dele). Quando ele volta
//   ("app-attached"), a principal relê os dados do disco.
// - Janela desatachada: X, Alt+F4 ou "Devolver" gravam as pendências e fecham a janela.
// - Sair do Dev Suite ("app-exit"): cada janela grava o que falta e confirma (app_flushed).

const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);

const NAMES = { tasks: "Tarefas", notes: "Notas", http: "HTTP", json: "Formatter JSON", db: "Banco de dados", rabbit: "RabbitMQ", redis: "Redis" };

const toastEl = el("div.hx-toast.ds-toast", { hidden: true });
const menuEl = el("div.nt-menu.ds-menu", { hidden: true });
let toastTimer = 0;
const busy = new Set();

function toast(message) {
  clearTimeout(toastTimer);
  toastEl.replaceChildren(el("span", { title: message }, message));
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4200);
}

const blurActive = () => document.activeElement?.blur?.(); // editores no lugar (ex.: bloco de código) gravam no blur

// ---------- Janela principal ----------

function renderDetached() {
  document.querySelectorAll("[data-switch-view], .bottom-tab[data-view]").forEach((b) => {
    const view = b.dataset.switchView || b.dataset.view;
    if (!NAMES[view]) return;
    const away = state.detached.has(view);
    b.dataset.baseTitle ??= b.title;
    b.classList.toggle("detached", away);
    b.title = away ? `${b.dataset.baseTitle} (em janela própria)` : b.dataset.baseTitle;
  });
  // A view aberta foi para outra janela: mostra o primeiro app que ficou (ou Configurações).
  if (state.detached.has(state.activeMainView)) {
    showMainView(DETACHABLE.find((v) => !state.detached.has(v)) || "settings");
  }
  document.dispatchEvent(new CustomEvent("detachedchange"));
}

function setDetached(view, away) {
  if (!DETACHABLE.includes(view)) return;
  if (away) state.detached.add(view);
  else state.detached.delete(view);
  renderDetached();
}

/** Move o app para uma janela própria (a principal deixa de gravar os dados dele). */
export async function detachApp(view) {
  if (!tauri?.core || !DETACHABLE.includes(view) || state.detached.has(view) || busy.has(view)) return;
  const why = detachBlocker(view);
  if (why) return toast(why);
  busy.add(view);
  try {
    if (state.activeMainView === view) blurActive();
    await flushApp(view);
    await invoke("app_window_open", { view });
    setDetached(view, true);
  } catch (e) {
    toast(`Não foi possível abrir a janela: ${e}`);
  } finally {
    busy.delete(view);
  }
}

function showSwitchMenu(view, x, y) {
  const away = state.detached.has(view);
  const item = (icon, label, run) =>
    el("button.nt-menu-item", { type: "button", onclick: () => ((menuEl.hidden = true), run()) }, el("i", { class: icon }), label);
  menuEl.replaceChildren(
    away
      ? item("fa-solid fa-window-restore", "Mostrar a janela", () => invoke("app_window_focus", { view }))
      : item("fa-solid fa-up-right-from-square", "Abrir em janela própria", () => detachApp(view)),
  );
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}

async function initMain() {
  try {
    for (const view of await invoke("app_windows_list")) state.detached.add(view);
  } catch (e) {
    console.error("app_windows_list failed", e);
  }
  renderDetached();

  await tauri.event.listen("app-detached", (e) => setDetached(e.payload, true));
  await tauri.event.listen("app-attached", async (e) => {
    const view = e.payload;
    // O app volta com o que a janela dele gravou: relê do disco antes de mostrar.
    await reloadApp(view);
    setDetached(view, false);
  });
  await tauri.event.listen("app-exit", async () => {
    blurActive();
    await flushAll((view) => !state.detached.has(view));
    invoke("app_flushed").catch(() => {});
  });

  document.addEventListener("click", (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) menuEl.hidden = true;
    if (e.target.closest("[data-detach]")) detachApp(state.activeMainView);
  });
  document.addEventListener("contextmenu", (e) => {
    const b = e.target.closest("[data-switch-view], .bottom-tab[data-view]");
    const view = b && (b.dataset.switchView || b.dataset.view);
    if (!DETACHABLE.includes(view)) return;
    e.preventDefault();
    showSwitchMenu(view, e.clientX, e.clientY);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menuEl.hidden) menuEl.hidden = true;
  });
  // O seletor é redesenhado pelo windowMode; mantém o ↗ nos botões.
  document.addEventListener("mainviewchange", () => {
    document.querySelectorAll("[data-switch-view], .bottom-tab[data-view]").forEach((b) =>
      b.classList.toggle("detached", state.detached.has(b.dataset.switchView || b.dataset.view)),
    );
  });
}

// ---------- Janela desatachada ----------

let closing = false;

/** Grava o que estiver pendente e fecha esta janela; o app volta para a principal. */
export async function reattachSelf() {
  if (!isSolo || closing) return;
  closing = true;
  blurActive();
  await flushApp(SOLO_APP);
  try {
    await invoke("app_window_close");
  } catch (e) {
    closing = false;
    toast(`Não foi possível fechar: ${e}`);
  }
}

async function initSolo() {
  document.title = `Dev Suite — ${NAMES[SOLO_APP]}`;
  // Onde o seletor de apps ocupava a coluna lateral (Tarefas, Notas, HTTP), entra o nome da janela.
  document
    .querySelector(`#view-${SOLO_APP} .nt-tb-sidebar`)
    ?.prepend(el("span.solo-title", { "data-tauri-drag-region": true }, `Dev Suite — ${NAMES[SOLO_APP]}`));
  document.querySelectorAll("[data-detach]").forEach((b) => {
    b.title = "Devolver à janela principal";
    b.querySelector("i").className = "fa-solid fa-arrow-right-to-bracket";
  });
  document.querySelectorAll('.win-close[data-action="close-desktop"]').forEach((b) => (b.title = "Fechar (volta para a janela principal)"));
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-detach]")) reattachSelf();
  });
  await tauri.event.listen("app-close-requested", reattachSelf);
  await tauri.event.listen("app-exit", async () => {
    blurActive();
    await flushApp(SOLO_APP);
    invoke("app_flushed").catch(() => {});
  });
}

export function initDetach() {
  document.body.append(toastEl, menuEl);
  if (!tauri?.core) return;
  (isSolo ? initSolo() : initMain()).catch((e) => console.error("detach init failed", e));
}

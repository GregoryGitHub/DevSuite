// Entrada do app "Notas" (notes.html): só as Notas e as Configurações, no desktop (Tauri) e no
// navegador (PWA). A markup das duas telas é a mesma do Dev Suite: vem do index.html em tempo de
// execução (sem build e sem cópia que desatualiza), antes de importar os componentes, que
// procuram os elementos ao carregar.

import { isTauri, isWeb } from "./js/platform.js";

/** Página do Dev Suite com a markup (no site do PWA o build_web a publica como suite.html). */
const TEMPLATE = document.documentElement.dataset.template || "index.html";

/** Move #view-notes e #view-settings do index.html para o #views desta página. */
async function mountViews() {
  const html = await fetch(TEMPLATE).then((r) => r.text());
  const doc = new DOMParser().parseFromString(html, "text/html");
  const views = document.getElementById("views");
  for (const id of ["view-notes", "view-settings"]) {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`index.html sem #${id}`);
    views.append(document.adoptNode(el));
  }
  // Configurações que não existem neste app (a markup fica, oculta, para settings.js).
  const hide = ["setting-cli-info", "setting-md-quicklook"];
  if (isWeb) hide.push("setting-autostart", "setting-start-minimized", "setting-notes-storage", "setting-vault-path", "setting-vault-copy");
  for (const id of hide) {
    const row = document.getElementById(id)?.closest(".setting-item");
    if (row) row.classList.add("notas-hidden");
  }
  // Celular: botão de foto (câmera) na barra de baixo da nota.
  if (isWeb && matchMedia("(pointer: coarse)").matches) {
    const bar = document.querySelector("#view-notes .nt-bottom-bar");
    bar?.querySelector('[data-action="delete-note"]')?.insertAdjacentHTML(
      "beforebegin",
      '<button class="nt-tool" data-cmd="camera" title="Foto"><i class="fa-solid fa-camera"></i></button>',
    );
  }
}

async function main() {
  await mountViews();

  const { state } = await import("./js/state.js");
  const { loadSettingsApi } = await import("./js/api.js");
  const { MD_FILE, MD_PREVIEW } = await import("./js/windowContext.js");
  const { initTheme, syncThemeFromSettings } = await import("./js/components/theme.js");
  const { initNotes, loadNotes } = await import("./js/components/notes.js");
  const { initSettings, initSettingsSync, updateSettingsUI } = await import("./js/components/settings.js");
  const { initWindowControls } = await import("./js/components/windowControls.js");
  const { initWindowMode, enterDesktopMode, exitDesktopMode } = await import("./js/components/windowMode.js");
  const { showMainView } = await import("./js/navigation.js");

  initTheme();
  if (MD_FILE || MD_PREVIEW) {
    const { initMdFile } = await import("./js/components/mdFile.js");
    return initMdFile();
  }
  state.activeMainView = "notes";
  initNotes();
  initSettings();
  initSettingsSync();
  if (isTauri) (await import("./js/components/notesStorage.js")).initNotesStorage();
  initWindowControls();
  initWindowMode();
  (await import("./js/components/notasShell.js")).initNotasShell();
  document.addEventListener("keydown", (e) => {
    const menu = document.getElementById("menu-dropdown");
    if (e.key === "Escape" && !menu.hidden) menu.hidden = true;
  });

  try {
    state.settings = { ...state.settings, ...(await loadSettingsApi()) };
  } catch (e) {
    console.error("load failed", e);
  }
  syncThemeFromSettings();
  updateSettingsUI();
  if (isWeb) {
    // Navegador: celular = pilha do modo bandeja; tela larga (iPad, computador) = 3 colunas.
    const wide = matchMedia("(min-width: 900px)");
    const apply = () => (wide.matches ? enterDesktopMode() : exitDesktopMode());
    wide.addEventListener("change", apply);
    await apply();
  }
  showMainView("notes");
  const pwa = isWeb ? await import("./js/web/pwa.js") : null;
  pwa?.initWebImages();
  await loadNotes();
  pwa?.initPwa();
  (await import("./js/sync/syncUi.js")).initSync();
}

main().catch((e) => {
  console.error("notas init failed", e);
  document.body.insertAdjacentHTML("beforeend", `<pre class="notas-fatal">Falha ao iniciar: ${String(e?.message || e)}</pre>`);
});

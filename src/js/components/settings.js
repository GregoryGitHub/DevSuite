import { state } from "../state.js";
import { saveSettingsApi } from "../api.js";
import { showMainView } from "../navigation.js";
import { exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";
import { syncThemeFromSettings } from "./theme.js";
import { SOLO_APP } from "../windowContext.js";

const bottomNav = document.getElementById("bottom-nav");
const settingAutostart = document.getElementById("setting-autostart");
const settingStartMinimized = document.getElementById("setting-start-minimized");
const settingZettelkasten = document.getElementById("setting-zettelkasten");
const settingsBar = document.getElementById("settings-bar");

// Barra do modo expandido (botões de janela).
const BAR_ACTIONS = {
  tray: () => exitDesktopMode(),
  "close-desktop": () => exitDesktopMode({ visible: false }),
  minimize: minimizeWindow,
  maximize: toggleMaximize,
};

export function initSettings() {
  settingAutostart.addEventListener("change", () => {
    state.settings.autostart = settingAutostart.checked;
    saveSettingsApi(state.settings);
  });

  settingStartMinimized.addEventListener("change", () => {
    state.settings.start_minimized = settingStartMinimized.checked;
    saveSettingsApi(state.settings);
  });

  settingZettelkasten.addEventListener("change", () => {
    state.settings.zettelkasten = settingZettelkasten.checked;
    saveSettingsApi(state.settings);
    document.dispatchEvent(new CustomEvent("zettelkastenchange"));
  });

  settingsBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn) BAR_ACTIONS[btn.dataset.action]?.();
  });

  bottomNav.addEventListener("click", (e) => {
    const tabBtn = e.target.closest(".bottom-tab");
    if (!tabBtn) return;

    const targetView = tabBtn.dataset.view;
    if (!targetView || targetView === state.activeMainView) return;

    showMainView(targetView);
  });
}

export function updateSettingsUI() {
  settingAutostart.checked = !!state.settings.autostart;
  settingStartMinimized.checked = !!state.settings.start_minimized;
  settingZettelkasten.checked = !!state.settings.zettelkasten;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Cada janela grava o settings.json inteiro; o Rust avisa todas ("settings-changed") e cada
 * uma atualiza a sua cópia, então a próxima gravação não desfaz o que a outra mudou.
 */
export function initSettingsSync() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  listen("settings-changed", (e) => {
    const next = e.payload || {};
    const prev = { ...state.settings };
    if (Object.keys(next).every((k) => same(prev[k], next[k]))) return;
    Object.assign(state.settings, next);
    updateSettingsUI();
    if (prev.theme !== next.theme) syncThemeFromSettings();
    if (!!prev.zettelkasten !== !!next.zettelkasten) document.dispatchEvent(new CustomEvent("zettelkastenchange"));
    if (prev.notes_storage !== next.notes_storage || prev.vault_path !== next.vault_path) {
      // Outra janela trocou o armazenamento das notas (o backend no Rust já é o novo).
      const ownsNotes = SOLO_APP ? SOLO_APP === "notes" : !state.detached.has("notes");
      document.dispatchEvent(new CustomEvent(ownsNotes ? "notesreload" : "notesstoragechange"));
    } else if (!same(prev.vaults, next.vaults)) {
      document.dispatchEvent(new CustomEvent("notesstoragechange"));
    }
  });
}

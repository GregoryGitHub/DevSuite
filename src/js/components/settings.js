import { state } from "../state.js";
import { saveSettingsApi } from "../api.js";
import { showMainView } from "../navigation.js";

const bottomNav = document.getElementById("bottom-nav");
const settingAutostart = document.getElementById("setting-autostart");
const settingStartMinimized = document.getElementById("setting-start-minimized");
const settingZettelkasten = document.getElementById("setting-zettelkasten");

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

import { state } from "./js/state.js";
import { loadSettingsApi, loadHttpDataApi, loadDbDataApi } from "./js/api.js";
import { SOLO_APP } from "./js/windowContext.js";
import { initTasks, reloadKanban } from "./js/components/tasks.js";
import { initNotes, loadNotes } from "./js/components/notes.js";
import { initHttp, setHttpData } from "./js/components/http.js";
import { initJsonFormatter } from "./js/components/jsonFormatter.js";
import { initDb, setDbData } from "./js/components/db.js";
import { initRabbit, loadRabbit } from "./js/components/rabbit.js";
import { initSettings, initSettingsSync, updateSettingsUI } from "./js/components/settings.js";
import { initNotesStorage } from "./js/components/notesStorage.js";
import { initWindowControls } from "./js/components/windowControls.js";
import { initWindowMode } from "./js/components/windowMode.js";
import { initTheme, syncThemeFromSettings } from "./js/components/theme.js";
import { initDetach } from "./js/components/detach.js";

// Janela principal: todos os apps. Janela desatachada (SOLO_APP): só aquele app.
const runs = (view) => !SOLO_APP || SOLO_APP === view;

async function load() {
  try {
    state.settings = { ...state.settings, ...(await loadSettingsApi()) };
  } catch (e) {
    console.error("load failed", e);
  }

  syncThemeFromSettings();
  updateSettingsUI();
  if (runs("tasks")) {
    // kanban.json (na 1ª execução, migrado do todos.json antigo).
    await reloadKanban();
  }
  // notes.db (SQLite): only metadata here; each note's HTML loads when it is opened.
  if (runs("notes")) await loadNotes();

  if (runs("http")) {
    try {
      setHttpData(await loadHttpDataApi());
    } catch (e) {
      console.error("http load failed", e);
      setHttpData({});
    }
  }

  if (runs("db")) {
    try {
      setDbData(await loadDbDataApi());
    } catch (e) {
      console.error("db load failed", e);
      setDbData({});
    }
  }

  // rabbit.db (SQLite): conexões, estado da interface e gravações.
  if (runs("rabbit")) await loadRabbit();
}

function initGlobalShortcutListeners() {
  const menuDropdown = document.getElementById("menu-dropdown");

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!menuDropdown.hidden) menuDropdown.hidden = true;
    }
  });
}

function main() {
  initTheme();
  if (runs("tasks")) initTasks();
  if (runs("notes")) initNotes();
  if (runs("http")) initHttp();
  if (runs("json")) initJsonFormatter();
  if (runs("db")) initDb();
  if (runs("rabbit")) initRabbit();
  initSettings();
  initSettingsSync();
  if (!SOLO_APP) initNotesStorage();
  initWindowControls();
  initWindowMode();
  initGlobalShortcutListeners();
  initDetach();

  load();
}

main();

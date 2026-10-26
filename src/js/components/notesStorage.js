import { state } from "../state.js";
import { hasTauri, openDirectoryDialogApi, saveSettingsApi } from "../api.js";
import { switchNotesStorage, createVault } from "./notes.js";
import { addVaultPath, knownVaults, sameVaultPath } from "../utils/vaultNote.js";

// Configurações: onde as notas ficam — banco local (notes.db) ou cofre (pasta de Markdown,
// src-tauri/src/notes_vault.rs). A troca em si fica em notes.js (switchNotesStorage).

const segEl = document.getElementById("setting-notes-storage");
const pathEl = document.getElementById("setting-vault-path");
const listEl = document.getElementById("setting-vault-list");
const statusEl = document.getElementById("setting-vault-status");
const pickBtn = document.getElementById("setting-vault-pick");
const createBtn = document.getElementById("setting-vault-create");
const copyRow = document.getElementById("setting-vault-copy-row");
const copyInput = document.getElementById("setting-vault-copy");

let busy = false;

const isVault = () => state.settings.notes_storage === "vault";

function setStatus(message) {
  statusEl.textContent = message || "";
  statusEl.hidden = !message;
}

/** Notas numa janela própria: a troca fica na barra lateral delas (um escritor só). */
const notesAway = () => state.detached.has("notes");
const AWAY_TEXT = "As Notas estão numa janela própria: troque o armazenamento pela barra lateral delas ou traga-as de volta.";

export function renderNotesStorage() {
  const locked = busy || notesAway();
  for (const btn of segEl.querySelectorAll("[data-storage]")) {
    btn.classList.toggle("active", btn.dataset.storage === (isVault() ? "vault" : "sqlite"));
    btn.disabled = locked;
  }
  pathEl.textContent = state.settings.vault_path || "Nenhuma pasta escolhida";
  // Outros cofres salvos (troca rápida na barra lateral das Notas), com × para tirar da lista.
  const others = knownVaults(state.settings).filter((p) => !state.settings.vault_path || !sameVaultPath(p, state.settings.vault_path));
  listEl.replaceChildren(
    ...others.map((p) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = p;
      const del = document.createElement("button");
      del.type = "button";
      del.title = "Remover da lista (a pasta não é tocada)";
      del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      del.disabled = locked;
      del.addEventListener("click", () => {
        state.settings.vaults = knownVaults(state.settings).filter((x) => !sameVaultPath(x, p));
        saveSettingsApi(state.settings);
        renderNotesStorage();
      });
      li.append(name, del);
      return li;
    }),
  );
  pickBtn.disabled = locked;
  createBtn.disabled = locked;
  copyRow.hidden = isVault();
  if (notesAway()) setStatus(AWAY_TEXT);
  else if (statusEl.textContent === AWAY_TEXT) setStatus("");
}

async function run(mode, path) {
  busy = true;
  setStatus(mode === "vault" ? "Abrindo o cofre…" : "");
  renderNotesStorage();
  const error = await switchNotesStorage(mode, path, { copy: mode === "vault" && copyInput.checked });
  busy = false;
  setStatus(error ? `Não foi possível trocar: ${error}` : "");
  if (!error) copyInput.checked = false;
  renderNotesStorage();
}

async function pickFolder() {
  const dir = await openDirectoryDialogApi({ title: "Pasta do cofre de notas" });
  return dir || null;
}

export function initNotesStorage() {
  segEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-storage]");
    if (!btn || busy || notesAway()) return;
    if (!hasTauri) return setStatus("Disponível apenas no aplicativo desktop.");
    const mode = btn.dataset.storage;
    if (mode === (isVault() ? "vault" : "sqlite")) return;
    if (mode === "sqlite") return run("sqlite", null);
    const path = state.settings.vault_path || (await pickFolder());
    if (path) run("vault", path);
  });

  pickBtn.addEventListener("click", async () => {
    if (busy || notesAway()) return;
    if (!hasTauri) return setStatus("Disponível apenas no aplicativo desktop.");
    const path = await pickFolder();
    if (!path) return;
    if (isVault()) return run("vault", path); // troca de cofre na hora
    // No banco local, só guarda a pasta: o cofre é ativado no seletor acima.
    state.settings.vaults = addVaultPath(knownVaults(state.settings), path);
    state.settings.vault_path = path;
    saveSettingsApi(state.settings);
    setStatus("");
    renderNotesStorage();
  });

  // Cofre novo = pasta criada com repositório git (notes.js -> notes_vault_create) e aberta.
  createBtn.addEventListener("click", async () => {
    if (busy || notesAway()) return;
    if (!hasTauri) return setStatus("Disponível apenas no aplicativo desktop.");
    await createVault();
    renderNotesStorage();
  });

  document.addEventListener("notesstoragechange", renderNotesStorage);
  document.addEventListener("detachedchange", renderNotesStorage);
  document.addEventListener("mainviewchange", () => {
    if (state.activeMainView === "settings") renderNotesStorage();
  });
  renderNotesStorage();
}

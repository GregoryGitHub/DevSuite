import { state } from "../state.js";
import { el, icon } from "../utils/dom.js";
import { mdApi, loadSettingsApi } from "../api.js";
import { initEditor, loadEditor, runCommand, getSelectionState } from "./noteEditor.js";
import { mdFileToHtml, htmlToMdFile } from "../utils/mdDoc.js";
import { fileImageUrl } from "../utils/noteContent.js";
import { setImageTarget } from "../utils/noteImages.js";
import { syncThemeFromSettings } from "./theme.js";
import { initSettingsSync } from "./settings.js";
import { minimizeWindow, toggleMaximize } from "./windowMode.js";
import { MD_FILE, MD_PREVIEW } from "../windowContext.js";
import { openFind, closeFind } from "./noteFind.js";

// Janela de um arquivo .md de fora das Notas (dois cliques no Explorer, "Abrir arquivo
// Markdown…") e a prévia somente leitura do Espaço no Explorer (src-tauri/src/md_files.rs e
// quicklook.rs). Reaproveita o editor das Notas (#nt-editor) sem o resto do app: sem pastas,
// lista, propriedades nem notes.db. O arquivo é a verdade: abrir nunca o regrava; editar grava
// nele (debounce), com conflito por mtime como no cofre.

const tauri = window.__TAURI__;
const appEl = document.getElementById("notes-app");
const popoverEl = document.getElementById("nt-format-popover");
const scroller = document.getElementById("nt-editor-scroll");
const SAVE_DELAY_MS = 800;

const doc = {
  path: MD_FILE?.path || "",
  name: "",
  token: "",
  meta: null, // readMdText: { yaml, eol, bom }
  mtime: null,
  html: "",
  dirty: false,
  conflict: false,
  saving: null,
};
let saveTimer = null;
let closing = false;

const nameEl = el("span.md-name", { "data-tauri-drag-region": true });
const statusEl = el("span.md-status", { "data-tauri-drag-region": true });
const banner = el("div.md-banner", { hidden: true });

// ---------- Layout ----------

/** Só a coluna do editor das Notas, com uma barra própria (nome, estado, janela). */
function buildChrome() {
  document.body.classList.add("desktop-mode", "md-window");
  document.body.classList.toggle("md-preview", MD_PREVIEW);
  document.querySelectorAll(".view-panel").forEach((p) => (p.hidden = p.id !== "view-notes"));
  state.activeMainView = "notes";
  state.desktopMode = true;

  const bar = appEl.querySelector(".nt-tb-editor");
  bar.querySelectorAll('[data-action="new-note"], [data-action="more"], [data-action="graph-local"], [data-action="tray"], [data-detach], .nt-search').forEach((n) => n.remove());
  bar.prepend(el("span.md-title", { "data-tauri-drag-region": true }, icon("fa-brands fa-markdown"), nameEl, statusEl));
  const spacer = bar.querySelector(".nt-tb-spacer");
  if (MD_PREVIEW) {
    spacer.after(el("button.nt-tb-btn.md-edit", { type: "button", "data-md": "edit", title: "Abrir para edição" }, icon("fa-solid fa-pen-to-square"), el("span", {}, "Editar")));
  } else {
    spacer.after(el("button.nt-tb-btn", { type: "button", "data-md": "reveal", title: "Mostrar na pasta" }, icon("fa-regular fa-folder-open")));
  }
  bar.querySelectorAll('[data-action="close-desktop"]').forEach((b) => (b.title = MD_PREVIEW ? "Fechar (Esc)" : "Fechar"));
  scroller.before(banner);
  scroller.tabIndex = -1; // setas/PageDown rolam a prévia
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `md-status${kind ? ` ${kind}` : ""}`;
}

function setName(name) {
  doc.name = name;
  nameEl.textContent = name;
  document.title = `${name} — Dev Suite`;
}

// ---------- Popover de formatação (como em notes.js) ----------

function handleSelectionState(sel) {
  appEl.querySelectorAll('[data-cmd="check"]').forEach((b) => b.classList.toggle("active", sel?.list === "check"));
  appEl.querySelectorAll('[data-cmd="table"]').forEach((b) => b.classList.toggle("active", !!sel?.table));
  if (popoverEl.hidden) return;
  popoverEl.querySelectorAll("[data-style]").forEach((b) => b.classList.toggle("active", sel?.style === b.dataset.style && !sel?.list));
  popoverEl.querySelectorAll("[data-list]").forEach((b) => b.classList.toggle("active", sel?.list === b.dataset.list));
  popoverEl.querySelectorAll("[data-quote]").forEach((b) => b.classList.toggle("active", !!sel?.quote));
  popoverEl.querySelectorAll("[data-inline]").forEach((b) => b.classList.toggle("active", !!sel?.[b.dataset.inline]));
}

function openPopover(anchor) {
  popoverEl.hidden = false;
  const a = anchor.getBoundingClientRect();
  const host = appEl.getBoundingClientRect();
  popoverEl.style.left = `${Math.max(8, Math.min(a.left - host.left, host.width - popoverEl.offsetWidth - 8))}px`;
  popoverEl.style.top = `${a.bottom - host.top + 6}px`;
  anchor.classList.add("active");
  handleSelectionState(getSelectionState());
}

function closePopover() {
  popoverEl.hidden = true;
  appEl.querySelectorAll("[data-popover].active").forEach((b) => b.classList.remove("active"));
}

// ---------- Arquivo ----------

/** Lê o arquivo do disco e mostra no editor. */
async function loadFile(path, { readOnly = false } = {}) {
  const r = await mdApi.read(path);
  const { html, meta } = mdFileToHtml(r.text, r.token);
  Object.assign(doc, { path, token: r.token, meta, mtime: r.mtime, html, dirty: false, conflict: false });
  setName(r.name);
  banner.hidden = true;
  loadEditor(html, { readOnly, key: readOnly ? null : `md:${path}` });
  scroller.scrollTop = 0;
}

function onInput(html) {
  if (MD_PREVIEW) return;
  doc.html = html;
  doc.dirty = true;
  if (!doc.conflict) setStatus("Editando…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), SAVE_DELAY_MS);
}

/** Grava se houver edição. `force` = sobrescreve mesmo com o arquivo alterado no disco. */
async function save({ force = false } = {}) {
  clearTimeout(saveTimer);
  while (doc.saving) await doc.saving;
  if (!doc.dirty || (doc.conflict && !force)) return;
  const text = htmlToMdFile(doc.html, doc.meta);
  doc.dirty = false;
  doc.saving = (async () => {
    try {
      const r = await mdApi.write(doc.path, text, force ? null : doc.mtime);
      if (r.conflict) {
        doc.dirty = true;
        showConflict();
        return;
      }
      doc.mtime = r.mtime;
      doc.conflict = false;
      banner.hidden = true;
      setStatus("Salvo", "ok");
    } catch (e) {
      doc.dirty = true;
      setStatus(`Erro ao salvar: ${e}`, "bad");
    }
  })();
  await doc.saving;
  doc.saving = null;
}

function showConflict() {
  doc.conflict = true;
  setStatus("Alterado fora do app", "bad");
  banner.innerHTML = "";
  banner.append(
    icon("fa-solid fa-triangle-exclamation"),
    el("span", {}, "O arquivo foi alterado fora do Dev Suite. Sua versão ainda não foi gravada."),
    el("button", { type: "button", onclick: () => reloadFromDisk() }, "Recarregar do disco"),
    el("button", { type: "button", onclick: () => save({ force: true }) }, "Sobrescrever"),
  );
  banner.hidden = false;
}

async function reloadFromDisk() {
  try {
    await loadFile(doc.path);
    setStatus("Recarregado do disco", "ok");
  } catch (e) {
    setStatus(String(e), "bad");
  }
}

/** Ao voltar para a janela: sem edição pendente, relê se o arquivo mudou no disco. */
async function checkDisk() {
  if (doc.dirty || doc.saving || doc.conflict || !doc.path) return;
  try {
    const r = await mdApi.read(doc.path);
    if (r.mtime !== doc.mtime && !doc.dirty) {
      const top = scroller.scrollTop;
      const { html, meta } = mdFileToHtml(r.text, r.token);
      Object.assign(doc, { meta, mtime: r.mtime, html });
      loadEditor(html, { key: `md:${doc.path}` });
      scroller.scrollTop = top;
      setStatus("Atualizado do disco", "ok");
    }
  } catch {
    /* arquivo removido/renomeado: fica o que está na tela */
  }
}

/** Antes de fechar/sair: grava; com conflito, a versão do app vai para uma cópia ao lado. */
async function flush() {
  await save();
  if (!doc.conflict || !doc.dirty) return;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
  const copy = doc.path.replace(/(\.[^.\\/]+)?$/, (ext) => ` (conflito ${stamp})${ext || ".md"}`);
  try {
    await mdApi.write(copy, htmlToMdFile(doc.html, doc.meta), null);
  } catch (e) {
    console.error("md conflict copy failed", e);
  }
}

async function closeSelf() {
  if (closing) return;
  closing = true;
  document.activeElement?.blur?.();
  await flush();
  mdApi.closeWindow().catch(() => (closing = false));
}

// ---------- Prévia ----------

let previewSeq = 0;

async function showPreview(path) {
  const seq = ++previewSeq;
  try {
    await loadFile(path, { readOnly: true });
  } catch (e) {
    if (seq !== previewSeq) return;
    loadEditor(`<p>${String(e).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>`, { readOnly: true });
  }
  if (seq !== previewSeq) return;
  setStatus("Somente leitura");
  await mdApi.previewReady();
  scroller.focus({ preventScroll: true });
}

function hidePreview() {
  closePopover();
  closeFind({ select: false });
  mdApi.previewHide().catch(() => {});
}

// ---------- Início ----------

function bindEvents() {
  appEl.addEventListener("mousedown", (e) => {
    // Botões da barra não tiram o cursor do editor.
    if (e.target.closest("[data-cmd], [data-popover]")) e.preventDefault();
    if (!popoverEl.hidden && !e.target.closest("#nt-format-popover, [data-popover]")) closePopover();
  });
  appEl.addEventListener("click", (e) => {
    const pop = e.target.closest("[data-popover]");
    if (pop && !MD_PREVIEW) return popoverEl.hidden ? openPopover(pop) : closePopover();
    const cmd = e.target.closest("[data-cmd]");
    if (cmd && !cmd.disabled && !MD_PREVIEW) {
      if (cmd.dataset.cmd === "code") closePopover();
      return runCommand(cmd.dataset.cmd);
    }
    const md = e.target.closest("[data-md]");
    if (md?.dataset.md === "reveal") return mdApi.reveal(doc.path).catch((err) => setStatus(String(err), "bad"));
    if (md?.dataset.md === "edit") {
      const path = doc.path;
      hidePreview();
      return mdApi.open(path).catch((err) => setStatus(String(err), "bad"));
    }
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "minimize") minimizeWindow();
    else if (action === "maximize") toggleMaximize();
    else if (action === "close-desktop") MD_PREVIEW ? hidePreview() : closeSelf();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popoverEl.hidden) return closePopover();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      return openFind();
    }
    if (e.target.closest?.(".nt-find")) return; // digitando na busca (Espaço não fecha a prévia)
    if (MD_PREVIEW) {
      // Como o Quick Look: Espaço ou Esc fecham a prévia.
      if (e.key === "Escape" || (e.key === " " && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        hidePreview();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });
}

export async function initMdFile() {
  buildChrome();
  initEditor({ onInput, onSelection: handleSelectionState });
  bindEvents();
  // Imagens coladas ficam ao lado do arquivo (attachments/), com caminho relativo no .md.
  setImageTarget({
    save: async (bytes, ext) => fileImageUrl(doc.token, await mdApi.saveImage(doc.token, bytes, ext)),
    copy: async (path) => fileImageUrl(doc.token, await mdApi.importImage(doc.token, path)),
  });

  try {
    state.settings = { ...state.settings, ...(await loadSettingsApi()) };
  } catch {}
  syncThemeFromSettings();
  initSettingsSync();
  if (!tauri?.event) return;

  // Um evento sem permissão (capabilities/default.json precisa listar "md-*") não pode
  // impedir o resto: cada listen falha sozinho, com o erro no console e na barra.
  const listen = (name, fn) =>
    tauri.event.listen(name, fn).catch((e) => {
      console.error(`md listen ${name} failed`, e);
      setStatus(`Erro: ${e}`, "bad");
    });
  listen("app-exit", async () => {
    await flush();
    tauri.core.invoke("app_flushed").catch(() => {});
  });

  if (MD_PREVIEW) {
    await listen("md-preview-show", (e) => showPreview(e.payload));
    window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && hidePreview(), 120));
    return;
  }

  // O arquivo primeiro: é o que o usuário está esperando ver.
  try {
    await loadFile(doc.path);
    setStatus("");
  } catch (e) {
    setName(doc.path.split(/[\\/]/).pop() || doc.path);
    setStatus(String(e), "bad");
    loadEditor("", { readOnly: true });
  }
  listen("md-close-requested", closeSelf);
  window.addEventListener("focus", checkDisk);
  window.addEventListener("blur", () => save());
}

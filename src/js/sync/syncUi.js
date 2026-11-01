// Sincronização das Notas com a nuvem na interface do app Notas: conta (e-mail + senha) nas
// Configurações, pílula de status na barra lateral das Notas e quando sincronizar (ao abrir,
// ao voltar para o app, com a rede de volta, logo depois de gravar, quando outro aparelho
// grava e a cada poucos minutos). O motor é o syncEngine.js; a nuvem, o firebaseRemote.js.

import { state } from "../state.js";
import { syncApi } from "../api.js";
import { isTauri, isIOS } from "../platform.js";
import { webSyncApi } from "../web/webNotesApi.js";
import { canonicalNoteHtml, normalizeNoteHtml } from "../utils/noteContent.js";
import { el } from "../utils/dom.js";
import { createSyncEngine } from "./syncEngine.js";
import { firebaseEnabled } from "./firebaseConfig.js";

const AFTER_WRITE_MS = 3000;
const PERIODIC_MS = 3 * 60 * 1000;
const DEVICE_KEY = "notas-device";

const local = isTauri ? syncApi : webSyncApi;

let status = { state: "off", text: "Sincronização desligada" };
let engine = null;
let stopWatch = null;
let timer = null;
let pill = null;
let panel = null;
let panelFor = undefined; // conta para a qual o painel foi montado (só o status muda depois)
let statusEl = null;
let firebase = null; // módulo firebaseRemote.js, carregado só com o Firebase configurado

function defaultDevice() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (isIOS && !/iPhone/.test(ua))) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return isTauri ? "PC" : "Navegador (PC)";
  if (/Mac/.test(ua)) return isTauri ? "Mac" : "Navegador (Mac)";
  return isTauri ? "Linux" : "Navegador";
}

function deviceName() {
  try {
    return localStorage.getItem(DEVICE_KEY) || defaultDevice();
  } catch {
    return defaultDevice();
  }
}

const vaultActive = () => isTauri && state.settings.notes_storage === "vault";

function setStatus(next) {
  status = next;
  if (pill) {
    pill.dataset.state = status.state;
    pill.querySelector("span").textContent = status.text;
    pill.title = status.detail || status.text;
    pill.querySelector("i").className = {
      off: "fa-solid fa-cloud",
      ok: "fa-solid fa-cloud",
      pending: "fa-solid fa-cloud-arrow-up",
      syncing: "fa-solid fa-rotate",
      offline: "fa-solid fa-plane",
      error: "fa-solid fa-triangle-exclamation",
    }[status.state];
  }
  renderPanel();
}

function since(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function runSync() {
  if (!engine || vaultActive()) return;
  if (!navigator.onLine) return setStatus({ state: "offline", text: "Offline", detail: "Sem conexão: as alterações sobem quando a internet voltar" });
  setStatus({ state: "syncing", text: "Sincronizando…" });
  try {
    const r = await engine.sync();
    setStatus(
      r.pending
        ? { state: "pending", text: `${r.pending} pendente(s)` }
        : { state: "ok", text: `Atualizado ${since(Date.now())}`, detail: `Última sincronização: ${new Date().toLocaleString()}` },
    );
  } catch (e) {
    console.error("sync failed", e);
    const offline = !navigator.onLine || e?.code === "unavailable" || /network|offline/i.test(e?.message || "");
    setStatus(
      offline
        ? { state: "offline", text: "Offline", detail: "Sem conexão: as alterações sobem quando a internet voltar" }
        : { state: "error", text: "Erro no sync", detail: String(e?.message || e) },
    );
  }
}

function syncSoon(ms = AFTER_WRITE_MS) {
  if (!engine) return;
  clearTimeout(timer);
  timer = setTimeout(runSync, ms);
}

/** Entrou numa conta: começa a sincronizar. Outra conta que a última = recomeça do zero. */
async function startFor(user) {
  stopWatch?.();
  stopWatch = null;
  engine = null;
  if (!user) return setStatus({ state: "off", text: "Sincronizar…", detail: "Entre numa conta para sincronizar entre aparelhos" });
  if (vaultActive()) return setStatus({ state: "off", text: "Sem sync (cofre)", detail: "Com um cofre aberto a sincronização fica desligada: ela vale só para as notas no banco local" });
  try {
    if ((await local.metaGet("uid")) !== user.uid) {
      await local.reset();
      await local.metaSet("uid", user.uid);
    }
  } catch (e) {
    return setStatus({ state: "error", text: "Falha ao preparar o sync", detail: String(e) });
  }
  const { syncHost } = await import("../components/notes.js");
  const remote = firebase.firebaseRemote(user.uid, deviceName());
  engine = createSyncEngine({
    local,
    remote,
    host: syncHost,
    device: deviceName(),
    canonical: canonicalNoteHtml,
    normalize: normalizeNoteHtml,
    log: (m) => console.warn("sync:", m),
  });
  await runSync();
  stopWatch = remote.watch(() => syncSoon(500));
}

// ---------- Interface ----------

/** Status no rodapé das pastas, ao lado de "Nova Pasta" (como o "Atualizado agora" do iOS). */
function renderPill() {
  const newFolder = document.querySelector("#notes-app .nt-sidebar > .nt-new-folder");
  if (!newFolder || pill) return;
  pill = el("button", { type: "button", class: "sync-pill", "data-state": "off" }, el("i", { class: "fa-solid fa-cloud" }), el("span", {}, ""));
  pill.addEventListener("click", () => {
    if (engine) runSync();
    else document.querySelector("[data-notas-go=settings]")?.click();
  });
  const foot = el("div", { class: "notas-sidebar-foot" });
  newFolder.replaceWith(foot);
  foot.append(newFolder, pill);
}

/** Item "Conta e sincronização" no topo das Configurações. */
function renderPanel() {
  const list = document.querySelector("#view-settings .settings-list");
  if (!list) return;
  if (!panel) {
    panel = el("div", { class: "setting-item", id: "setting-sync" });
    list.prepend(panel);
  }
  const user = firebase?.account.current() || null;
  const statusText = status.state === "error" ? `${status.text}: ${status.detail}` : status.state === "ok" ? status.text : status.detail || status.text;
  // Mesma conta: só o status (não refaz campos que podem estar em edição).
  if (panelFor !== undefined && panelFor === (user?.uid ?? null) && statusEl) {
    statusEl.textContent = statusText;
    statusEl.classList.toggle("ok", status.state === "ok");
    return;
  }
  panelFor = firebaseEnabled() ? (user?.uid ?? null) : undefined;
  statusEl = null;
  const info = el("div", { class: "sync-account" });
  info.append(el("span", { class: "setting-title" }, "Conta e sincronização"));

  if (!firebaseEnabled()) {
    info.append(el("span", { class: "setting-desc" }, "Configure o projeto Firebase em src/js/sync/firebaseConfig.js para sincronizar as notas entre aparelhos."));
    return panel.replaceChildren(info);
  }
  if (!user) {
    info.append(el("span", { class: "setting-desc" }, "Entre para manter as notas e as imagens iguais no computador e no celular. Sem conta, tudo fica só neste aparelho."));
    statusEl = el("span", { class: "setting-desc", hidden: true });
    info.append(loginForm(), statusEl);
    return panel.replaceChildren(info);
  }
  const device = el("input", { type: "text", value: deviceName(), maxlength: "40", title: "Nome deste aparelho (aparece nas cópias de conflito)" });
  device.addEventListener("change", () => {
    try {
      localStorage.setItem(DEVICE_KEY, device.value.trim() || defaultDevice());
    } catch {}
    startFor(firebase.account.current());
  });
  statusEl = el("span", { class: `setting-desc setting-status${status.state === "ok" ? " ok" : ""}` }, statusText);
  info.append(
    el("span", { class: "setting-desc" }, `Conectado como ${user.email}`),
    statusEl,
    el("form", { class: "sync-form", onsubmit: (e) => e.preventDefault() }, el("label", { class: "setting-desc" }, "Nome deste aparelho"), device),
  );
  const syncBtn = el("button", { type: "button", class: "setting-btn" }, "Sincronizar agora");
  syncBtn.addEventListener("click", runSync);
  const out = el("button", { type: "button", class: "setting-btn" }, "Sair");
  out.addEventListener("click", async () => {
    await firebase.account.signOut();
  });
  panel.replaceChildren(info, el("div", { class: "sync-form sync-actions" }, syncBtn, out));
}

function loginForm() {
  const email = el("input", { type: "email", placeholder: "E-mail", autocomplete: "username", required: "" });
  const pass = el("input", { type: "password", placeholder: "Senha", autocomplete: "current-password", required: "" });
  const error = el("span", { class: "sync-error" });
  const busy = (on) => form.querySelectorAll("button").forEach((b) => (b.disabled = on));
  const run = async (fn) => {
    error.textContent = "";
    busy(true);
    try {
      await fn();
    } catch (e) {
      error.textContent = firebase.authMessage(e);
    } finally {
      busy(false);
    }
  };
  const signIn = el("button", { type: "submit", class: "setting-btn" }, "Entrar");
  const signUp = el("button", { type: "button", class: "setting-btn" }, "Criar conta");
  const reset = el("button", { type: "button", class: "setting-btn" }, "Esqueci a senha");
  const form = el("form", { class: "sync-form" }, email, pass, el("div", { class: "sync-actions" }, signIn, signUp, reset), error);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(() => firebase.account.signIn(email.value.trim(), pass.value));
  });
  signUp.addEventListener("click", () => {
    if (!form.reportValidity()) return;
    run(() => firebase.account.signUp(email.value.trim(), pass.value));
  });
  reset.addEventListener("click", () => {
    if (!email.value.trim()) return (error.textContent = "Digite o e-mail.");
    run(async () => {
      await firebase.account.resetPassword(email.value.trim());
      error.textContent = "Enviamos um e-mail para trocar a senha.";
    });
  });
  return form;
}

export async function initSync() {
  renderPill();
  renderPanel();
  if (!firebaseEnabled()) return setStatus({ state: "off", text: "Só neste aparelho", detail: "Sincronização não configurada (src/js/sync/firebaseConfig.js)" });
  try {
    firebase = await import("./firebaseRemote.js");
  } catch (e) {
    console.error("firebase load failed", e);
    return setStatus({ state: "error", text: "Falha ao carregar o Firebase", detail: String(e) });
  }
  firebase.account.watch((user) => startFor(user));

  document.addEventListener("noteslocalwrite", () => syncSoon());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncSoon(300);
  });
  window.addEventListener("online", () => syncSoon(300));
  window.addEventListener("offline", () => engine && setStatus({ state: "offline", text: "Offline", detail: "Sem conexão: as alterações sobem quando a internet voltar" }));
  window.addEventListener("focus", () => syncSoon(300));
  setInterval(() => {
    if (!document.hidden) runSync();
  }, PERIODIC_MS);
  // Trocou entre banco local e cofre (desktop): liga/desliga o sync.
  document.addEventListener("notesstoragechange", () => startFor(firebase.account.current()));
}

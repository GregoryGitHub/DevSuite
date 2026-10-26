import { state } from "../state.js";
import { el, icon } from "../utils/dom.js";
import { gitApi, hasTauri } from "../api.js";
import { isVault } from "../noteStore.js";
import { remoteDialog, identityDialog, gitModal } from "./gitDialogs.js";

// Painel Git das Notas (metade de baixo da barra lateral, só no modo cofre e no desktop),
// no espírito da janela "Commit" das IDEs da JetBrains:
//  - Alterações: árvore por pasta com caixas de seleção (Conflitos / Alterações / Não
//    versionados), clique abre o diff, duplo clique abre a nota; mensagem + Commit / Commit e Push;
//  - Histórico: commits do cofre (ou de um arquivo), clique mostra os arquivos e o diff de cada um;
//  - Fetch / Pull / Push com ↑N ↓M, remoto opcional configurado pela interface.
// O git roda no Rust (src-tauri/src/notes_git.rs); o diff fica em diffView.js.

const SPLIT_KEY = "nt-vcs-split";
const COLLAPSED_KEY = "nt-vcs-collapsed"; // "0" = aberto; padrão recolhido (como as seções do VS Code)
const LOG_PAGE = 100;
const POLL_MS = 30_000;

const STATUS_LABEL = {
  modified: "Modificado",
  added: "Adicionado",
  deleted: "Apagado",
  renamed: "Renomeado/movido",
  untracked: "Não versionado",
  conflicted: "Em conflito",
};

const MSG_KEY = () => `nt-vcs-msg:${state.settings.vault_path || ""}`;

function readStore(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const isMd = (p) => /\.(md|markdown|mdown|mkd)$/i.test(p);
const displayName = (p) => (isMd(p) ? baseName(p).replace(/\.[^.]+$/, "") : baseName(p));

function fileIcon(path) {
  if (isMd(path)) return "fa-regular fa-file-lines";
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path)) return "fa-regular fa-file-image";
  return "fa-regular fa-file";
}

function relativeDate(secs) {
  const diff = secs * 1000 - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  if (abs < 60_000) return "agora";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), "day");
  return new Date(secs * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * host: { toast, showMenu(x, y, items), flush(): Promise, sync(): Promise, noteByRel(rel),
 *         openNote(note), openDiff(spec), closeDiff(), diffSpec() }
 */
export function createGitPanel(appEl, host) {
  const sidebar = appEl.querySelector(".nt-sidebar");
  const panel = document.getElementById("nt-vcs");
  const splitter = document.getElementById("nt-vcs-split");
  const storageBtn = appEl.querySelector('[data-action="storage-menu"]');

  let info = null;
  let status = null;
  let busy = null; // { label, opId }
  let tab = "changes";
  let selected = null; // caminho selecionado na lista
  const unchecked = new Set(); // caminhos desmarcados (arquivos novos entram marcados)
  const collapsed = new Set(); // grupos/pastas recolhidos
  let amend = false;
  let log = [];
  let logDone = false;
  let logLoading = false;
  let logFilter = null; // { path, name }
  let logOpen = null; // hash expandido
  const logFiles = new Map();
  let refreshTimer = null;
  let refreshing = null;
  let pollTimer = null;
  let loadedFor = null; // cofre para o qual info/status valem

  // ----- estrutura -----

  const tabBtn = (id, label) => el("button.nt-vcs-tab", { type: "button", dataset: { tab: id }, onclick: () => setTab(id) }, label);
  const tabChanges = tabBtn("changes", "Alterações");
  const tabLog = tabBtn("log", "Histórico");
  const branchEl = el("span.nt-vcs-branch");
  const tool = (iconCls, title, run) => el("button.nt-vcs-tool", { type: "button", title, onclick: run }, icon(iconCls));
  const tools = {
    refresh: tool("fa-solid fa-rotate", "Atualizar status", () => refresh({ full: true })),
    rollback: tool("fa-solid fa-rotate-left", "Reverter os arquivos marcados…", () => rollback(checkedFiles())),
    fetch: tool("fa-solid fa-cloud-arrow-down", "Fetch (buscar o remoto sem mexer nas notas)", fetchRemote),
    pull: tool("fa-solid fa-arrow-down", "Pull (trazer as alterações do remoto)", pull),
    push: tool("fa-solid fa-arrow-up", "Push (enviar os commits)", push),
    remote: tool("fa-solid fa-cloud", "Repositório remoto…", editRemote),
  };
  const busyEl = el("div.nt-vcs-busy");
  const toolbar = el("div.nt-vcs-tools", {},
    tools.refresh, tools.rollback, el("span.nt-vcs-sep"), tools.fetch, tools.pull, tools.push, el("span.nt-vcs-sep"), tools.remote, busyEl);
  const banner = el("div.nt-vcs-banner");
  const listEl = el("div.nt-vcs-list", { tabindex: "0" });
  const msgEl = el("textarea.nt-vcs-msg", { placeholder: "Mensagem do commit (Ctrl+Enter)", rows: 3, spellcheck: true });
  const amendEl = el("input", { type: "checkbox" });
  const commitBtn = el("button.nt-vcs-commit-btn", { type: "button", onclick: () => commit({ andPush: false }) }, "Commit");
  const pushBtn = el("button.nt-vcs-commit-btn.secondary", { type: "button", title: "Commit e Push", onclick: () => commit({ andPush: true }) }, "Commit e Push");
  const commitBox = el("div.nt-vcs-commit", {},
    msgEl,
    el("div.nt-vcs-commit-row", {},
      el("label.nt-vcs-amend", { title: "Corrigir o último commit (amend)" }, amendEl, "Corrigir último"),
      el("span.nt-vcs-grow"),
      pushBtn, commitBtn));
  const changesView = el("div.nt-vcs-view.changes", {}, listEl, commitBox);
  const logHead = el("div.nt-vcs-log-head");
  const logList = el("div.nt-vcs-log", { tabindex: "0" });
  const logView = el("div.nt-vcs-view.log", {}, logHead, logList);
  // Cabeçalho da seção: recolhe/expande o painel (as pastas ficam com a altura toda).
  let panelCollapsed = readStore(COLLAPSED_KEY, "1") !== "0";
  const titleChev = el("i.nt-vcs-title-chev");
  const titleBadge = el("span.nt-vcs-badge");
  const titleEl = el("button.nt-vcs-title", { type: "button", onclick: () => setCollapsed(!panelCollapsed) },
    titleChev, el("span.nt-vcs-title-text", {}, "Controle de versão"), titleBadge, branchEl);
  panel.replaceChildren(
    titleEl,
    el("div.nt-vcs-body", {},
      el("div.nt-vcs-head", {}, el("div.nt-vcs-tabs", {}, tabChanges, tabLog)),
      toolbar,
      banner,
      changesView,
      logView),
  );

  function setCollapsed(value) {
    panelCollapsed = value;
    writeStore(COLLAPSED_KEY, value ? "1" : "0");
    render();
    if (!value) refresh();
  }

  // ----- divisão da barra lateral -----

  const ratio = () => Math.min(0.85, Math.max(0.15, Number(readStore(SPLIT_KEY, "0.5")) || 0.5));
  appEl.style.setProperty("--nt-vcs-ratio", ratio());
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const h = sidebar.getBoundingClientRect().height || 1;
    const startY = e.clientY;
    const start = ratio();
    let value = start;
    splitter.setPointerCapture(e.pointerId);
    document.body.classList.add("db-resizing-y");
    const move = (ev) => {
      value = Math.min(0.85, Math.max(0.15, start - (ev.clientY - startY) / h));
      appEl.style.setProperty("--nt-vcs-ratio", value);
    };
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      splitter.removeEventListener("pointercancel", up);
      document.body.classList.remove("db-resizing-y");
      writeStore(SPLIT_KEY, String(value));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
    splitter.addEventListener("pointercancel", up);
  });
  splitter.addEventListener("dblclick", () => {
    writeStore(SPLIT_KEY, "0.5");
    appEl.style.setProperty("--nt-vcs-ratio", 0.5);
  });

  // ----- mensagem -----

  msgEl.value = readStore(MSG_KEY(), "");
  msgEl.addEventListener("input", () => writeStore(MSG_KEY(), msgEl.value || null));
  msgEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      commit({ andPush: e.shiftKey });
    }
    e.stopPropagation(); // atalhos das Notas (Ctrl+N, Ctrl+F...) não valem aqui
  });
  amendEl.addEventListener("change", async () => {
    amend = amendEl.checked;
    if (amend && !msgEl.value.trim()) {
      try {
        const [last] = await gitApi.log(null, 0, 1);
        if (last && !msgEl.value.trim()) msgEl.value = last.body ? `${last.subject}\n\n${last.body}` : last.subject;
      } catch {}
    }
    renderCommitBox();
  });

  // ----- dados -----

  const active = () => hasTauri && isVault() && state.desktopMode && state.activeMainView === "notes";

  async function refresh({ full = false } = {}) {
    if (!hasTauri || !isVault()) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const vault = state.settings.vault_path;
      if (full || !info || loadedFor !== vault) {
        info = await gitApi.info().catch((e) => ({ available: false, error: String(e) }));
        loadedFor = vault;
      }
      status = info.available && info.repo ? await gitApi.status().catch((e) => ({ error: String(e), files: [] })) : null;
      render();
      if (tab === "log" && (full || !log.length)) loadLog(true);
    })().finally(() => (refreshing = null));
    return refreshing;
  }

  function refreshSoon(ms = 1200) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(), ms);
  }

  async function loadLog(reset = false) {
    if (!info?.repo || logLoading) return;
    if (reset) {
      log = [];
      logDone = false;
      logFiles.clear();
    }
    if (logDone) return;
    logLoading = true;
    renderLog();
    try {
      const page = await gitApi.log(logFilter?.path ?? null, log.length, LOG_PAGE);
      log = log.concat(page);
      logDone = page.length < LOG_PAGE;
    } catch (e) {
      host.toast(`Falha ao ler o histórico: ${e}`);
      logDone = true;
    } finally {
      logLoading = false;
      renderLog();
    }
  }

  // ----- operações -----

  async function op(label, fn, { remote = false } = {}) {
    if (busy) {
      host.toast(`Aguarde: ${busy.label.toLowerCase()} em andamento.`);
      return undefined;
    }
    busy = { label, opId: remote ? `git-${Date.now()}` : null };
    renderHead();
    try {
      return await fn(busy.opId);
    } catch (e) {
      host.toast(`${label}: ${e}`);
      return undefined;
    } finally {
      busy = null;
      renderHead();
    }
  }

  function checkedFiles() {
    return (status?.files || []).filter((f) => f.status !== "conflicted" && !unchecked.has(f.path));
  }

  async function ensureIdentity() {
    if (info?.user_email && info?.user_name) return true;
    if (!(await identityDialog(info))) return false;
    info = await gitApi.info();
    return !!info.user_email;
  }

  async function commit({ andPush }) {
    if (!status) return;
    const message = msgEl.value.trim();
    if (!message) {
      host.toast("Escreva a mensagem do commit.");
      return msgEl.focus();
    }
    const files = checkedFiles();
    if (status.files.some((f) => f.status === "conflicted")) return host.toast("Resolva os conflitos antes de commitar.");
    if (!files.length && !amend && !status.merging) return host.toast("Marque ao menos um arquivo para commitar.");
    if (!(await ensureIdentity())) return;
    await host.flush();
    const paths = [...new Set(files.flatMap((f) => [f.path, f.orig_path].filter(Boolean)))];
    const hash = await op("Commit", () => gitApi.commit(paths, message, amend));
    if (!hash) return refresh();
    msgEl.value = "";
    writeStore(MSG_KEY(), null);
    amend = amendEl.checked = false;
    host.toast(`Commit ${hash} criado (${files.length} arquivo${files.length === 1 ? "" : "s"}).`);
    await refresh();
    syncDiff();
    if (tab === "log") loadLog(true);
    else log = [];
    if (andPush) await push();
  }

  async function rollback(files) {
    files = files.filter((f) => f.status !== "conflicted");
    if (!files.length) return host.toast("Marque os arquivos que quer reverter.");
    const fresh = files.filter((f) => f.status === "untracked" || f.status === "added").length;
    const ok = await gitModal.confirm({
      title: "Reverter alterações",
      message:
        files.length === 1
          ? `Desfazer as alterações de "${displayName(files[0].path)}"? ${fresh ? "O arquivo é novo: vai para Apagadas Recentemente." : "Ele volta à versão do último commit."}`
          : `Desfazer as alterações de ${files.length} arquivos? Os modificados voltam à versão do último commit${fresh ? `; ${fresh} novo(s) vão para Apagadas Recentemente` : ""}.`,
      confirmLabel: "Reverter",
      danger: true,
    });
    if (!ok) return;
    await host.flush();
    const done = await op("Reverter", () => gitApi.rollback(files).then(() => true));
    await afterWorktreeChange();
    if (done) host.toast(files.length === 1 ? "Alteração revertida." : `${files.length} arquivos revertidos.`);
  }

  /** Arquivos mudaram por baixo das Notas: relê o cofre, o status e o diff aberto. */
  async function afterWorktreeChange() {
    await host.sync();
    await refresh();
    syncDiff();
  }

  /** O diff aberto da cópia de trabalho segue o status: fecha se o arquivo não mudou mais. */
  function syncDiff() {
    const spec = host.diffSpec();
    if (spec && !spec.rev) {
      if (spec.kind === "conflict" && !status?.files.some((f) => f.path === spec.path && f.status === "conflicted")) host.closeDiff();
      else if (!status?.files.some((f) => f.path === spec.path)) host.closeDiff();
      else host.refreshDiff();
    }
  }

  async function editRemote() {
    if (!info?.repo) return;
    if (await remoteDialog(info.remote_url)) await refresh({ full: true });
  }

  async function fetchRemote() {
    if (!info?.remote_url) return editRemote();
    const msg = await op("Fetch", (id) => gitApi.fetch(id), { remote: true });
    if (msg !== undefined) host.toast("Fetch concluído.");
    await refresh();
  }

  async function pull() {
    if (!info?.remote_url) return editRemote();
    await host.flush();
    const res = await op("Pull", (id) => gitApi.pull(id), { remote: true });
    await afterWorktreeChange();
    if (!res) return;
    if (res.conflicts) {
      host.toast("O pull trouxe conflitos: resolva cada arquivo marcado em vermelho e faça o commit.");
      setTab("changes");
      const first = status?.files.find((f) => f.status === "conflicted");
      if (first) openFile(first);
    } else {
      host.toast(/up to date|atualizad/i.test(res.message) ? "Já está atualizado." : res.message.split("\n")[0] || "Pull concluído.");
    }
    if (tab === "log") loadLog(true);
  }

  async function push() {
    if (!info?.remote_url) {
      await editRemote();
      if (!info?.remote_url) return;
    }
    const msg = await op("Push", (id) => gitApi.push(id), { remote: true });
    if (msg !== undefined) host.toast("Push concluído.");
    await refresh();
    if (tab === "log") loadLog(true);
  }

  async function mergeAbort() {
    const ok = await gitModal.confirm({
      title: "Abortar merge",
      message: "Desfazer o merge em andamento? As notas voltam ao estado de antes do pull.",
      confirmLabel: "Abortar merge",
      danger: true,
    });
    if (!ok) return;
    await host.flush();
    await op("Abortar merge", () => gitApi.mergeAbort());
    await afterWorktreeChange();
  }

  async function initRepo() {
    const done = await op("Ativar controle de versão", () => gitApi.init().then(() => true));
    if (done) host.toast("Controle de versão ativado: as notas aparecem como não versionadas, prontas para o primeiro commit.");
    await refresh({ full: true });
  }

  async function ignore(file) {
    await op("Ignorar", () => gitApi.ignore(file.path));
    await refresh();
  }

  function openFile(file, rev = null) {
    selected = file.path;
    const name = displayName(file.path);
    if (!rev && file.status === "conflicted") {
      host.openDiff({ kind: "conflict", path: file.path, title: name, subtitle: `Conflito de merge · ${file.rel ?? file.path}` });
    } else {
      host.openDiff({
        kind: "pair",
        path: file.path,
        origPath: file.orig_path || null,
        rev,
        title: name,
        subtitle: `${STATUS_LABEL[file.status] || ""} · ${file.rel ?? file.path}${file.orig_path ? ` (era ${file.orig_path})` : ""}`,
      });
    }
    renderList();
  }

  function openNoteOf(file) {
    if (!isMd(file.path) || !file.rel) return false;
    const note = host.noteByRel(file.rel);
    if (!note) return false;
    host.openNote(note);
    return true;
  }

  function fileMenu(e, file) {
    e.preventDefault();
    selected = file.path;
    renderList();
    const items = [];
    if (file.status === "conflicted") items.push({ label: "Resolver conflito…", icon: "fa-solid fa-code-merge", run: () => openFile(file) });
    else items.push({ label: "Mostrar diferenças", icon: "fa-solid fa-code-compare", run: () => openFile(file) });
    if (isMd(file.path) && file.status !== "deleted") items.push({ label: "Abrir nota", icon: "fa-regular fa-note-sticky", disabled: !file.rel || !host.noteByRel(file.rel), run: () => openNoteOf(file) });
    items.push("sep");
    if (file.status !== "conflicted") items.push({ label: "Reverter…", icon: "fa-solid fa-rotate-left", danger: true, run: () => rollback([file]) });
    if (file.status !== "untracked" && file.status !== "added") {
      items.push({ label: "Histórico do arquivo", icon: "fa-solid fa-clock-rotate-left", run: () => showFileHistory(file.orig_path && file.status === "renamed" ? file.path : file.path) });
    }
    if (file.status === "untracked") items.push({ label: "Ignorar (adicionar ao .gitignore)", icon: "fa-solid fa-eye-slash", run: () => ignore(file) });
    host.showMenu(e.clientX, e.clientY, items);
  }

  function showFileHistory(path) {
    logFilter = { path, name: displayName(path) };
    logOpen = null;
    setTab("log");
    loadLog(true);
  }

  function setTab(next) {
    tab = next;
    render();
    if (tab === "log" && !log.length) loadLog(true);
  }

  // ----- desenho -----

  function render() {
    const show = hasTauri && isVault();
    panel.hidden = !show;
    splitter.hidden = !show || panelCollapsed;
    panel.classList.toggle("collapsed", panelCollapsed);
    titleChev.className = `nt-vcs-title-chev fa-solid fa-chevron-${panelCollapsed ? "right" : "down"}`;
    titleEl.title = panelCollapsed ? "Mostrar o controle de versão (git)" : "Recolher o controle de versão";
    storageBtn?.classList.toggle("has-changes", !!status?.files?.length);
    if (!show) return;
    tabChanges.classList.toggle("active", tab === "changes");
    tabLog.classList.toggle("active", tab === "log");
    const n = status?.files?.length || 0;
    titleBadge.textContent = n || "";
    titleBadge.hidden = !n;
    titleBadge.title = `${n} arquivo(s) alterado(s)`;
    changesView.hidden = tab !== "changes";
    logView.hidden = tab !== "log";
    renderHead();
    renderBanner();
    if (tab === "changes") renderList();
    else renderLog();
    renderCommitBox();
  }

  function renderHead() {
    const repo = !!(info?.available && info?.repo);
    toolbar.hidden = !repo;
    tabChanges.parentElement.hidden = !repo;
    const s = status || {};
    branchEl.replaceChildren();
    if (repo) {
      branchEl.append(icon("fa-solid fa-code-branch"), " ", s.branch || (s.head ? `(${s.head})` : "main"));
      if (s.ahead) branchEl.append(el("span.nt-vcs-ab.up", { title: `${s.ahead} commit(s) para enviar` }, `↑${s.ahead}`));
      if (s.behind) branchEl.append(el("span.nt-vcs-ab.down", { title: `${s.behind} commit(s) para trazer` }, `↓${s.behind}`));
      branchEl.title = `${s.branch || "HEAD solto"}${s.upstream ? ` → ${s.upstream}` : info.remote_url ? " (sem upstream: o primeiro push cria)" : " (sem remoto)"}`;
    }
    const remote = !!info?.remote_url;
    tools.fetch.disabled = tools.pull.disabled = !!busy;
    tools.push.disabled = !!busy;
    tools.fetch.classList.toggle("dim", !remote);
    tools.pull.classList.toggle("dim", !remote);
    tools.push.classList.toggle("dim", !remote);
    tools.remote.classList.toggle("active", remote);
    tools.remote.title = remote ? `Remoto: ${info.remote_url}` : "Configurar repositório remoto (opcional)…";
    tools.pull.title = `Pull${s.behind ? ` (${s.behind} para trazer)` : ""}`;
    tools.push.title = `Push${s.ahead ? ` (${s.ahead} para enviar)` : ""}`;
    tools.rollback.disabled = !!busy || !checkedFiles().length;
    commitBtn.disabled = pushBtn.disabled = !!busy;
    busyEl.replaceChildren();
    if (busy) {
      busyEl.append(icon("fa-solid fa-spinner fa-spin"), ` ${busy.label}…`);
      if (busy.opId) {
        const id = busy.opId;
        busyEl.append(el("button.nt-vcs-cancel", { type: "button", title: "Cancelar", onclick: () => gitApi.cancel(id) }, icon("fa-solid fa-xmark")));
      }
    }
  }

  function renderBanner() {
    banner.replaceChildren();
    banner.hidden = true;
    const show = (...children) => {
      banner.hidden = false;
      banner.append(...children);
    };
    if (!info) return show(icon("fa-solid fa-spinner fa-spin"), " Lendo o repositório…");
    if (!info.available) {
      return show(
        el("p", {}, icon("fa-solid fa-code-branch"), " ", info.error && !/git/i.test(info.error) ? info.error : "Controle de versão indisponível: o Git não está instalado."),
        el("p.nt-vcs-hint", {}, "Instale o Git (git-scm.com) e reabra o app. O cofre continua funcionando normalmente."),
      );
    }
    if (!info.repo) {
      return show(
        el("p", {}, "Este cofre ainda não tem controle de versão."),
        el("button.nt-vcs-commit-btn", { type: "button", onclick: initRepo }, icon("fa-solid fa-code-branch"), " Ativar controle de versão (git)"),
      );
    }
    if (status?.error) return show(icon("fa-solid fa-triangle-exclamation"), ` ${status.error}`);
    if (status?.merging) {
      const left = status.files.filter((f) => f.status === "conflicted").length;
      show(
        el("p", {}, icon("fa-solid fa-code-merge"), left ? ` Merge em andamento: ${left} conflito(s) para resolver.` : " Conflitos resolvidos: faça o commit para concluir o merge."),
        el("button.nt-vcs-link", { type: "button", onclick: mergeAbort }, "Abortar merge"),
      );
      if (!left && !msgEl.value.trim()) msgEl.value = "Merge do remoto";
    }
  }

  function renderCommitBox() {
    const repo = !!(info?.available && info?.repo) && !status?.error;
    commitBox.hidden = !repo;
    amendEl.checked = amend;
    amendEl.disabled = !!status?.merging || !status?.head;
    const n = checkedFiles().length;
    commitBtn.textContent = amend ? "Corrigir commit" : status?.merging ? "Commit do merge" : n ? `Commit (${n})` : "Commit";
  }

  /** Árvore { dirs: Map, files: [] } a partir do caminho relativo ao cofre. */
  function tree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const rel = f.rel ?? f.path;
      let node = root;
      for (const part of dirName(rel).split("/").filter(Boolean)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push(f);
    }
    return root;
  }

  function allFiles(node) {
    return [...node.files, ...[...node.dirs.values()].flatMap(allFiles)];
  }

  function checkbox(files) {
    const box = el("input.nt-vcs-check", { type: "checkbox", tabindex: "-1" });
    const on = files.filter((f) => !unchecked.has(f.path)).length;
    box.checked = on === files.length && on > 0;
    box.indeterminate = on > 0 && on < files.length;
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => {
      for (const f of files) {
        if (box.checked) unchecked.delete(f.path);
        else unchecked.add(f.path);
      }
      renderList();
      renderCommitBox();
      renderHead();
    });
    return box;
  }

  function renderList() {
    if (tab !== "changes") return;
    const files = status?.files || [];
    const scrollTop = listEl.scrollTop;
    listEl.replaceChildren();
    if (!info?.repo || status?.error) return;
    if (!files.length) {
      listEl.append(el("div.nt-vcs-empty", {}, icon("fa-solid fa-check"), " Nenhuma alteração desde o último commit."));
      return;
    }
    const groups = [
      ["conflicts", "Conflitos de merge", files.filter((f) => f.status === "conflicted")],
      ["changes", "Alterações", files.filter((f) => f.status !== "conflicted" && f.status !== "untracked")],
      ["untracked", "Não versionados", files.filter((f) => f.status === "untracked")],
    ];
    for (const [id, label, list] of groups) {
      if (!list.length) continue;
      const key = `g:${id}`;
      const open = !collapsed.has(key);
      listEl.append(
        el("div.nt-vcs-row.group", { onclick: () => toggle(key) },
          el("i", { class: `nt-vcs-chev fa-solid fa-chevron-${open ? "down" : "right"}` }),
          id === "conflicts" ? el("span.nt-vcs-check-pad") : checkbox(list),
          el("span.nt-vcs-name", {}, label),
          el("span.nt-vcs-count", {}, list.length)),
      );
      if (open) renderNode(tree(list), 1, key);
    }
    listEl.scrollTop = scrollTop;
  }

  function toggle(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    renderList();
  }

  function renderNode(node, depth, prefix) {
    const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR", { sensitivity: "base" }));
    for (const [name, child] of dirs) {
      const key = `${prefix}/${name}`;
      const open = !collapsed.has(key);
      const files = allFiles(child);
      listEl.append(
        el("div.nt-vcs-row.dir", { style: `--depth:${depth}`, onclick: () => toggle(key) },
          el("i", { class: `nt-vcs-chev fa-solid fa-chevron-${open ? "down" : "right"}` }),
          prefix === "g:conflicts" ? el("span.nt-vcs-check-pad") : checkbox(files),
          icon(open ? "fa-regular fa-folder-open" : "fa-regular fa-folder"),
          el("span.nt-vcs-name", {}, name),
          el("span.nt-vcs-count", {}, files.length)),
      );
      if (open) renderNode(child, depth + 1, key);
    }
    for (const f of node.files.sort((a, b) => displayName(a.path).localeCompare(displayName(b.path), "pt-BR", { sensitivity: "base" }))) {
      const row = el(`div.nt-vcs-row.file.${f.status}`, {
        style: `--depth:${depth}`,
        title: `${STATUS_LABEL[f.status]} · ${f.rel ?? f.path}${f.orig_path ? `\nAntes: ${f.orig_path}` : ""}\nClique: diferenças · Duplo clique: abrir a nota`,
        onclick: () => openFile(f),
        ondblclick: () => openNoteOf(f) || openFile(f),
        oncontextmenu: (e) => fileMenu(e, f),
      },
        el("span.nt-vcs-chev"),
        f.status === "conflicted" ? el("span.nt-vcs-check-pad") : checkbox([f]),
        icon(fileIcon(f.path)),
        el("span.nt-vcs-name", {}, displayName(f.path)),
        f.status === "renamed" && f.orig_path ? el("span.nt-vcs-was", {}, `← ${displayName(f.orig_path)}`) : null);
      row.classList.toggle("selected", f.path === selected && !!host.diffSpec());
      listEl.append(row);
    }
  }

  function renderLog() {
    if (tab !== "log") return;
    logHead.replaceChildren();
    logHead.hidden = !logFilter;
    if (logFilter) {
      logHead.append(
        icon("fa-solid fa-filter"),
        el("span", {}, ` Histórico de "${logFilter.name}"`),
        el("button.nt-vcs-link", { type: "button", title: "Ver o histórico do cofre inteiro", onclick: () => ((logFilter = null), loadLog(true)) }, icon("fa-solid fa-xmark")),
      );
    }
    const scrollTop = logList.scrollTop;
    logList.replaceChildren();
    if (!info?.repo) return;
    if (!log.length && !logLoading) {
      logList.append(el("div.nt-vcs-empty", {}, "Nenhum commit ainda."));
      return;
    }
    for (const c of log) {
      const open = logOpen === c.hash;
      const refs = c.refs ? c.refs.split(", ").map((r) => el(`span.nt-vcs-ref${/origin\//.test(r) ? ".remote" : ""}`, {}, r.replace("HEAD -> ", ""))) : [];
      const item = el("div.nt-vcs-commitrow", {
        title: `${c.subject}${c.body ? `\n\n${c.body}` : ""}\n\n${c.author} <${c.email}>\n${new Date(c.date * 1000).toLocaleString("pt-BR")}\n${c.hash}`,
        onclick: () => toggleCommit(c),
      },
        el("div.nt-vcs-subject", {}, el("i", { class: `nt-vcs-chev fa-solid fa-chevron-${open ? "down" : "right"}` }), el("span", {}, c.subject), ...refs),
        el("div.nt-vcs-meta", {}, `${c.author} · ${relativeDate(c.date)} · `, el("code", {}, c.short), c.parents.length > 1 ? " · merge" : ""));
      item.classList.toggle("open", open);
      logList.append(item);
      if (open) {
        const files = logFiles.get(c.hash);
        if (!files) logList.append(el("div.nt-vcs-empty.small", {}, icon("fa-solid fa-spinner fa-spin")));
        else if (!files.length) logList.append(el("div.nt-vcs-empty.small", {}, "Nenhum arquivo do cofre neste commit."));
        for (const f of files || []) {
          const spec = host.diffSpec();
          const row = el(`div.nt-vcs-row.file.${f.status}`, {
            style: "--depth:1",
            title: `${STATUS_LABEL[f.status]} · ${f.rel ?? f.path}`,
            onclick: () => openFile(f, c.hash),
            ondblclick: () => openNoteOf(f),
          }, el("span.nt-vcs-chev"), icon(fileIcon(f.path)), el("span.nt-vcs-name", {}, displayName(f.path)), el("span.nt-vcs-was", {}, dirName(f.rel ?? f.path)));
          row.classList.toggle("selected", !!spec && spec.rev === c.hash && spec.path === f.path);
          logList.append(row);
        }
      }
    }
    if (logLoading) logList.append(el("div.nt-vcs-empty.small", {}, icon("fa-solid fa-spinner fa-spin"), " Carregando…"));
    logList.scrollTop = scrollTop;
  }

  async function toggleCommit(c) {
    logOpen = logOpen === c.hash ? null : c.hash;
    renderLog();
    if (logOpen && !logFiles.has(c.hash)) {
      try {
        logFiles.set(c.hash, await gitApi.commitFiles(c.hash));
      } catch (e) {
        logFiles.set(c.hash, []);
        host.toast(`Falha ao ler o commit: ${e}`);
      }
      renderLog();
    }
  }

  logList.addEventListener("scroll", () => {
    if (logList.scrollTop + logList.clientHeight > logList.scrollHeight - 80) loadLog();
  }, { passive: true });

  listEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const files = [...listEl.querySelectorAll(".nt-vcs-row.file")];
    const i = files.findIndex((r) => r.classList.contains("selected"));
    const next = files[Math.max(0, Math.min(files.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    next?.click();
    listEl.querySelector(".nt-vcs-row.file.selected")?.scrollIntoView({ block: "nearest" });
  });

  // ----- ciclo de vida -----

  function restartPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => active() && !document.hidden && !busy && refresh(), POLL_MS);
  }

  document.addEventListener("notesvaultwrite", () => isVault() && refreshSoon());
  window.addEventListener("focus", () => active() && refreshSoon(100));
  document.addEventListener("mainviewchange", () => active() && refreshSoon(50));
  document.addEventListener("windowmodechange", () => active() && refreshSoon(50));
  document.addEventListener("notesstoragechange", () => {
    info = null;
    status = null;
    log = [];
    logFilter = null;
    logOpen = null;
    unchecked.clear();
    collapsed.clear();
    selected = null;
    msgEl.value = readStore(MSG_KEY(), "");
    host.closeDiff();
    render();
    if (isVault()) refresh({ full: true });
  });
  restartPolling();
  render();
  if (isVault()) refresh({ full: true });

  return {
    refresh,
    refreshSoon,
    /** Diff fechado/aberto: só redesenha a seleção. */
    selectionChanged() {
      if (tab === "changes") renderList();
      else renderLog();
    },
    afterWorktreeChange,
  };
}

import { state } from "../state.js";
import { getTodayStr, addDays, formatDayLabel } from "../utils/date.js";
import { loadKanbanApi, saveKanbanApi, loadLegacyTodosApi, kanbanMigratedApi } from "../api.js";
import { registerApp } from "../appLifecycle.js";
import { el, icon } from "../utils/dom.js";
import {
  COLORS,
  COLOR_NAMES,
  uid,
  normalizeKanban,
  normalizePomo,
  migrateTodos,
  newBoard,
  boardOf,
  columnOf,
  columnByRole,
  cardOf,
  cardsIn,
  archivedCards,
  isDoneCard,
  dueState,
  matchFilter,
  labelColor,
  moveCard,
  shiftCard,
  addCard,
  moveColumn,
  moveBoard,
  setColumnRole,
  deleteColumn,
  archiveColumn,
  formatFocus,
} from "../utils/kanbanModel.js";
import {
  initPomodoro,
  startPomodoro,
  stopPomodoro,
  togglePomodoro,
  skipPhase,
  hasPomo,
  isPomoRunning,
  pomoCard,
  pomoClock,
  pomoProgress,
  refreshPhaseLength,
  PHASE_LABEL,
} from "./pomodoro.js";
import { renderCardDetail } from "./taskDetail.js";
import { enterDesktopMode, exitDesktopMode, minimizeWindow, toggleMaximize } from "./windowMode.js";

// Tarefas = board kanban (vários boards, colunas editáveis, cada tarefa é um card).
//  - desktop: boards | colunas lado a lado | detalhe do card (só com um card selecionado)
//  - bandeja: seletor de board + abas das colunas → lista da coluna → detalhe, em pilha
// Pomodoro: ▶ no card inicia direto (move para a coluna "doing"); a barra de foco no rodapé controla.

const ui = state.tasksUI;
const ps = state.pomoState;

const appEl = document.getElementById("tasks-app");
const boardEl = document.getElementById("kb-board");
const boardsEl = document.getElementById("kb-boards");
const segEl = document.getElementById("kb-seg");
const detailEl = document.getElementById("tk-detail");
const searchEl = document.getElementById("kb-search");
const filtersEl = document.getElementById("kb-filters");
const tbTitleEl = document.getElementById("kb-tb-title");
const tbCountEl = document.getElementById("kb-tb-count");
const boardNameEl = document.getElementById("kb-board-name");
const backLabelEl = document.getElementById("kb-back-label");
const focusEl = document.getElementById("kb-focusbar");
const menuEl = document.getElementById("kb-menu");
const toastEl = el("div.hx-toast", { hidden: true });
appEl.append(toastEl);

let saveTimer = null;
let toastTimer = null;
let popEl = null; // popover dos padrões do Pomodoro
let composer = null; // { colId, text } — campo "Adicionar card" aberto
let renaming = null; // { kind: "board" | "column", id }
let drag = null; // { kind: "card" | "column" | "board", id }
const dropLine = el("div.kb-drop-line");

const doc = () => state.kanban;
const board = () => boardOf(doc(), doc().active_board);
const selectedCard = () => (ui.selectedId != null ? cardOf(doc(), ui.selectedId) : null);
const today = () => getTodayStr();
const filter = () => ({ query: ui.query, due: ui.due, label: ui.label });
const visibleIn = (colId) => cardsIn(doc(), colId).filter((c) => matchFilter(doc(), c, filter(), today()));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- Dados ----------

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

/** Grava agora o que estiver pendente (navegação, blur...). Sem edição pendente, não faz nada. */
function flushSave() {
  if (!saveTimer) return;
  saveNow();
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return saveKanbanApi(doc());
}

/** Grava e redesenha (toda alteração estrutural passa por aqui). */
function commit() {
  saveNow();
  renderTasks();
}

/** Lê o kanban.json; na 1ª execução migra o todos.json antigo. */
export async function reloadKanban() {
  let raw = null;
  try {
    raw = await loadKanbanApi();
  } catch (e) {
    console.error("load_kanban_data failed", e);
  }
  if (raw != null) {
    state.kanban = normalizeKanban(raw);
    return renderTasks();
  }
  let legacy = null;
  try {
    legacy = await loadLegacyTodosApi();
  } catch (e) {
    // todos.json ilegível: começa vazio e não toca no arquivo (nem grava, até a 1ª edição).
    state.kanban = normalizeKanban(null);
    renderTasks();
    return toast(`Não foi possível ler as tarefas antigas: ${e}. O todos.json foi mantido.`, null, 9000);
  }
  state.kanban = legacy ? migrateTodos(legacy) : normalizeKanban(null);
  await saveNow();
  if (legacy) kanbanMigratedApi().catch((e) => console.error("kanban_migrated failed", e));
  renderTasks();
}

// ---------- Ações: cards ----------

/** Move e cuida dos efeitos: card que entra no "Concluído" encerra o Pomodoro dele. */
function moveCardTo(card, colId, beforeId = null) {
  // No "Concluído" o card entra no topo (os mais recentes ficam à vista).
  const target = columnOf(boardOf(doc(), card.board_id), colId);
  if (beforeId == null && target?.role === "done" && card.column_id !== colId) beforeId = cardsIn(doc(), colId)[0]?.id ?? null;
  if (!moveCard(doc(), card, colId, beforeId)) return false;
  if (isDoneCard(doc(), card) && hasPomo(card.id)) stopPomodoro();
  return true;
}

function completeCard(card) {
  const done = columnByRole(boardOf(doc(), card.board_id), "done");
  if (!done || card.column_id === done.id) return;
  moveCardTo(card, done.id);
  flash(card.id);
  commit();
  toast(`“${short(card.title)}” concluído`);
}

function moveCardToBoard(card, boardId) {
  const target = boardOf(doc(), boardId);
  if (!target || card.board_id === boardId) return;
  card.board_id = boardId;
  moveCardTo(card, target.columns[0].id);
  if (ui.selectedId === card.id) ui.selectedId = null;
  commit();
  toast(`Movido para “${short(target.name)}”`);
}

function createCard(colId, title, { top = false } = {}) {
  const card = addCard(doc(), board().id, colId, title, { top });
  commit();
  boardEl.querySelector(`.kb-card[data-id="${card.id}"]`)?.scrollIntoView({ block: "nearest" });
  return card;
}

function duplicateCard(card) {
  const copy = structuredClone(card);
  Object.assign(copy, { id: uid(), created_at: Date.now(), pomo: { ...copy.pomo, count: 0, focus_ms: 0 } });
  delete copy.completed_at;
  doc().cards.splice(doc().cards.indexOf(card) + 1, 0, copy); // logo abaixo do original
  commit();
}

function removeCard(card, { archive = false } = {}) {
  if (!card) return;
  if (hasPomo(card.id)) stopPomodoro();
  const index = doc().cards.indexOf(card);
  if (archive) card.archived_at = Date.now();
  else doc().cards.splice(index, 1);
  if (ui.selectedId === card.id) {
    ui.selectedId = null;
    ui.pane = "list";
  }
  commit();
  toast(`“${short(card.title)}” ${archive ? "arquivado" : "excluído"}`, {
    label: "Desfazer",
    run: () => {
      if (archive) delete card.archived_at;
      else doc().cards.splice(Math.min(index, doc().cards.length), 0, card);
      commit();
    },
  });
}

/** Inicia (ou pausa/retoma) o Pomodoro do card; iniciar leva o card para a coluna de andamento. */
function focusCard(card) {
  if (hasPomo(card.id)) return togglePomodoro();
  if (isDoneCard(doc(), card)) return;
  const doing = columnByRole(boardOf(doc(), card.board_id), "doing");
  if (doing && card.column_id !== doing.id) {
    moveCardTo(card, doing.id, cardsIn(doc(), doing.id)[0]?.id ?? null);
    flash(card.id);
  }
  startPomodoro(card);
  commit();
}

function select(id, { open = true } = {}) {
  flushSave();
  ui.selectedId = id;
  if (open && id != null && !state.desktopMode) ui.pane = "editor";
  renderTasks();
}

let flashId = null;
function flash(id) {
  flashId = id;
}

const short = (s) => (s.length > 32 ? s.slice(0, 32) + "…" : s);

function toast(message, action = null, ms = null) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.append(el("span", {}, message));
  if (action) {
    toastEl.append(el("button", { type: "button", onclick: () => ((toastEl.hidden = true), action.run()) }, action.label));
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms || (action ? 6000 : 2500));
}

// ---------- Ações: colunas e boards ----------

function addColumn() {
  const col = { id: uid(), name: "Nova coluna", color: "gray", role: null, wip: 0 };
  // Antes da coluna de concluídos, se ela for a última.
  const cols = board().columns;
  const last = cols[cols.length - 1];
  cols.splice(last?.role === "done" ? cols.length - 1 : cols.length, 0, col);
  renaming = { kind: "column", id: col.id };
  if (!state.desktopMode) ui.column = col.id;
  commit();
}

function removeColumn(col) {
  const b = board();
  const index = b.columns.indexOf(col);
  const ids = doc().cards.filter((c) => c.column_id === col.id).map((c) => c.id);
  const target = deleteColumn(doc(), b, col.id);
  if (target == null) return toast("O board precisa de pelo menos uma coluna.");
  if (ps.cardId != null && ids.includes(ps.cardId) && isDoneCard(doc(), pomoCard())) stopPomodoro();
  if (ui.column === col.id) ui.column = target;
  commit();
  toast(`Coluna “${short(col.name)}” excluída${ids.length ? ` · ${plural(ids.length, "card movido", "cards movidos")}` : ""}`, {
    label: "Desfazer",
    run: () => {
      b.columns.splice(index, 0, col);
      for (const id of ids) {
        const c = cardOf(doc(), id);
        if (c) moveCard(doc(), c, col.id);
      }
      commit();
    },
  });
}

function addBoard() {
  const b = newBoard();
  doc().boards.push(b);
  renaming = { kind: "board", id: b.id };
  switchBoard(b.id);
}

function switchBoard(id) {
  if (doc().active_board !== id) {
    doc().active_board = id;
    ui.selectedId = null;
    ui.column = null;
    ui.archived = false;
    ui.label = null;
    if (!state.desktopMode) ui.pane = "list";
  }
  commit();
  boardEl.scrollLeft = 0;
}

function removeBoard(b) {
  const index = doc().boards.indexOf(b);
  const cards = doc().cards.filter((c) => c.board_id === b.id);
  if (cards.some((c) => hasPomo(c.id))) stopPomodoro();
  doc().boards.splice(index, 1);
  doc().cards = doc().cards.filter((c) => c.board_id !== b.id);
  if (!doc().boards.length) doc().boards.push(newBoard("Tarefas"));
  if (doc().active_board === b.id) switchBoard(doc().boards[Math.max(0, index - 1)].id);
  else commit();
  toast(`Board “${short(b.name)}” excluído${cards.length ? ` (${plural(cards.length, "card", "cards")})` : ""}`, {
    label: "Desfazer",
    run: () => {
      doc().boards.splice(index, 0, b);
      doc().cards.push(...cards);
      switchBoard(b.id);
    },
  });
}

// ---------- Menus ----------

function showMenu(x, y, items) {
  closePopover();
  menuEl.innerHTML = "";
  for (const item of items) {
    if (!item) continue;
    if (item === "sep") {
      menuEl.append(el("div.nt-menu-sep"));
      continue;
    }
    if (item.header) {
      menuEl.append(el("div.nt-menu-header", {}, item.header));
      continue;
    }
    const i = el("i", { class: item.icon || "" });
    if (item.color) i.style.color = `var(--kb-${item.color})`;
    const b = el("button.nt-menu-item", { type: "button", disabled: !!item.disabled }, i, item.label);
    b.classList.toggle("danger", !!item.danger);
    b.classList.toggle("indent", !!item.indent);
    b.classList.toggle("checked", !!item.checked);
    b.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menuEl.append(b);
  }
  menuEl.hidden = false;
  const host = appEl.getBoundingClientRect();
  const left = Math.min(x - host.left, host.width - menuEl.offsetWidth - 6);
  const top = Math.min(y - host.top, host.height - menuEl.offsetHeight - 6);
  menuEl.style.left = `${Math.max(6, left)}px`;
  menuEl.style.top = `${Math.max(6, top)}px`;
}

function closeMenu() {
  menuEl.hidden = true;
}

/** Submenu: abre outra lista no lugar do menu que acabou de fechar. */
function reopenMenu(items) {
  const host = appEl.getBoundingClientRect();
  const x = host.left + parseFloat(menuEl.style.left);
  const y = host.top + parseFloat(menuEl.style.top);
  showMenu(x, y, items);
}

function showMenuBelow(anchor, items) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, items);
}

function cardMenuItems(card) {
  const b = boardOf(doc(), card.board_id);
  const done = columnByRole(b, "done");
  const d = today();
  const setDue = (due) => () => {
    if (due) card.due = due;
    else delete card.due;
    commit();
  };
  return [
    { label: "Abrir", icon: "fa-regular fa-window-maximize", run: () => select(card.id) },
    !isDoneCard(doc(), card)
      ? { label: hasPomo(card.id) ? (isPomoRunning(card.id) ? "Pausar foco" : "Retomar foco") : "Iniciar foco (Pomodoro)", icon: "fa-solid fa-stopwatch", run: () => focusCard(card) }
      : null,
    done && card.column_id !== done.id ? { label: "Concluir", icon: "fa-solid fa-check", run: () => completeCard(card) } : null,
    "sep",
    { header: "Mover para" },
    ...b.columns.map((c) => ({
      label: c.name,
      icon: "fa-solid fa-circle",
      color: c.color,
      indent: true,
      checked: c.id === card.column_id,
      disabled: c.id === card.column_id,
      run: () => (moveCardTo(card, c.id), flash(card.id), commit()),
    })),
    doc().boards.length > 1 ? "sep" : null,
    doc().boards.length > 1 ? { header: "Mover para o board" } : null,
    ...(doc().boards.length > 1
      ? doc().boards.filter((x) => x.id !== b.id).map((x) => ({ label: x.name, icon: "fa-solid fa-table-columns", indent: true, run: () => moveCardToBoard(card, x.id) }))
      : []),
    "sep",
    { header: "Prazo" },
    { label: "Hoje", icon: "fa-regular fa-calendar", indent: true, checked: card.due === d, run: setDue(d) },
    { label: "Amanhã", icon: "fa-regular fa-calendar", indent: true, checked: card.due === addDays(d, 1), run: setDue(addDays(d, 1)) },
    { label: "Próxima semana", icon: "fa-regular fa-calendar", indent: true, checked: card.due === addDays(d, 7), run: setDue(addDays(d, 7)) },
    card.due ? { label: "Remover prazo", icon: "fa-regular fa-calendar-xmark", indent: true, run: setDue(null) } : null,
    "sep",
    { label: "Duplicar", icon: "fa-regular fa-clone", run: () => duplicateCard(card) },
    { label: "Arquivar", icon: "fa-solid fa-box-archive", run: () => removeCard(card, { archive: true }) },
    { label: "Excluir", icon: "fa-regular fa-trash-can", danger: true, run: () => removeCard(card) },
  ];
}

function columnMenuItems(col) {
  const b = board();
  const i = b.columns.indexOf(col);
  const count = cardsIn(doc(), col.id).length;
  const move = (delta) => () => {
    moveColumn(b, col.id, b.columns[i + delta + (delta > 0 ? 1 : 0)]?.id ?? null);
    commit();
  };
  return [
    { label: "Adicionar card", icon: "fa-solid fa-plus", run: () => openComposer(col.id) },
    { label: "Renomear", icon: "fa-solid fa-pen", run: () => ((renaming = { kind: "column", id: col.id }), renderTasks()) },
    { label: `Cor: ${COLOR_NAMES[col.color]}…`, icon: "fa-solid fa-circle", color: col.color, run: () => reopenMenu(COLORS.map((c) => ({ label: COLOR_NAMES[c], icon: "fa-solid fa-circle", color: c, checked: col.color === c, run: () => ((col.color = c), commit()) }))) },
    {
      label: `Limite de cards (WIP): ${col.wip || "sem limite"}…`,
      icon: "fa-solid fa-gauge",
      run: () => reopenMenu([0, 2, 3, 4, 5, 8, 10].map((n) => ({ label: n ? String(n) : "Sem limite", icon: "fa-solid fa-gauge", checked: col.wip === n, run: () => ((col.wip = n), commit()) }))),
    },
    "sep",
    { header: "Papel" },
    { label: "Andamento (recebe o card ao iniciar o foco)", icon: "fa-solid fa-person-running", indent: true, checked: col.role === "doing", run: () => (setColumnRole(doc(), b, col.id, "doing"), commit()) },
    { label: "Concluídos (marca o card como concluído)", icon: "fa-solid fa-check", indent: true, checked: col.role === "done", run: () => (setColumnRole(doc(), b, col.id, "done"), stopIfPomoDone(), commit()) },
    "sep",
    { label: "Mover para a esquerda", icon: "fa-solid fa-arrow-left", disabled: i === 0, run: move(-1) },
    { label: "Mover para a direita", icon: "fa-solid fa-arrow-right", disabled: i === b.columns.length - 1, run: move(1) },
    {
      label: col.role === "done" ? "Arquivar concluídos" : "Arquivar todos os cards",
      icon: "fa-solid fa-box-archive",
      disabled: !count,
      run: () => {
        const ids = cardsIn(doc(), col.id).map((c) => c.id);
        if (ids.includes(ps.cardId)) stopPomodoro();
        const n = archiveColumn(doc(), col.id);
        if (ids.includes(ui.selectedId)) ui.selectedId = null;
        commit();
        toast(`${plural(n, "card arquivado", "cards arquivados")}`, {
          label: "Desfazer",
          run: () => {
            for (const id of ids) delete cardOf(doc(), id).archived_at;
            commit();
          },
        });
      },
    },
    { label: "Excluir coluna", icon: "fa-regular fa-trash-can", danger: true, disabled: b.columns.length < 2, run: () => removeColumn(col) },
  ];
}

function stopIfPomoDone() {
  const card = pomoCard();
  if (card && isDoneCard(doc(), card)) stopPomodoro();
}

function boardMenuItems(b) {
  return [
    { label: "Renomear", icon: "fa-solid fa-pen", run: () => ((renaming = { kind: "board", id: b.id }), renderTasks()) },
    { label: "Arquivados", icon: "fa-solid fa-box-archive", run: () => (switchBoard(b.id), showArchived(true)) },
    "sep",
    { label: "Excluir board", icon: "fa-regular fa-trash-can", danger: true, run: () => removeBoard(b) },
  ];
}

function showArchived(on) {
  ui.archived = on;
  ui.selectedId = null;
  if (!state.desktopMode) ui.pane = "list";
  renderTasks();
}

// ---------- Renomear no lugar ----------

function renameInput(value, onDone) {
  const input = el("input.nt-folder-input.kb-rename", { type: "text", value, maxLength: 80, spellcheck: false });
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    renaming = null;
    const v = input.value.trim();
    if (save && v && v !== value) onDone(v);
    commit();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  for (const ev of ["click", "dblclick", "mousedown"]) input.addEventListener(ev, (e) => e.stopPropagation());
  input.draggable = false;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return input;
}

// ---------- Render: barra lateral (boards) ----------

function renderBoards() {
  boardsEl.innerHTML = "";
  for (const b of doc().boards) {
    const count = doc().cards.filter((c) => c.board_id === b.id && !c.archived_at && !isDoneCard(doc(), c)).length;
    const editing = renaming?.kind === "board" && renaming.id === b.id;
    const li = el(
      "li.nt-folder.kb-board-item",
      {
        dataset: { id: b.id },
        draggable: !editing,
        onclick: () => switchBoard(b.id),
        ondblclick: () => ((renaming = { kind: "board", id: b.id }), renderBoards()),
      },
      el("i", { class: "fa-solid fa-table-columns nt-folder-icon" }),
      editing ? renameInput(b.name, (v) => (b.name = v)) : el("span.nt-folder-name", {}, b.name),
      el("span.nt-folder-count", {}, count || ""),
    );
    li.classList.toggle("active", b.id === doc().active_board);
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, boardMenuItems(b));
    });
    li.addEventListener("dragstart", (e) => startDrag(e, "board", b.id));
    li.addEventListener("dragover", (e) => {
      if (drag?.kind === "card" && b.id !== board().id) {
        e.preventDefault();
        li.classList.add("drop-target");
      } else if (drag?.kind === "board" && drag.id !== b.id) {
        e.preventDefault();
        const r = li.getBoundingClientRect();
        li.classList.toggle("drop-before", e.clientY < r.top + r.height / 2);
        li.classList.toggle("drop-after", e.clientY >= r.top + r.height / 2);
      }
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-target", "drop-before", "drop-after"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const after = li.classList.contains("drop-after");
      li.classList.remove("drop-target", "drop-before", "drop-after");
      if (drag?.kind === "card") {
        const card = cardOf(doc(), drag.id);
        if (card) moveCardToBoard(card, b.id);
      } else if (drag?.kind === "board") {
        const idx = doc().boards.indexOf(b);
        moveBoard(doc(), drag.id, after ? doc().boards[idx + 1]?.id ?? null : b.id);
        commit();
      }
    });
    boardsEl.append(li);
  }
}

// ---------- Render: board ----------

function dueChip(card) {
  if (!card.due) return null;
  const s = dueState(doc(), card, today());
  return el(`span.kb-meta.kb-due${s ? `.${s}` : ""}`, { title: `Prazo: ${formatDayLabel(card.due)}` }, icon(s === "overdue" ? "fa-solid fa-triangle-exclamation" : "fa-regular fa-calendar"), formatDayLabel(card.due));
}

function cardEl(card) {
  const done = isDoneCard(doc(), card);
  const session = hasPomo(card.id);
  const labels = card.labels.length
    ? el("div.kb-labels", {}, card.labels.map((l) => el("span.kb-label", { style: `--c: var(--kb-${labelColor(doc(), l)})`, title: l }, l)))
    : null;
  const meta = [];
  if (session) meta.push(el("span.kb-meta.kb-meta-pomo", {}, icon(ps.phase === "work" ? "fa-solid fa-brain" : "fa-solid fa-mug-hot"), el("span", { dataset: { pomoTime: "" } }, `${PHASE_LABEL[ps.phase]} · ${pomoClock()}`)));
  const due = done ? null : dueChip(card);
  if (due) meta.push(due);
  if (card.pomo.count) meta.push(el("span.kb-meta.kb-meta-tomato", { title: `${plural(card.pomo.count, "pomodoro", "pomodoros")} · ${formatFocus(card.pomo.focus_ms)} de foco` }, icon("fa-solid fa-stopwatch"), card.pomo.count));
  if (card.note?.trim()) meta.push(el("span.kb-meta", { title: card.note.slice(0, 300) }, icon("fa-regular fa-note-sticky")));
  if (done && card.completed_at) meta.push(el("span.kb-meta", {}, icon("fa-solid fa-check"), formatDayLabel(dateOf(card.completed_at))));

  const play = done
    ? null
    : el(
        `button.kb-play${session ? ".session" : ""}${isPomoRunning(card.id) ? ".running" : ""}`,
        {
          type: "button",
          title: session ? (isPomoRunning(card.id) ? "Pausar foco (Espaço)" : "Retomar foco (Espaço)") : "Iniciar foco — Pomodoro (Espaço)",
          style: session ? `--p: ${pomoProgress()}` : null,
          dataset: session ? { pomoRing: "" } : {},
          onclick: (e) => (e.stopPropagation(), focusCard(card)),
        },
        icon(isPomoRunning(card.id) ? "fa-solid fa-pause" : "fa-solid fa-play"),
      );

  const editing = renaming?.kind === "card" && renaming.id === card.id;
  const title = editing
    ? renameInput(card.title, (v) => (card.title = v))
    : el("div.kb-card-title", {}, card.title);
  const node = el(
    "div.kb-card",
    {
      dataset: { id: card.id },
      draggable: !editing,
      tabindex: -1,
      onclick: () => select(card.id),
    },
    labels,
    el("div.kb-card-row", {}, title, play),
    meta.length ? el("div.kb-card-meta", {}, meta) : null,
  );
  title.addEventListener?.("dblclick", (e) => {
    if (!state.desktopMode || editing) return;
    e.stopPropagation();
    renaming = { kind: "card", id: card.id };
    renderBoard();
  });
  node.classList.toggle("selected", card.id === ui.selectedId);
  node.classList.toggle("done", done);
  node.classList.toggle("session", session);
  node.classList.toggle("flash", card.id === flashId);
  node.classList.toggle("overdue", !done && dueState(doc(), card, today()) === "overdue");
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, cardMenuItems(card));
  });
  node.addEventListener("dragstart", (e) => startDrag(e, "card", card.id));
  return node;
}

const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function composerEl(colId, { inline = true } = {}) {
  const ta = el("textarea.kb-composer-input", { rows: inline ? 2 : 1, placeholder: "Título do card — Enter adiciona", maxLength: 300, spellcheck: true });
  ta.value = composer?.colId === colId ? composer.text : "";
  let done = false;
  const close = () => {
    done = true;
    composer = null;
    renderBoard();
  };
  ta.addEventListener("input", () => {
    if (composer) composer.text = ta.value;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  });
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = ta.value.replace(/\s+/g, " ").trim();
      if (!text) return;
      composer = { colId, text: "", focus: true };
      done = true;
      createCard(colId, text, { top: !inline });
    } else if (e.key === "Escape") close();
  });
  ta.addEventListener("focus", () => {
    if (composer?.colId !== colId) composer = { colId, text: ta.value };
  });
  // Vazio ao sair = fecha (com folga, para o clique que tirou o foco chegar ao destino antes).
  ta.addEventListener("blur", () => {
    if (done || !inline) return;
    setTimeout(() => {
      if (!done && composer?.colId === colId && !composer.text.trim() && document.activeElement !== ta) close();
    }, 200);
  });
  if (!inline) return el("form.tk-add.kb-add", { onsubmit: (e) => e.preventDefault() }, el("span.tk-add-icon", {}, icon("fa-solid fa-plus")), ta);
  return el(
    "div.kb-composer",
    {},
    ta,
    el(
      "div.kb-composer-actions",
      {},
      el("button.kb-btn.primary", { type: "button", onmousedown: (e) => e.preventDefault(), onclick: () => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })) }, "Adicionar"),
      el("button.kb-btn", { type: "button", onmousedown: (e) => e.preventDefault(), onclick: close }, "Cancelar"),
    ),
  );
}

function openComposer(colId) {
  if (!state.desktopMode) {
    ui.column = colId;
    ui.pane = "list";
  }
  composer = { colId, text: "", focus: true };
  renderTasks();
}

function columnEl(col, { solo = false } = {}) {
  const all = cardsIn(doc(), col.id);
  const cards = all.filter((c) => matchFilter(doc(), c, filter(), today()));
  const over = col.wip && all.length > col.wip;
  const editing = renaming?.kind === "column" && renaming.id === col.id;
  const head = solo
    ? null
    : el(
        "div.kb-col-head",
        { draggable: !editing, ondblclick: () => ((renaming = { kind: "column", id: col.id }), renderBoard()) },
        el("span.kb-dot", { style: `--c: var(--kb-${col.color})` }),
        editing ? renameInput(col.name, (v) => (col.name = v)) : el("span.kb-col-name", { title: col.name }, col.name),
        col.role ? icon(`${col.role === "done" ? "fa-solid fa-check" : "fa-solid fa-person-running"} kb-col-role`) : null,
        el(`span.kb-col-count${over ? ".over" : ""}`, { title: col.wip ? `Limite: ${col.wip}` : null }, col.wip ? `${all.length}/${col.wip}` : all.length),
        el("button.kb-col-btn", { type: "button", title: "Adicionar card", onclick: (e) => (e.stopPropagation(), openComposer(col.id)) }, icon("fa-solid fa-plus")),
        el("button.kb-col-btn", { type: "button", title: "Opções da coluna", onclick: (e) => (e.stopPropagation(), showMenuBelow(e.currentTarget, columnMenuItems(col))) }, icon("fa-solid fa-ellipsis")),
      );
  if (head) {
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, columnMenuItems(col));
    });
    head.addEventListener("dragstart", (e) => startDrag(e, "column", col.id));
  }

  const body = el("div.kb-col-body", { dataset: { col: col.id } });
  if (solo) body.append(composerEl(col.id, { inline: false }));
  for (const c of cards) body.append(cardEl(c));
  if (!cards.length) {
    const filtered = all.length > 0;
    body.append(el("div.kb-col-empty", {}, filtered ? "Nenhum card com esse filtro" : solo ? "Nenhum card nesta coluna" : "Solte cards aqui"));
  }
  body.addEventListener("dragover", (e) => cardDragOver(e, body));
  body.addEventListener("drop", (e) => cardDrop(e, body, col.id));

  const foot = solo
    ? null
    : composer?.colId === col.id
      ? composerEl(col.id)
      : el("button.kb-add-card", { type: "button", onclick: () => openComposer(col.id) }, icon("fa-solid fa-plus"), "Adicionar card");

  const node = el("div.kb-col", { dataset: { col: col.id }, style: `--c: var(--kb-${col.color})` }, head, body, foot);
  node.classList.toggle("over", !!over);
  node.classList.toggle("solo", solo);
  if (!solo) {
    node.addEventListener("dragover", (e) => {
      if (drag?.kind === "column") columnDragOver(e, node);
      else if (drag?.kind === "card" && !body.contains(e.target)) cardDragOver(e, body);
    });
    node.addEventListener("drop", (e) => {
      if (drag?.kind === "column") columnDrop(e, node, col.id);
      else if (drag?.kind === "card" && !body.contains(e.target)) cardDrop(e, body, col.id);
    });
  }
  return node;
}

function archivedEl() {
  const list = archivedCards(doc(), board().id).filter((c) => matchFilter(doc(), c, filter(), today()));
  const wrap = el(
    "div.kb-archived",
    {},
    el(
      "div.kb-archived-head",
      {},
      el("button.nt-back", { type: "button", onclick: () => showArchived(false) }, icon("fa-solid fa-chevron-left"), " Board"),
      el("h3", {}, icon("fa-solid fa-box-archive"), ` Arquivados · ${list.length}`),
      list.length
        ? el(
            "button.kb-btn.danger",
            {
              type: "button",
              onclick: () => {
                const removed = list.slice();
                doc().cards = doc().cards.filter((c) => !removed.includes(c));
                commit();
                toast(`${plural(removed.length, "card excluído", "cards excluídos")}`, { label: "Desfazer", run: () => (doc().cards.push(...removed), commit()) });
              },
            },
            "Esvaziar",
          )
        : null,
    ),
  );
  if (!list.length) wrap.append(el("div.kb-col-empty.big", {}, icon("fa-solid fa-box-open"), el("span", {}, "Nada arquivado neste board.")));
  for (const c of list) {
    const col = columnOf(board(), c.column_id);
    wrap.append(
      el(
        "div.kb-arch-item",
        {},
        el("span.kb-dot", { style: `--c: var(--kb-${col?.color || "gray"})` }),
        el("div.kb-arch-main", {}, el("div.kb-card-title", {}, c.title), el("small", {}, `${col?.name || ""} · arquivado ${formatDayLabel(dateOf(c.archived_at)).toLowerCase()}`)),
        el("button.kb-btn", { type: "button", onclick: () => (delete c.archived_at, commit()) }, icon("fa-solid fa-rotate-left"), " Restaurar"),
        el("button.tk-act.danger", { type: "button", title: "Excluir de vez", onclick: () => removeCard(c) }, icon("fa-regular fa-trash-can")),
      ),
    );
  }
  return wrap;
}

function renderBoard() {
  const b = board();
  const prevFocus = composer?.focus || boardEl.querySelector(".kb-composer-input") === document.activeElement;
  const scroll = [boardEl.scrollLeft, ...[...boardEl.querySelectorAll(".kb-col-body")].map((n) => n.scrollTop)];
  boardEl.innerHTML = "";
  boardEl.classList.toggle("archived", ui.archived);
  if (ui.archived) {
    boardEl.append(archivedEl());
  } else if (state.desktopMode) {
    for (const col of b.columns) boardEl.append(columnEl(col));
    boardEl.append(el("button.kb-add-col", { type: "button", onclick: addColumn }, icon("fa-solid fa-plus"), "Adicionar coluna"));
  } else {
    if (!columnOf(b, ui.column)) ui.column = b.columns[0].id;
    boardEl.append(columnEl(columnOf(b, ui.column), { solo: true }));
  }
  // Mantém a rolagem (o board é redesenhado a cada alteração).
  boardEl.scrollLeft = scroll[0];
  boardEl.querySelectorAll(".kb-col-body").forEach((n, i) => (n.scrollTop = scroll[i + 1] || 0));
  if (composer) {
    const ta = boardEl.querySelector(".kb-composer-input");
    if (ta && prevFocus) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.closest(".kb-col-body, .kb-col")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
    composer.focus = false;
  }
  flashId = null;
}

// ---------- Drag & drop ----------

function startDrag(e, kind, id) {
  if (e.target.closest("input, textarea")) return e.preventDefault();
  e.stopPropagation();
  drag = { kind, id };
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(id));
  const node = e.currentTarget.closest(".kb-card, .kb-col, .kb-board-item") || e.currentTarget;
  requestAnimationFrame(() => node.classList.add("dragging"));
  closeMenu();
}

function endDrag() {
  drag = null;
  dropLine.remove();
  appEl.querySelectorAll(".dragging, .drop-before, .drop-after, .drop-target").forEach((n) => n.classList.remove("dragging", "drop-before", "drop-after", "drop-target"));
}

/** Card antes do qual soltar (metade de cima do card = antes dele). */
function beforeCardAt(body, y) {
  for (const n of body.querySelectorAll(".kb-card:not(.dragging)")) {
    const r = n.getBoundingClientRect();
    if (y < r.top + r.height / 2) return n;
  }
  return null;
}

function cardDragOver(e, body) {
  if (drag?.kind !== "card") return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const before = beforeCardAt(body, e.clientY);
  if (before) {
    if (dropLine.nextSibling !== before) body.insertBefore(dropLine, before);
  } else if (dropLine.parentNode !== body || dropLine.nextSibling) {
    body.append(dropLine);
  }
}

function cardDrop(e, body, colId) {
  if (drag?.kind !== "card") return;
  e.preventDefault();
  e.stopPropagation();
  const card = cardOf(doc(), drag.id);
  const before = beforeCardAt(body, e.clientY);
  endDrag();
  if (!card) return;
  if (moveCardTo(card, colId, before ? Number(before.dataset.id) : null)) {
    flash(card.id);
    commit();
  } else renderBoard();
}

function columnDragOver(e, node) {
  if (drag.id === Number(node.dataset.col)) return;
  e.preventDefault();
  boardEl.querySelectorAll(".kb-col.drop-before, .kb-col.drop-after").forEach((n) => n !== node && n.classList.remove("drop-before", "drop-after"));
  const r = node.getBoundingClientRect();
  const left = e.clientX < r.left + r.width / 2;
  node.classList.toggle("drop-before", left);
  node.classList.toggle("drop-after", !left);
}

function columnDrop(e, node, colId) {
  e.preventDefault();
  const after = node.classList.contains("drop-after");
  const id = drag.id;
  endDrag();
  const b = board();
  const idx = b.columns.findIndex((c) => c.id === colId);
  if (moveColumn(b, id, after ? b.columns[idx + 1]?.id ?? null : colId)) commit();
}

// ---------- Render: barra de foco ----------

function renderFocusBar() {
  const card = pomoCard();
  focusEl.hidden = !card;
  appEl.classList.toggle("has-focus", !!card);
  appEl.classList.toggle("pomo-break", !!card && ps.phase !== "work");
  if (!card) {
    focusEl.innerHTML = "";
    return;
  }
  const running = ps.running;
  const phaseIcon = ps.phase === "work" ? "fa-solid fa-brain" : "fa-solid fa-mug-hot";
  const sub = ps.phase === "work" ? `${PHASE_LABEL.work} · ${card.pomo.count + 1}º pomodoro` : `${PHASE_LABEL[ps.phase]} · ${plural(card.pomo.count, "pomodoro", "pomodoros")}`;
  const done = columnByRole(boardOf(doc(), card.board_id), "done");
  focusEl.innerHTML = "";
  focusEl.className = `kb-focusbar phase-${ps.phase}${running ? " running" : ""}`;
  focusEl.append(
    el("div.kb-fb-ring", { style: `--p: ${pomoProgress()}`, dataset: { pomoRing: "" } }, icon(phaseIcon)),
    el(
      "button.kb-fb-text",
      { type: "button", title: "Abrir o card", onclick: () => (card.board_id !== doc().active_board ? switchBoard(card.board_id) : null, select(card.id)) },
      el("small", {}, sub),
      el("strong", {}, card.title),
    ),
    el("span.kb-fb-time", { dataset: { pomoClock: "" } }, pomoClock()),
    el(
      "div.kb-fb-actions",
      {},
      el("button.kb-fb-btn.main", { type: "button", title: running ? "Pausar" : "Retomar", onclick: () => togglePomodoro() }, icon(running ? "fa-solid fa-pause" : "fa-solid fa-play")),
      el("button.kb-fb-btn.extra", { type: "button", title: ps.phase === "work" ? "Pular para a pausa" : "Pular a pausa", onclick: () => skipPhase() }, icon("fa-solid fa-forward-step")),
      done && card.column_id !== done.id ? el("button.kb-fb-btn", { type: "button", title: "Concluir o card", onclick: () => completeCard(card) }, icon("fa-solid fa-check")) : null,
      el("button.kb-fb-btn", { type: "button", title: "Parar", onclick: () => stopPomodoro() }, icon("fa-solid fa-stop")),
      el("button.kb-fb-btn.extra", { type: "button", title: "Tempos padrão do Pomodoro", onclick: (e) => (e.stopPropagation(), togglePopover(e.currentTarget)) }, icon("fa-solid fa-sliders")),
    ),
  );
}

/** Atualiza só os relógios e anéis (a cada segundo, sem redesenhar). */
function updateTicks() {
  const clock = pomoClock();
  const label = `${PHASE_LABEL[ps.phase]} · ${clock}`;
  const p = pomoProgress();
  appEl.querySelectorAll("[data-pomo-clock]").forEach((n) => (n.textContent = clock));
  appEl.querySelectorAll("[data-pomo-time]").forEach((n) => (n.textContent = label));
  appEl.querySelectorAll("[data-pomo-ring]").forEach((n) => n.style.setProperty("--p", p));
}

function closePopover() {
  popEl?.remove();
  popEl = null;
}

/** Padrões do Pomodoro (todos os cards; o card pode sobrepor foco/pausa no detalhe). */
function togglePopover(anchor) {
  if (popEl) return closePopover();
  closeMenu();
  const p = doc().pomo;
  const num = (key, label, min, max) => {
    const input = el("input.kb-num", { type: "number", min, max, value: p[key] });
    input.addEventListener("change", () => {
      doc().pomo = normalizePomo({ ...doc().pomo, [key]: input.value });
      input.value = doc().pomo[key];
      saveNow();
      refreshPhaseLength();
    });
    return el("label.kb-pop-row", {}, el("span", {}, label), input);
  };
  const auto = el("input", { type: "checkbox", checked: p.auto_next });
  auto.addEventListener("change", () => {
    doc().pomo.auto_next = auto.checked;
    saveNow();
  });
  popEl = el(
    "div.kb-pop",
    { onclick: (e) => e.stopPropagation(), onmousedown: (e) => e.stopPropagation() },
    el("div.kb-pop-title", {}, "Pomodoro"),
    num("work", "Foco (min)", 1, 180),
    num("break", "Pausa (min)", 1, 60),
    num("long_break", "Pausa longa (min)", 1, 90),
    num("long_every", "Pausa longa a cada (focos)", 1, 12),
    el("label.kb-pop-row.check", {}, auto, el("span", {}, "Iniciar a próxima fase sozinho")),
  );
  appEl.append(popEl);
  const host = appEl.getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  popEl.style.right = `${Math.max(6, host.right - r.right)}px`;
  popEl.style.bottom = `${host.bottom - r.top + 8}px`;
}

// ---------- Render: chrome ----------

function renderChrome() {
  const b = board();
  const active = doc().cards.filter((c) => c.board_id === b.id && !c.archived_at);
  const open = active.filter((c) => !isDoneCard(doc(), c));
  const overdue = open.filter((c) => dueState(doc(), c, today()) === "overdue").length;
  const dueToday = open.filter((c) => dueState(doc(), c, today()) === "today").length;

  tbTitleEl.textContent = b.name;
  boardNameEl.textContent = b.name;
  backLabelEl.textContent = b.name;
  tbCountEl.textContent = [plural(open.length, "aberto", "abertos"), overdue ? plural(overdue, "atrasado", "atrasados") : null].filter(Boolean).join(" · ");

  // Filtros (desktop)
  filtersEl.innerHTML = "";
  const chip = (key, label, n, cls) =>
    el(
      `button.kb-filter${ui.due === key ? ".active" : ""}${cls ? `.${cls}` : ""}`,
      { type: "button", onclick: () => ((ui.due = ui.due === key ? null : key), renderTasks()) },
      label,
      n ? el("span.kb-filter-n", {}, n) : null,
    );
  filtersEl.append(chip("overdue", "Atrasados", overdue, "danger"), chip("today", "Vence hoje", dueToday + overdue));
  if (doc().labels.length) {
    const lb = el(
      `button.kb-filter${ui.label ? ".active" : ""}`,
      {
        type: "button",
        onclick: (e) =>
          showMenuBelow(e.currentTarget, [
            { label: "Todas as etiquetas", icon: "fa-solid fa-tags", checked: !ui.label, run: () => ((ui.label = null), renderTasks()) },
            "sep",
            ...doc().labels.map((l) => ({ label: l.name, icon: "fa-solid fa-tag", color: l.color, checked: ui.label === l.name, run: () => ((ui.label = l.name), renderTasks()) })),
          ]),
      },
      icon("fa-solid fa-tag"),
      ui.label || "Etiqueta",
    );
    if (ui.label) lb.style.setProperty("--c", `var(--kb-${labelColor(doc(), ui.label)})`);
    filtersEl.append(lb);
  }

  // Abas das colunas (bandeja)
  segEl.innerHTML = "";
  segEl.hidden = ui.archived;
  for (const col of b.columns) {
    const n = cardsIn(doc(), col.id).length;
    const btn = el(
      "button",
      { type: "button", title: col.name, onclick: () => ((ui.column = col.id), (composer = null), renderTasks()) },
      el("span.kb-dot", { style: `--c: var(--kb-${col.color})` }),
      el("span.kb-seg-name", {}, col.name),
      n ? el("span.kb-seg-n", {}, n) : null,
    );
    btn.classList.toggle("active", col.id === ui.column);
    btn.addEventListener("dragover", (e) => drag?.kind === "card" && (e.preventDefault(), btn.classList.add("drop-target")));
    btn.addEventListener("dragleave", () => btn.classList.remove("drop-target"));
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      const card = drag?.kind === "card" && cardOf(doc(), drag.id);
      endDrag();
      if (card && moveCardTo(card, col.id)) commit();
    });
    segEl.append(btn);
  }

  appEl.classList.toggle("sidebar-hidden", state.desktopMode && ui.sidebarHidden);
  appEl.dataset.pane = ui.pane;
  appEl.classList.toggle("has-detail", !!selectedCard());
  document.body.classList.toggle("tasks-editing", !state.desktopMode && ui.pane === "editor" && state.activeMainView === "tasks");
}

// ---------- Render: detalhe ----------

function renderDetail() {
  const card = selectedCard();
  detailEl.innerHTML = "";
  delete detailEl.dataset.id;
  if (!card) {
    if (!state.desktopMode && ui.pane === "editor") ui.pane = "list";
    return;
  }
  // Na bandeja o detalhe só é montado quando está na tela.
  if (!state.desktopMode && ui.pane !== "editor") return;
  detailEl.dataset.id = card.id;
  renderCardDetail(detailEl, card, {
    doc: doc(),
    saveSoon,
    flushSave,
    commit,
    close: () => select(null),
    focus: () => focusCard(card),
    complete: () => completeCard(card),
    move: (colId) => {
      if (moveCardTo(card, colId)) commit();
    },
    remove: () => removeCard(card),
    archive: () => removeCard(card, { archive: true }),
    onPomoMinutes: () => {
      saveNow();
      if (hasPomo(card.id)) refreshPhaseLength();
    },
    updateCardTitle: (text) => {
      const n = boardEl.querySelector(`.kb-card[data-id="${card.id}"] .kb-card-title`);
      if (n) n.textContent = text;
    },
    showMenu,
  });
}

/** Re-renderiza boards, colunas, cabeçalhos, detalhe e barra de foco. */
export function renderTasks() {
  if (!doc()) return;
  if (ui.selectedId != null && !selectedCard()) ui.selectedId = null;
  renderBoards();
  renderBoard();
  renderDetail(); // pode voltar o painel da bandeja para a lista
  renderChrome();
  renderFocusBar();
}

// ---------- Teclado ----------

function visibleColumns() {
  return board().columns.map((c) => ({ col: c, cards: visibleIn(c.id) }));
}

function moveSelection(dx, dy) {
  const cols = state.desktopMode ? visibleColumns() : [{ col: columnOf(board(), ui.column), cards: visibleIn(ui.column) }];
  const card = selectedCard();
  let ci = card ? cols.findIndex((c) => c.col.id === card.column_id) : -1;
  let ri = ci >= 0 ? cols[ci].cards.indexOf(card) : -1;
  if (ci < 0 || ri < 0) {
    const first = cols.find((c) => c.cards.length);
    if (first) select(first.cards[0].id, { open: false });
    return;
  }
  if (dy) ri = Math.max(0, Math.min(cols[ci].cards.length - 1, ri + dy));
  if (dx) {
    let ni = ci + dx;
    while (ni >= 0 && ni < cols.length && !cols[ni].cards.length) ni += dx;
    if (ni < 0 || ni >= cols.length) return;
    ci = ni;
    ri = Math.min(ri, cols[ci].cards.length - 1);
  }
  const next = cols[ci].cards[ri];
  select(next.id, { open: false });
  boardEl.querySelector(`.kb-card[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function moveSelectedCard(dx, dy) {
  const card = selectedCard();
  if (!card) return;
  if (dy) {
    if (shiftCard(doc(), card, dy)) commit();
  } else {
    const cols = board().columns;
    const next = cols[cols.findIndex((c) => c.id === card.column_id) + dx];
    if (next && moveCardTo(card, next.id)) {
      flash(card.id);
      commit();
    }
  }
  boardEl.querySelector(`.kb-card[data-id="${card.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function handleGlobalKeydown(e) {
  if (state.activeMainView !== "tasks" || !doc()) return;
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");

  if (e.key === "Escape") {
    if (!menuEl.hidden) return closeMenu();
    if (popEl) return closePopover();
    if (typing === searchEl && ui.query) {
      searchEl.value = ui.query = "";
      return renderTasks();
    }
    if (typing) return typing.blur();
    if (!state.desktopMode && ui.pane === "editor") return actions["show-list"]();
    if (state.desktopMode && ui.selectedId != null) return select(null);
    if (ui.archived) return showArchived(false);
    return;
  }
  if (mod && e.key.toLowerCase() === "n") {
    e.preventDefault();
    const card = selectedCard();
    return openComposer(card && !ui.archived ? card.column_id : state.desktopMode ? board().columns[0].id : ui.column || board().columns[0].id);
  }
  if (mod && e.key.toLowerCase() === "f" && state.desktopMode) {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }
  if (typing || ui.archived) return;
  if (!state.desktopMode && ui.pane !== "list") return;

  const card = selectedCard();
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    const [dx, dy] = arrows[e.key];
    if (mod) moveSelectedCard(dx, dy);
    else moveSelection(dx, dy);
  } else if (card && e.key === " ") {
    e.preventDefault();
    focusCard(card);
  } else if (card && (e.key === "Delete" || e.key === "Backspace")) {
    e.preventDefault();
    removeCard(card);
  } else if (card && e.key === "Enter") {
    e.preventDefault();
    if (!state.desktopMode) return select(card.id);
    detailEl.querySelector(".tk-d-title")?.focus();
  }
}

// ---------- Init ----------

const actions = {
  "show-list": () => {
    flushSave();
    ui.pane = "list";
    renderTasks();
  },
  delete: () => removeCard(selectedCard()),
  "new-card": () => openComposer(board().columns[0].id),
  "new-column": addColumn,
  "new-board": addBoard,
  archived: () => showArchived(!ui.archived),
  "toggle-sidebar": () => {
    ui.sidebarHidden = !ui.sidebarHidden;
    renderChrome();
  },
  desktop: () => enterDesktopMode(),
  tray: () => exitDesktopMode(),
  "close-desktop": () => exitDesktopMode({ visible: false }),
  minimize: minimizeWindow,
  maximize: toggleMaximize,
};

export function initTasks() {
  initPomodoro({ onSave: saveNow });

  appEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (btn && actions[btn.dataset.action]) actions[btn.dataset.action]();
  });

  document.getElementById("kb-board-pick").addEventListener("click", (e) => {
    showMenuBelow(e.currentTarget, [
      ...doc().boards.map((b) => ({ label: b.name, icon: "fa-solid fa-table-columns", checked: b.id === doc().active_board, run: () => switchBoard(b.id) })),
      "sep",
      { label: "Novo board", icon: "fa-solid fa-plus", run: addBoard },
      { label: "Renomear board", icon: "fa-solid fa-pen", run: () => renameBoardCompact() },
      { label: "Nova coluna", icon: "fa-solid fa-square-plus", run: addColumn },
      { label: "Opções da coluna", icon: "fa-solid fa-ellipsis", run: () => showMenuBelow(e.target.closest("button"), columnMenuItems(columnOf(board(), ui.column))) },
      doc().boards.length > 1 ? { label: "Excluir board", icon: "fa-regular fa-trash-can", danger: true, run: () => removeBoard(board()) } : null,
    ]);
  });

  searchEl.addEventListener("input", () => {
    ui.query = searchEl.value;
    renderBoard();
  });

  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("dragend", endDrag);
  document.addEventListener("mousedown", (e) => {
    if (!menuEl.hidden && !e.target.closest("#kb-menu")) closeMenu();
    if (popEl && !e.target.closest(".kb-pop")) closePopover();
  });
  boardEl.addEventListener("scroll", closeMenu, { capture: true, passive: true });

  document.addEventListener("pomodorotick", updateTicks);
  document.addEventListener("pomodorochange", () => {
    // Campo em edição (título, anotação, renomear): não redesenha por baixo de quem digita.
    const a = document.activeElement;
    if (appEl.contains(a) && a.matches("input, textarea, select")) {
      renderFocusBar();
      updateTicks();
    } else renderTasks();
  });

  document.addEventListener("mainviewchange", () => {
    if (state.activeMainView !== "tasks") {
      flushSave();
      closeMenu();
      closePopover();
      document.body.classList.remove("tasks-editing");
      return;
    }
    renderTasks();
  });

  document.addEventListener("windowmodechange", () => {
    if (!state.desktopMode) {
      ui.pane = "list";
      ui.query = searchEl.value = "";
      ui.due = ui.label = null;
      const card = selectedCard();
      if (card) ui.column = card.column_id;
    }
    composer = null;
    renderTasks();
  });

  window.addEventListener("beforeunload", () => {
    if (saveTimer) flushSave();
  });

  registerApp("tasks", {
    flush: async () => {
      if (!saveTimer) return;
      await saveNow();
    },
    reload: async () => {
      ui.selectedId = null;
      await reloadKanban();
    },
    blocker: () => (ps.cardId != null ? "Pare o Pomodoro antes de mover as Tarefas para outra janela." : null),
  });
}

/** Bandeja: renomear o board atual pelo seletor do topo. */
function renameBoardCompact() {
  const b = board();
  const btn = document.getElementById("kb-board-pick");
  const input = renameInput(b.name, (v) => (b.name = v));
  input.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === "Escape") && input.blur());
  btn.hidden = true;
  btn.after(input);
  input.addEventListener("blur", () => {
    input.remove();
    btn.hidden = false;
  });
}

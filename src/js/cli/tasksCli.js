// CLI: `devsuite tasks ...` (ver src-tauri/cli/commands.json), sobre o kanban vivo (state.kanban).

import { state } from "../state.js";
import { tasksHost as host } from "../components/tasks.js";
import { getTodayStr } from "../utils/date.js";
import {
  boardOf, columnOf, columnByRole, cardsIn, archivedCards, dueState, matchFilter, addCard, ensureLabel, labelColor, formatFocus,
} from "../utils/kanbanModel.js";
import { CliError, pick, list, requireFlag, iso, parseDue } from "./cliUtils.js";

const doc = () => {
  if (!state.kanban) throw new CliError("unavailable", "As tarefas ainda não carregaram");
  return state.kanban;
};

function findBoard(wanted) {
  if (wanted === undefined || wanted === null || wanted === "") return boardOf(doc(), doc().active_board) || doc().boards[0];
  return pick(doc().boards, wanted, { what: "board" });
}

function findColumn(board, wanted) {
  return pick(board.columns, wanted, { what: "coluna", label: (c) => `${c.name} em ${board.name}` });
}

function findCard(wanted, { archived = null } = {}) {
  const cards = doc().cards.filter((c) => archived === null || !!c.archived_at === archived);
  return pick(cards, wanted, {
    what: "card",
    name: (c) => c.title,
    label: (c) => `${c.title} [${boardOf(doc(), c.board_id)?.name}/${columnOf(boardOf(doc(), c.board_id), c.column_id)?.name}]`,
  });
}

function cardView(c) {
  const b = boardOf(doc(), c.board_id);
  const out = {
    id: c.id,
    title: c.title,
    board: b?.name,
    column: columnOf(b, c.column_id)?.name,
    due: c.due || null,
    due_state: dueState(doc(), c, getTodayStr()),
    labels: c.labels,
    note: c.note || "",
    created: iso(c.created_at),
  };
  if (c.completed_at) out.completed = iso(c.completed_at);
  if (c.archived_at) out.archived = iso(c.archived_at);
  if (c.pomo?.count || c.pomo?.focus_ms) out.focus = { pomodoros: c.pomo.count, time: formatFocus(c.pomo.focus_ms || 0) };
  return out;
}

async function boards() {
  return doc().boards.map((b) => ({
    id: b.id,
    name: b.name,
    active: b.id === doc().active_board,
    columns: b.columns.map((c) => ({ id: c.id, name: c.name, role: c.role, wip: c.wip || null, cards: cardsIn(doc(), c.id).length })),
  }));
}

async function listCards(p) {
  const boardsList = p.all_boards ? doc().boards : [findBoard(p.board)];
  const today = getTodayStr();
  const due = p.overdue ? "overdue" : p.today ? "today" : null;
  const label = p.label ? pick(doc().labels, p.label, { what: "etiqueta", id: (l) => l.name }).name : null;
  const out = [];
  for (const b of boardsList) {
    if (p.archived) {
      out.push(...archivedCards(doc(), b.id).filter((c) => matchFilter(doc(), c, { query: p.query || "", label }, today)));
      continue;
    }
    const cols = p.column ? [findColumn(b, p.column)] : b.columns;
    for (const col of cols) {
      out.push(...cardsIn(doc(), col.id).filter((c) => matchFilter(doc(), c, { query: p.query || "", due, label }, today)));
    }
  }
  return out.map(cardView);
}

async function get(p) {
  return cardView(findCard(p.card));
}

function applyLabels(card, labels) {
  card.labels = [...new Set(list(labels).flatMap((l) => String(l).split(",")).map((l) => ensureLabel(doc(), l)).filter(Boolean))];
}

async function add(p) {
  const b = findBoard(p.board);
  const col = p.column ? findColumn(b, p.column) : b.columns[0];
  const title = String(p.title).trim();
  if (!title) throw new CliError("usage", "Título vazio");
  const card = addCard(doc(), b.id, col.id, title, { top: col.role === "done" });
  if (p.due !== undefined) card.due = parseDue(p.due) || undefined;
  if (p.label !== undefined) applyLabels(card, p.label);
  if (p.note !== undefined) card.note = String(p.note);
  host.commit();
  return cardView(card);
}

async function update(p) {
  const card = findCard(p.card);
  if (p.title !== undefined) {
    const t = String(p.title).trim();
    if (!t) throw new CliError("usage", "Título vazio");
    card.title = t;
  }
  if (p.due !== undefined) {
    const d = parseDue(p.due);
    if (d) card.due = d;
    else delete card.due;
  }
  if (p.label !== undefined) applyLabels(card, p.label);
  if (p.note !== undefined) card.note = String(p.note);
  host.commit();
  return cardView(card);
}

async function move(p) {
  const card = findCard(p.card, { archived: false });
  let b = boardOf(doc(), card.board_id);
  if (p.board !== undefined) b = findBoard(p.board);
  if (p.column === undefined && p.board === undefined) throw new CliError("usage", "Informe --column e/ou --board");
  const col = p.column !== undefined ? findColumn(b, p.column) : b.columns[0];
  card.board_id = b.id;
  const before = p.top ? cardsIn(doc(), col.id).find((c) => c.id !== card.id)?.id ?? null : null;
  host.moveCardTo(card, col.id, before);
  host.commit();
  return cardView(card);
}

async function done(p) {
  const card = findCard(p.card, { archived: false });
  const col = columnByRole(boardOf(doc(), card.board_id), "done");
  if (!col) throw new CliError("failed", "Este board não tem coluna de concluídos (papel 'done')");
  if (card.column_id !== col.id) host.moveCardTo(card, col.id);
  host.commit();
  return cardView(card);
}

async function archive(p) {
  const card = findCard(p.card, { archived: false });
  host.removeCard(card, { archive: true });
  return cardView(card);
}

async function unarchive(p) {
  const card = findCard(p.card, { archived: true });
  delete card.archived_at;
  host.commit();
  return cardView(card);
}

async function remove(p) {
  requireFlag(p, "yes", "Excluir um card exige --yes");
  const card = findCard(p.card);
  host.removeCard(card);
  return { id: card.id, title: card.title, deleted: true };
}

async function labels() {
  const used = new Map();
  for (const c of doc().cards) for (const l of c.labels) used.set(l, (used.get(l) || 0) + 1);
  return doc().labels.map((l) => ({ name: l.name, color: labelColor(doc(), l.name), cards: used.get(l.name) || 0 }));
}

export const tasksCli = {
  boards,
  list: listCards,
  get,
  add,
  update,
  move,
  done,
  archive,
  unarchive,
  delete: remove,
  labels,
};

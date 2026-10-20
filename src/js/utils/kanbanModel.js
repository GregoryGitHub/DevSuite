// Board kanban das Tarefas: documento kanban.json (sem DOM; testado em tests/kanban.test.mjs).
//
// { version, boards: [{ id, name, columns: [{ id, name, color, role, wip }] }],
//   cards: [{ id, board_id, column_id, title, note, due, labels, created_at, completed_at, archived_at, pomo }],
//   active_board, labels: [{ name, color }], pomo: { work, break, long_break, long_every, auto_next } }
//
// A ordem dos cards numa coluna é a ordem em `cards`; colunas e boards seguem a ordem dos arrays.
// Papéis das colunas (no máximo um de cada por board): "doing" recebe o card ao iniciar o Pomodoro,
// "done" marca `completed_at` (sair dela apaga).

import { addDays } from "./date.js";

export const VERSION = 1;

/** Paleta fixa das colunas/etiquetas (cores reais em tasks.css: --kb-<cor>). */
export const COLORS = ["gray", "blue", "teal", "green", "amber", "orange", "red", "pink", "purple"];
export const COLOR_NAMES = { gray: "Cinza", blue: "Azul", teal: "Turquesa", green: "Verde", amber: "Amarelo", orange: "Laranja", red: "Vermelho", pink: "Rosa", purple: "Roxo" };

export const DEFAULT_POMO = { work: 25, break: 5, long_break: 15, long_every: 4, auto_next: false };

let uidCounter = 0;
export function uid() {
  uidCounter = (uidCounter + 1) % 1000;
  return Date.now() * 1000 + uidCounter;
}

export function defaultColumns() {
  return [
    { id: uid(), name: "A fazer", color: "gray", role: null, wip: 0 },
    { id: uid(), name: "Fazendo", color: "blue", role: "doing", wip: 0 },
    { id: uid(), name: "Concluído", color: "green", role: "done", wip: 0 },
  ];
}

export function newBoard(name = "Novo board") {
  return { id: uid(), name, columns: defaultColumns() };
}

const posInt = (v, def, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
};
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function normalizeColumn(c, i) {
  return {
    id: c?.id ?? uid(),
    name: String(c?.name ?? "").trim() || `Coluna ${i + 1}`,
    color: COLORS.includes(c?.color) ? c.color : "gray",
    role: c?.role === "doing" || c?.role === "done" ? c.role : null,
    wip: Math.max(0, Math.round(Number(c?.wip) || 0)),
  };
}

function normalizeBoard(b, i) {
  const columns = (Array.isArray(b?.columns) ? b.columns : []).map(normalizeColumn);
  if (!columns.length) columns.push(...defaultColumns());
  // Um papel de cada no máximo: fica o primeiro.
  for (const role of ["doing", "done"]) {
    let seen = false;
    for (const c of columns) {
      if (c.role !== role) continue;
      if (seen) c.role = null;
      seen = true;
    }
  }
  return { id: b?.id ?? uid(), name: String(b?.name ?? "").trim() || `Board ${i + 1}`, columns };
}

export function normalizePomo(p) {
  return {
    work: posInt(p?.work, DEFAULT_POMO.work, 180),
    break: posInt(p?.break, DEFAULT_POMO.break, 60),
    long_break: posInt(p?.long_break, DEFAULT_POMO.long_break, 90),
    long_every: posInt(p?.long_every, DEFAULT_POMO.long_every, 12),
    auto_next: !!p?.auto_next,
  };
}

function normalizeCard(c, now) {
  const card = {
    id: c.id ?? uid(),
    board_id: c.board_id,
    column_id: c.column_id,
    title: String(c.title ?? "").trim() || "Sem título",
    note: typeof c.note === "string" ? c.note : "",
    labels: Array.isArray(c.labels) ? [...new Set(c.labels.map((l) => String(l).trim()).filter(Boolean))] : [],
    created_at: Number(c.created_at) || now,
    pomo: {
      count: Math.max(0, Math.round(Number(c.pomo?.count) || 0)),
      focus_ms: Math.max(0, Math.round(Number(c.pomo?.focus_ms) || 0)),
    },
  };
  if (isDate(c.due)) card.due = c.due;
  if (c.completed_at) card.completed_at = Number(c.completed_at) || now;
  if (c.archived_at) card.archived_at = Number(c.archived_at) || now;
  if (c.pomo?.work) card.pomo.work = posInt(c.pomo.work, DEFAULT_POMO.work, 180);
  if (c.pomo?.break) card.pomo.break = posInt(c.pomo.break, DEFAULT_POMO.break, 60);
  return card;
}

/** Documento válido a partir de qualquer coisa (null, parcial, versão antiga). Sempre há ≥ 1 board. */
export function normalizeKanban(raw, now = Date.now()) {
  const doc = raw && typeof raw === "object" ? raw : {};
  const boards = (Array.isArray(doc.boards) ? doc.boards : []).map(normalizeBoard);
  if (!boards.length) boards.push(newBoard("Tarefas"));
  const byId = new Map(boards.map((b) => [b.id, b]));

  const cards = [];
  for (const c of Array.isArray(doc.cards) ? doc.cards : []) {
    if (!c || typeof c !== "object") continue;
    const card = normalizeCard(c, now);
    const board = byId.get(card.board_id) || boards[0];
    card.board_id = board.id;
    const col = board.columns.find((x) => x.id === card.column_id) || board.columns[0];
    card.column_id = col.id;
    if (col.role === "done" && !card.completed_at) card.completed_at = now;
    if (col.role !== "done") delete card.completed_at;
    cards.push(card);
  }

  const labels = [];
  for (const l of Array.isArray(doc.labels) ? doc.labels : []) {
    const name = String(l?.name ?? "").trim();
    if (name && !labels.some((x) => x.name === name)) labels.push({ name, color: COLORS.includes(l.color) ? l.color : "gray" });
  }
  // Etiquetas usadas nos cards e ausentes da lista ganham uma cor.
  for (const c of cards) for (const name of c.labels) if (!labels.some((x) => x.name === name)) labels.push({ name, color: nextColor(labels) });

  return {
    version: VERSION,
    boards,
    cards,
    active_board: byId.has(doc.active_board) ? doc.active_board : boards[0].id,
    labels,
    pomo: normalizePomo(doc.pomo),
  };
}

function nextColor(labels) {
  const pool = COLORS.filter((c) => c !== "gray");
  return pool[labels.length % pool.length];
}

/** Tarefas antigas (todos.json) → board "Tarefas": concluídas em "Concluído", o resto em "A fazer". */
export function migrateTodos(todos, now = Date.now()) {
  const board = newBoard("Tarefas");
  const [todo, , done] = board.columns;
  const cards = (Array.isArray(todos) ? todos : []).map((t) => {
    const created = Number(t.id) > 1e12 ? Number(t.id) : now;
    const card = {
      id: t.id ?? uid(),
      board_id: board.id,
      column_id: t.done ? done.id : todo.id,
      title: t.text,
      note: t.note || "",
      labels: [],
      created_at: created,
      pomo: { count: 0, focus_ms: 0 },
    };
    if (t.pomoWorkMinutes) card.pomo.work = t.pomoWorkMinutes;
    if (t.pomoBreakMinutes) card.pomo.break = t.pomoBreakMinutes;
    if (t.done) {
      const day = t.completed_date || t.date;
      card.completed_at = isDate(day) ? new Date(`${day}T12:00:00`).getTime() : now;
    } else if (isDate(t.date)) {
      card.due = t.date;
    }
    return card;
  });
  // Pendentes por data (como a lista "Pendentes" mostrava); concluídas mais recentes primeiro.
  const pending = cards.filter((c) => !c.completed_at).sort((a, b) => (a.due || "").localeCompare(b.due || "") || a.created_at - b.created_at);
  const finished = cards.filter((c) => c.completed_at).sort((a, b) => b.completed_at - a.completed_at);
  return normalizeKanban({ boards: [board], cards: [...pending, ...finished], active_board: board.id }, now);
}

// ---------- Consultas ----------

export const boardOf = (doc, id) => doc.boards.find((b) => b.id === id) || null;
export const columnOf = (board, id) => board?.columns.find((c) => c.id === id) || null;
export const columnByRole = (board, role) => board?.columns.find((c) => c.role === role) || null;
export const cardOf = (doc, id) => doc.cards.find((c) => c.id === id) || null;
export const isDoneCard = (doc, card) => columnOf(boardOf(doc, card.board_id), card.column_id)?.role === "done";

/** Cards de uma coluna, na ordem (arquivados ficam de fora). */
export function cardsIn(doc, columnId) {
  return doc.cards.filter((c) => c.column_id === columnId && !c.archived_at);
}

export function archivedCards(doc, boardId) {
  return doc.cards.filter((c) => c.board_id === boardId && c.archived_at).sort((a, b) => b.archived_at - a.archived_at);
}

/** "overdue" | "today" | "soon" (até 2 dias) | "later" | null (sem prazo ou concluído). */
export function dueState(doc, card, today) {
  if (!card.due || isDoneCard(doc, card)) return null;
  if (card.due < today) return "overdue";
  if (card.due === today) return "today";
  if (card.due <= addDays(today, 2)) return "soon";
  return "later";
}

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Filtros da barra: texto (título, anotação, etiquetas), prazo ("overdue" | "today") e etiqueta. */
export function matchFilter(doc, card, { query = "", due = null, label = null } = {}, today = "") {
  if (label && !card.labels.includes(label)) return false;
  if (due) {
    const s = dueState(doc, card, today);
    if (due === "overdue" && s !== "overdue") return false;
    if (due === "today" && s !== "today" && s !== "overdue") return false;
  }
  const q = fold(query.trim());
  if (!q) return true;
  return [card.title, card.note, ...card.labels].some((t) => fold(t).includes(q));
}

export function labelColor(doc, name) {
  return doc.labels.find((l) => l.name === name)?.color || "gray";
}

// ---------- Alterações ----------

/** Ajusta completed_at conforme a coluna (done ou não). */
function syncDone(doc, card, now) {
  if (isDoneCard(doc, card)) card.completed_at ||= now;
  else delete card.completed_at;
}

/**
 * Move o card para `columnId` (no mesmo board), antes do card `beforeId` ou no fim da coluna.
 * Retorna true se algo mudou.
 */
export function moveCard(doc, card, columnId, beforeId = null, now = Date.now()) {
  const from = doc.cards.indexOf(card);
  if (from < 0 || beforeId === card.id) return false;
  const prevCol = card.column_id;
  const prevIdx = from;
  doc.cards.splice(from, 1);
  card.column_id = columnId;
  let at;
  const before = beforeId != null ? doc.cards.findIndex((c) => c.id === beforeId) : -1;
  if (before >= 0) at = before;
  else {
    // Depois do último card da coluna (ou no fim do array).
    let last = -1;
    doc.cards.forEach((c, i) => {
      if (c.column_id === columnId) last = i;
    });
    at = last >= 0 ? last + 1 : doc.cards.length;
  }
  doc.cards.splice(at, 0, card);
  syncDone(doc, card, now);
  return prevCol !== columnId || prevIdx !== at;
}

/** Card um passo para cima/baixo dentro da coluna (só entre os visíveis, não arquivados). */
export function shiftCard(doc, card, delta) {
  const list = cardsIn(doc, card.column_id);
  const i = list.indexOf(card);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return false;
  const beforeId = delta < 0 ? list[j].id : list[j + 1]?.id ?? null;
  return moveCard(doc, card, card.column_id, beforeId);
}

export function addCard(doc, boardId, columnId, title, { top = false, now = Date.now() } = {}) {
  const card = normalizeCard({ id: uid(), board_id: boardId, column_id: columnId, title, created_at: now }, now);
  doc.cards.push(card);
  if (top) {
    const first = cardsIn(doc, columnId)[0];
    if (first && first !== card) moveCard(doc, card, columnId, first.id, now);
  }
  syncDone(doc, card, now);
  return card;
}

export function moveColumn(board, colId, beforeId = null) {
  const i = board.columns.findIndex((c) => c.id === colId);
  if (i < 0 || colId === beforeId) return false;
  const [col] = board.columns.splice(i, 1);
  const j = beforeId != null ? board.columns.findIndex((c) => c.id === beforeId) : -1;
  board.columns.splice(j >= 0 ? j : board.columns.length, 0, col);
  return board.columns.indexOf(col) !== i;
}

/** Define (ou tira, se já tem) o papel da coluna; outra coluna com o mesmo papel perde. */
export function setColumnRole(doc, board, colId, role) {
  const col = columnOf(board, colId);
  if (!col) return;
  const next = col.role === role ? null : role;
  for (const c of board.columns) if (next && c.role === next) c.role = null;
  col.role = next;
  const now = Date.now();
  for (const card of doc.cards) if (card.board_id === board.id) syncDone(doc, card, now);
}

/** Exclui a coluna; os cards vão para a vizinha (anterior, ou a seguinte). Retorna o id da vizinha. */
export function deleteColumn(doc, board, colId) {
  if (board.columns.length < 2) return null;
  const i = board.columns.findIndex((c) => c.id === colId);
  if (i < 0) return null;
  const target = board.columns[i > 0 ? i - 1 : 1];
  const moving = doc.cards.filter((c) => c.column_id === colId);
  board.columns.splice(i, 1);
  for (const card of moving) moveCard(doc, card, target.id);
  return target.id;
}

export function deleteBoard(doc, boardId) {
  doc.boards = doc.boards.filter((b) => b.id !== boardId);
  doc.cards = doc.cards.filter((c) => c.board_id !== boardId);
  if (!doc.boards.length) doc.boards.push(newBoard("Tarefas"));
  if (!boardOf(doc, doc.active_board)) doc.active_board = doc.boards[0].id;
}

export function moveBoard(doc, boardId, beforeId = null) {
  const i = doc.boards.findIndex((b) => b.id === boardId);
  if (i < 0 || boardId === beforeId) return false;
  const [b] = doc.boards.splice(i, 1);
  const j = beforeId != null ? doc.boards.findIndex((x) => x.id === beforeId) : -1;
  doc.boards.splice(j >= 0 ? j : doc.boards.length, 0, b);
  return doc.boards.indexOf(b) !== i;
}

/** Arquiva os cards da coluna (padrão do "Arquivar concluídos"). Retorna quantos. */
export function archiveColumn(doc, colId, now = Date.now()) {
  const list = cardsIn(doc, colId);
  for (const c of list) c.archived_at = now;
  return list.length;
}

export function ensureLabel(doc, name) {
  name = name.trim();
  if (!name) return null;
  if (!doc.labels.some((l) => l.name === name)) doc.labels.push({ name, color: nextColor(doc.labels) });
  return name;
}

// ---------- Pomodoro ----------

/** Minutos de cada fase para um card (o card sobrepõe os padrões do documento). */
export function pomoMinutes(doc, card) {
  return {
    work: card?.pomo?.work || doc.pomo.work,
    break: card?.pomo?.break || doc.pomo.break,
    long: doc.pomo.long_break,
  };
}

/** Fase seguinte: depois de `long_every` focos seguidos vem a pausa longa. */
export function nextPhase(phase, worksDone, cfg) {
  if (phase !== "work") return "work";
  return worksDone > 0 && worksDone % cfg.long_every === 0 ? "long" : "break";
}

/** "25 min", "1 h 05 min", "< 1 min". */
export function formatFocus(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return ms > 0 ? "< 1 min" : "0 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

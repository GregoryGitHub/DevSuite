// Testes do modelo do board kanban (Tarefas): node tests/kanban.test.mjs
import assert from "node:assert/strict";
const base = new URL("../src/js/utils/", import.meta.url).href;
const k = await import(base + "kanbanModel.js");

const NOW = new Date("2026-10-20T10:00:00").getTime();
const today = "2026-10-20";

// --- normalização
{
  const doc = k.normalizeKanban(null, NOW);
  assert.equal(doc.boards.length, 1);
  assert.deepEqual(doc.boards[0].columns.map((c) => c.name), ["A fazer", "Fazendo", "Concluído"]);
  assert.deepEqual(doc.boards[0].columns.map((c) => c.role), [null, "doing", "done"]);
  assert.equal(doc.active_board, doc.boards[0].id);
  assert.deepEqual(doc.pomo, k.DEFAULT_POMO);
}
{
  // Card órfão vai para a 1ª coluna do 1º board; papel repetido some; etiqueta desconhecida ganha cor.
  const doc = k.normalizeKanban(
    {
      boards: [{ id: 1, name: "X", columns: [{ id: 10, name: "A", role: "done" }, { id: 11, name: "B", role: "done", color: "nope" }] }],
      cards: [{ id: 5, board_id: 99, column_id: 77, title: "  ", labels: ["bug", "bug", ""] }, null],
      pomo: { work: "50", break: 0, long_every: 99 },
      active_board: 42,
    },
    NOW,
  );
  const [card] = doc.cards;
  assert.equal(doc.cards.length, 1);
  assert.equal(card.board_id, 1);
  assert.equal(card.column_id, 10);
  assert.equal(card.title, "Sem título");
  assert.deepEqual(card.labels, ["bug"]);
  assert.equal(card.completed_at, NOW, "coluna done marca completed_at");
  assert.deepEqual(doc.boards[0].columns.map((c) => c.role), ["done", null]);
  assert.equal(doc.boards[0].columns[1].color, "gray");
  assert.equal(doc.active_board, 1);
  assert.equal(doc.labels[0].name, "bug");
  assert.notEqual(doc.labels[0].color, "gray");
  assert.equal(doc.pomo.work, 50);
  assert.equal(doc.pomo.break, 5);
  assert.equal(doc.pomo.long_every, 12);
}

// --- migração do todos.json
{
  const todos = [
    { id: 1760000000000, text: "Concluída ontem", done: true, date: "2026-10-18", completed_date: "2026-10-19", is_my_day: false },
    { id: 1760000000001, text: "Amanhã", done: false, date: "2026-10-21", is_my_day: false, note: "obs" },
    { id: 1760000000002, text: "Atrasada", done: false, date: "2026-10-01", is_my_day: true },
    { id: 1760000000003, text: "Concluída hoje", done: true, date: "2026-10-20", completed_date: "2026-10-20" },
  ];
  const doc = k.migrateTodos(todos, NOW);
  const [todo, doing, done] = doc.boards[0].columns;
  assert.equal(doc.boards[0].name, "Tarefas");
  assert.deepEqual(k.cardsIn(doc, todo.id).map((c) => c.title), ["Atrasada", "Amanhã"]);
  assert.deepEqual(k.cardsIn(doc, doing.id), []);
  assert.deepEqual(k.cardsIn(doc, done.id).map((c) => c.title), ["Concluída hoje", "Concluída ontem"]);
  const amanha = doc.cards.find((c) => c.title === "Amanhã");
  assert.equal(amanha.due, "2026-10-21");
  assert.equal(amanha.note, "obs");
  assert.equal(amanha.created_at, 1760000000001);
  assert.equal(doc.cards.find((c) => c.title === "Concluída ontem").due, undefined, "concluída não leva prazo");
  assert.equal(new Date(doc.cards.find((c) => c.title === "Concluída ontem").completed_at).getDate(), 19);
  assert.equal(k.migrateTodos([], NOW).cards.length, 0);
}

// --- mover cards
{
  const doc = k.normalizeKanban(null, NOW);
  const b = doc.boards[0];
  const [todo, doing, done] = b.columns;
  const a = k.addCard(doc, b.id, todo.id, "a", { now: NOW });
  const c = k.addCard(doc, b.id, todo.id, "c", { now: NOW });
  const top = k.addCard(doc, b.id, todo.id, "top", { top: true, now: NOW });
  assert.deepEqual(k.cardsIn(doc, todo.id).map((x) => x.title), ["top", "a", "c"]);

  assert.ok(k.moveCard(doc, c, todo.id, a.id));
  assert.deepEqual(k.cardsIn(doc, todo.id).map((x) => x.title), ["top", "c", "a"]);
  assert.equal(k.moveCard(doc, c, todo.id, c.id), false, "soltar sobre si mesmo não muda nada");

  k.moveCard(doc, a, done.id, null, NOW);
  assert.equal(a.completed_at, NOW);
  assert.ok(k.isDoneCard(doc, a));
  k.moveCard(doc, a, doing.id);
  assert.equal(a.completed_at, undefined, "sair do done limpa completed_at");

  assert.ok(k.shiftCard(doc, top, 1));
  assert.deepEqual(k.cardsIn(doc, todo.id).map((x) => x.title), ["c", "top"]);
  assert.equal(k.shiftCard(doc, top, 1), false);
  assert.ok(k.shiftCard(doc, top, -1));
  assert.deepEqual(k.cardsIn(doc, todo.id).map((x) => x.title), ["top", "c"]);

  // Arquivar sai da coluna, mas continua no documento.
  k.moveCard(doc, c, done.id, null, NOW);
  assert.equal(k.archiveColumn(doc, done.id, NOW + 1), 1);
  assert.deepEqual(k.cardsIn(doc, done.id), []);
  assert.deepEqual(k.archivedCards(doc, b.id).map((x) => x.title), ["c"]);
}

// --- colunas: papel, reordenar, excluir
{
  const doc = k.normalizeKanban(null, NOW);
  const b = doc.boards[0];
  const [todo, doing, done] = b.columns;
  const x = k.addCard(doc, b.id, done.id, "x", { now: NOW });
  assert.equal(x.completed_at, NOW);

  k.setColumnRole(doc, b, todo.id, "done");
  assert.equal(todo.role, "done");
  assert.equal(done.role, null);
  assert.equal(x.completed_at, undefined, "coluna perdeu o papel done");
  k.setColumnRole(doc, b, todo.id, "done");
  assert.equal(todo.role, null, "mesmo papel de novo = tira");

  assert.ok(k.moveColumn(b, done.id, todo.id));
  assert.deepEqual(b.columns.map((c) => c.name), ["Concluído", "A fazer", "Fazendo"]);

  const y = k.addCard(doc, b.id, doing.id, "y", { now: NOW });
  assert.equal(k.deleteColumn(doc, b, doing.id), todo.id, "vai para a anterior");
  assert.equal(y.column_id, todo.id);
  assert.equal(k.deleteColumn(doc, b, done.id), todo.id, "primeira coluna vai para a seguinte");
  assert.equal(x.column_id, todo.id);
  assert.equal(k.deleteColumn(doc, b, todo.id), null, "última coluna não sai");
}

// --- boards
{
  const doc = k.normalizeKanban(null, NOW);
  const first = doc.boards[0];
  const second = k.newBoard("Projeto");
  doc.boards.push(second);
  k.addCard(doc, second.id, second.columns[0].id, "p");
  doc.active_board = second.id;
  assert.ok(k.moveBoard(doc, second.id, first.id));
  assert.equal(doc.boards[0].id, second.id);
  k.deleteBoard(doc, second.id);
  assert.equal(doc.cards.length, 0);
  assert.equal(doc.active_board, first.id);
  k.deleteBoard(doc, first.id);
  assert.equal(doc.boards.length, 1, "sempre sobra um board");
}

// --- prazo e filtros
{
  const doc = k.normalizeKanban(null, NOW);
  const b = doc.boards[0];
  const [todo, , done] = b.columns;
  const mk = (title, due, col = todo.id) => Object.assign(k.addCard(doc, b.id, col, title, { now: NOW }), due ? { due } : {});
  const late = mk("Relatório atrasado", "2026-10-19");
  const now = mk("Hoje", today);
  const soon = mk("Depois de amanhã", "2026-10-22");
  const later = mk("Mês que vem", "2026-11-20");
  const none = mk("Sem prazo");
  const fin = mk("Feito", "2026-10-01", done.id);
  assert.equal(k.dueState(doc, late, today), "overdue");
  assert.equal(k.dueState(doc, now, today), "today");
  assert.equal(k.dueState(doc, soon, today), "soon");
  assert.equal(k.dueState(doc, later, today), "later");
  assert.equal(k.dueState(doc, none, today), null);
  assert.equal(k.dueState(doc, fin, today), null, "concluído não fica atrasado");

  const titles = (f) => doc.cards.filter((c) => k.matchFilter(doc, c, f, today)).map((c) => c.title);
  assert.deepEqual(titles({ due: "overdue" }), ["Relatório atrasado"]);
  assert.deepEqual(titles({ due: "today" }), ["Relatório atrasado", "Hoje"]);
  assert.deepEqual(titles({ query: "RELATORIO" }), ["Relatório atrasado"], "sem acento/maiúsculas");
  k.ensureLabel(doc, "urgente");
  later.labels.push("urgente");
  assert.deepEqual(titles({ label: "urgente" }), ["Mês que vem"]);
  assert.deepEqual(titles({ query: "urg" }), ["Mês que vem"], "busca nas etiquetas");
  later.note = "falar com o João";
  assert.deepEqual(titles({ query: "joao" }), ["Mês que vem"], "busca na anotação");
}

// --- pomodoro
{
  const doc = k.normalizeKanban({ pomo: { work: 30, long_break: 20, long_every: 2 } }, NOW);
  const card = { pomo: { work: 50, count: 0, focus_ms: 0 } };
  assert.deepEqual(k.pomoMinutes(doc, card), { work: 50, break: 5, long: 20 });
  assert.deepEqual(k.pomoMinutes(doc, null), { work: 30, break: 5, long: 20 });
  assert.equal(k.nextPhase("work", 1, doc.pomo), "break");
  assert.equal(k.nextPhase("work", 2, doc.pomo), "long");
  assert.equal(k.nextPhase("break", 2, doc.pomo), "work");
  assert.equal(k.nextPhase("long", 2, doc.pomo), "work");
  assert.equal(k.formatFocus(0), "0 min");
  assert.equal(k.formatFocus(30000), "< 1 min");
  assert.equal(k.formatFocus(25 * 60000), "25 min");
  assert.equal(k.formatFocus(65 * 60000), "1 h 05 min");
}

console.log("kanban: ok");

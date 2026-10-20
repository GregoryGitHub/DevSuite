import { state } from "../state.js";
import { getTodayStr, addDays, formatDayLabel } from "../utils/date.js";
import { el, icon } from "../utils/dom.js";
import { boardOf, columnOf, columnByRole, isDoneCard, dueState, labelColor, ensureLabel, COLORS, COLOR_NAMES, formatFocus } from "../utils/kanbanModel.js";
import { hasPomo, isPomoRunning, pomoClock, pomoProgress, PHASE_LABEL } from "./pomodoro.js";

// Detalhe do card (coluna à direita no desktop, tela da pilha na bandeja): título, status, prazo,
// etiquetas, foco (Pomodoro) e anotação. As ações vêm de tasks.js por `ctx`.

const ps = state.pomoState;

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

function row({ iconCls, label, sub = null, on = false, onclick, trailing = null, disabled = false, title = null, tag = "button" }) {
  return el(
    `${tag}.tk-d-row${on ? ".on" : ""}${tag !== "button" ? ".static" : ""}`,
    tag === "button" ? { type: "button", onclick, disabled, title } : { title },
    icon(`${iconCls} tk-d-row-icon`),
    el("span.tk-d-row-text", {}, el("span", {}, label), sub),
    trailing,
  );
}

const dateLabel = (ms) => new Date(ms).toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });

export function renderCardDetail(container, card, ctx) {
  const { doc } = ctx;
  const board = boardOf(doc, card.board_id);
  const col = columnOf(board, card.column_id);
  const done = isDoneCard(doc, card);
  const today = getTodayStr();

  // Título
  const title = el("textarea.tk-d-title", { rows: 1, maxLength: 300, spellcheck: true, "aria-label": "Título do card" });
  title.value = card.title;
  title.addEventListener("input", () => {
    autoGrow(title);
    const text = title.value.replace(/\n/g, " ").trim();
    if (text) {
      card.title = text;
      ctx.saveSoon();
      ctx.updateCardTitle(text);
    }
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      title.blur();
    }
  });
  title.addEventListener("blur", () => {
    if (!title.value.trim()) title.value = card.title;
    ctx.flushSave();
  });
  const head = el(
    "div.tk-d-head",
    {},
    el("span.kb-dot.big", { style: `--c: var(--kb-${col.color})` }),
    title,
    el("button.nt-icon-btn.desktop-only", { type: "button", title: "Fechar detalhe (Esc)", onclick: ctx.close }, icon("fa-solid fa-xmark")),
  );
  head.classList.toggle("done", done);

  // Status
  const select = el("select.kb-d-select", { "aria-label": "Status" }, board.columns.map((c) => el("option", { value: c.id, selected: c.id === col.id }, c.name)));
  select.addEventListener("change", () => ctx.move(Number(select.value)));
  const doneCol = columnByRole(board, "done");
  const status = el(
    "div.tk-d-card",
    {},
    row({ tag: "label", iconCls: done ? "fa-solid fa-circle-check kb-ok" : "fa-solid fa-table-columns", label: "Status", trailing: select }),
    doneCol && !done
      ? el("div.tk-chips", {}, el("button.tk-chip", { type: "button", onclick: ctx.complete }, icon("fa-solid fa-check"), ` Mover para “${doneCol.name}”`))
      : null,
  );

  // Prazo
  const dateInput = el("input.tk-d-date", { type: "date", value: card.due || "" });
  dateInput.addEventListener("change", () => {
    if (dateInput.value) card.due = dateInput.value;
    else delete card.due;
    ctx.commit();
  });
  const setDue = (due) => {
    if (due && card.due !== due) card.due = due;
    else delete card.due;
    ctx.commit();
  };
  const chip = (label, date) => el(`button.tk-chip${card.due === date ? ".active" : ""}`, { type: "button", onclick: () => setDue(date) }, label);
  const ds = dueState(doc, card, today);
  const dueSub = card.due
    ? el("small", { class: ds === "overdue" ? "overdue" : ds === "today" ? "today" : "" }, ds === "overdue" ? `Atrasado · ${formatDayLabel(card.due)}` : formatDayLabel(card.due))
    : el("small", {}, "Sem prazo");
  const dueCard = el(
    "div.tk-d-card",
    {},
    row({ tag: "label", iconCls: `fa-regular fa-calendar${ds === "overdue" ? " overdue" : ""}`, label: "Prazo", sub: dueSub, trailing: dateInput }),
    el(
      "div.tk-chips",
      {},
      chip("Hoje", today),
      chip("Amanhã", addDays(today, 1)),
      chip("Próx. semana", addDays(today, 7)),
      card.due ? el("button.tk-chip", { type: "button", title: "Remover prazo", onclick: () => setDue(null) }, icon("fa-solid fa-xmark")) : null,
    ),
  );

  // Etiquetas: todas as do documento, ligadas/desligadas; campo cria uma nova.
  const labelInput = el("input.kb-label-input", { type: "text", placeholder: "Nova etiqueta", maxLength: 40, spellcheck: false });
  labelInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = ensureLabel(doc, labelInput.value);
    if (name && !card.labels.includes(name)) card.labels.push(name);
    ctx.commit();
    requestAnimationFrame(() => container.querySelector(".kb-label-input")?.focus());
  });
  const labels = el(
    "div.kb-d-labels",
    {},
    doc.labels.map((l) => {
      const on = card.labels.includes(l.name);
      const b = el(
        `button.kb-label.toggle${on ? ".on" : ""}`,
        {
          type: "button",
          style: `--c: var(--kb-${labelColor(doc, l.name)})`,
          title: on ? "Tirar a etiqueta (clique direito: cor / excluir)" : "Pôr a etiqueta (clique direito: cor / excluir)",
          onclick: () => {
            card.labels = on ? card.labels.filter((x) => x !== l.name) : [...card.labels, l.name];
            ctx.commit();
          },
        },
        on ? icon("fa-solid fa-check") : null,
        l.name,
      );
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        ctx.showMenu(e.clientX, e.clientY, [
          { header: `Etiqueta “${l.name}”` },
          ...COLORS.map((c) => ({ label: COLOR_NAMES[c], icon: "fa-solid fa-circle", color: c, indent: true, checked: l.color === c, run: () => ((l.color = c), ctx.commit()) })),
          "sep",
          {
            label: "Excluir etiqueta (de todos os cards)",
            icon: "fa-regular fa-trash-can",
            danger: true,
            run: () => {
              doc.labels = doc.labels.filter((x) => x !== l);
              for (const c of doc.cards) c.labels = c.labels.filter((x) => x !== l.name);
              ctx.commit();
            },
          },
        ]);
      });
      return b;
    }),
    labelInput,
  );
  const labelsCard = el("div.tk-d-card", {}, row({ tag: "div", iconCls: "fa-solid fa-tags", label: "Etiquetas" }), labels);

  // Foco (Pomodoro)
  const session = hasPomo(card.id);
  const running = isPomoRunning(card.id);
  const stats = card.pomo.count || card.pomo.focus_ms ? `${card.pomo.count} 🍅 · ${formatFocus(card.pomo.focus_ms)} de foco` : "Nenhum pomodoro ainda";
  const minutes = (key, label, def, max) => {
    const input = el("input.kb-num", { type: "number", min: 1, max, placeholder: def, value: card.pomo[key] || "" });
    input.addEventListener("change", () => {
      const n = Math.round(Number(input.value));
      if (n >= 1) card.pomo[key] = Math.min(n, max);
      else delete card.pomo[key];
      input.value = card.pomo[key] || "";
      ctx.onPomoMinutes();
    });
    return el("label.kb-d-min", {}, el("span", {}, label), input);
  };
  const focus = done
    ? card.pomo.count || card.pomo.focus_ms
      ? el("div.tk-d-card", {}, row({ tag: "div", iconCls: "fa-solid fa-stopwatch", label: "Foco", sub: el("small", {}, stats) }))
      : null
    : el(
        "div.tk-d-card",
        {},
        row({
          iconCls: running ? "fa-solid fa-pause" : "fa-solid fa-play",
          label: session ? (running ? "Foco em andamento" : "Foco pausado") : "Iniciar foco",
          sub: session ? el("small", { dataset: { pomoTime: "" } }, `${PHASE_LABEL[ps.phase]} · ${pomoClock()}`) : el("small", {}, stats),
          on: session,
          onclick: ctx.focus,
          trailing: session ? el("span.kb-mini-ring", { style: `--p: ${pomoProgress()}`, dataset: { pomoRing: "" } }) : null,
        }),
        session ? el("div.kb-d-stats", {}, stats) : null,
        el("div.kb-d-mins", {}, minutes("work", "Foco (min)", doc.pomo.work, 180), minutes("break", "Pausa (min)", doc.pomo.break, 60)),
      );

  // Anotação
  const note = el("textarea.tk-d-note", { placeholder: "Adicionar anotação", rows: 3, spellcheck: true });
  note.value = card.note || "";
  note.addEventListener("input", () => {
    autoGrow(note);
    card.note = note.value;
    ctx.saveSoon();
  });
  note.addEventListener("blur", () => ctx.flushSave());

  // Rodapé
  const info = [`Criado em ${dateLabel(card.created_at)}`, card.completed_at ? `Concluído em ${dateLabel(card.completed_at)}` : null].filter(Boolean).join(" · ");
  const footer = el(
    "div.tk-d-footer",
    {},
    el("span", {}, info),
    el(
      "span.kb-d-foot-actions",
      {},
      el("button.tk-act", { type: "button", title: "Arquivar", onclick: ctx.archive }, icon("fa-solid fa-box-archive")),
      el("button.tk-act.danger.desktop-only", { type: "button", title: "Excluir card (Delete)", onclick: ctx.remove }, icon("fa-regular fa-trash-can")),
    ),
  );

  container.append(head, status, focus, dueCard, labelsCard, note, footer);
  requestAnimationFrame(() => {
    autoGrow(title);
    autoGrow(note);
  });
}

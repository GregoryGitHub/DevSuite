---
name: devsuite-tasks
description: Manage the user's kanban tasks in Dev Suite with the `devsuite tasks` CLI — list boards/cards, find overdue or due-today work, add cards with due dates and labels, move them between columns, mark them done or archive them. Use when the user talks about their tasks, to-dos, board, backlog, what is late or due today.
---

# Tasks (`devsuite tasks`)

Tasks are cards on kanban boards (columns like "A fazer / Fazendo / Concluído"). A column with role `done` marks cards as completed; `doing` is where focus sessions move cards. See the `devsuite` skill for output format and safety flags; always pass `--json`.

```
devsuite tasks boards --json                          # boards, columns (role, WIP), card counts
devsuite tasks list --json                            # active board, all columns
devsuite tasks list --overdue --all-boards --json     # late work everywhere
devsuite tasks list --today --json                    # due today (includes overdue)
devsuite tasks list --column "Fazendo" --label urgente --query "api" --json
devsuite tasks list --archived --json
devsuite tasks get "Corrigir login" --json

devsuite tasks add "Revisar PR #42" --column "A fazer" --due amanha --label review --note "ver testes" --json
devsuite tasks update "Revisar PR #42" --due 2026-11-03 --label review --label urgente --json   # --due none removes
devsuite tasks move "Revisar PR #42" --column Fazendo --top --json
devsuite tasks move "Revisar PR #42" --board "Pessoal" --json        # first column of that board
devsuite tasks done "Revisar PR #42" --json
devsuite tasks archive "Revisar PR #42" --json
devsuite tasks delete "Revisar PR #42" --yes --json                  # permanent; only if asked
devsuite tasks labels --json
```

- Due dates accept `AAAA-MM-DD`, `DD/MM/AAAA`, `hoje`, `amanha`, `+N` (days).
- `due_state` in results: `overdue`, `today`, `soon` (≤ 2 days), `later`, or null (no date or done).
- Cards are found by id or title; use the id after an `ambiguous` error.

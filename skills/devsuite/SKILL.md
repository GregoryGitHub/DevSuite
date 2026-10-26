---
name: devsuite
description: Use the `devsuite` CLI to reach the user's Dev Suite app — notes and Markdown vaults, kanban tasks, saved HTTP requests (Postman-like), SQL Server/MongoDB connections (with saved queries), RabbitMQ queues and Redis servers. Use when the user mentions "minhas notas", "meu cofre", "minhas tarefas", "minhas requisições", "meu banco local", "minhas filas", "meu redis", "meu cache", or asks about anything stored in Dev Suite. Start here; the devsuite-notes, devsuite-tasks, devsuite-http, devsuite-db, devsuite-rabbit and devsuite-redis skills cover each area.
---

# Dev Suite CLI (`devsuite`)

`devsuite` talks to the Dev Suite desktop app over a local pipe. If the app is closed, the CLI starts it in the tray (first call can take ~10 s). Everything runs with the user's own data and saved credentials — passwords never appear in output.

## How to call it

```
devsuite <group> <command> [args] [--options] --json
```

- Groups: `notes`, `tasks`, `http`, `db`, `rabbit`, `redis`. Discover commands with `devsuite <group> --help` and `devsuite <group> <command> --help`; the full catalog is `devsuite schema`.
- Always pass `--json` (it is also the default when stdout is not a terminal). Output is `{"ok":true,"data":...}` or `{"ok":false,"error":{"code","message"}}`.
- Long-running streams (`rabbit watch`, `http run`, `redis monitor/subscribe/memory`) print one `{"event":...}` line per step before the final result.
- Values marked as input (bodies, SQL, scripts, Markdown) accept literal text, `@file` or `-` for stdin. Prefer `@file`/stdin for anything multi-line or containing quotes.
- Items are found by id or by name (case/accent-insensitive: exact > prefix > contains). An `ambiguous` error lists the candidates with ids — retry with the id.
- In Git Bash on Windows, arguments starting with `/` are rewritten into Windows paths; prefix such commands with `MSYS_NO_PATHCONV=1`.

## Exit codes and safety gates

| exit | meaning |
| --- | --- |
| 0 | ok |
| 1 | failure (message in `error.message`) |
| 2 | usage / not found / ambiguous |
| 3 | app unavailable |
| 4 | a safety flag is missing |

Reading is always free. Destructive or outward-facing actions require explicit flags, and you should only add them when the user asked for that action:

- `--write`: SQL/Mongo that changes data or schema, RabbitMQ publish/consume/move/purge/delete, raw management API calls other than GET, Redis commands with the `write` flag (set, del, ttl --set, publish, exec of write commands).
- `--yes`: deleting notes, cards, requests, collections, connections, captures, Redis keys.
- `--confirm "<connection name>"`: RabbitMQ and Redis connections marked as "ambiente sensível".
- Read-only database connections refuse writes even with `--write` (`read_only`).

Never add `--write`/`--yes`/`--confirm` just to get past an exit code 4: report what the command would do and ask the user.

## Quick reference

```
devsuite status --json                                  # app running? which windows are ready
devsuite notes search "deploy" --all-vaults --json      # search every vault
devsuite tasks list --overdue --json
devsuite http send "Api/Auth/Login" --env Dev --json
devsuite db query Local "select top 5 * from dbo.Pedidos" --db Loja --json
devsuite rabbit overview Local --json
devsuite redis info Local --json
```

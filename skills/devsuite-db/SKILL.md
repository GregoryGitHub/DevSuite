---
name: devsuite-db
description: Query and inspect the user's databases saved in Dev Suite (SQL Server, Azure SQL, MongoDB/Cosmos) with the `devsuite db` CLI — list connections, databases, schemas, tables/collections, describe tables (columns, keys, indexes, FKs), get DDL, run SQL or mongosh queries, and use the user's saved queries (catalog per connection/database, with parameters), and analyze SQL Server performance (execution plans, top queries, Query Store, blocking, waits, missing/unused indexes). Use when the user asks about data or structure in "my local database", a named connection, or wants a query run.
---

# Databases (`devsuite db`)

Connections come from the app (passwords stay in the OS keychain; Microsoft Entra logins may open a browser once). The CLI keeps its own sessions per connection/database while the app runs. See the `devsuite` skill for output format and safety flags; always pass `--json`.

## Explore structure first

```
devsuite db conns --json                                   # name, driver, host, default db, read_only
devsuite db databases Local --json
devsuite db schemas Local --db Loja --json
devsuite db objects Local --db Loja --kind table --filter pedido --json   # tables/views/procs/functions (+ row estimate)
devsuite db describe Local dbo.Pedidos --db Loja --json    # columns, PK, identity, defaults, FKs, indexes, checks
devsuite db ddl Local dbo.vw_Vendas --db Loja --json       # CREATE script of one object
devsuite db script Local --db Loja --out ./loja.sql --json # whole database DDL in dependency order (SQL Server)
devsuite db objects Mongo --db loja --json                 # MongoDB: collections
devsuite db describe Mongo pedidos --db loja --json        # sampled fields with BSON types + indexes
```

## Query

```
devsuite db query Local "select top 20 * from dbo.Pedidos order by Id desc" --db Loja --json
devsuite db query Local @relatorio.sql --db Loja --max-rows 2000 --json
devsuite db query Local "select ..." --db Loja --format csv        # csv | tsv | md | table (prints raw, no envelope)
devsuite db query Mongo "db.pedidos.find({status: 'novo'}).sort({criado: -1}).limit(10)" --db loja --json
devsuite db query Mongo "db.pedidos.aggregate([{\$group: {_id: '\$status', n: {\$sum: 1}}}])" --db loja --json
```

- Result: `results[]` with `columns` + `rows` (SQL) or `docs` in Extended JSON (MongoDB), `row_count`, `truncated` (hit `--max-rows`, default 500), plus `messages` (rows affected) and `elapsed_ms`.
- Scripts may have several statements and `GO` batches; MongoDB accepts mongosh syntax (`db.x.find/aggregate/countDocuments/distinct/...`, `use otherdb`).
- Big numbers, decimals and dates come as strings to keep precision.

## Performance (SQL Server / Azure SQL)

Typical flow for "why is this slow?": find the expensive queries, read the plan, then check indexes/statistics.

```
devsuite db top-queries Local --db Loja --by cpu --limit 10 --json          # plan cache: cpu|avg_cpu|duration|avg_duration|reads|writes|physical|executions|memory
devsuite db top-queries Local --db Loja --by reads --plan --json            # + plan summary of the top 5
devsuite db top-queries Local --db Loja --store --hours 168 --json          # Query Store history (survives restarts)
devsuite db top-queries Local --db Loja --store --regressed --json          # got slower vs. the previous week
devsuite db plan Local "select * from dbo.Pedidos where ClienteId = 42" --db Loja --json   # estimated plan: nothing runs
devsuite db plan Local @lenta.sql --db Loja --analyze --json                # runs it: actual rows, STATISTICS IO/TIME
devsuite db plan Local @lenta.sql --db Loja --out lenta.sqlplan --json      # save for SSMS / the app
devsuite db indexes Local --db Loja --kind missing --json                   # optimizer suggestions + CREATE INDEX
devsuite db indexes Local --db Loja --table dbo.Pedidos --kind usage --json # seeks/scans/lookups vs. writes
devsuite db indexes Local --db Loja --kind stale --json                     # statistics with many modifications
devsuite db sessions Local --blocking --json                                # who blocks whom (depth, wait, SQL)
devsuite db waits Local --sample 10 --json                                  # where the server waits (benign waits removed)
```

- `plan` returns per statement: `cost`, `top_operators` (operator, object, `cost_pct`, estimated vs. actual rows, predicate), `missing_indexes` (with `ddl`) and `insights` (`level` error|warn|info: costly operator, wrong estimate, key lookup, scan with residual predicate, spill, implicit conversion, parameter sniffing...). Start from `insights`.
- `plan` without `--analyze` never executes the statement, so it needs no `--write`. `--analyze` executes it: writes need `--write` (and stay refused on read-only connections). Prefer the estimated plan unless the user wants real numbers.
- Missing index suggestions overlap: combine the ones on the same table before suggesting a `CREATE INDEX`, and show it to the user instead of running it.
- These read DMVs: the login needs VIEW SERVER STATE (SQL Server 2022: VIEW SERVER PERFORMANCE STATE; Azure SQL Database: VIEW DATABASE STATE). Index usage and the plan cache reset when the server restarts.
- KILL, forcing a Query Store plan and creating indexes are done in the app (Desempenho tab) or via `db query --write`, only when asked.

## Saved queries

The user keeps reusable queries per connection and database (Explorer → "consultas salvas"). Parameters are `:name` (SQL) or `{{name}}` (SQL and MongoDB).

```
devsuite db queries --conn Local --db Loja --json                 # name, folder, params, sql
devsuite db run-saved Local "Pedidos do cliente" --param id=42 --json
devsuite db run-saved Local "Pedidos por período" --param inicio:date=2026-01-01 --param fim:date=2026-01-31 --json
devsuite db run-saved Local "Pedidos do cliente" --use-last --json   # reuse the last values
devsuite db save-query Local "Pedidos do cliente" "select * from dbo.Pedidos where ClienteId = :id" --db Loja --folder Relatórios --json
```

- Parameter types: `auto` (number/true/false/null detected, otherwise text), `text`, `number`, `date`, `bool`, `null`, `raw` (inserted as-is, e.g. `IN (:ids)` with `ids:raw=1,2,3`). Text is quoted/escaped for you; inside a string literal (`'%{{q}}%'`) only the text is inserted.
- `run-saved` follows the same `--write`/read-only rules as `query`. Prefer a saved query over writing a new one when its name matches what the user asks.

## Writing (only when the user asked)

- Anything other than `SELECT`/`WITH ... SELECT` (and `DECLARE`/`SET`) needs `--write`: INSERT/UPDATE/DELETE/MERGE, `SELECT INTO`, DDL, `EXEC`. MongoDB inserts/updates/deletes/index changes too.
- Connections marked read-only always refuse writes (`read_only`).
- The CLI never leaves a transaction open: a script that ends with `BEGIN TRAN` and no `COMMIT` is rolled back (and says so). Include `COMMIT` when the user wants the change kept.
- Prefer showing the user the statement (and a `SELECT` of the affected rows) before running a write.

## Connections

```
devsuite db conn add --name "Local" --host localhost --port 1433 --user sa --password @pw.txt --trust-cert --test --json
devsuite db conn add --name "Mongo" --driver mongo --uri "mongodb://user@localhost:27017/?authSource=admin" --password - --test --json
devsuite db conn add --name "Prod" --host srv.database.windows.net --database app --entra --read-only --json
devsuite db test Local --json
devsuite db disconnect Local --json     # close CLI sessions (e.g. before DROP DATABASE)
devsuite db conn remove Local --yes --json
```

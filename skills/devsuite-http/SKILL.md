---
name: devsuite-http
description: Use the user's saved HTTP requests in Dev Suite (Postman-like collections, environments, {{variables}}, pre-request and test scripts) through the `devsuite http` CLI. Use when the user wants to call one of their APIs, run a collection, create or edit a request with scripts, run a cURL with their environment variables, manage environments, or import/export Postman collections.
---

# HTTP client (`devsuite http`)

Requests run through the same pipeline as the app: collection + request pre-request scripts → `{{variables}}` (local `--var` > environment > collection > globals, plus `{{$guid}}`, `{{$timestamp}}`...) → auth → send → test scripts. See the `devsuite` skill for output format and safety flags; always pass `--json`.

## Explore

```
devsuite http collections --json
devsuite http requests --collection Api --folder Auth --json
devsuite http requests --query login --json
devsuite http request get "Api/Auth/Login" --json      # full request: headers, body, auth, scripts
devsuite http envs --json                              # environments (active marked) and globals
devsuite http history --limit 10 --json
```

Requests are addressed by id, name, or path `"Collection/Folder/Sub/Name"`.

## Send

```
devsuite http send "Api/Auth/Login" --json                       # active environment
devsuite http send "Api/Pedidos/Listar" --env Homologação --var page=2 --json
devsuite http send "Api/Relatorio" --body-only --json            # just the response body
devsuite http run "Api" --env Dev --json                         # runner: whole collection, in order
devsuite http run "Api/Pedidos" --iterations 3 --bail --json
devsuite http curl "curl -X POST {{base}}/x -d 'a=1'" --env Dev --json   # ad hoc, not saved (--save to keep)
```

The result has `status`, `time_ms`, `headers`, `body` (cut at 512 KB; `--max-body KB`, `0` = all), `tests` (`passed` per `pm.test`), `logs` (console output of scripts) and `error`. `ok` is false on network errors or failed tests. Scripts can change environment variables (e.g. store a token) — that is persisted, like in the app.

## Create and edit

```
devsuite http request create --collection Api --folder Auth --name Login --method POST \
  --url "{{base}}/auth/login" --header "Accept: application/json" \
  --body @login.json --pre-script @pre.js --test-script @tests.js --json
devsuite http request update "Api/Auth/Login" --auth "bearer:{{token}}" --json
devsuite http env set Dev --var base=http://localhost:5000 --var user=ana --json   # creates env if needed
devsuite http env use Dev --json
devsuite http import ./colecao.postman_collection.json --json
devsuite http export Api --out ./api.postman.json --json
```

- `--body-type`: `json` (default when the body looks like JSON), `text`, `xml`, `html`, `javascript`, `graphql`, `urlencoded`/`form` with repeated `--form key=value` (`--form file=@/path` uploads a file).
- `--auth`: `inherit` (default: collection auth), `none`, `bearer:TOKEN`, `basic:USER:PASS`, `apikey:NAME:VALUE[:query]`.
- Scripts use the Postman `pm` API: `pm.environment.set/get`, `pm.variables`, `pm.test(name, fn)`, `pm.expect(x).to.eql(y)`, `pm.response.json()`, `pm.response.to.have.status(200)`, `pm.sendRequest`.
- Deleting (`request delete`, `collection delete`, `env delete`) needs `--yes` and only when the user asked.

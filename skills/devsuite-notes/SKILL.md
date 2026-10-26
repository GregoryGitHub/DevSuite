---
name: devsuite-notes
description: Read, search, create and edit the user's notes in Dev Suite (local notes database or Obsidian-style Markdown vaults) with the `devsuite notes` CLI. Use when the user asks to find something in their notes, summarize or update a note, save information as a note, list folders/tags, or follow [[links]] and backlinks between notes.
---

# Notes (`devsuite notes`)

Notes live in the active storage (local database or a vault = folder of `.md` files). Other vaults the user has opened are readable too. See the `devsuite` skill for output format and safety flags; always pass `--json`.

## Find

```
devsuite notes vaults --json                         # storages; "active": true marks the current one
devsuite notes search "kafka retry" --json           # full text (case/accent-insensitive)
devsuite notes search "kafka" --all-vaults --json    # every vault + local db ("store" says where)
devsuite notes search "tag:projeto/api type:permanent [[Arquitetura]] deploy" --json
devsuite notes list --folder Trabalho/Clientes --tag reuniao --limit 50 --json
devsuite notes folders --json                        # tree with counts
devsuite notes tags --json
```

Search filters: `tag:x` / `#x` (hierarchical: `tag:a` matches `a/b`), `type:`, `status:`, `id:`, `[[Note]]` (notes that link to it); the rest is full-text. Results are metadata (title, folder, tags, preview); read the body with `get`.

## Read

```
devsuite notes get "Deploy da API" --json            # content as Markdown (default)
devsuite notes get 1712345678901 --format text --json
devsuite notes get "Ideias" --vault "Outro Cofre" --json
devsuite notes links "Arquitetura" --json            # outgoing [[links]] (+ pending targets)
devsuite notes backlinks "Arquitetura" --json        # who links here
```

Notes are identified by id or title. Prefer ids from a previous result to avoid `ambiguous`.

## Write

```
devsuite notes create --title "Reunião 21/10" --folder Trabalho/Reuniões --tag reuniao --body @/tmp/ata.md --json
echo "- [ ] revisar PR" | devsuite notes update "Reunião 21/10" --append - --json
devsuite notes update "Reunião 21/10" --body @novo-corpo.md --json   # replaces everything below the title
devsuite notes update "Reunião 21/10" --title "Reunião de planejamento" --add-tag q4 --json
devsuite notes move "Reunião 21/10" --folder Arquivo --json
devsuite notes pin "Reunião 21/10" --json
devsuite notes export "Reunião 21/10" --out ./reuniao.md --json
devsuite notes import ./docs/a.md ./docs/b.md --folder Importadas --json
devsuite notes delete "Rascunho" --yes --json                       # goes to trash (30 days); --permanent to purge
```

- Bodies are Markdown: headings, lists, `- [ ]` checklists, tables, fenced code (```` ```sql ````), Mermaid, and `[[Other note]]` links (they become real links when the title exists).
- The first line is the title. `create` without `--title` uses the first line of the body.
- `create --vault <name>` writes a new `.md` straight into another vault; edits/moves only work on the active storage.
- Only delete when the user asked; `delete` needs `--yes`.

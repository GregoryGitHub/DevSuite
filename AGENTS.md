# AGENTS.md - Guia do Projeto para Agentes de IA

Este documento fornece um mapa conciso e abrangente da arquitetura, estrutura de código, comandos backend e regras de negócio do **Dev Suite** (antigo TodoRS), otimizando o contexto para assistentes e agentes de IA (como o Antigravity).

---

## 1. Visão Geral do Projeto

- **Nome**: Dev Suite (`productName`; executável `dev-suite`). O repositório, o crate (`todo-rs`), o `identifier` (`com.todors.app`, que define a pasta de dados) e o serviço do cofre de senhas (`todo-rs`) mantêm o nome antigo: trocá-los perderia dados e senhas.
- **Tipo**: Aplicativo de produtividade com CLI (`devsuite`, para scripts e agentes de IA) (Tarefas em board kanban com Pomodoro, Notas Rápidas, Timer Pomodoro, cliente HTTP estilo Postman, Formatter JSON, cliente de banco de dados estilo DataGrip — SQL Server, Azure SQL e MongoDB — monitor/depurador de RabbitMQ e cliente Redis — standalone, Cluster, Sentinel, TLS e túnel SSH) para Desktop.
- **Tecnologias**:
  - **Frontend**: HTML5, CSS3 Vanilla (com variáveis CSS e design moderno), JavaScript nativo (ES Modules).
  - **Backend / Desktop Frame**: Rust + Tauri v2.
  - **Ícones**: FontAwesome 6 (via CDN).
  - **Fontes**: Google Fonts (Poppins).

---

## 2. Estrutura de Diretórios e Arquivos

```
todo-rs/
├── .github/workflows/release.yml # CI/CD automático via GitHub Actions para releases Linux e Windows
├── AGENTS.md                  # Este guia de contexto para agentes de IA
├── build_linux.sh             # Script de build de release para Linux (.deb, .rpm, .AppImage)
├── build_windows.ps1          # Script de build de release para Windows (.exe/.msi)
├── build_windows.sh           # Script de cross-compilação para Windows via Linux
├── build_cli.ps1 / build_cli.sh # Compila a CLI `devsuite` para src-tauri/binaries/devsuite-<target> (externalBin; chamados pelos scripts de build e pelo release.yml)
├── skills/                    # Skills para agentes de IA (SKILL.md: devsuite, -notes, -tasks, -http, -db, -rabbit, -redis), embutidas na CLI (`devsuite skills install`)
├── dev-suite.svg              # Ícone fonte do app: bloco cinza com a grade 2×2 da suíte e um prompt `>_` (gerado em src-tauri/icons via `_gen_icons.ps1`, que também gera a bandeja `tray_*.svg` e os ícones de `icons/apps`)
├── _gen_icons.ps1             # Gera todos os ícones do bundle com `cargo tauri icon` a partir do SVG (e os de cada app em src-tauri/icons/apps e de tipos de arquivo em src-tauri/icons/files)
├── clean.sh                   # Script para limpar cache de build no Linux (cargo clean)
├── clean.ps1                  # Script para limpar cache de build no Windows
├── tests/kanban.test.mjs     # Testes do board das Tarefas: migração do todos.json, mover cards, colunas, prazos, filtros, Pomodoro (`node tests/kanban.test.mjs`)
├── tests/db-utils.test.mjs    # Testes dos utilitários da aba Banco (`node tests/db-utils.test.mjs`)
├── tests/sqlplan.test.mjs     # Planos de execução (parser, custos, diagnósticos, layout), STATISTICS IO/TIME e SQL das DMVs (`node tests/sqlplan.test.mjs`; planos reais em tests/fixtures/plans/*.sqlplan)
├── tests/mongo.test.mjs       # Testes do parser mongosh e da conversão de documentos (`node tests/mongo.test.mjs`)
├── tests/code-block.test.mjs  # Testes dos blocos de código das Notas: dobras, realce, linguagens (`node tests/code-block.test.mjs`)
├── tests/rabbit.test.mjs      # Testes dos utilitários da aba RabbitMQ (`node tests/rabbit.test.mjs`)
├── tests/redis.test.mjs       # Testes do app Redis: linha de comando redis-cli, formato RESP, árvore de chaves, INFO/CLIENT LIST/SLOWLOG/MONITOR, URL (`node tests/redis.test.mjs`)
├── tests/zettel.test.mjs      # Testes do Zettelkasten das Notas: links, propriedades/YAML, grafo, busca, layout (`node tests/zettel.test.mjs`)
├── tests/folders.test.mjs     # Subpastas (Notas/HTTP), importação de pasta de Markdown, Postman aninhado (`node tests/folders.test.mjs`)
├── tests/vault.test.mjs       # Modo cofre das Notas: nomes de arquivo, caminhos de imagens, front-matter (`node tests/vault.test.mjs`)
├── tests/mdfile.test.mjs      # .md de fora das Notas: front-matter/CRLF/BOM preservados, URLs de imagem `f/` (`node tests/mdfile.test.mjs`)
├── tests/textdiff.test.mjs    # Diff do git das Notas: Myers por linha, palavras, dobras, reverter trecho, merge 3 vias (`node tests/textdiff.test.mjs`)
├── tests/cli.test.mjs         # CLI: utilitários (pick, SQL somente leitura, prazos, auth), commands.json x handlers, exemplos das skills (`node tests/cli.test.mjs`)
├── src/                       # Frontend da Aplicação
│   ├── index.html             # Estrutura HTML principal (views, modais e barra de navegação)
│   ├── theme.css              # Tokens de tema claro/escuro (html[data-theme]) e paleta de realce --syn-*
│   ├── styles.css             # Estilos CSS globais, modais, configurações e layout da bandeja
│   ├── notes.css              # Estilos das Notas (modo bandeja compacto + modo desktop estilo macOS)
│   ├── zettel.css             # Notas: chips de link [[ ]], prévia, painel de propriedades, rodapé de links e grafo
│   ├── git.css                # Notas (cofre): painel Git da barra lateral, diff estilo JetBrains, diálogos do git
│   ├── http.css               # Estilos da aba HTTP (reaproveita o layout .notes-app/.nt-* das Notas)
│   ├── json.css               # Estilos do Formatter JSON
│   ├── tasks.css              # Board das Tarefas: colunas, cards, drag & drop, barra de foco, detalhe (bandeja = abas de coluna)
│   ├── code.css               # Editor de código compartilhado (.ce) e tokens de realce (.tok-*)
│   ├── db.css                 # Aba Banco: Explorer, abas, DataGrid, console, log e diálogos
│   ├── rabbit.css             # Aba RabbitMQ (reaproveita .db-app/.hx-*): seções, tabelas, mensagens, gravações
│   ├── redis.css              # App Redis (reaproveita .db-app/.rmq-*/.hx-*): árvore de chaves, editores por tipo, console, monitor, pub/sub, memória
│   ├── main.js                # Entry point JS: inicialização (todos os apps ou só o da janela desatachada) e eventos globais
│   ├── vendor/mermaid/        # Mermaid 11 (UMD, MIT) carregado sob demanda pelos diagramas das Notas (offline)
│   └── js/                    # Módulos JS organizados por responsabilidade
│       ├── api.js             # Bridge IPC Tauri (`load_todos`, `save_todos`, etc.)
│       ├── state.js           # Estado global reativo da aplicação
│       ├── noteStore.js       # Notas no notes.db: migração do JSON, conteúdo sob demanda, fila de gravação, busca
│       ├── navigation.js      # Troca de view principal (dispara o evento "mainviewchange"); app solto = foca a janela dele
│       ├── windowContext.js   # SOLO_APP: app desta janela desatachada (null na principal), DETACHABLE
│       ├── appLifecycle.js    # registerApp(view, { flush, reload, blocker }): gravar/reler ao mudar de janela
│       ├── cli/               # Ponte da CLI `devsuite` (regra 14): handlers sobre o estado vivo de cada app
│       │   ├── bridge.js      # "cli-call" → handler → cli_reply/cli_event; registerCli(view, tabela), cancelamento
│       │   ├── cliUtils.js    # Sem DOM: CliError, pick (id/nome), splitPair, sqlReadOnly, parseDue, parseAuth, sinceMs
│       │   ├── notesCli.js    # notes.*: cofres, list/search (todos os cofres), get/create/update/move/delete, links, export/import
│       │   ├── tasksCli.js    # tasks.*: boards, list (filtros), add/update/move/done/archive/delete
│       │   ├── httpCli.js     # http.*: coleções, requisições (CRUD + scripts), send/run/curl, ambientes, Postman
│       │   ├── dbCli.js       # db.*: conexões, introspecção, describe/ddl/script, query (SQL/mongosh, trava de escrita), plan/top-queries/sessions/waits/indexes
│       │   └── rabbitCli.js   # rabbit.*: overview/filas/..., peek/watch, publish/move/purge (--write/--confirm), gravações, log
│       │   └── redisCli.js    # redis.*: conns, info, keys/get/ttl, set/del/exec/publish (--write/--yes/--confirm), slowlog, clients, memory, monitor/subscribe
│       ├── utils/
│       │   ├── date.js        # Utilitários de data e formatação de tempo
│       │   ├── dom.js         # Helper `el()` para montar DOM (compartilhado pelos componentes)
│       │   ├── highlight.js   # Realce por regex (JSON, JS/TS, XML/HTML, GraphQL, SQL, CSS, Python, Bash, PowerShell, C#/Java/Go/Rust/C++, YAML, diff, Mermaid) + CODE_LANGS
│       │   ├── codeBlock.js   # Blocos de código das Notas: regiões dobráveis, linhas realçadas, detecção da linguagem
│       │   ├── audio.js       # Gerador de som WebAudio para o alarme do Pomodoro
│       │   ├── kanbanModel.js # Tarefas: kanban.json (normalizar, migrar todos.json, mover card/coluna, papéis, prazos, filtros, fases do Pomodoro; sem DOM)
│       │   ├── noteContent.js # HTML das notas: migração, título/preview, sanitização, URLs de imagem
│       │   ├── noteImages.js  # Imagens das notas: salvar colagens/data: URLs, importar arquivos do Markdown
│       │   ├── markdown.js    # Conversão HTML das notas <-> Markdown (import/export; [[ ]] e front-matter)
│       │   ├── zettel.js      # Notas: links [[ ]], propriedades + YAML, TitleIndex, backlinks, buildGraph, filtros da busca (sem DOM)
│       │   ├── graphLayout.js # Notas: simulação de forças do grafo (Barnes-Hut, para sozinha; sem DOM)
│       │   ├── folderTree.js  # Árvore de pastas com subpastas (Notas e HTTP): filhos, caminho, achatar, mover, garantir caminho
│       │   ├── mdImport.js    # Importar pasta de Markdown: caminhos relativos, imagens do vault, links [[pasta/Nota#seção]]
│       │   ├── textDiff.js    # Git das Notas: diff por linha (Myers) e palavra, blocos insert/delete/modify, dobras, reverter trecho, merge3 + marcadores (sem DOM)
│       │   ├── textFind.js    # Busca sem maiúsculas/acentos com posições preservadas (Ctrl+F na nota)
│       │   ├── mdDoc.js       # .md de fora das Notas: texto do arquivo <-> HTML do editor (front-matter, EOL e BOM intactos; imagens relativas)
│       │   ├── vaultNote.js   # Modo cofre: HTML da nota <-> arquivo .md (título = nome do arquivo, imagens relativas), safeName, folderDir
│       │   ├── httpModel.js   # HTTP: modelo/migração, variáveis {{}}, URL<->params, montagem da requisição
│       │   ├── httpConvert.js # HTTP: import cURL, snippets de código, import/export Postman v2.1
│       │   ├── httpScripts.js # HTTP: sandbox dos scripts pre-request/tests (API `pm` + `pm.expect`)
│       │   ├── jsonRepair.js  # JSON: diagnóstico heurístico + pipeline de reparo, parser tolerante e serializador
│       │   ├── dbModel.js     # Banco: databases.json (conexões sem segredo, consoles, consultas salvas, abas), connection string ADO/JDBC
│       │   ├── sqlParams.js   # Parâmetros das consultas (:nome / {{nome}}): achar e substituir por literais do dialeto/mongosh (sem DOM)
│       │   ├── sqlDialect.js  # Banco: dialeto SQL (quoting, literais, paginação OFFSET/FETCH); marcadores DEFAULT/GENERATED
│       │   ├── sqlSplit.js    # Banco: divide scripts em lotes (GO) e comandos; comando sob o cursor
│       │   ├── sqlGen.js      # Banco: UPDATE/INSERT/DELETE das alterações pendentes do grid (pela PK original)
│       │   ├── sqlDdl.js      # Banco: modelo editável da tabela + DDL do SQL Server (diff ALTER/CREATE, renomear, excluir)
│       │   ├── sqlPlan.js     # Banco: SHOWPLAN XML (tokenizer próprio) → comandos/operadores com custos, avisos, índices faltantes, diagnósticos, layout do diagrama (sem DOM)
│       │   ├── sqlStats.js    # Banco: mensagens SET STATISTICS IO/TIME (3615/3612/3613) → leituras por tabela e tempos (pelo número, não pelo idioma)
│       │   ├── sqlPerf.js     # Banco: SQL das DMVs/Query Store (top consultas, sessões, esperas, índices, estatísticas), cadeia de bloqueio, categorias de espera (sem DOM)
│       │   ├── mongoShell.js  # MongoDB: parser da sintaxe do mongosh → operação JSON (Extended JSON); divisão do script
│       │   ├── mongoValue.js  # MongoDB: Extended JSON ↔ células, formatação mongosh, updateOne/insertOne/deleteOne do grid
│       │   ├── gridModel.js   # DataGrid: linhas, visão filtrada/ordenada, pendências, agregados (sem DOM)
│       │   ├── gridExport.js  # DataGrid: TSV/CSV/JSON/Markdown/SQL INSERT e leitura de TSV colado (Excel)
│       │   └── rabbitModel.js # RabbitMQ: conexões/ui/settings, caminhos da API, formatação, x-death, filtros, {{n}}/{{uuid}}
│       │   └── redisModel.js  # Redis: redis.json, valores RESP {t,v} ↔ texto/JSON, linha do redis-cli, árvore de chaves, INFO/CLIENT LIST/SLOWLOG/MONITOR, comandos perigosos, URL
│       └── components/
│           ├── tasks.js       # Tarefas: board kanban (boards, colunas, cards, drag & drop, filtros, arquivados, barra de foco, atalhos)
│           ├── taskDetail.js  # Tarefas: detalhe do card (status, prazo, etiquetas, foco/Pomodoro, anotação)
│           ├── codeEditor.js  # Editor de código (textarea + realce + numeração de linhas + recuo inteligente)
│           ├── theme.js       # Tema claro/escuro/sistema (botões [data-theme-toggle] e seletor nas Configurações)
│           ├── notes.js       # Notas: pastas, lista agrupada, busca, lixeira, menus
│           ├── noteEditor.js  # Editor rico (contenteditable): estilos, listas, checklist, tabelas, colar imagens
│           ├── noteHistory.js # Desfazer/refazer das notas (snapshots do HTML, agrupados por palavra)
│           ├── noteMenus.js   # Notas: barra flutuante da seleção e menu "/" (estilo Notion)
│           ├── noteCode.js    # Blocos de código das Notas (widget): linhas numeradas, dobrar/desdobrar, edição no lugar, Mermaid
│           ├── mermaidView.js # Mermaid: carga sob demanda, fila de renderização, visualização com zoom/arrastar
│           ├── notePdf.js     # Exportar nota em PDF: monta #note-print (só na mídia print, tema claro) e chama notes_print_pdf
│           ├── noteFind.js    # Ctrl+F dentro da nota (Notas, janela do .md e prévia): barra flutuante + destaques via CSS Highlight API
│           ├── noteLinks.js   # Links [[ ]] no editor: hidratar chips, seguir link, prévia ao passar o mouse (dados via setLinkProvider)
│           ├── noteProps.js   # Painel de propriedades do modo Zettelkasten (tags, apelidos, tipo, status, fonte, campos livres)
│           ├── noteLinksPanel.js # Rodapé da nota: "Mencionada em" (backlinks) e "Links"
│           ├── noteGraph.js   # Grafo das notas em <canvas> (global/local, busca por nó, zoom/arrastar); carregado sob demanda
│           ├── http.js        # HTTP: coleções/pastas, lista, histórico, envio, menus, atalhos
│           ├── httpEditor.js  # HTTP: barra de URL, abas da requisição e visualizador da resposta
│           ├── httpDialogs.js # HTTP: modais (ambientes, coleção, importar, código, runner)
│           ├── httpWidgets.js # HTTP: tabela chave/valor, auth, autocomplete de variáveis, realce JSON
│           ├── jsonFormatter.js # Formatter JSON: editor, formatar no lugar, copiar formatado/minificado, opções
│           ├── modal.js       # Modal compartilhado (HTTP e Banco): createModalHost(overlay)
│           ├── db.js          # Banco: orquestrador (conexões, abas, log de consultas, menus, atalhos, layout)
│           ├── dbExplorer.js  # Banco: Database Explorer (árvore lazy conexão → banco → schema → objetos → colunas/chaves)
│           ├── dbTableTab.js  # Banco: aba de tabela (paginação, WHERE/ORDER BY, edição, Submit/Revert, transação)
│           ├── dbConsole.js   # Banco: console (Ctrl+Enter, result sets, Saída, cancelar) e aba de DDL
│           ├── dbLanguages.js # Banco: adaptadores do console por conexão (SQL | mongosh): divisão, editor, autocomplete
│           ├── dbMongoTab.js  # Banco: aba de coleção MongoDB (filtro/sort/projeção, edição tipada, JSON)
│           ├── dbShared.js    # Banco: rodapé com agregados, "copiar como", exportação, controles Tx
│           ├── dbDialogs.js   # Banco: diálogo de conexão, revisão do SQL antes de gravar
│           ├── dbSchema.js    # Banco: "Modificar tabela"/"Nova tabela" e ações rápidas de DDL (prévia do SQL + execução)
│           ├── dbPlan.js      # Banco: visualizador de plano (diagrama com zoom, árvore, diagnósticos, propriedades, XML, .sqlplan) + aba de plano
│           ├── dbPerf.js      # Banco: aba Desempenho (Top consultas, Query Store, Sessões e bloqueios, Esperas, Índices e estatísticas)
│           ├── dataGrid.js    # DataGrid genérico virtualizado (2 eixos): seleção estilo Excel, edição, colar, busca
│           ├── dataGridFilter.js # DataGrid: popup de filtro local (valores distintos + contagem)
│           ├── dataGridEditor.js # DataGrid: editor sobre a célula e editor de valor (texto longo/JSON/XML)
│           ├── sqlComplete.js # Autocomplete SQL (tabelas, colunas por alias, palavras-chave) e de colunas em inputs
│           ├── rabbit.js      # RabbitMQ: orquestrador (conexões, barra lateral, seções, auto-refresh, operações, gravações ativas)
│           ├── rabbitViews.js # RabbitMQ: tabela genérica + Visão geral, Filas, Exchanges, Conexões, Canais, Consumidores
│           ├── rabbitQueue.js # RabbitMQ: detalhe da fila (mensagens/consumidores/ligações/detalhes) e da exchange
│           ├── rabbitMessage.js # RabbitMQ: detalhe de uma mensagem (propriedades, headers, x-death, corpo JSON/XML/hex)
│           ├── rabbitLog.js   # RabbitMQ: Gravações (capturas + mensagens do rabbit.db, filtros, ao vivo, republicar, exportar)
│           ├── rabbitDialogs.js # RabbitMQ: conexão, publicar, mover/copiar, nova fila/exchange/ligação, gravar, preferências
│           ├── redis.js       # Redis: orquestrador (conexões, árvore de chaves virtualizada por SCAN, abas, bandeja, ao vivo)
│           ├── redisKey.js    # Redis: aba da chave (TTL, renomear, excluir, DUMP) + editores por tipo e o editor de valor (texto/JSON/hex/Base64)
│           ├── redisConsole.js # Redis: console estilo redis-cli (histórico, Tab, dica do COMMAND DOCS, sessão própria)
│           ├── redisViews.js  # Redis: visão geral, configuração, slowlog/latência, clientes, Monitor, Pub/Sub, análise de memória, Cluster
│           ├── redisDialogs.js # Redis: conexão (modos, TLS, SSH), nova chave, TTL, formulários, confirmação de ambiente sensível
│           ├── windowMode.js  # Alterna modo bandeja <-> modo desktop (evento "windowmodechange"); janela desatachada = sempre desktop
│           ├── detach.js      # Apps desatachados: abrir em janela própria, ↗ no seletor, reatachar, gravar antes de sair
│           ├── pomodoro.js    # Motor do Pomodoro dos cards (por timestamp; eventos pomodorotick/pomodorochange; sem interface)
│           ├── settings.js    # Gerenciamento de configurações (autostart, minimizado)
│           ├── mdFile.js      # Janela de um .md de fora das Notas (editor, grava no arquivo, conflito) e a prévia somente leitura do Espaço
│           ├── noteGit.js     # Notas (cofre): painel Git na metade de baixo da barra lateral (Alterações com caixas + commit, Histórico, Fetch/Pull/Push)
│           ├── diffView.js    # Notas (cofre): diff lado a lado/unificado estilo JetBrains (faixas, palavras, ≫ reverter trecho) e merge de 3 vias
│           ├── gitDialogs.js  # Notas (cofre): diálogos do git (remoto, identidade, cofre novo), overlay próprio no <body>
│           ├── notesStorage.js # Configurações: notas no banco local ou num cofre (pasta de Markdown); lista de cofres; copiar notas ao ativar
│           └── windowControls.js # Controles da janela frameless e menu dropdown
└── src-tauri/                 # Backend Rust (Tauri)
    ├── Cargo.toml             # Dependências Rust (tauri, serde, etc.)
    ├── tauri.conf.json        # Configuração do aplicativo (tamanho, frameless, tray, associação de .md, resources, hooks do NSIS)
    ├── tauri.release.conf.json # Só no build de release (`--config`): externalBin da CLI (o tauri-build exige o binário, então fica fora do dev)
    ├── installer-hooks.nsh    # Hooks do NSIS: ProgID DevSuite.Markdown com ícone de arquivo .md e "Abrir com → Dev Suite - Notas" (ícone do Notas); pasta da CLI no PATH do usuário
    ├── cli/                   # Crate `devsuite-cli` (workspace; binário de console `devsuite`, sem Tauri)
    │   ├── commands.json      # Catálogo dos comandos (grupos, args, opções, exemplos): parser, --help, `devsuite schema`
    │   └── src/               # main.rs (fluxo, saída, skills install), spec.rs (parser/ajuda), conn.rs (pipe/socket, inicia o app), out.rs (tabelas, CSV)
    ├── icons/files/markdown.* # Ícone dos arquivos .md (folha + marca M↓; .ico gerado pelo _gen_icons.ps1, instalado como resource)
    └── src/
        ├── main.rs            # Comandos Rust IPC e lógica de persistência JSON no disco
        ├── http.rs            # Cliente HTTP (reqwest), cancelamento, cookies, http.json e arquivos
        ├── note_images.rs     # Imagens das notas em note-images/ + protocolo noteimg://
        ├── note_pdf.rs        # Exportar nota em PDF: imprime a webview direto no arquivo (WebView2 PrintToPdf / WebKitGTK PrintOperation)
        ├── notes_db.rs        # Notas e pastas em SQLite (notes.db, rusqlite bundled): FTS5 trigram, migração do JSON; despacha os comandos para SQLite ou cofre
        ├── md_files.rs        # .md de fora das Notas: janela `md-<hash>` por arquivo, ler/gravar com conflito por mtime, imagens em attachments/ ao lado, janela `md-preview`
        ├── quicklook.rs       # Windows: Espaço no Explorer/Área de Trabalho (hook WH_KEYBOARD_LL + IShellWindows/IFolderView2) abre a prévia do .md
        ├── notes_git.rs       # Git do cofre: executável `git` do sistema (sem console), status/diff/commit/reverter/log, remoto, pull com merge e conflitos, cofre novo
        ├── notes_vault.rs     # Modo cofre: pasta de .md como fonte da verdade + índice local (vaults/<hash>.db), conflitos, lixeira .trash
        ├── persist.rs         # Fila de gravação em thread própria (atômica, sem travar a UI)
        ├── cli/               # Servidor da CLI: named pipe/socket + token (cli.json), roteia "<app>.<cmd>" para a janela dona (mod.rs); cofres não ativos (vaults.rs)
        ├── app_windows.rs     # Janelas desatachadas (app-<id>): abrir/fechar, windows.json, AppUserModelID + relançamento, menu da bandeja
        ├── rabbit/            # Aba RabbitMQ
        │   ├── mod.rs         # Comandos Tauri, senhas (cofre + cache), gravações ativas (tracing liga/desliga)
        │   ├── mgmt.rs        # Cliente da API HTTP do management (reqwest), erros legíveis
        │   ├── amqp.rs        # AMQP (amqprs): captura tap/firehose/exchange, mover/copiar em transação, FieldTable<->JSON
        │   ├── store.rs       # rabbit.db (SQLite): conexões, meta (ui/settings), captures, messages + FTS5 trigram
        │   └── it_tests.rs    # Testes de integração (precisam de TODORS_RABBIT_TEST)
        ├── redis_app/         # App Redis (não se chama `redis` para não colidir com o crate)
        │   ├── mod.rs         # Comandos Tauri, redis.json, segredos (cofre + cache), exec/pipeline/scan, ao vivo
        │   ├── conn.rs        # RedisConn → Handle (standalone/Cluster/Sentinel, TLS), sessões por (sessão, banco), COMMAND INFO
        │   ├── value.rs       # RESP2/RESP3 ↔ JSON { t, v } (binário em Base64), argumentos texto | { b64 }
        │   ├── ssh.rs         # Túnel SSH (russh): encaminhamento local por nó + resolvedor de nomes do driver; known_hosts
        │   ├── live.rs        # MONITOR e Pub/Sub em conexões dedicadas (eventos em lotes pelo Channel)
        │   ├── analyze.rs     # Análise de memória (SCAN + TYPE/MEMORY USAGE/PTTL): tipo, prefixo, TTL, maiores chaves
        │   └── it_tests.rs    # Integração (TODORS_REDIS_TEST, _CLUSTER_TEST, _SENTINEL_TEST, _SSH_TEST)
        ├── (vendor/tiberius)  # tiberius 0.13 com patch "TodoRS patch" (contagem por comando e mensagens INFO); ver [patch.crates-io]
        ├── (vendor/mongodb)   # mongodb 3.9.1 com "TodoRS patch": aceita MongoDB 3.6+ (wire 6, ex.: Cosmos DB API 3.6) e a rodada final vazia do SCRAM
        └── db/                # Cliente de banco de dados (aba Banco)
            ├── mod.rs         # Comandos Tauri, sessões (session_id) e cancelamento
            ├── driver.rs      # Traits Driver/Session + tipos neutros (ColumnMeta, ExecEvent, ObjectNode, TableInfo)
            ├── mssql.rs       # SQL Server/Azure SQL via tiberius: conexão, streaming, conversão de tipos
            ├── mssql_meta.rs  # Introspecção (sys.*) e geração de DDL
            ├── mongo.rs       # MongoDB (driver oficial): Client por conexão, operações, Docs em Extended JSON
            ├── entra.rs       # Login Microsoft Entra interativo (OAuth Auth Code + PKCE, refresh token)
            ├── secrets.rs     # Senhas/tokens no cofre do sistema (keyring)
            └── it_tests.rs    # Testes de integração (precisam de TODORS_MSSQL_TEST)
```

---

## 3. Contratos de Dados & Persistência (Backend Rust)

O backend Rust (`src-tauri/src/main.rs`) expõe os seguintes comandos via Tauri IPC:

| Comando IPC | Parâmetros | Retorno | Descrição |
| :--- | :--- | :--- | :--- |
| `load_kanban_data` / `save_kanban_data` | `{ data: Value }` | `Value` / `Result` | Documento único `kanban.json` do board (formato em `kanbanModel.js`); `null` = ainda não existe (`.bak` se inválido) |
| `load_todos` | - | `Result<Option<Value>>` | Lista antiga `todos.json`, só para a migração (`None` = não existe; erro = ilegível, não é tocado) |
| `kanban_migrated` | - | `Result` | Depois de gravar o `kanban.json` migrado: `todos.json` → `todos.json.migrated` |
| `notes_list` | - | `Result<Vec<NoteMeta>>` | Metadados das notas (com `props` e `links`), sem o HTML (antes remove da lixeira o que passou de 30 dias) |
| `notes_get` | `{ id }` | `Result<Option<String>>` | HTML de uma nota (carregado ao abri-la) |
| `notes_save` | `{ note: NoteSave }` | `Result` | UPSERT de uma nota (só a alterada) |
| `notes_save_many` | `{ notes: Vec<NoteSave> }` | `Result` | UPSERT de várias notas numa transação (importação de pasta) |
| `notes_scan_dir` | `{ dir }` | `Result<DirScan>` | Lê uma pasta recursivamente: `{ name, notes: [{rel, path, text, modified}], files: [{rel, path}], skipped }` (pula pastas ocultas e node_modules) |
| `notes_set_meta` | `{ notes: Vec<NoteMeta> }` | `Result` | Fixar/mover/lixeira/restaurar sem reenviar o HTML |
| `notes_delete` | `{ ids }` | `Result` | Apaga de vez |
| `notes_search` | `{ query }` | `Result<Vec<u64>>` | Ids que contêm o texto (FTS5 trigram, sem maiúsculas/acentos; < 3 caracteres = LIKE) |
| `notes_folders` / `notes_save_folders` | `{ folders? }` | `Result` | Pastas com `parent_id` (a ordem do array é a ordem entre irmãs) |
| `notes_legacy` / `notes_import` | `{ notes, folders }` | `Result` | Importa `notes.json`/`folders.json` na 1ª execução (depois renomeados para `*.migrated`) |
| `load_settings` | - | `AppSettings` | Carrega configurações de `settings.json` |
| `save_settings` | `{ settings: AppSettings }` | `Result<(), String>` | Salva configurações e ajusta autostart do sistema |
| `hide_window` | - | `()` | Oculta a janela principal na bandeja (System Tray) |
| `exit_app` | - | `()` | Emite `app-exit` (cada janela grava e responde `app_flushed`, até 1,5 s), guarda as janelas soltas e encerra |
| `app_window_open` / `app_window_focus` | `{ view }` | `Result` / `()` | Abre (ou foca) a janela `app-<view>` (antes esvazia a fila do `persist`) |
| `app_window_close` | - | `()` | Chamado pela janela desatachada depois de gravar: fecha e emite `app-attached` para a principal |
| `app_windows_list` | - | `Vec<String>` | Apps desatachados agora |
| `app_flushed` | - | `()` | Resposta ao evento `app-exit` |
| `set_desktop_mode` | `{ enabled: bool, visible: bool }` | `()` | Janela grande/redimensionável na taskbar (`true`) ou compacta presa à tray (`false`) |
| `minimize_window` | - | `()` | Minimiza a janela que chamou |
| `toggle_maximize` | - | `bool` | Maximiza/restaura a janela que chamou; retorna se ficou maximizada |
| `send_http_request` | `{ request: HttpRequest }` | `Result<HttpResponse, String>` | Executa a requisição no Rust (sem CORS) |
| `cancel_http_request` | `{ id: String }` | `()` | Cancela a requisição em andamento com esse id |
| `clear_http_cookies` | - | `()` | Limpa o cookie jar da sessão |
| `load_http_data` / `save_http_data` | `{ data: Value }` | `Value` / `Result` | Documento único `http.json` (formato definido em `httpModel.js`) |
| `read_text_file` / `write_file` | `{ path, text?, base64? }` | `Result` | Importação/exportação e salvar corpo de resposta |
| `save_note_image` | bytes crus no corpo + header `x-ext` | `Result<String>` | Salva imagem colada em `note-images/<hash>.<ext>` e retorna o nome |
| `import_note_image` | `{ path }` | `Result<String>` | Copia uma imagem do disco (import de Markdown) |
| `export_note_images` | `{ names, dir }` | `Result` | Copia imagens para a pasta `<nome>.assets` do export |
| `notes_print_pdf` | `{ path }` | `Result` | Imprime a webview (mídia print = só `#note-print`) num PDF A4, sem diálogo |
| `notes_gc_images` | - | `Result<u32>` | Apaga imagens órfãs com mais de 24 h (nomes usados vêm do notes.db; chamado após carregar). No cofre não apaga nada |
| `notes_set_storage` | `{ mode: "sqlite"\|"vault", path? }` | `Result` | Troca o backend das notas na hora (erro = continua no anterior) |
| `notes_vault_refresh` | - | `Result<ScanDiff>` | Cofre: relê o que mudou no disco `{ changed: [NoteMeta], removed: [id], folders? }` |
| `notes_vault_files` | - | `Result<Vec<String>>` | Cofre: anexos (não-.md), relativos ao cofre, para resolver `![[x.png]]` |
| `md_file_read` / `md_file_write` | `{ path }` / `{ path, text, expectedMtime }` | `{ text, mtime, token, name }` / `{ mtime, conflict }` | .md de fora das Notas; `token` = pasta do arquivo (imagens `f/`); com `conflict` nada é gravado |
| `md_file_save_image` / `md_file_import_image` | bytes + headers `x-token`/`x-ext` / `{ token, path }` | `Result<String>` | Imagem em `attachments/` ao lado do arquivo; devolve o caminho relativo |
| `md_open` / `md_reveal` / `md_window_close` | `{ path }` / `{ path }` / - | `Result` | Abrir a janela do arquivo, mostrar no Explorer, fechar depois de gravar |
| `md_preview_ready` / `md_preview_hide` | - | `()` | Prévia: mostrar (centralizada no monitor do cursor) / esconder |
| `cli_ready` / `cli_reply` / `cli_event` | - / `{ callId, result?, error? }` / `{ callId, event }` | `()` / `()` / `bool` | Ponte da CLI (regra 14): handlers prontos nesta janela; resposta; evento intermediário (`false` = cliente saiu) |
| `cli_store_read` | `{ store: { kind: sqlite\|vault, path? }, op: { op: list\|search\|get, ... } }` | `Value` | CLI: lê um armazenamento de notas que não é o ativo (banco local ou outro cofre) |
| `cli_vault_create` | `{ vault, dir, title, markdown }` | `Result<String>` | CLI: cria um .md novo noutro cofre (nunca sobrescreve) |
| `cli_info` / `cli_setup` | - / `{ action: path\|skills }` | `{ exe, on_path }` / `Result<String>` | Configurações → CLI: onde está; pôr no PATH (Linux: link em ~/.local/bin); instalar as skills |

### Git do cofre (`src-tauri/src/notes_git.rs`)

Sempre sobre o cofre ativo (`notes_db::active_vault_root`); `path` = relativo à raiz do repositório (o cofre pode ser subpasta dele), `rel` = relativo ao cofre. Um comando por repositório de cada vez.

| Comando IPC | Parâmetros | Retorno | Descrição |
| :--- | :--- | :--- | :--- |
| `git_info` | - | `{ available, version, repo, root, top, prefix, remote_url, user_name, user_email }` | Git instalado? Cofre é repositório? |
| `git_status` | - | `{ files: [{ path, orig_path, rel, status }], branch, head, upstream, ahead, behind, merging }` | `status`: modified, added, deleted, renamed, untracked, conflicted |
| `git_init` / `notes_vault_create` | - / `{ parent, name }` | `()` / `{ path, git, committed, git_error }` | Ativar no cofre aberto (sem commit) / criar pasta nova com repositório + commit inicial |
| `git_file_pair` | `{ path, origPath?, rev? }` | `{ left, right, left_label, right_label, binary, editable, mtime }` | HEAD x cópia de trabalho, ou `rev^` x `rev` (null = não existe) |
| `git_write_file` | `{ path, text, expectedMtime }` | `mtime` | Grava o arquivo com um trecho revertido (recusa se mudou no disco) |
| `git_commit` | `{ paths, message, amend }` | hash curto | Só os caminhos marcados (`--only`); durante merge commita o merge |
| `git_rollback` / `git_ignore` | `{ files }` / `{ path }` | `()` | Volta ao HEAD (novos vão para `.trash/`) / linha no .gitignore do cofre |
| `git_log` / `git_commit_files` | `{ path?, skip, limit }` / `{ hash }` | commits / arquivos | Histórico do cofre (ou de um arquivo, `--follow`) |
| `git_remote_set` / `git_remote_test` | `{ url? }` / `{ url, opId }` | `()` / nº de branches | `origin` opcional |
| `git_fetch` / `git_pull` / `git_push` / `git_cancel` | `{ opId }` | | Pull = merge (`--no-rebase`, `--allow-unrelated-histories`); conflito = `{ conflicts: true }`, não erro |
| `git_conflict` / `git_resolve` / `git_merge_abort` | `{ path }` / `{ path, text? }` / - | | Base/minha/deles (`:1:/:2:/:3:`); gravar + `add` |
| `git_set_identity` | `{ name, email, global }` | `()` | `user.name`/`user.email` |

**Modo cofre** (`AppSettings.notes_storage = "vault"`, `vault_path`): os comandos `notes_*` são os mesmos, despachados em `notes_db.rs` (`Backend::Sqlite | Backend::Vault`). Diferenças: `notes_get` devolve `{ markdown, rel, mtime }` em vez do HTML; `notes_save` recebe também `markdown` (gerado no JS) e `disk_mtime` e devolve `{ disk_mtime, rel, conflict }`; `NoteMeta` traz `front_matter` (cru), `disk_mtime` e `rel`.

Arquivos `.md` de fora das Notas: ver regra 13. Imagens das notas são servidas pelo protocolo `noteimg` (`http://noteimg.localhost/<nome>` no Windows, `noteimg://localhost/<nome>` no Linux/macOS); o HTML guarda só a URL e `normalizeNote` converte entre as duas formas.

Diálogos de arquivo usam `tauri-plugin-dialog` (`plugin:dialog|open` / `plugin:dialog|save`).

### Banco de dados (`src-tauri/src/db/`)

Todos os comandos que tocam a rede são `async`. Os que rodam SQL recebem `target = { session_id, conn: ConnConfig, database }`: a sessão é aberta no primeiro uso e reaberta sozinha se cair. Sessões: `meta:<conn>:<db>` (Explorer/autocomplete), `tab:<tabId>` (tabelas), `console:<consoleId>`.

| Comando IPC | Parâmetros | Retorno | Descrição |
| :--- | :--- | :--- | :--- |
| `load_db_data` / `save_db_data` | `{ data: Value }` | `Value` / `Result` | Documento `databases.json` (formato em `dbModel.js`, sem segredos) |
| `db_set_password` / `db_has_password` / `db_get_password` / `db_forget_secrets` | `{ connId, password? }` | `Result` | Senha (e refresh token do Entra) no cofre do sistema; `get` só para "Copiar connection string com senha" (`buildConnectionString` em `dbModel.js`) |
| `db_test_connection` | `{ conn, password? }` | `Result<ServerInfo>` | Testa a configuração do diálogo |
| `db_connect` | `{ target }` | `Result<ServerInfo>` | Abre a sessão (pode abrir o navegador para o login do Entra) |
| `db_disconnect` | `{ prefix }` | `()` | Fecha as sessões com esse prefixo |
| `db_introspect` | `{ target, path: {kind, schema, name} }` | `Result<Vec<ObjectNode>>` | `databases` / `schemas` / `schema` / `table` / `view` / `procedure` / `function` |
| `db_table_info` / `db_ddl` | `{ target, schema, name }` / `{ target, path }` | `Result` | Colunas com PK/identity/FK; DDL do objeto |
| `db_table_schema` | `{ target, schema, name }` | `Result<TableSchema>` | Estrutura editável: colunas (default + nome da constraint), índices/chaves, FKs, checks |
| `db_database_script` | `{ target, options: DbScriptOptions }` | `Result<{ sql, objects, warnings }>` | Script do banco inteiro na ordem de criação (só SQL Server); `options` = tipos de objeto, `schemas` (vazio = todos), `if_not_exists` |
| `db_execute` | `{ target, queryId, sql, maxRows?, options?: { plan: estimated\|actual, stats_io, stats_time }, onEvent: Channel }` | `Result<ExecSummary>` | Result sets em lotes pelo Channel (`result_start`/`rows`/`docs`/`result_end`, `message` = PRINT/STATISTICS IO/TIME `{ number, class, line, procedure, text }`, `plan` = `{ index, xml }` fora do grid, e `done` por último: `dbApi.execute` só resolve depois dele, porque a resposta do invoke pode chegar antes das mensagens grandes do Channel); `sql` = SQL ou, no MongoDB, a operação JSON |
| `db_cancel` | `{ queryId }` | `()` | Cancela fechando o socket (o servidor aborta e desfaz a transação) |
| `db_tx` | `{ target, action: begin\|commit\|rollback }` | `Result<u32>` | Devolve @@TRANCOUNT |
| `db_apply` | `{ target, statements, atomic }` | `Result<Vec<u64>>` | Alterações do grid (tudo ou nada quando `atomic`) |

### Redis (`src-tauri/src/redis_app/`)

Dados em `redis.json` (sem segredos). Segredos no cofre (`db:redis:<connId>:<password|sentinel_password|ssh_password|ssh_passphrase>`). `conn` = `RedisConn` (`connConfig()` no JS). Valores voltam como `{ t, v }` (`str`, `bin` em Base64, `int`, `nil`, `status`, `err`, `arr`, `map`, `set`, `dbl`, `bool`, `big`); argumentos vão como texto ou `{ b64 }`. Erro de resposta do servidor (WRONGTYPE…) é `{ t: "err" }`; só falha de conexão rejeita.

| Comando IPC | Parâmetros | Retorno | Descrição |
| :--- | :--- | :--- | :--- |
| `load_redis_data` / `save_redis_data` | `{ data }` | `Value` / `Result` | Documento `redis.json` (formato em `redisModel.js`) |
| `redis_set_secret` / `redis_has_secrets` / `redis_forget_secrets` | `{ connId, kind?, value? }` | `Result` / `{ kind: bool }` | Segredos no cofre (o cache é limpo ao gravar) |
| `redis_test` / `redis_connect` | `{ conn, secrets? }` | `ServerInfo` | `{ version, mode, role, os, databases, address, modules }`; test usa os segredos digitados |
| `redis_disconnect` / `redis_close_session` | `{ connId, session? }` | `()` | Fecha tudo (e para ao vivo) / uma sessão (cancelar console) |
| `redis_exec` | `{ conn, db, session, args, node? }` | `{ t, v }` | Comando cru; `node` = `host:porta` no Cluster; recusa SUBSCRIBE/MONITOR/SELECT/QUIT…; conexão somente leitura recusa a flag `write` |
| `redis_pipeline` | `{ conn, db, session, cmds, node? }` | `[{ t, v }]` | Vários comandos (no Cluster, um por vez em paralelo) |
| `redis_scan` | `{ conn, db, spec: { cursor, pattern, type, count, limit } }` | `{ cursor \| null, keys: [{ k, type }] }` | SCAN incremental (todos os masters no Cluster) + TYPE |
| `redis_nodes` | `{ conn }` | `[NodeInfo]` | CLUSTER NODES (ou o próprio servidor) |
| `redis_live_start` | `{ conn, spec: { kind: monitor\|subscribe, channels, patterns, node, db }, onEvent }` | `id` | Eventos `monitor { lines }` / `messages { items }` / `stopped { error }` |
| `redis_analyze_start` | `{ conn, spec: { db, pattern, count, limit, separator, depth, top, pause_ms }, onEvent }` | `id` | Parcial a cada ~0,5 s; o último tem `done: true` |
| `redis_live_stop` | `{ id }` | `bool` | Para Monitor/assinatura/análise |

### RabbitMQ (`src-tauri/src/rabbit/`)

Dados em `rabbit.db` (SQLite, WAL). Senhas no cofre (`rmq:<connId>`). `conn` = `RmqConn` (`connConfig()` no JS).

| Comando IPC | Parâmetros | Retorno | Descrição |
| :--- | :--- | :--- | :--- |
| `rmq_load` / `rmq_save_connections` / `rmq_save_meta` | `{ connections }` / `{ key: ui\|settings, value }` | `{ connections, ui, settings }` / `Result` | Conexões (sem senha) e estado da interface |
| `rmq_set_password` / `rmq_has_password` / `rmq_forget_password` | `{ connId, password? }` | `Result` | Senha no cofre (com cache em memória) |
| `rmq_http` | `{ conn, method, path, body?, password? }` | `Result<Value>` | API de management (`path` sem `/api`, segmentos codificados) |
| `rmq_test` / `rmq_open_mgmt` | `{ conn, password?, vhost? }` | `{ overview, amqp_error }` | Testa management + AMQP; abre a UI web |
| `rmq_move` | `{ conn, spec: { vhost, from_queue, target: queue\|exchange\|origin, to_queue, exchange, routing_key, count?, copy } }` | `{ moved, skipped, returned }` | Move/copia em transação AMQP; sem rota volta à origem |
| `rmq_capture_start` | `{ conn, spec: { vhost, mode: tap\|firehose\|exchange, queues, exchange, routing_key, events, name, max_body_kb, max_messages }, onEvent: Channel }` | `Capture` | Grava em segundo plano; eventos `progress`/`warning`/`stopped` |
| `rmq_capture_stop` / `rmq_capture_attach` / `rmq_captures` / `rmq_capture_rename` / `rmq_capture_delete` | `{ captureId, ... }` | | Controle das gravações (attach = reconectar eventos após recarregar a UI) |
| `rmq_messages_query` | `{ filter: { conn_id, capture_id, text, routing_key (*), queue, exchange, event, json_path/op/value, from, to, before_id, ascending, limit } }` | `{ rows, total }` | Busca (FTS no corpo; LIKE em headers/routing key; json_extract) |
| `rmq_message_get` / `rmq_messages_get` / `rmq_messages_delete` / `rmq_messages_delete_matching` / `rmq_messages_save` / `rmq_store_stats` | | | Detalhe, exclusão, salvar mensagens espiadas (`peek`) |

### Estruturas de Dados (JSON / Rust Structs)

- **kanban.json**: `{ version, boards: [{ id, name, columns: [{ id, name, color, role: null|"doing"|"done", wip }] }], cards: [{ id, board_id, column_id, title, note, due?: "YYYY-MM-DD", labels: [nome], created_at (ms), completed_at?, archived_at?, pomo: { work?, break?, count, focus_ms } }], active_board, labels: [{ name, color }], pomo: { work, break, long_break, long_every, auto_next } }` — ordem dos cards numa coluna = ordem em `cards`; colunas/boards = ordem dos arrays
- **NoteMeta** (notes.db): `{ id: u64, title, preview, created_at: String, updated_at: u64 (ms), pinned: u32 (posição; 0 = não fixada; aceita bool), folder_id: u64 (0 = "Notas"), deleted_at?: u64, props: Value (null | { zid, tags, aliases, type, status, source, author, extra }), links: [id | "título sem nota"] }`
- **NoteSave**: `NoteMeta` + `{ content: String (HTML), plain: String (texto da busca + tags/apelidos), images: [nome] }` — título/prévia/texto/imagens/links calculados no JS (`noteRecord`). `notes_set_meta` não toca em `props`/`links`. Esquema do notes.db migra por `PRAGMA user_version` (`MIGRATIONS` em `notes_db.rs`).
- **Folder**: `{ id: u64, name: String, parent_id: u64 (0 = nível superior) }` — coluna `parent_id` criada pela migração v2 do notes.db
- **AppSettings**: `{ autostart: bool, start_minimized: bool, theme: "system" | "light" | "dark", zettelkasten: bool, notes_storage: "sqlite" | "vault", vault_path: String, vaults: [String], md_quicklook: bool (padrão true; só Windows) }`
- **HttpRequest** (IPC): `{ id, method, url, headers: [{key,value}], body: {kind: none|text|multipart|file}, timeout_ms, follow_redirects, verify_ssl, use_cookies }`
- **http.json**: `{ version, collections: [{id,name,description,auth,variables,scripts,folders: [{id,name,parent_id,collapsed}]}], requests: [...], environments, active_env, globals, history, settings }`
- **databases.json → queries** (consultas salvas): `[{ id, conn_id, database ("" = padrão do login), folder: "a/b", name, description, sql, params: { nome: { type, last } }, created_at, updated_at }]`; console ligado a uma: `consoles[].saved_id` (+ `params` com os últimos valores)
- **redis.json**: `{ version, connections: [{ id, name, color, mode: standalone|cluster|sentinel, host, port, nodes, master_name, username, sentinel_username, tls, tls_insecure, ca_path, timeout_s, read_only, protected, db, separator, ssh: null | { host, port, user, auth: password|key, key_path } }], history: { connId: [linhas do console] }, ui: { conn_id, dbs, tabs: [{ id, type: key|console|overview|…, conn_id, db, key? }], active_tab, side_w, side_open, refresh_s, view, scan_count } }`

---

## 4. Regras de Negócio Importantes

1. **Tarefas = board kanban**:
   - Vários boards (barra lateral no desktop; seletor no topo na bandeja), cada um com colunas editáveis (padrão *A fazer / Fazendo / Concluído*): renomear (duplo clique), cor, limite WIP (contagem fica vermelha acima), mover, excluir (os cards vão para a coluna vizinha; Desfazer). Cada tarefa é um card: título, anotação, prazo opcional, etiquetas (globais do documento, com cor) e estatística de foco.
   - **Papéis das colunas** (no máximo um de cada por board): `done` = entrar grava `completed_at` (no topo da coluna) e encerra o Pomodoro do card; sair apaga. `doing` = destino automático ao iniciar o foco. Sem coluna `done`, nada fica "concluído".
   - Prazo: atrasado (vermelho, borda no card), hoje (amarelo); cards concluídos não ficam atrasados. Filtros da barra: "Atrasados", "Vence hoje" (inclui atrasados), etiqueta e busca (título, anotação, etiquetas; sem acento/maiúsculas).
   - "Arquivar" (card, ou todos da coluna) marca `archived_at`; a visão "Arquivados" do board restaura ou exclui de vez. Excluir card/board/coluna tem Desfazer no toast.
   - Drag & drop HTML5: card entre/dentro de colunas (metade de cima = antes), sobre outro board na barra lateral (vai para a 1ª coluna dele) ou sobre as abas da bandeja; coluna pelo cabeçalho; board na barra lateral.
   - Teclado (desktop): setas navegam, Ctrl+setas movem o card (←/→ coluna, ↑/↓ ordem), Enter edita, Espaço inicia/pausa o foco, Delete exclui, Ctrl+N novo card, Ctrl+F busca, Esc fecha.
   - **Migração**: sem `kanban.json`, o JS lê o `todos.json` (`load_todos`), cria o board "Tarefas" (concluídas → Concluído; pendentes → A fazer com `due` = data antiga), grava e chama `kanban_migrated`. Meu Dia, Pendentes/Histórico e o reagendar não existem mais.
   - **Layout**: desktop = boards | colunas (rolagem horizontal) | detalhe (só com card selecionado). Bandeja = abas das colunas → lista da coluna (campo "Adicionar card" no topo) → detalhe em pilha (seletor "Status" move o card).

2. **Pomodoro nos cards** (`pomodoro.js` + barra de foco em `tasks.js`):
   - ▶ no card (ou Espaço/menu/detalhe) inicia sem modal e leva o card para a coluna `doing`; o card ganha anel de progresso e tempo. Uma sessão por vez.
   - Barra de foco no rodapé (os dois modos): título (clique abre o card), fase, tempo, Pausar/Retomar, Pular fase, Concluir card, Parar e padrões (foco/pausa/pausa longa/a cada N focos/iniciar a próxima fase sozinho, em `kanban.json → pomo`). O card pode sobrepor foco/pausa no detalhe.
   - Tempo por timestamp (`endsAt`), não por ticks: não deriva e continua certo com a janela oculta. Fim do foco: chime, `pomo.count++` e `focus_ms` somado (parar/pular/pausar também somam o trecho). Redesenhos do evento `pomodorochange` não acontecem por baixo de um campo em edição.
   - Com sessão ativa as Tarefas não podem ser desatachadas (blocker).

3. **Notas Rápidas (cópia do app Notas do macOS)**:
   - O conteúdo é HTML gerado pelo editor (`h1/h2/h3/p/pre/blockquote/ul/ol/li/table/b/i/u/s`). A primeira linha é o título; `title` é derivado e salvo só por compatibilidade. Notas antigas em texto puro são migradas por `normalizeNote`.
   - Listas: `ul` (marcadores), `ul.dashed` (traços), `ol` (numerada), `ul.checklist` com `li.checked`. Tabelas usam `table.nt-table`.
   - Imagens coladas (print, "Copiar imagem", HTML com `data:`) viram arquivos via `save_note_image`; nunca guardar base64 no banco de notas. `<img>` leva `width/height` (sem reflow) e `loading="lazy"`.
   - **Blocos de código**: salvos como `<pre data-lang="sql">texto</pre>` (`pre` sem `data-lang` = estilo Monoespaçado). No editor viram um widget `div.nt-code` (`contenteditable=false`, `noteCode.js`): linhas numeradas e realçadas, regiões dobráveis (chaves ou recuo, `codeBlock.js`), clique no código troca para o `codeEditor()` no lugar. Criar: botão `</>`, Ctrl+Shift+K ou ```` ```lang ```` + Enter. O HTML da nota sempre passa por `serializeEditorHtml()` (nunca `editor.innerHTML` direto) e todo HTML carregado/desfeito/colado passa por `hydrateCodeBlocks()`.
   - **Mermaid**: bloco `data-lang="mermaid"` alterna Visualizar / Código / Live (canto superior direito; Live = código e diagrama lado a lado, redesenhado ao digitar, mantendo o último diagrama válido se houver erro). A visualização tem zoom (Ctrl+roda, botões), arrastar e tela cheia (sobreposição em `document.body`, roda dá zoom, Esc sai). A biblioteca (`src/vendor/mermaid`) só carrega quando há diagrama e segue o tema claro/escuro (claro = tema `base` com `LIGHT_VARS` em `mermaidView.js`, também no PDF; blocos de código usam `--nt-code-bg`/`--nt-code-border`); só redesenhar quando fonte ou tema mudarem de fato (`data-theme` é regravado com o mesmo valor ao carregar settings), senão zoom/posição se perdem.
   - **Atalhos de digitação** (`noteEditor.js`): no início da linha + Espaço, `#`/`##`/`###` (título/cabeçalho/subcabeçalho), `>` (citação), `-` `*` `+` `1.` `[ ]` (listas), ```` ``` ```` (código). Inline ao fechar o marcador: `**negrito**`, `*itálico*`, `` `código` ``, `~~tachado~~` (o cursor fica depois de um ZWSP transitório, removido na próxima tecla e em `editorHtml()`; o texto cru fica um passo atrás no desfazer).
   - **Menus** (`noteMenus.js`): selecionar texto mostra a barra de formatação abaixo da seleção; `/` no início da linha ou após espaço abre o menu de blocos (filtra pelo texto, setas/Enter/Tab, Esc mantém a `/`). Os itens chamam `runCommand` (inclui `mermaid`, `image`, `inline-code`, `clear`). Teclas consumidas pelos menus/blocos de código param a propagação (Esc no modo bandeja volta para a lista).
   - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y usam `noteHistory.js`, não o undo nativo (que quebra com as edições diretas no DOM). Toda alteração deve passar por `changed()` no editor para entrar no histórico.
   - Markdown: menu "…" (e menus de contexto) importa `.md` como novas notas e exporta a nota (imagens copiadas para `<nome>.assets/`).
   - **Subpastas**: pastas formam uma árvore (`parent_id`, qualquer profundidade; a pasta virtual "Notas" (id 0) não tem filhas). A lista de uma pasta mostra também as notas das subpastas (com o caminho no item) e a contagem soma as subpastas. Recolher/expandir fica no `localStorage`. Arrastar pasta sobre pasta: faixa de cima = antes (irmã), de baixo = depois (só com a pasta fechada ou sem subpastas), meio = dentro; sobre "Notas" volta ao nível superior. Ordem: pastas novas, renomeadas, movidas para dentro de outra, importadas ou criadas fora do cofre entram em ordem alfabética entre as irmãs (`insertFolderSorted`); reordenar à mão é respeitado; menu "Ordenar (Sub)pastas de A a Z". As pastas antigas foram ordenadas A–Z uma vez por armazenamento (`nt-folders-az:*` no `localStorage`). Apagar pasta apaga as subpastas e manda as notas para a lixeira.
   - **Importar pasta de Markdown** (ícone ao lado de "No Meu PC", menu "…" e menu da pasta): `notes_scan_dir` lê tudo no Rust; cria uma pasta com o nome do diretório (dentro da pasta aberta) e uma subpasta por diretório que tenha notas; notas ficam com a data do arquivo e são gravadas em lotes (`notes_save_many`). Imagens: relativas à nota, à raiz ou só pelo nome (`![[x.png]]` do Obsidian). Links `[[pasta/Nota.md#seção]]` viram `[[Nota]]` quando a nota existe na pasta importada (`mdImport.js`).
   - **Título e front-matter no import** (arquivo ou pasta): o **nome do arquivo é o título** (`applyFileTitle`: um 1º título com o mesmo texto vira o h1; senão o nome entra acima e o `### Seção` inicial continua como seção). Chaves do YAML comparadas sem acento/maiúsculas/espaços (`parseFrontMatter`): `tags` (o `#` das tags sai), `Autor`/`author` → propriedade `author` (campo opcional do painel), `Data criação`/`created`/`date`/`criado em` → `created_at` da nota (AAAA-MM-DD, DD/MM/AAAA ou ISO); o resto vai para campos livres.
   - **Buscar na nota (Ctrl+F)** (`noteFind.js`): com uma nota aberta, Ctrl+F abre a barra no canto do editor (sem maiúsculas/acentos; Enter/Shift+Enter ou F3/Shift+F3 navegam, Esc fecha e seleciona a ocorrência). Ctrl+Shift+F (ou Ctrl+F já na busca da lista) busca em todas as notas. Vale também na janela do .md e na prévia do Espaço. Os destaques usam a CSS Custom Highlight API (`::highlight(nt-find)`), sem tocar no DOM do editor; um `MutationObserver` refaz a busca ao editar/trocar de nota. Ignora cabeçalho/numeração dos blocos de código, diagramas e editores de código abertos.
   - **Data de criação**: toda nota mostra "Criada em <data> · Editada em …" acima do texto; a data é editável (input date, mantém a hora) e grava a nota inteira (`notes_set_meta` não toca em `created_at`).
   - **Colar Markdown** (Ctrl+V): texto puro (ou HTML sem formatação, ex. VS Code) que `markdownKind()` reconhece vira formatação — uma linha com `` `código` ``/`**negrito**`/links = inline; títulos, listas, cercas, citações, tabelas = blocos (numa nota vazia viram a nota inteira). Ctrl+Shift+V cola o texto cru. Dentro de `pre`/tabela nunca converte.
   - **Código inline**: `` `texto` `` vira `<code>` ao fechar a crase (também com tecla morta do ABNT2, em que a crase chega junto do próximo caractere, e por composição no Linux — `compositionend`), pela barra da seleção ou pelo menu "/".
   - **PDF**: "Exportar como PDF…" (menu "…" e menus de contexto) gera o arquivo com a mesma tipografia do editor (`#note-print` usa as regras de `.nt-editor`), código realçado com rótulo da linguagem, diagramas Mermaid (tema claro) e imagens; sempre no tema claro.
   - **Fixadas**: `pinned` é a posição (0 = não; maior = mais acima; `true` antigo = 1). Ficam no topo de toda lista que as contém; nova fixada entra no topo; arrastar uma fixada sobre outra reordena (metade de cima = antes; `reorderPinned` renumera só o que mudou). Banco local: coluna `pinned`; cofre: front-matter (`saveNotePins`).
   - **Voltar (link seguido)**: nota aberta por um link `[[ ]]` (ou Alt+←/→) mostra uma seta flutuante à esquerda do título (`#nt-nav-back`, posicionada por `placeNavBack`, sem ocupar espaço; só no desktop) que volta como Alt+←.
   - Notas vazias são descartadas ao sair delas. Apagar move para "Apagadas Recentemente" (`deleted_at`); após 30 dias são removidas (`notes_list`).
   - **Armazenamento** (`notes.db`, SQLite): `state.notes` tem só metadados; `content` fica `undefined` até a nota ser aberta (`ensureContent`). Editar marca `dirty` e grava só aquela nota (`noteStore.js`, fila em ordem); fixar/mover/apagar usam `notes_set_meta`. A lista usa o título/prévia gravados ou, com o conteúdo carregado, os derivados ao vivo. Na 1ª execução o `notes.json` é importado pelo JS (normalizado como antes) e renomeado para `notes.json.migrated`; se estiver ilegível, nada é tocado e o app avisa.
   - **Links entre notas** (sempre ativos): `[[Título]]` / `[[Título|texto]]` viram `<a class="nt-link" contenteditable="false" data-note="<id>">` (chip atômico). O link guarda o **id** (renomear não quebra; o texto é atualizado ao abrir, `hydrateLinks`); sem nota com esse título fica `data-target="Título"` (pendente, tracejado; clicar cria a nota). Digitar `[[` abre o menu de notas (títulos e apelidos, "Criar …"); `]]` fecha à mão; também no menu "/" e na barra da seleção. Clique abre a nota (vai para a pasta dela se não estiver na lista), hover mostra a prévia, Alt+← / Alt+→ navegam. Rodapé "Mencionada em"/"Links" sai dos metadados em memória (`backlinkMap`), sem carregar HTML. Os dados do editor vêm de `notes.js` via `setLinkProvider`.
   - **Modo Zettelkasten** (`AppSettings.zettelkasten`, Configurações ou menu "…"): painel de propriedades acima do texto (fora do HTML; coluna `props`): id zettel `AAAAMMDDHHmm` (nota nova, ou a antiga na 1ª edição), tags, apelidos (também resolvem `[[ ]]`), tipo (fleeting/literature/permanent/hub), status, fonte e campos livres. Busca aceita `tag:x` / `#x` (hierárquica: `a` casa `a/b`), `type:`, `status:`, `id:` e `[[Nota]]` (quem aponta para ela) — filtros na memória, o resto do texto vai para o FTS. Grafo (entrada "Grafo" nas pastas, botão "Grafo local", Ctrl+Shift+G): notas + tags, global/local (1–3 níveis), busca por nó, órfãs/pendentes, cores por tipo. Rótulos sem sobreposição: entram por prioridade (sob o mouse, nota atual, busca; depois notas mais ligadas, tags por último) e o que encostaria num já desenhado fica de fora; os "ambientes" só aparecem a partir do zoom configurado (padrão 0.8×, com fade). Painel de ajustes (ícone de sliders): limiar dos títulos e forças (repulsão, distância e força das ligações, gravidade; `DEFAULT_FORCES` em `graphLayout.js`, `sim.setForces` reorganiza ao vivo), salvos no `nt-graph-opts` do localStorage. Foco do hover com fade de opacidade (180/260 ms), também com "reduzir animações". O layout tem colisão entre nós. A simulação (`graphLayout.js`) roda em passos com orçamento de ~7 ms por quadro e **para sozinha**: nada de `requestAnimationFrame` com o grafo parado ou oculto. Export Markdown escreve o front-matter YAML (sempre com `created: AAAA-MM-DD`) e `[[Título]]`.
   - **Cofre (pasta de Markdown, como o Obsidian)**: Configurações → "Notas: onde guardar" (banco local | cofre) + pasta; opção de copiar as notas locais ao ativar (o notes.db fica intacto). Troca rápida na barra lateral: o rótulo "No Meu PC"/nome do cofre abre um menu com o banco local, os cofres já usados (`AppSettings.vaults`), "Abrir outro cofre…" e "Remover da lista" (a pasta não é tocada); `switchNotesStorage` dispara `notesstoragechange`. Pode ser uma pasta de rede compartilhada. Os arquivos são a verdade: `<cofre>/a/b/Título.md` = nota "Título" na pasta `a/b`; diretórios = pastas; lixeira = `.trash/` (pastas ocultas, `node_modules` e `attachments/` na raiz não viram pastas). O título é o nome do arquivo (`safeName`/`safe_name`, iguais no JS e no Rust): a 1ª linha só fica no corpo como `# Título` se o nome não consegue representá-la; mudar o título renomeia o arquivo. Front-matter via `propsToYaml` (sempre `created:`), links `[[Título]]`, imagens coladas em `attachments/<hash>` e todas por caminho relativo à nota; no app as imagens do cofre usam `noteimg://localhost/v/<caminho>` (`vault_file` rejeita `..`/absolutos/fora da raiz). Índice local em `<app_data>/vaults/<hash>.db` (só cache: ids estáveis, mtime, FTS); `scan` relê só o que mudou e renomeação externa (mesmo conteúdo) mantém o id. Fixada = `pinned: <posição>` no front-matter (vale para todos que abrem o cofre; fixar/reordenar regrava o .md; continua no arquivo na lixeira). Sincroniza ao focar a janela, ao entrar na aba e a cada 30 s (polling por mtime; watchers não são confiáveis em SMB) + "Atualizar do Cofre". **Conflito**: se o arquivo mudou no disco desde a versão que o app leu (`disk_mtime`), nada é sobrescrito — a versão do app vai para `Título (conflito <máquina> <data>).md`. Abrir uma nota e só resolver links não regrava o arquivo (`vaultKey`). Gravação atômica (temporário oculto + rename).
   - **Controle de versão (git) do cofre** (`notes_git.rs`, `noteGit.js`, `diffView.js`, `textDiff.js`): usa o `git` do sistema (credenciais do usuário: Git Credential Manager/SSH; `GIT_TERMINAL_PROMPT=0`, SSH em `BatchMode` se não houver `core.sshCommand`); sem git, o painel avisa e o cofre segue igual. "Criar novo cofre…" (menu do cofre na barra lateral e Configurações) cria a pasta já com `git init -b main`, `core.autocrlf=false`, `.gitignore` (`.trash/`, temporários) e commit inicial; cofre existente sem repositório oferece "Ativar controle de versão" (sem commit). No desktop, a largura da barra lateral é ajustável pela borda direita (`#nt-sb-split`, `--nt-sb-w` de 220 px até 50% da janela, `nt-sidebar-w` no localStorage, duplo clique = padrão) e ela é dividida (`--nt-vcs-ratio`, padrão 50%, `nt-vcs-split` no localStorage): pastas em cima, painel Git embaixo sob a seção "Controle de versão" (contador + branch), recolhida por padrão como no VS Code (`nt-vcs-collapsed` no localStorage; recolhida = só o cabeçalho, sem divisor) com abas **Alterações** (árvore por pasta com caixas; arquivos novos entram marcados; clique = diff, duplo clique = abrir a nota; menu: reverter, histórico do arquivo, ignorar; mensagem + "Corrigir último" + Commit / Commit e Push, Ctrl+Enter) e **Histórico** (commits do cofre ou de um arquivo; clique mostra os arquivos e o diff `pai ↔ commit`). Commits são só manuais. Remoto `origin` opcional pelo ícone de nuvem; Fetch/Pull/Push canceláveis, ↑N ↓M. O status atualiza após cada gravação no cofre (evento `notesvaultwrite` do `noteStore.js`), ao focar e a cada 30 s. Operações que mexem nos arquivos (pull, reverter, ≫, resolver) gravam as pendências antes e chamam `syncVault` depois. **Diff** (`#nt-diff`, `data-view="diff"`, ocupa lista + editor; Esc fecha): lado a lado com faixas curvas, azul/verde/cinza, palavras alteradas, ≫ reverte o trecho (só cópia de trabalho), F7/Shift+F7, unificado, ignorar espaços, trechos iguais recolhidos. Conflito de merge: Minha | Resultado (editável, marcadores `<<<<<<< Minha`) | Deles, por conflito ou arquivo inteiro, "Marcar como resolvido" = `git_resolve`; o commit conclui o merge.
   - **Modo bandeja**: navegação em pilha Pastas → Lista → Nota dentro da janela 370x530 (o grafo é mais um painel da pilha). **Modo desktop**: botão de expandir chama `set_desktop_mode(true)`; layout de 3 colunas com barra unificada e botões de janela no estilo do SO (fechar = volta à bandeja e oculta). Ao entrar na aba Notas no modo bandeja, sempre abre a lista "Todas as Notas".

4. **HTTP (cópia do Postman, visual das Notas)**:
   - Coleções com pastas e subpastas (`parent_id`, qualquer profundidade; arrastar pasta sobre pasta aninha), "Todas as Requisições", Histórico (agrupado por data) e Ambientes. Edições são salvas automaticamente.
   - Nova pasta pela própria lista (botão de pasta ao lado de "Nova requisição" e menu de contexto da área vazia), além dos menus da coleção/pasta. A ordem das requisições é a ordem de `requests`: soltar sobre outra requisição reordena (metade de cima = antes) e adota a coleção/pasta dela; soltar na área vazia leva para a raiz da coleção. Pasta arrastada sobre o cabeçalho de outra: faixa de cima = antes (irmã), de baixo = depois (só com a pasta-alvo fechada ou vazia), meio = dentro; na área vazia = raiz da coleção (desagrupar).
   - Postman: import mantém a árvore de pastas; a auth de uma pasta vai para as requisições abaixo dela que herdam. Export volta a aninhar (requisições da pasta antes das subpastas, mesma ordem do Runner).
   - Variáveis `{{nome}}` com prioridade local (scripts) > ambiente > coleção > globais, além de dinâmicas (`{{$guid}}`, `{{$timestamp}}`...).
   - Auth "Herdar da coleção" é o padrão das requisições. Colar um cURL na barra de URL substitui a requisição.
   - **Modo bandeja**: pilha Coleções → Lista → Requisição, com alternância Requisição/Resposta. **Modo desktop**: 3 colunas, requisição e resposta divididas por um separador arrastável; o seletor no topo da barra alterna entre Notas, HTTP e JSON.

5. **Formatter JSON**:
   - Um único campo (sem entrada/saída separadas). "Formatar" (Ctrl+Enter) diagnostica o texto, repara e substitui o conteúdo no lugar (Ctrl+Z desfaz). Botões copiam formatado ou minificado (Ctrl+Shift+C / Ctrl+Shift+M) mesmo sem formatar antes.
   - Pipeline local em `jsonRepair.js`, por camada: caracteres invisíveis e mojibake (UTF-8 lido como Latin-1/CP1252) → invólucros (```, JWT, Base64, URL-encoding, entidades HTML) → lixo antes do JSON (logs, `var x =`, JSONP) → escapes sem aspas externas → parser tolerante (JSON5/JS/Python/Mongo shell, comentários, vírgulas, aspas internas, truncado, JSON Lines) → se o resultado é uma string com JSON, repete.
   - O parser gera AST própria (não usa `JSON.parse`) para preservar ordem das chaves e números grandes. Cada reparo vira um passo (`info` | `fix` | `warn`) exibido no diagnóstico.
   - Opções (indentação, ordenar chaves, expandir JSON em strings, formatar ao colar) e o texto ficam no `localStorage` (conveniência local, não vai para o Rust).

6. **Tema claro/escuro**:
   - Preferência em `AppSettings.theme` (com cópia em `localStorage` para o script do `<head>` aplicar antes da primeira pintura). O tema resolvido fica em `<html data-theme>`.
   - CSS novo deve usar tokens: `rgba(var(--fg-rgb), a)` para camadas translúcidas, `calc(a * var(--shade-k))` no alfa de sombras/poços escuros, `--nt-*`/`--c-*` para superfícies e `--syn-*` para realce. Cores claras específicas de cada app ficam em `theme.css`.

7. **Editor de código**: campos de código (body raw/GraphQL e scripts do HTTP, Formatter JSON, console SQL) usam `codeEditor()`, com numeração de linhas, realce, Tab/Shift+Tab e Enter com recuo.

8. **Banco de Dados (cópia do DataGrip)**:
   - **Registros afetados**: toda escrita mostra "(N) registro(s) afetado(s)" na Saída do console e no log (`affectedText`). No SQL Server a contagem vem do DONE de cada comando filtrado por tipo (INSERT/UPDATE/DELETE/MERGE), via `simple_query_counted` do tiberius vendorizado — exata em qualquer script (transação, variáveis, CTE), sem contar SELECT nem atribuições. No MongoDB vem de inserted/modified/deleted.
   - **MongoDB** (driver `mongo`): connection string (Atlas `mongodb+srv://`, servidor/replica set, Azure Cosmos DB) salva SEM a senha (vai para o cofre). Console em sintaxe do mongosh (`mongoShell.js` → operação JSON → `mongo.rs`); grid com campos de topo como colunas (descobertas no streaming), campo ausente ≠ NULL, edição preserva o tipo BSON original (long, double, Decimal128, ObjectId, datas). Gravação por `_id`, em ordem e sem transação. Views são somente leitura. Servidores 3.6+ (o driver vendorizado aceita wire 6; o upstream exige 4.4); host `*.mongo.cosmos.azure.com` sem `retryWrites` na string = `retry_writes` desligado.
   - SQL Server e Azure SQL (driver `tiberius`, TLS rustls). Auth: login SQL ou Microsoft Entra interativo/MFA. Senhas e tokens NUNCA vão para JSON (cofre do sistema via `keyring`).
   - Novo banco = implementar `Driver`/`Session` em `src-tauri/src/db/` + um dialeto em `sqlDialect.js`. O frontend só conhece `ColumnMeta.kind` (int, num, dec, bool, str, date, time, datetime, guid, bin, xml, other).
   - Valores sem perder precisão: bigint fora do intervalo seguro, decimal/money e datas chegam como string; binário como `0x…` (truncado em 4 KB → somente leitura).
   - Azure SQL não aceita nomes de três partes: cada banco da árvore usa uma sessão própria; a introspecção roda no banco da sessão.
   - Grid: virtualizado nos dois eixos (só células visíveis viram HTML), filtro/ordenação locais trabalham em índices (`GridModel.view`). Edição só com PK e conexão não somente leitura; o SQL é revisado antes de gravar (`reviewChangesDialog`).
   - Tabelas paginam no servidor (`OFFSET n ROWS FETCH NEXT page+1`); o console limita linhas por result set (excedentes descartados, o lote segue rodando).
   - Cancelar fecha a conexão da aba (o Attention do tiberius deixa a conexão dessincronizada); a sessão é reaberta no próximo comando.
   - **Estrutura (DDL)**: menus do Explorer (tabela, schema, pasta, grupos e itens) abrem "Modificar tabela" (Ctrl+F6) / "Nova tabela" ou ações rápidas (renomear, excluir, TRUNCATE, coluna/índice/FK). `sqlDdl.js` compara o modelo com o original e gera os comandos na ordem certa (remove FKs/checks/índices/defaults dependentes antes de excluir ou alterar coluna e recria depois; `sp_rename` para renomear; nome da tabela por último). Tudo roda numa transação na sessão `meta:` com `SET LOCK_TIMEOUT` e o SQL é mostrado antes. Bloqueado em conexão somente leitura; só SQL Server.
   - **DDL do banco inteiro** ("Gerar DDL do banco/schema…" no Explorer → diálogo de opções → aba de DDL com "Salvar .sql…" e "Abrir no console de…" outra conexão): `mssql_meta::database_script` carrega tudo em lote (`load_tables(Scope)`, uma consulta por categoria, sem N+1) e monta lotes separados por `GO`: schemas → tipos (alias e de tabela) → sequences → sinônimos → tabelas e módulos num grafo só (`topo_order`: FKs + `sys.sql_expression_dependencies`, ciclos viram um bloco via Tarjan; prioridade tabelas < views/funções < procedures, então uma função usada em CHECK/coluna calculada sai logo antes da tabela) → triggers. Cada tabela leva seus índices e as FKs cujo alvo já existe; FK circular sai depois da segunda tabela do ciclo. `if_not_exists` protege cada objeto (`IF OBJECT_ID … IS NULL`; módulos via `EXEC(N'…')`, porque `CREATE OR ALTER` falha em função SCHEMABINDING referenciada). Fora: dados, usuários, permissões, filegroups/partições, propriedades estendidas, índices XML/espaciais (avisados no cabeçalho). O DDL de uma tabela (`table_ddl`) usa o mesmo render (`create_table_sql`/`index_sqls`/`fk_sql`).
   - **Desempenho (só SQL Server/Azure SQL)**: `db_execute` com `options` liga os `SET` num lote próprio antes e os desliga depois (sempre; se não der, a sessão é marcada quebrada e reaberta — com SHOWPLAN ligado nada mais executaria). Estimado = `SET SHOWPLAN_XML` (nada executa, sem trava de escrita); real = `STATISTICS XML` + IO/TIME. O result set com a coluna `Microsoft SQL Server 2005 XML Showplan` vira o evento `plan`; mensagens INFO vêm do patch `QueryItem::Info` do tiberius. Sessões `console:`/`tab:`/`cli:q:`/`perf:` rodam sem `command_timeout` (o Cancelar fecha o socket); `meta:` mantém 30 s. Console: "Explicar" (Ctrl+L), "Explicar e executar" (Ctrl+Shift+L) e o botão IO/TIME (`consoles[].stats`) — abas "Plano" (`createPlanView`) e "Estatísticas" no resultado; PRINT aparece na Saída. Aba `plan` (XML só em memória; só a aberta de um `.sqlplan` volta ao recarregar) e aba `perf` por conexão + banco (`options.section`, sessão `perf:<conn>:<db>`), abertas pelos menus do Explorer (conexão, banco → "Desempenho", tabela → índices, procedure → estatísticas). O SQL das DMVs fica em `sqlPerf.js` (usado também pela CLI). Escritas da aba (KILL, forçar/desforçar plano, ativar Query Store, criar índice, UPDATE STATISTICS) mostram o SQL e confirmam; recusadas em conexão somente leitura. Diagnósticos (`planInsights`): operador caro, estimativa errada (≥10×), Key Lookup repetido, scan com predicado residual, spill, conversão implícita, sem predicado de junção, memory grant, parameter sniffing, índices faltantes.
   - Conexões na ordem de `connections` (databases.json): arrastar no Explorer ou "Mover para cima/baixo" no menu da conexão.
   - **Consultas salvas** (catálogo por conexão + banco, `databases.json → queries`): nó "consultas salvas" antes dos objetos de cada banco no Explorer (montado do JSON a cada desenho, sem rede; continua visível se a listagem do servidor falhar), com subpastas pelo `folder` ("a/b"). Duplo clique abre num console ligado à consulta (`saved_id`, título com "*" quando difere); menu: Executar, Abrir no console, Editar detalhes (nome/pasta/descrição/conexão/banco), Duplicar, Copiar, Excluir (Desfazer); pastas: renomear/excluir; arrastar consulta para outra pasta/banco. No console, Ctrl+S salva (seleção ou script; ligado = atualiza) e Ctrl+Shift+S salva como nova; o log tem "Salvar como consulta…".
   - **Parâmetros** (`sqlParams.js`): `:nome` (SQL, fora de strings/comentários/`[..]`; `::` e `:` no início da linha — SQLCMD — não contam) e `{{nome}}` (SQL e MongoDB, em qualquer lugar; dentro de string entra só o texto escapado). Antes de executar, `paramsDialog` pede os valores (tipo auto/texto/número/data/bool/NULL/cru, prévia do texto final) e lembra os últimos (`params[x].last` no console e na consulta). A trava de somente leitura é avaliada depois da substituição.
   - Modo bandeja mostra só a lista de conexões; o cliente completo é desktop-only.

9. **RabbitMQ (monitor e depurador de filas)**:
   - Gestão pela API HTTP do plugin de management; AMQP (amqprs) só para gravar e mover. Conexão = URL do management + usuário (+ host/porta AMQP opcionais). "Ambiente sensível" exige digitar o nome para purgar/excluir/consumir/fechar.
   - Seções: Visão geral (totais, taxas 10 min, alarmes, DLQs com mensagens, filas sem consumidor, nós), Filas, Exchanges, Conexões (fechar), Canais, Consumidores, Gravações. Auto-refresh configurável; a aba de mensagens e as gravações não atualizam sozinhas (espiar é invasivo).
   - **Espiar** usa `/get` com `ack_requeue_true` (marca `redelivered`); consumir/rejeitar removem e salvam automaticamente no log. Publicar aceita repetição com `{{n}}`, `{{uuid}}`, `{{now}}`, `{{timestamp}}`.
   - **Gravação**: `tap` = fila temporária exclusiva com as ligações das filas (não consome; não vê publicação direta na exchange padrão); `firehose` = liga o tracing do vhost (desliga ao parar, se foi o app que ligou) e grava publish/deliver; `exchange` = exchange + routing key. Mensagens vão em lotes para o `rabbit.db`; o limite (`max_messages`) apaga as mais antigas.
   - **Mover/copiar** nunca usa a API HTTP (perderia mensagens se falhar no meio): transação AMQP por lote; "origem" usa o `x-death`; destino fila é verificado (passive) antes.
   - Modo bandeja mostra só o resumo de cada conexão (prontas / sem ack, a cada 15 s).

10. **Configurações**: aba própria nos dois modos. No modo expandido tem barra unificada (seletor de apps com a engrenagem, botões de janela tratados em `settings.js`) e a lista centralizada; a lista rola (`.settings-list` com `overflow-y: auto`).

11. **Janela Frameless & System Tray**:
   - A janela não possui barra de título do sistema operacional (`decorations: false`). A barra de arrastar é estilizada via `data-tauri-drag-region`.
   - `dragDropEnabled: false` na janela (`tauri.conf.json`): com o padrão (true) o WebView2 no Windows engole o drag & drop HTML5 (arrastar notas/pastas/requisições). Não reativar; soltar arquivos do sistema não é usado.
   - O aplicativo minimiza para a bandeja do sistema ao fechar ou ao clicar em ocultar.
   - Uma instância só (`tauri-plugin-single-instance`, primeiro plugin do Builder): uma 2ª execução mostra a principal ou, com `--app=<id>`, abre a janela daquele app.

12. **Apps desatachados (janelas próprias)**:
   - Tarefas, Notas, HTTP, JSON, Banco, RabbitMQ e Redis podem sair da principal para uma janela `app-<id>` (botão ↗ na barra desktop de cada app ou clique direito no seletor/abas). Configurações fica sempre na principal. A janela carrega o mesmo `index.html` com `window.__DEVSUITE_APP__` (`initialization_script`) e o `main.js` só inicializa aquele app (`SOLO_APP`).
   - **Um app vive em uma janela por vez**: a principal não mostra nem grava um app solto (`state.detached`; `showMainView` foca a janela dele). Por isso `kanban.json`, `http.json`, `databases.json` etc. continuam com um único escritor. Antes de mover, `flushApp` grava as pendências e `app_window_open` esvazia a fila do `persist`; ao voltar (`app-attached`) a principal relê do disco (`reloadApp`). Cada app registra `flush`/`reload`/`blocker` em `appLifecycle.js` (Banco: consulta rodando bloqueia; Tarefas: sessão de Pomodoro bloqueia). O reload do Banco recria a interface sem `dispose()`: as sessões `tab:`/`console:`/`meta:` continuam no Rust (transação aberta preservada). Gravações do RabbitMQ reconectam por `rmq_capture_attach`.
   - X / Alt+F4 / botão "Devolver" na janela solta = reatachar (`app-close-requested` → grava → `app_window_close`; sem resposta em 3 s fecha mesmo assim). Novo app desatachável = registrar no `APPS` do `app_windows.rs`, em `DETACHABLE` (`windowContext.js`), um ícone em `src-tauri/icons/apps/<id>.svg` (+ `_gen_icons.ps1`) e `registerApp` no componente.
   - `settings.json`: cada janela grava o documento inteiro; `save_settings` emite `settings-changed` para todas e `initSettingsSync` (settings.js) atualiza a cópia local (tema, Zettelkasten, cofre). Com as Notas soltas, a troca de armazenamento nas Configurações fica bloqueada (é feita pela barra lateral das Notas).
   - **Barra de tarefas (Windows)**: cada janela recebe o AppUserModelID `DevSuite.<id>` (botão e ícone separados da principal) e as propriedades de relançamento (`"<exe>" --app=<id>`, nome e `.ico` gravado em `<app_data>/app-icons/`), limpas antes de destruir a janela. Fixar a janela na barra cria um atalho que abre direto aquele app. No Linux só o ícone da janela muda.
   - `windows.json` (app_data): apps soltos (reabertos ao iniciar; com "iniciar minimizado" abrem minimizados) e posição/tamanho físicos de cada janela (guardados ao fechar e ao sair; fora da tela = centraliza). O menu da bandeja ganha "Mostrar <app>" para cada app solto.

13. **Arquivos .md de fora das Notas** (`md_files.rs`, `quicklook.rs`, `mdFile.js`, `mdDoc.js`):
   - **Abrir para editar**: dois cliques num `.md` (associação em `tauri.conf.json → bundle.fileAssociations`, registrada pelo instalador NSIS/MSI), `dev-suite.exe <arquivo.md>` ou "Abrir Arquivo Markdown…" no menu "…" das Notas. O argumento chega pelo `setup` (1º início; a principal fica na bandeja) ou pelo single-instance (`md_arg`). Cada arquivo tem a sua janela `md-<hash do caminho>` (`window.__DEVSUITE_MD__ = { path }`; `main.js` só chama `initMdFile`): o editor das Notas sem pastas/lista/propriedades, não entra no notes.db nem no cofre.
   - O arquivo é a verdade: **abrir nunca regrava**; editar grava com debounce (800 ms), ao perder o foco, Ctrl+S e ao fechar. Front-matter cru, CRLF/LF e BOM voltam como estavam; o arquivo não ganha título nem `created:` (diferente do cofre). Conflito por mtime (`expectedMtime`): faixa "Recarregar do disco" / "Sobrescrever"; fechar com conflito grava a versão do app em `<nome> (conflito <data>).md`. Ao focar a janela sem edição pendente, relê se o mtime mudou. Links `[[ ]]` ficam pendentes (sem notas nesta janela).
   - Imagens relativas ao arquivo: `noteimg://localhost/f/<token>/<caminho codificado num segmento só>` (`fileImageUrl`; um segmento para o navegador não resolver `../` na URL); o Rust resolve com `vault_file` (recusa `..`/absolutos, então `../x.png` aparece quebrada mas volta igual ao salvar). Coladas vão para `attachments/` ao lado do arquivo (`setImageTarget` em `noteImages.js`).
   - **Prévia com Espaço (Windows)**: `quicklook.rs` instala um hook `WH_KEYBOARD_LL` que só observa (não engole a tecla). Espaço sem modificadores com o foco na lista de itens (`DirectUIHWND`/`SysListView32`) do Explorer (`CabinetWClass`) ou da Área de Trabalho (`Progman`/`WorkerW`) → thread COM pergunta o item selecionado (`IShellWindows`; aba ativa do Win11 = 1ª `ShellTabWindowClass`; `IFolderView2::GetSelection`) → um único `.md` abre a janela `md-preview` (criada oculta no início para abrir na hora; `__DEVSUITE_PREVIEW__`): editor `readOnly` com Mermaid, código, tabelas e imagens, botão "Editar" (abre a janela do arquivo). Espaço/Esc/perder o foco escondem; Espaço de novo no Explorer sobre o mesmo arquivo também. Liga/desliga em Configurações (`md_quicklook`, `quicklook::set_enabled` no `setup` e no `save_settings`).
   - **Associação e ícones (instalador NSIS)**: `fileAssociations` cria o ProgID `DevSuite.Markdown` (o nome da associação), mas o template do Tauri sempre usa o ícone do executável; o `installer-hooks.nsh` (POSTINSTALL) troca o `DefaultIcon` para `icons/markdown.ico` e define o nome/ícone do "Abrir com" (`Application` + `FriendlyAppName` = "Dev Suite - Notas", `icons/notes.ico`), adiciona `OpenWithProgids` e remove o ProgID antigo `Markdown` se apontar para o `dev-suite.exe`. O MSI não usa os hooks. A janela do arquivo usa o ícone do Notas.
   - **Permissões**: toda janela nova precisa casar com `windows` em `src-tauri/capabilities/default.json` (`main`, `app-*`, `md-*`); sem isso `event.listen` falha e a janela fica sem eventos (foi o que impedia abrir o arquivo e a prévia).

14. **CLI `devsuite` (scripts e agentes de IA)** (`src-tauri/cli`, `src-tauri/src/cli`, `src/js/cli`, `skills/`):
   - **Ponte com o app** (nunca lê/grava os dados direto): o app abre o named pipe `devsuite-cli-<usuário>` (Windows, `reject_remote_clients`) ou `<app_data>/cli.sock` (0600) e grava `<app_data>/cli.json` (`endpoint`, `token` aleatório a cada início, `pid`, `exe`). Frames NDJSON: `{ hello, token }` → `{ id, method, params }` → `{ id, event }`* → `{ id, result }` | `{ id, error: { code, message } }`. Sem app rodando, a CLI inicia `dev-suite --background` (fica na bandeja; o single-instance ignora `--background`) e espera o handshake.
   - `method = "<app>.<comando>"` (espaços/hífens → `_`). O Rust emite `cli-call` para a **janela dona** do app (`app-<id>` se desatachado, senão `main`), espera o `cli_ready` dela e reenvia quando a resposta é `moved` (app mudando de janela) ou a página recarregou (um novo `cli_ready` descarta as pendências daquela janela). Os handlers (`registerCli` em `main.js`, só para os apps desta janela) trabalham no estado vivo e gravam pelo mesmo caminho da interface (`notesHost`, `tasksHost`, `httpHost`, `dbHost`, `rabbitHost` exportados pelos componentes): um único escritor e a UI atualiza na hora. Eventos (`ctx.event`) saem em fila antes do `cli_reply` (o IPC do Tauri não garante ordem). Cliente que sai (Ctrl+C) = `cli-cancel` (consulta cancelada, `watch` para).
   - **Comandos novos**: entrada em `src-tauri/cli/commands.json` (args/opções/exemplos; `input` = texto, `@arquivo` ou `-`; `path` = absoluto pelo cwd; `number`, `multi`, `flag`) + função na tabela exportada do `*Cli.js` do app. Nenhuma opção pode se chamar `json`, `text`, `pretty`, `timeout`, `no-start` ou `help` (globais). `node tests/cli.test.mjs` confere handlers, opções e os exemplos das skills.
   - **Travas**: leitura livre. `--write` para SQL que não seja só leitura (`sqlReadOnly`: SELECT/WITH sem INTO, DECLARE/SET/PRINT; `EXEC` conta como escrita), escrita no MongoDB (unidade não `readOnly` do `mongoLanguage`), publish/consume/move/purge/delete/declare/close e API não-GET do RabbitMQ, firehose. `--yes` para excluir. `--confirm <nome>` em conexão RabbitMQ/Redis "ambiente sensível". Redis: `--write` para comandos com a flag `write` do COMMAND INFO (cache por conexão) e os perigosos; `del` exige `--yes`. `db run-saved` substitui os parâmetros (`--param nome[:tipo]=valor`, `--use-last`) e segue as travas do `db query`. `db plan` sem `--analyze` não executa nada (sem trava); `--analyze` executa e segue as travas do `db query`; `top-queries`/`sessions`/`waits`/`indexes` só leem DMVs (KILL, forçar plano e criar índice ficam na interface). Conexão de banco `read_only` recusa escrita. Códigos de saída: 0 ok, 1 erro, 2 uso/não encontrado/ambíguo, 3 app indisponível, 4 falta trava.
   - **Banco**: sessões próprias `cli:q:<conn>:<banco>` / `cli:meta:<conn>:<banco>` (separadas das abas); transação deixada aberta por um script é desfeita (`rollback`) e avisada; `db disconnect` fecha as sessões da CLI.
   - **Notas**: o armazenamento ativo é o estado vivo; `--vault`/`--all-vaults` leem os outros pelo `cli_store_read` (abre o índice `vaults/<hash>.db` ou o notes.db sem trocar o backend); `create --vault` grava um .md novo no outro cofre.
   - **Instalação**: release com `--config src-tauri/tauri.release.conf.json` (externalBin `binaries/devsuite`, compilado por `build_cli.*`). NSIS: `devsuite.exe` em `$INSTDIR`, que o hook põe/tira do PATH do usuário (HKCU; o MSI não tem hooks) via PowerShell no valor cru do registro — nunca com `ReadRegStr`/`StrCpy`: strings do NSIS param em 1024 caracteres e um PATH maior voltava vazio, apagando o PATH do usuário. `.deb`/`.rpm`: `/usr/bin/devsuite`. Configurações → "CLI": status, "Adicionar ao PATH" e "Instalar skills" (`devsuite skills install`, padrão `~/.claude/skills`).

15. **Redis (cliente completo)** (`redis_app/`, `redis*.js`, `redisModel.js`):
   - Conexão: standalone (URL `redis://`/`rediss://` ou argumentos do redis-cli colados), Cluster (nós iniciais) ou Sentinel (sentinels + master; senha própria), ACL usuário/senha, TLS (sem verificação ou CA própria em PEM) e túnel SSH (senha ou chave + senha da chave). Segredos só no cofre. "Somente leitura" recusa no Rust comandos com a flag `write` do COMMAND INFO (subcomando em CONFIG/CLIENT/…); "ambiente sensível" exige digitar o nome para FLUSH, excluir, CLIENT KILL, CONFIG SET e comandos perigosos do console (`classifyCommand`).
   - **Sessões**: uma conexão multiplexada por (sessão, banco): `meta` (árvore/abas), `console:<aba>` (sem timeout de resposta: BLPOP/XREAD BLOCK não travam o resto; Cancelar fecha a sessão), `analyze`, `cli`. Erro de rede descarta a sessão (reconecta no próximo comando). No Cluster cada sessão é uma `ClusterConnection` (só db 0) e `node` roteia por endereço.
   - **SSH**: `Tunnels` abre um encaminhamento local por host:porta pedido e é o resolvedor de nomes do driver (SNI/certificado continuam os do host real; no Cluster cada nó anunciado ganha o seu). Monitor/Pub/Sub pelo túnel conectam direto na porta local (sem verificar o nome no certificado). Chave do host: `~/.ssh/known_hosts` ou `<app_data>/ssh_known_hosts` (TOFU); chave diferente = recusa. Sentinel por SSH não é suportado.
   - **Árvore de chaves**: SCAN incremental (`scan_count` por página, "carregar mais"/"tudo" até 200 mil), filtro por padrão (MATCH) e tipo (SCAN TYPE), pastas pelo separador da conexão (`keyTreeRows`), lista virtualizada (linhas de 22 px). Clique abre em aba de pré-visualização (reaproveitada, título em itálico); duplo clique/edição fixa. Menu: TTL, renomear, excluir; pasta: filtrar, nova chave aqui, analisar memória, excluir por padrão (SCAN + UNLINK em lotes, contagem antes).
   - **Aba da chave**: tipo, TTL (diálogo aceita 3600/30min/1h30m/7d; remover = PERSIST), tamanho, MEMORY USAGE, encoding, renomear (RENAMENX), COPY, RESTORE do DUMP. String: editor de valor (Automático/Texto/JSON/Hex/Base64; JSON compacto volta compacto; > 512 KB abre só leitura com "carregar tudo"; salvar usa SET KEEPTTL). Hash/set/zset: HSCAN/SSCAN/ZSCAN (filtro MATCH) ou ZRANGE por rank; list: LRANGE; remover da list = LSET marcador + LREM. Stream: XREVRANGE paginado, XADD, XDEL, XTRIM e grupos (XINFO GROUPS/CONSUMERS, XPENDING, XACK, XCLAIM, SETID, criar/excluir). RedisJSON: JSON.GET/JSON.SET.
   - **Ferramentas**: Visão geral (INFO everything: tiles, alertas — maxmemory, evicted, rejected, BGSAVE/AOF, réplica, fragmentação —, gráficos de ops/s, memória e rede, keyspace, replicação, INFO filtrável), Configuração (CONFIG GET/SET/REWRITE), Slowlog e latência (SLOWLOG, LATENCY LATEST/DOCTOR), Clientes (CLIENT LIST/KILL), Monitor (filtro, pausar tela, top comandos, exportar), Pub/Sub (canais/padrões, publicar, PUBSUB CHANNELS/NUMSUB), Análise de memória (Rust, cancelável, pausa entre lotes), Nós do Cluster. Seletor de nó nas ferramentas quando é Cluster. Visão geral/clientes/slowlog seguem o auto-refresh.
   - Ao vivo (Monitor, Pub/Sub, análise) aparece na pílula da barra e bloqueia desatachar (`blocker`). Modo bandeja: memória, clientes e ops/s de cada conexão a cada 15 s.

---

## 5. Instruções para Manutenção

- Ao adicionar novos recursos JS, coloque a lógica em componentes desacoplados na pasta `src/js/components/`.
- Mantenha o arquivo `src/main.js` apenas para carregar o estado inicial e vincular ouvintes globais.
- Sempre rode `./build_linux.sh` ou `cargo check` em `src-tauri` para validar alterações no código Rust ou builds.
- Tarefas: `node tests/kanban.test.mjs`.
- CLI: `node tests/cli.test.mjs` e `cargo test -p devsuite-cli` (parser); ponta a ponta com o app em dev (`cargo tauri dev`) e `src-tauri/target/debug/devsuite.exe status`.
- Arquivos .md de fora das Notas: `node tests/mdfile.test.mjs` e `cargo test md_files`.
- Git das Notas: `node tests/textdiff.test.mjs` e `cargo test notes_git` (precisa do `git` no PATH; sem ele os testes de integração são pulados).
- Notas: `node tests/code-block.test.mjs` (blocos de código e realce), `node tests/zettel.test.mjs` (links, propriedades, grafo), `node tests/folders.test.mjs` (subpastas, importação de pasta, Postman aninhado), `node tests/vault.test.mjs` (cofre) e `cargo test notes` (notes_db + notes_vault) / `cargo test vault_file`.
- Banco: `node tests/db-utils.test.mjs`, `node tests/sqlplan.test.mjs` (planos, IO/TIME, DMVs) e `node tests/mongo.test.mjs` (utilitários JS) e `cargo test` em `src-tauri`; MongoDB: `docker run -d -p 27019:27017 -e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD=TodoRs#Mongo2026 mongo:7` e `TODORS_MONGO_TEST="mongodb://admin@localhost:27019/?authSource=admin|TodoRs#Mongo2026" cargo test it_mongo`; os testes de integração precisam de um SQL Server: `docker run -d -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=TodoRs#Test2026" -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest` e `TODORS_MSSQL_TEST="localhost,14333,sa,TodoRs#Test2026" cargo test it_ -- --test-threads=1`.
- RabbitMQ: `node tests/rabbit.test.mjs`, `cargo test rabbit`; integração: `docker run -d --name todors-rabbit-test -p 5673:5672 -p 15673:15672 rabbitmq:3-management` e `TODORS_RABBIT_TEST="http://localhost:15673|5673|guest|guest" cargo test it_rabbit -- --test-threads=1`.
- Redis: `node tests/redis.test.mjs`, `cargo test redis`; integração: `docker run -d --name todors-redis-test -p 6380:6379 redis/redis-stack-server:latest` e `TODORS_REDIS_TEST="localhost|6380|" cargo test it_redis -- --test-threads=1`. Cluster: `docker run -d -e IP=0.0.0.0 -e INITIAL_PORT=7100 -p 7100-7105:7100-7105 grokzen/redis-cluster:7.0.10` + `TODORS_REDIS_CLUSTER_TEST="127.0.0.1:7100"`. Sentinel: `docker run -d -p 6390:6390 -p 26390:26390 redis:7 sh -c "redis-server --port 6390 --daemonize yes && printf 'port 26390\nsentinel monitor mymaster 127.0.0.1 6390 1\n' > /tmp/s.conf && exec redis-sentinel /tmp/s.conf"` + `TODORS_REDIS_SENTINEL_TEST="127.0.0.1:26390|mymaster"`. SSH: um sshd com AllowTcpForwarding na mesma rede docker do Redis + `TODORS_REDIS_SSH_TEST="127.0.0.1:2222|root|senha|todors-redis-test:6379"`.
- **Desempenho**: comandos Tauri síncronos rodam na thread da UI. Gravações em disco devem usar `persist::write` (nunca `fs::write` direto num comando), e efeitos caros (ex.: `reg.exe` do autostart) só quando o valor muda.
- Não salvar em disco ao navegar entre abas: só gravar quando houver alteração pendente.
- Abas ocultas usam `display: none`. Não usar `content-visibility: hidden` nelas: com a aba JSON grande, todos os frames do app ficam ~45 ms mais lentos.

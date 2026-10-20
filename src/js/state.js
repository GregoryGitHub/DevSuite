export const state = {
  kanban: null, // documento de kanban.json normalizado por normalizeKanban (board das Tarefas)
  notes: [],
  folders: [], // pastas criadas pelo usuário; a pasta padrão "Notas" (id 0) é implícita
  settings: { autostart: false, start_minimized: false, theme: "system", zettelkasten: false, notes_storage: "sqlite", vault_path: "", vaults: [] },
  tasksUI: {
    selectedId: null, // card aberto no detalhe
    pane: "list", // modo bandeja: "list" (board) | "editor" (detalhe do card)
    query: "",
    due: null, // filtro de prazo: null | "overdue" | "today"
    label: null, // filtro por etiqueta
    sidebarHidden: false,
    column: null, // modo bandeja: coluna mostrada (abas)
    archived: false, // mostrando os arquivados do board
  },
  activeMainView: "tasks", // "tasks" | "notes" | "http" | "json" | "db" | "settings"
  desktopMode: false, // true = janela grande (Notas, HTTP e JSON)
  detached: new Set(), // janela principal: apps abertos numa janela própria (ver components/detach.js)
  notesUI: {
    scope: "all", // "all" | "trash" | "graph" (modo Zettelkasten) | "f:<folderId>"
    selectedId: null,
    query: "",
    pane: "list", // modo bandeja: "folders" | "list" | "editor" | "graph"
    sidebarHidden: false,
    editingFolderId: null,
  },
  http: null, // documento de http.json normalizado por normalizeHttpData
  db: null, // documento de databases.json normalizado por normalizeDbData (sem segredos)
  httpUI: {
    scope: null, // "all" | "history" | "c:<collectionId>"
    selectedId: null, // id da requisição (ou da entrada do histórico quando scope === "history")
    query: "",
    pane: "list", // modo bandeja: "collections" | "list" | "editor"
    side: "request", // modo bandeja: "request" | "response"
    sidebarHidden: false,
    editingCollectionId: null,
    editingFolderId: null,
    reqTab: "params",
    resTab: "body",
    bodyView: "pretty", // "pretty" | "raw" | "preview"
    wrap: false,
    split: 0.48, // modo desktop: fração da altura usada pela requisição
  },
  pomoState: {
    cardId: null,
    phase: "work", // "work" | "break" | "long"
    running: false,
    endsAt: 0, // rodando: fim da fase (Date.now())
    remainingMs: 25 * 60 * 1000, // pausado: quanto falta
    totalMs: 25 * 60 * 1000, // duração da fase atual
    segStart: 0, // foco rodando: início do trecho ainda não somado ao card
    worksDone: 0, // focos completos nesta sequência (pausa longa)
  },
};

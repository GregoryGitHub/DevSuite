const { invoke } = window.__TAURI__?.core || { invoke: async () => [] };

// ---------- Tarefas (board kanban, kanban.json; formato em js/utils/kanbanModel.js) ----------

/** Documento do board (null = ainda não existe). */
export const loadKanbanApi = () => invoke("load_kanban_data");

export async function saveKanbanApi(data) {
  try {
    await invoke("save_kanban_data", { data });
  } catch (e) {
    console.error("save_kanban_data failed", e);
  }
}

/** todos.json antigo (só para migrar): null = não existe; erro = ilegível. */
export const loadLegacyTodosApi = () => invoke("load_todos");
/** Renomeia o todos.json para todos.json.migrated (depois de gravar o kanban.json). */
export const kanbanMigratedApi = () => invoke("kanban_migrated");

// ---------- Notas e pastas (notes.db, SQLite; ver src-tauri/src/notes_db.rs) ----------
// Os erros sobem para quem chama (js/noteStore.js), que decide como avisar.

export const notesApi = {
  /** Metadados de todas as notas (sem o HTML); remove da lixeira o que passou de 30 dias. */
  list: () => invoke("notes_list"),
  /** HTML de uma nota (null se não existe); no cofre, { markdown, rel, mtime }. */
  get: (id) => invoke("notes_get", { id }),
  /** Grava uma nota completa: { ...meta, content, plain, images, markdown? }. Cofre: { disk_mtime, rel, conflict }. */
  save: (note) => invoke("notes_save", { note }),
  /** Grava várias notas numa transação (importação de pasta). */
  saveMany: (notes) => invoke("notes_save_many", { notes }),
  /** Lê uma pasta recursivamente: { name, notes: [{ rel, path, text, modified }], files: [{ rel, path }], skipped }. */
  scanDir: (dir) => invoke("notes_scan_dir", { dir }),
  /** Atualiza fixada/pasta/lixeira/data de várias notas sem reenviar o HTML. */
  setMeta: (notes) => invoke("notes_set_meta", { notes }),
  delete: (ids) => invoke("notes_delete", { ids }),
  /** Ids das notas que contêm o texto (trigram: sem maiúsculas/acentos). */
  search: (query) => invoke("notes_search", { query }),
  folders: () => invoke("notes_folders"),
  saveFolders: (folders) => invoke("notes_save_folders", { folders }),
  /** notes.json/folders.json antigos ainda não importados, ou null. */
  legacy: () => invoke("notes_legacy"),
  import: (notes, folders) => invoke("notes_import", { notes, folders }),
  /** Apaga imagens que nenhuma nota usa (a lista vem do banco). */
  gcImages: () => invoke("notes_gc_images"),
  /** Troca o armazenamento: mode "sqlite" | "vault" (+ pasta). Erro = continua no anterior. */
  setStorage: (mode, path) => invoke("notes_set_storage", { mode, path }),
  /** Cofre: o que mudou no disco { changed: [NoteMeta], removed: [id], folders: [Folder] | null }. */
  vaultRefresh: () => invoke("notes_vault_refresh"),
  /** Cofre: arquivos que não são notas (imagens/anexos), relativos ao cofre. */
  vaultFiles: () => invoke("notes_vault_files"),
};

// ---------- Controle de versão do cofre (git do sistema; src-tauri/src/notes_git.rs) ----------
// `path` = relativo à raiz do repositório (o cofre pode ser uma subpasta dele).

export const gitApi = {
  /** { available, version, repo, root, top, prefix, remote_url, user_name, user_email } */
  info: () => invoke("git_info"),
  /** { files: [{ path, orig_path, rel, status }], branch, head, upstream, ahead, behind, merging } */
  status: () => invoke("git_status"),
  init: () => invoke("git_init"),
  /** Cria <parent>/<name> com repositório e commit inicial: { path, git, committed, git_error }. */
  createVault: (parent, name) => invoke("notes_vault_create", { parent, name }),
  /** { left, right, left_label, right_label, binary, editable, mtime } (null = não existe naquele lado). */
  filePair: (path, origPath = null, rev = null) => invoke("git_file_pair", { path, origPath, rev }),
  writeFile: (path, text, expectedMtime) => invoke("git_write_file", { path, text, expectedMtime }),
  commit: (paths, message, amend = false) => invoke("git_commit", { paths, message, amend }),
  rollback: (files) => invoke("git_rollback", { files }),
  ignore: (path) => invoke("git_ignore", { path }),
  log: (path = null, skip = 0, limit = 100) => invoke("git_log", { path, skip, limit }),
  commitFiles: (hash) => invoke("git_commit_files", { hash }),
  setRemote: (url) => invoke("git_remote_set", { url }),
  testRemote: (url, opId) => invoke("git_remote_test", { url, opId }),
  fetch: (opId) => invoke("git_fetch", { opId }),
  /** { message, conflicts } */
  pull: (opId) => invoke("git_pull", { opId }),
  push: (opId) => invoke("git_push", { opId }),
  cancel: (opId) => invoke("git_cancel", { opId }),
  /** { base, ours, theirs, binary } */
  conflict: (path) => invoke("git_conflict", { path }),
  /** text = null apaga o arquivo. */
  resolve: (path, text) => invoke("git_resolve", { path, text }),
  mergeAbort: () => invoke("git_merge_abort"),
  setIdentity: (name, email, global) => invoke("git_set_identity", { name, email, global }),
};

export async function loadSettingsApi() {
  try {
    return (await invoke("load_settings")) || { autostart: false, start_minimized: false };
  } catch (e) {
    console.error("load_settings failed", e);
    return { autostart: false, start_minimized: false };
  }
}

export async function saveSettingsApi(settings) {
  try {
    await invoke("save_settings", { settings });
  } catch (e) {
    console.error("save_settings failed", e);
  }
}

export function hideWindowApi() {
  invoke("hide_window");
}

export function exitAppApi() {
  invoke("exit_app");
}

export async function setDesktopModeApi(enabled, visible = true) {
  try {
    await invoke("set_desktop_mode", { enabled, visible });
  } catch (e) {
    console.error("set_desktop_mode failed", e);
  }
}

export function minimizeWindowApi() {
  invoke("minimize_window");
}

export async function toggleMaximizeApi() {
  try {
    return !!(await invoke("toggle_maximize"));
  } catch (e) {
    console.error("toggle_maximize failed", e);
    return false;
  }
}

// ---------- HTTP (aba estilo Postman) ----------

export async function loadHttpDataApi() {
  try {
    return await invoke("load_http_data");
  } catch (e) {
    console.error("load_http_data failed", e);
    return null;
  }
}

export async function saveHttpDataApi(data) {
  try {
    await invoke("save_http_data", { data });
  } catch (e) {
    console.error("save_http_data failed", e);
  }
}

/** Executes the request in Rust (no CORS). Rejects with a readable message string. */
export async function sendHttpRequestApi(request) {
  if (!window.__TAURI__?.core) throw "Disponível apenas no aplicativo desktop.";
  return invoke("send_http_request", { request });
}

export function cancelHttpRequestApi(id) {
  invoke("cancel_http_request", { id }).catch(() => {});
}

export function clearHttpCookiesApi() {
  return invoke("clear_http_cookies").catch(() => {});
}

export async function openFileDialogApi({ filters, title, multiple = false } = {}) {
  try {
    const path = await invoke("plugin:dialog|open", { options: { multiple, directory: false, filters, title } });
    if (multiple) return Array.isArray(path) ? path : path ? [path] : [];
    return Array.isArray(path) ? path[0] ?? null : path ?? null;
  } catch (e) {
    console.error("open dialog failed", e);
    return null;
  }
}

export async function openDirectoryDialogApi({ title } = {}) {
  try {
    const path = await invoke("plugin:dialog|open", { options: { multiple: false, directory: true, title } });
    return Array.isArray(path) ? path[0] ?? null : path ?? null;
  } catch (e) {
    console.error("open dialog failed", e);
    return null;
  }
}

export async function saveFileDialogApi({ defaultPath, filters, title } = {}) {
  try {
    return (await invoke("plugin:dialog|save", { options: { defaultPath, filters, title } })) ?? null;
  } catch (e) {
    console.error("save dialog failed", e);
    return null;
  }
}

export function readTextFileApi(path) {
  return invoke("read_text_file", { path });
}

export function writeFileApi(path, { text = null, base64 = null } = {}) {
  return invoke("write_file", { path, text, base64 });
}

// ---------- Imagens das notas ----------

export const hasTauri = !!window.__TAURI__?.core;

/** Stores image bytes (sent raw, no base64) and resolves to the file name. */
export function saveNoteImageApi(bytes, ext = "") {
  return invoke("save_note_image", bytes, { headers: { "x-ext": ext } });
}

export function importNoteImageApi(path) {
  return invoke("import_note_image", { path });
}

// ---------- Arquivos .md fora das Notas (src-tauri/src/md_files.rs) ----------

export const mdApi = {
  /** { text, mtime, token, name } — token = pasta do arquivo (imagens). */
  read: (path) => invoke("md_file_read", { path }),
  /** { mtime, conflict }: com conflito nada é gravado. */
  write: (path, text, expectedMtime) => invoke("md_file_write", { path, text, expectedMtime }),
  /** Caminho relativo ao arquivo (attachments/<hash>.<ext>). */
  saveImage: (token, bytes, ext = "") => invoke("md_file_save_image", bytes, { headers: { "x-token": token, "x-ext": ext } }),
  importImage: (token, path) => invoke("md_file_import_image", { token, path }),
  open: (path) => invoke("md_open", { path }),
  reveal: (path) => invoke("md_reveal", { path }),
  closeWindow: () => invoke("md_window_close"),
  previewReady: () => invoke("md_preview_ready"),
  previewHide: () => invoke("md_preview_hide"),
};

/** Copia imagens para `dir`; `local` = das imagens do banco local mesmo com um cofre aberto. */
export function exportNoteImagesApi(names, dir, local = false) {
  return invoke("export_note_images", { names, dir, local });
}

/** Imprime a webview direto num PDF (só o que aparece na mídia print: #note-print). */
export function notesPrintPdfApi(path) {
  return invoke("notes_print_pdf", { path });
}

// ---------- Banco de dados (aba estilo DataGrip) ----------

export async function loadDbDataApi() {
  try {
    return await invoke("load_db_data");
  } catch (e) {
    console.error("load_db_data failed", e);
    return null;
  }
}

export async function saveDbDataApi(data) {
  try {
    await invoke("save_db_data", { data });
  } catch (e) {
    console.error("save_db_data failed", e);
  }
}

function requireTauri() {
  if (!window.__TAURI__?.core) throw "Disponível apenas no aplicativo desktop.";
}

/** Os comandos de banco rejeitam com uma mensagem legível (string). */
export const dbApi = {
  setPassword: (connId, password) => invoke("db_set_password", { connId, password }),
  hasPassword: (connId) => invoke("db_has_password", { connId }).catch(() => false),
  forgetSecrets: (connId) => invoke("db_forget_secrets", { connId }).catch(() => {}),
  test(conn, password = null) {
    requireTauri();
    return invoke("db_test_connection", { conn, password });
  },
  connect(target) {
    requireTauri();
    return invoke("db_connect", { target });
  },
  disconnect: (prefix) => invoke("db_disconnect", { prefix }).catch(() => {}),
  introspect: (target, path) => invoke("db_introspect", { target, path }),
  tableInfo: (target, schema, name) => invoke("db_table_info", { target, schema, name }),
  ddl: (target, path) => invoke("db_ddl", { target, path }),
  /** Script do banco inteiro na ordem de criação: { sql, objects, warnings }. */
  databaseScript: (target, options) => invoke("db_database_script", { target, options }),
  tableSchema: (target, schema, name) => invoke("db_table_schema", { target, schema, name }),
  /** Senha do cofre (null = não tem). */
  getPassword: (connId) => invoke("db_get_password", { connId }),
  /**
   * `onEvent` recebe ResultStart/Rows/ResultEnd/Message/Plan enquanto a consulta roda; resolve com o resumo
   * só depois do evento "done": a resposta do invoke pode chegar antes das últimas linhas.
   */
  /** `options`: { plan: "estimated" | "actual", stats_io, stats_time } (análise; só SQL Server). */
  async execute(target, queryId, sql, { maxRows = null, options = null, onEvent }) {
    requireTauri();
    const channel = new window.__TAURI__.core.Channel();
    let finished;
    const done = new Promise((resolve) => (finished = resolve));
    channel.onmessage = (ev) => (ev.type === "done" ? finished() : onEvent(ev));
    const summary = await invoke("db_execute", { target, queryId, sql, maxRows, options, onEvent: channel });
    // Segurança: não trava se o evento se perder.
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))]);
    return summary;
  },
  cancel: (queryId) => invoke("db_cancel", { queryId }).catch(() => {}),
  tx: (target, action) => invoke("db_tx", { target, action }),
  apply: (target, statements, atomic = true) => invoke("db_apply", { target, statements, atomic }),
};

// ---------- RabbitMQ (rabbit.db + API de management + AMQP; ver src-tauri/src/rabbit/) ----------

/** Os comandos rejeitam com uma mensagem legível (string). */
export const rabbitApi = {
  load: () => invoke("rmq_load"),
  saveConnections: (connections) => invoke("rmq_save_connections", { connections }),
  saveMeta: (key, value) => invoke("rmq_save_meta", { key, value }),
  setPassword: (connId, password) => invoke("rmq_set_password", { connId, password }),
  hasPassword: (connId) => invoke("rmq_has_password", { connId }).catch(() => false),
  forgetPassword: (connId) => invoke("rmq_forget_password", { connId }).catch(() => {}),
  /** Chamada à API HTTP do management: path sem "/api" (segmentos já codificados). */
  http(conn, method, path, body = null, password = null) {
    requireTauri();
    return invoke("rmq_http", { conn, method, path, body, password });
  },
  test(conn, password = null, vhost = null) {
    requireTauri();
    return invoke("rmq_test", { conn, password, vhost });
  },
  move: (conn, spec) => invoke("rmq_move", { conn, spec }),
  openMgmt: (conn) => invoke("rmq_open_mgmt", { conn }),
  /** onEvent recebe { kind: progress | warning | stopped, capture_id, ... }. */
  captureStart(conn, spec, onEvent) {
    requireTauri();
    const ch = new window.__TAURI__.core.Channel();
    ch.onmessage = onEvent;
    return invoke("rmq_capture_start", { conn, spec, onEvent: ch });
  },
  captureStop: (captureId) => invoke("rmq_capture_stop", { captureId }),
  captureAttach(captureId, onEvent) {
    const ch = new window.__TAURI__.core.Channel();
    ch.onmessage = onEvent;
    return invoke("rmq_capture_attach", { captureId, onEvent: ch });
  },
  captures: (connId = null) => invoke("rmq_captures", { connId }),
  captureRename: (captureId, name) => invoke("rmq_capture_rename", { captureId, name }),
  captureDelete: (captureId) => invoke("rmq_capture_delete", { captureId }),
  query: (filter) => invoke("rmq_messages_query", { filter }),
  message: (id) => invoke("rmq_message_get", { id }),
  messages: (ids) => invoke("rmq_messages_get", { ids }),
  deleteMessages: (ids) => invoke("rmq_messages_delete", { ids }),
  deleteMatching: (filter) => invoke("rmq_messages_delete_matching", { filter }),
  saveMessages: (messages, maxBodyKb = null) => invoke("rmq_messages_save", { messages, maxBodyKb }),
  stats: () => invoke("rmq_store_stats"),
};

// ---------- Redis (redis.json + comandos crus; ver src-tauri/src/redis_app/) ----------

/** Valores chegam como { t, v } (ver redisModel.js); os comandos rejeitam com texto legível. */
export const redisApi = {
  load: () => invoke("load_redis_data").catch(() => null),
  save: (data) => invoke("save_redis_data", { data }),
  setSecret: (connId, kind, value) => invoke("redis_set_secret", { connId, kind, value }),
  hasSecrets: (connId) => invoke("redis_has_secrets", { connId }).catch(() => ({})),
  forgetSecrets: (connId) => invoke("redis_forget_secrets", { connId }).catch(() => {}),
  test(conn, secrets = null) {
    requireTauri();
    return invoke("redis_test", { conn, secrets });
  },
  connect(conn) {
    requireTauri();
    return invoke("redis_connect", { conn });
  },
  disconnect: (connId) => invoke("redis_disconnect", { connId }).catch(() => {}),
  closeSession: (connId, session) => invoke("redis_close_session", { connId, session }).catch(() => {}),
  nodes: (conn) => invoke("redis_nodes", { conn }),
  /** args: [texto | { b64 }]; node: "host:porta" no Cluster. */
  exec: (conn, db, args, { session = "meta", node = null } = {}) => invoke("redis_exec", { conn, db, session, args, node }),
  pipeline: (conn, db, cmds, { session = "meta", node = null } = {}) => invoke("redis_pipeline", { conn, db, session, cmds, node }),
  scan: (conn, db, spec) => invoke("redis_scan", { conn, db, spec }),
  /** spec: { kind: monitor | subscribe, channels, patterns, node, db }; onEvent(ev). */
  liveStart(conn, spec, onEvent) {
    requireTauri();
    const ch = new window.__TAURI__.core.Channel();
    ch.onmessage = onEvent;
    return invoke("redis_live_start", { conn, spec, onEvent: ch });
  },
  analyzeStart(conn, spec, onEvent) {
    requireTauri();
    const ch = new window.__TAURI__.core.Channel();
    ch.onmessage = onEvent;
    return invoke("redis_analyze_start", { conn, spec, onEvent: ch });
  },
  liveStop: (id) => invoke("redis_live_stop", { id }).catch(() => false),
};

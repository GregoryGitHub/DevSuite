const { invoke } = window.__TAURI__?.core || { invoke: async () => [] };

export async function loadTodosApi() {
  try {
    return (await invoke("load_todos")) || [];
  } catch (e) {
    console.error("load_todos failed", e);
    return [];
  }
}

export async function saveTodosApi(todos) {
  try {
    await invoke("save_todos", { todos });
  } catch (e) {
    console.error("save_todos failed", e);
  }
}

// ---------- Notas e pastas (notes.db, SQLite; ver src-tauri/src/notes_db.rs) ----------
// Os erros sobem para quem chama (js/noteStore.js), que decide como avisar.

export const notesApi = {
  /** Metadados de todas as notas (sem o HTML); remove da lixeira o que passou de 30 dias. */
  list: () => invoke("notes_list"),
  /** HTML de uma nota (null se não existe). */
  get: (id) => invoke("notes_get", { id }),
  /** Grava uma nota completa: { ...meta, content, plain, images }. */
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

export function exportNoteImagesApi(names, dir) {
  return invoke("export_note_images", { names, dir });
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
  tableSchema: (target, schema, name) => invoke("db_table_schema", { target, schema, name }),
  /** `onEvent` recebe ResultStart/Rows/ResultEnd enquanto a consulta roda; resolve com o resumo. */
  execute(target, queryId, sql, { maxRows = null, onEvent }) {
    requireTauri();
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = onEvent;
    return invoke("db_execute", { target, queryId, sql, maxRows, onEvent: channel });
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

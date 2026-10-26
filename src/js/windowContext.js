// Em qual janela este código roda: a principal (todos os apps) ou uma janela desatachada,
// que o Rust cria com window.__DEVSUITE_APP__ = "<app>" (ver src-tauri/src/app_windows.rs).

/** Apps que podem sair para uma janela própria (Configurações fica sempre na principal). */
export const DETACHABLE = ["tasks", "notes", "http", "json", "db", "rabbit", "redis"];

/** App desta janela desatachada, ou null na janela principal. */
export const SOLO_APP = DETACHABLE.includes(window.__DEVSUITE_APP__) ? window.__DEVSUITE_APP__ : null;

export const isSolo = !!SOLO_APP;

/**
 * Janela de um arquivo .md de fora das Notas ({ path }) ou a prévia somente leitura do Espaço
 * no Explorer (ver src-tauri/src/md_files.rs). Nenhum app roda nessas janelas, só o editor.
 */
export const MD_FILE = window.__DEVSUITE_MD__?.path ? window.__DEVSUITE_MD__ : null;
export const MD_PREVIEW = window.__DEVSUITE_PREVIEW__ === true;

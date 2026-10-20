// Em qual janela este código roda: a principal (todos os apps) ou uma janela desatachada,
// que o Rust cria com window.__DEVSUITE_APP__ = "<app>" (ver src-tauri/src/app_windows.rs).

/** Apps que podem sair para uma janela própria (Configurações fica sempre na principal). */
export const DETACHABLE = ["tasks", "notes", "http", "json", "db", "rabbit"];

/** App desta janela desatachada, ou null na janela principal. */
export const SOLO_APP = DETACHABLE.includes(window.__DEVSUITE_APP__) ? window.__DEVSUITE_APP__ : null;

export const isSolo = !!SOLO_APP;

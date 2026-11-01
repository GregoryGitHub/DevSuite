// Onde este código roda: app desktop (Tauri) ou navegador (PWA do app "Notas"), e qual edição.

/** App desktop (Tauri): comandos `invoke`, sistema de arquivos, git, cofre. */
export const isTauri = !!window.__TAURI__?.core;

/** Navegador (PWA): armazenamento no IndexedDB, sem cofre/git/arquivos do disco. */
export const isWeb = !isTauri;

/** "notas" = app só de Notas (notes.html, branch notas-pessoal); "suite" = Dev Suite (index.html). */
export const EDITION = document.documentElement.dataset.edition === "notas" ? "notas" : "suite";

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** PWA aberto pela Tela de Início (no iOS, só assim o Safari não apaga os dados após 7 dias sem uso). */
export const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

export const isTouch = matchMedia("(pointer: coarse)").matches;

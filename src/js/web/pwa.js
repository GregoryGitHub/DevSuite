// App Notas no navegador (PWA): service worker (offline + imagens), imagens no IndexedDB,
// armazenamento persistente e o aviso do iOS para instalar na Tela de Início.

import { setImageTarget } from "../utils/noteImages.js";
import { noteImageUrl } from "../utils/noteContent.js";
import { saveWebImage } from "./webNotesApi.js";
import { isIOS, isStandalone } from "../platform.js";
import { el } from "../utils/dom.js";

const BANNER_KEY = "notas-install-dismissed";

/** Imagens coladas/fotografadas vão para o IndexedDB (nome = SHA-256, igual ao desktop). */
export function initWebImages() {
  setImageTarget({
    save: (bytes, ext) => saveWebImage(bytes, ext).then(noteImageUrl),
    copy: async () => {
      throw new Error("Importar imagens do disco só no app desktop.");
    },
  });
}

function installBanner() {
  try {
    if (localStorage.getItem(BANNER_KEY)) return;
  } catch {}
  const close = el("button", { type: "button", title: "Fechar" }, el("i", { class: "fa-solid fa-xmark" }));
  const banner = el(
    "div",
    { class: "pwa-banner", role: "note" },
    el("i", { class: "fa-solid fa-arrow-up-from-bracket" }),
    el("p", {}, "Para usar offline e não perder as notas, toque em Compartilhar e depois em “Adicionar à Tela de Início”. Fora dela, o Safari apaga os dados de sites sem uso há 7 dias."),
    close,
  );
  close.addEventListener("click", () => {
    banner.remove();
    try {
      localStorage.setItem(BANNER_KEY, "1");
    } catch {}
  });
  document.body.append(banner);
}

const LONG_PRESS_MS = 480;
const MOVE_TOLERANCE = 10;

/**
 * Toque longo = clique direito: o Safari do iOS não dispara `contextmenu`, e os menus das
 * notas e pastas (notes.js) abrem nele.
 */
function initLongPress() {
  let timer = null;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return cancel();
      const target = e.target.closest?.("#notes-app .nt-item, #notes-app .nt-folders li");
      if (!target) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, target: e.target };
      cancel();
      timer = setTimeout(() => {
        timer = null;
        navigator.vibrate?.(10);
        start.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, button: 2 }));
        start.fired = true;
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_TOLERANCE) cancel();
    },
    { passive: true },
  );
  document.addEventListener("touchend", (e) => {
    cancel();
    // O menu abriu: o "click" que viria depois do dedo levantar não abre a nota.
    if (start?.fired) e.preventDefault();
    start = null;
  });
  document.addEventListener("touchcancel", cancel, { passive: true });
}

/** Teclado do iOS: a área visível encolhe, mas 100dvh não; a barra de baixo fica acima dele. */
function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
  vv.addEventListener("resize", apply);
  apply();
}

export async function initPwa() {
  initLongPress();
  initViewport();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("service worker:", e));
    // Versão nova publicada: recarrega quando o app sair da tela (não no meio de uma edição).
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) return;
      const reload = () => document.hidden && location.reload();
      document.addEventListener("visibilitychange", reload);
    });
  }
  // Pede para o navegador não apagar o IndexedDB quando faltar espaço.
  navigator.storage?.persist?.().catch(() => {});
  if (isIOS && !isStandalone) installBanner();
}

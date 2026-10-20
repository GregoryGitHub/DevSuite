// Ciclo de vida de cada app quando ele muda de janela (desatachar/reatachar) ou o Dev Suite sai.
// Cada componente registra:
// - flush(): grava já o que estiver pendente (a outra janela vai ler do disco);
// - reload(): relê os dados do disco (a principal, ao receber o app de volta);
// - blocker(): texto explicando por que não dá para mover agora (ex.: consulta rodando), ou null.

const apps = new Map();

export function registerApp(view, hooks) {
  apps.set(view, hooks);
}

export function isRegistered(view) {
  return apps.has(view);
}

export async function flushApp(view) {
  try {
    await apps.get(view)?.flush?.();
  } catch (e) {
    console.error(`flush ${view} failed`, e);
  }
}

export async function reloadApp(view) {
  try {
    await apps.get(view)?.reload?.();
  } catch (e) {
    console.error(`reload ${view} failed`, e);
  }
}

export function detachBlocker(view) {
  return apps.get(view)?.blocker?.() || null;
}

/** Grava as pendências dos apps desta janela (antes de sair do Dev Suite). */
export async function flushAll(filter = () => true) {
  await Promise.all([...apps.keys()].filter(filter).map(flushApp));
}

// Ponte da CLI `devsuite` (src-tauri/src/cli/mod.rs): o Rust recebe o comando pelo named pipe e
// emite "cli-call" para a janela dona do app; aqui o handler roda sobre o estado vivo e a resposta
// volta por `cli_reply` (eventos intermediários por `cli_event`, ex.: linhas do `rabbit watch`).

import { state } from "../state.js";
import { SOLO_APP } from "../windowContext.js";
import { CliError } from "./cliUtils.js";

export { CliError, fold, pick, splitPair, list, requireFlag, iso } from "./cliUtils.js";

const tauri = window.__TAURI__;
const handlers = new Map(); // app -> { comando: fn(params, ctx) }
const running = new Map(); // callId -> ctx

export function registerCli(view, table) {
  handlers.set(view, table);
}

function ownsApp(view) {
  if (SOLO_APP) return SOLO_APP === view;
  return !state.detached.has(view);
}

function errorOf(e) {
  if (e instanceof CliError) return { code: e.code, message: e.message };
  const message = typeof e === "string" ? e : e?.message || String(e);
  return { code: "failed", message };
}

async function handle({ callId, view, method, params }) {
  const invoke = tauri.core.invoke;
  // Eventos em fila: o IPC do Tauri não garante ordem, e a resposta só sai depois deles.
  let events = Promise.resolve(true);
  const ctx = {
    callId,
    cancelled: false,
    onCancel: [],
    /** Evento intermediário; resolve false se o cliente saiu. */
    event: (event) => (events = events.then(() => invoke("cli_event", { callId, event }).catch(() => false))),
  };
  running.set(callId, ctx);
  let reply;
  try {
    if (!ownsApp(view)) throw new CliError("moved", `O app ${view} está em outra janela`);
    const table = handlers.get(view);
    const name = method.slice(view.length + 1);
    const fn = table && Object.hasOwn(table, name) ? table[name] : null;
    if (!fn) throw new CliError("usage", `Comando não suportado: ${method}`);
    const result = await fn(params || {}, ctx);
    reply = { callId, result: result === undefined ? null : result, error: null };
  } catch (e) {
    if (!(e instanceof CliError)) console.error(`cli ${method} failed`, e);
    reply = { callId, result: null, error: errorOf(e) };
  } finally {
    running.delete(callId);
  }
  await events;
  await invoke("cli_reply", reply).catch((e) => console.error("cli_reply failed", e));
}

/** Escuta as chamadas desta janela e avisa o Rust que os handlers estão prontos. */
export async function initCliBridge() {
  if (!tauri?.event) return;
  const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
  await tauri.event.listen("cli-call", (e) => {
    if (label && e.payload?.label !== label) return; // emit_to também chega a quem escuta "qualquer alvo"
    handle(e.payload);
  });
  await tauri.event.listen("cli-cancel", (e) => {
    const ctx = running.get(e.payload?.callId);
    if (!ctx) return;
    ctx.cancelled = true;
    for (const fn of ctx.onCancel) {
      try {
        fn();
      } catch (err) {
        console.error("cli cancel failed", err);
      }
    }
  });
  await tauri.core.invoke("cli_ready");
}

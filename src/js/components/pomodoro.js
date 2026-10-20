import { state } from "../state.js";
import { playChimeSound } from "../utils/audio.js";
import { cardOf, nextPhase, pomoMinutes } from "../utils/kanbanModel.js";

// Motor do Pomodoro dos cards (sem interface própria: o board e a barra de foco ficam em tasks.js).
// O tempo é medido por timestamp (endsAt), não contando ticks: não deriva e continua certo depois
// de a janela ficar oculta/suspensa. Eventos: "pomodorotick" (a cada segundo, só textos/anéis)
// e "pomodorochange" (início, pausa, troca de fase, fim).

const ps = state.pomoState;
let ticker = null;
let save = () => {};

export const PHASE_LABEL = { work: "Foco", break: "Pausa", long: "Pausa longa" };

/** `onSave` grava o documento (o motor altera card.pomo.count/focus_ms). */
export function initPomodoro({ onSave }) {
  save = onSave;
  document.addEventListener("visibilitychange", () => ps.running && tick());
}

const doc = () => state.kanban;
export const pomoCard = () => (ps.cardId != null && doc() ? cardOf(doc(), ps.cardId) : null);
/** O card tem uma sessão (rodando ou pausada). */
export const hasPomo = (id) => ps.cardId === id;
export const isPomoRunning = (id = ps.cardId) => ps.running && ps.cardId === id;

export function pomoRemainingMs() {
  return Math.max(0, ps.running ? ps.endsAt - Date.now() : ps.remainingMs);
}

export function pomoProgress() {
  return ps.totalMs ? 1 - pomoRemainingMs() / ps.totalMs : 0;
}

/** "24:59" */
export function pomoClock(ms = pomoRemainingMs()) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function phaseMs(phase, card) {
  const m = pomoMinutes(doc(), card);
  return (phase === "work" ? m.work : phase === "break" ? m.break : m.long) * 60000;
}

function emit(name) {
  document.dispatchEvent(new CustomEvent(name));
}

/** Soma ao card o foco corrido desde o último registro. */
function commitFocus(now = Date.now()) {
  if (ps.phase !== "work" || !ps.running || !ps.segStart) return;
  const card = pomoCard();
  if (card) card.pomo.focus_ms += Math.max(0, Math.min(now, ps.endsAt) - ps.segStart);
  ps.segStart = now;
}

function setTicker(on) {
  clearInterval(ticker);
  ticker = on ? setInterval(tick, 1000) : null;
}

function run(now = Date.now()) {
  ps.running = true;
  ps.endsAt = now + ps.remainingMs;
  ps.segStart = ps.phase === "work" ? now : 0;
  setTicker(true);
}

function tick() {
  if (!ps.running) return;
  if (ps.endsAt - Date.now() <= 0) finishPhase();
  else emit("pomodorotick");
}

function enterPhase(phase, card, keepRunning) {
  ps.phase = phase;
  ps.totalMs = ps.remainingMs = phaseMs(phase, card);
  ps.running = false;
  ps.segStart = 0;
  if (keepRunning) run();
  else setTicker(false);
}

function finishPhase() {
  const card = pomoCard();
  commitFocus(ps.endsAt);
  if (ps.phase === "work") {
    ps.worksDone++;
    if (card) card.pomo.count++;
  }
  playChimeSound();
  enterPhase(nextPhase(ps.phase, ps.worksDone, doc().pomo), card, doc().pomo.auto_next);
  save();
  emit("pomodorochange");
}

/** Começa uma sessão no card (ou retoma, se a sessão já é dele). */
export function startPomodoro(card) {
  if (ps.cardId === card.id) return resumePomodoro();
  if (ps.cardId != null) stopPomodoro({ silent: true });
  ps.cardId = card.id;
  ps.worksDone = 0;
  enterPhase("work", card, true);
  emit("pomodorochange");
}

export function pausePomodoro() {
  if (!ps.running) return;
  commitFocus();
  ps.remainingMs = pomoRemainingMs();
  ps.running = false;
  ps.segStart = 0;
  setTicker(false);
  save();
  emit("pomodorochange");
}

export function resumePomodoro() {
  if (ps.running || ps.cardId == null) return;
  run();
  emit("pomodorochange");
}

export function togglePomodoro() {
  if (ps.running) pausePomodoro();
  else resumePomodoro();
}

/** Pula para a próxima fase (o foco interrompido conta o tempo, mas não o 🍅). */
export function skipPhase() {
  if (ps.cardId == null) return;
  const wasRunning = ps.running;
  commitFocus();
  enterPhase(nextPhase(ps.phase, ps.worksDone, doc().pomo), pomoCard(), wasRunning);
  save();
  emit("pomodorochange");
}

export function stopPomodoro({ silent = false } = {}) {
  if (ps.cardId == null) return;
  commitFocus();
  setTicker(false);
  Object.assign(ps, { cardId: null, phase: "work", running: false, endsAt: 0, segStart: 0, worksDone: 0 });
  save();
  if (!silent) emit("pomodorochange");
}

/** Minutos alterados com a fase parada e no início: a fase atual passa a ter a nova duração. */
export function refreshPhaseLength() {
  if (ps.cardId == null || ps.running || ps.remainingMs !== ps.totalMs) return;
  ps.totalMs = ps.remainingMs = phaseMs(ps.phase, pomoCard());
  emit("pomodorochange");
}

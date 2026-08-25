import type { AssistantCuriosityHeuristicConfig } from "./types.js";
import type { StoredAssistantCuriosityTriggerState } from "../store.js";

export function windowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export interface HeuristicGateResult {
  pass: boolean;
  reason?:
    | "outside_active_hours"
    | "rate_limited"
    | "chat_too_quiet"
    | "recently_initiated"
    | "awaiting_answer";
}

/**
 * The curiosity trigger's cheap gate: purely resource checks (active-hours
 * window, rate limit, cooldown since the last question, a still-pending
 * unanswered question) with zero judgment about chat content or topic.
 * Whether the assistant has something worth asking is decided only by the
 * LLM call this gate protects (`AssistantCuriosityPort.decide`), mirroring
 * the human-persona trigger's explicit heuristic/judgment split
 * (`src/human-persona-trigger/heuristics.ts`).
 */
export function evaluateCuriosityGate(params: {
  state: StoredAssistantCuriosityTriggerState | undefined;
  config: AssistantCuriosityHeuristicConfig;
  now: Date;
  lastMessageAtMs: number | undefined;
}): HeuristicGateResult {
  const { state, config, now, lastMessageAtMs } = params;
  const nowMs = now.getTime();

  const hour = moscowHour(now);
  if (
    hour < config.activeHourStartMoscow ||
    hour >= config.activeHourEndMoscow
  ) {
    return { pass: false, reason: "outside_active_hours" };
  }

  if (
    lastMessageAtMs !== undefined &&
    nowMs - lastMessageAtMs < config.minSilenceMs
  ) {
    return { pass: false, reason: "chat_too_quiet" };
  }

  if (
    state?.lastInitiatedAtMs != null &&
    nowMs - state.lastInitiatedAtMs < config.minSilenceSinceOwnQuestionMs
  ) {
    return { pass: false, reason: "recently_initiated" };
  }

  if (
    state?.lastAskedMessageId != null &&
    state.lastAskedAnsweredAtMs == null &&
    state.lastInitiatedAtMs != null &&
    nowMs - state.lastInitiatedAtMs < config.pendingAnswerGraceMs
  ) {
    return { pass: false, reason: "awaiting_answer" };
  }

  if (state?.windowStartMs != null) {
    const sameWindow =
      windowStart(nowMs, config.windowMs) === state.windowStartMs;
    if (
      sameWindow &&
      state.initiatedCountInWindow >= config.maxInitiationsPerWindow
    ) {
      return { pass: false, reason: "rate_limited" };
    }
  }

  return { pass: true };
}

function moscowHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  return hour === undefined ? date.getUTCHours() : Number(hour);
}

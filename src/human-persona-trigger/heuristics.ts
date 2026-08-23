import type { HumanPersonaTriggerHeuristicConfig } from "./types.js";
import type { StoredHumanPersonaTriggerState } from "../store.js";

export interface HeuristicGateResult {
  pass: boolean;
  reason?:
    | "outside_active_hours"
    | "rate_limited"
    | "chat_too_quiet"
    | "recently_initiated";
}

/**
 * The trigger-engine's cheap gate (plan Фаза 4e/5 Шаг 4): purely resource
 * checks (active-hours window, rate limit, cooldown since the last
 * initiation) with zero judgment about chat content or topic. Whether the
 * persona has something worth saying is decided only by the LLM call this
 * gate protects (`HumanPersonaTriggerPort.decide`), never by heuristics —
 * that split was an explicit product decision, not an implementation detail.
 */
export function evaluateHeuristicGate(params: {
  state: StoredHumanPersonaTriggerState | undefined;
  config: HumanPersonaTriggerHeuristicConfig;
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
    nowMs - state.lastInitiatedAtMs < config.minSilenceMs
  ) {
    return { pass: false, reason: "recently_initiated" };
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

export function windowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
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

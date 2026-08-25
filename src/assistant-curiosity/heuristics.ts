import type { AssistantCuriosityHeuristicConfig } from "./types.js";
import type { StoredAssistantCuriosityTriggerState } from "../store.js";

export function windowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** Recent-activity window used to estimate how "busy" the chat is right now. */
export const VELOCITY_WINDOW_MS = 15 * 60_000;

/** Busier chats need proportionally more silence before the probability climbs back up. */
const VELOCITY_SENSITIVITY = 2;

export interface HeuristicGateResult {
  pass: boolean;
  reason?:
    | "outside_active_hours"
    | "rate_limited"
    | "recently_initiated"
    | "awaiting_answer"
    | "not_this_time";
  /**
   * The probability that was rolled against for a "quiet enough" decision
   * (present whenever the gate got past the hard checks), so a `false`
   * result stays explainable after the fact — see `not_this_time`.
   */
  probability?: number;
}

/**
 * The curiosity trigger's gate. Hard resource checks (active-hours window,
 * rate limit, cooldown since the last question, a still-pending unanswered
 * question) still block outright -- those exist to cap spend and spam, not
 * to judge whether now is a good moment. "Is now quiet enough" is
 * deliberately *not* a hard cutoff: a chat that is reliably active would
 * then never see a fixed silence threshold and the feature would go dead.
 * Instead it's a probability that climbs smoothly with how long the chat
 * has been quiet and drops with how busy it currently is, rolled once per
 * check -- the same way a person who's interested doesn't wait for total
 * silence to speak up, but is also unlikely to interrupt a lively exchange.
 * Whether the assistant actually has something worth asking is still
 * decided only by the LLM call this gate protects
 * (`AssistantCuriosityPort.decide`), mirroring the human-persona trigger's
 * explicit heuristic/judgment split (`src/human-persona-trigger/heuristics.ts`).
 */
export function evaluateCuriosityGate(params: {
  state: StoredAssistantCuriosityTriggerState | undefined;
  config: AssistantCuriosityHeuristicConfig;
  now: Date;
  lastMessageAtMs: number | undefined;
  /** Message count in the last `VELOCITY_WINDOW_MS` -- a cheap busyness proxy. */
  recentMessageCount: number;
  /** Injectable for tests; defaults to `Math.random`. Must return `[0, 1)`. */
  random?: () => number;
}): HeuristicGateResult {
  const { state, config, now, lastMessageAtMs, recentMessageCount } = params;
  const nowMs = now.getTime();

  const hour = moscowHour(now);
  if (
    hour < config.activeHourStartMoscow ||
    hour >= config.activeHourEndMoscow
  ) {
    return { pass: false, reason: "outside_active_hours" };
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

  const probability = quietProbability({
    config,
    nowMs,
    lastMessageAtMs,
    recentMessageCount,
  });
  const roll = (params.random ?? Math.random)();
  if (roll >= probability) {
    return { pass: false, reason: "not_this_time", probability };
  }
  return { pass: true, probability };
}

/**
 * Climbs from `baseAskProbability` toward `maxAskProbability` as silence
 * since the last message approaches `minSilenceMs` (used here as a scale,
 * not a cutoff), then damped by how busy the chat has been recently -- a
 * quiet moment right after a burst is still less "ripe" than the same
 * silence in a chat that was already calm.
 */
function quietProbability(params: {
  config: AssistantCuriosityHeuristicConfig;
  nowMs: number;
  lastMessageAtMs: number | undefined;
  recentMessageCount: number;
}): number {
  const { config, nowMs, lastMessageAtMs, recentMessageCount } = params;
  const silenceMs =
    lastMessageAtMs === undefined
      ? config.minSilenceMs
      : nowMs - lastMessageAtMs;
  const quietness = Math.min(1, Math.max(0, silenceMs / config.minSilenceMs));
  const velocityPerMin = recentMessageCount / (VELOCITY_WINDOW_MS / 60_000);
  const busynessDamping = 1 / (1 + velocityPerMin * VELOCITY_SENSITIVITY);
  const span = config.maxAskProbability - config.baseAskProbability;
  return config.baseAskProbability + span * quietness * busynessDamping;
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

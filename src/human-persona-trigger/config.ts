import type { HumanPersonaAutonomyMode } from "../store.js";
import type { HumanPersonaTriggerRuntimeConfig } from "./types.js";

const DEFAULT_ACTIVE_HOUR_START = 9;
const DEFAULT_ACTIVE_HOUR_END = 23;
const DEFAULT_MIN_SILENCE_MS = 20 * 60_000;
const DEFAULT_MAX_INITIATIONS_PER_WINDOW = 3;
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Reads `BOT_HUMAN_PERSONA_*` directly from the environment rather than
 * through the central `src/config/` module (`AGENTS.md`'s new-env-key
 * contract governs Telegram connectivity config imported via
 * `src/config.ts`; this mirrors the same feature-scoped precedent
 * `src/digest-cli/options.ts` already sets for `BOT_DIGEST_*`). Returns
 * undefined when persona/chat/target aren't all set, so the sync daemon
 * simply doesn't construct a trigger port -- no persona configured, no
 * behavior change, matching `VectorRag.isConfigured`'s gating shape.
 */
export function loadHumanPersonaTriggerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HumanPersonaTriggerRuntimeConfig | undefined {
  const personaId = env.BOT_HUMAN_PERSONA_ID?.trim();
  const chatId = env.BOT_HUMAN_PERSONA_CHAT_ID?.trim();
  const targetUserKey = env.BOT_HUMAN_PERSONA_TARGET_USER?.trim();
  if (!personaId || !chatId || !targetUserKey) {
    return undefined;
  }

  return {
    personaId,
    chatId,
    targetUserKey,
    chatTitle: env.BOT_HUMAN_PERSONA_CHAT_TITLE?.trim() || chatId,
    autonomyMode: parseAutonomyMode(env.BOT_HUMAN_PERSONA_AUTONOMY_MODE),
    heuristics: {
      activeHourStartMoscow: intEnv(
        env.BOT_HUMAN_PERSONA_ACTIVE_HOUR_START,
        DEFAULT_ACTIVE_HOUR_START,
        0,
        23,
      ),
      activeHourEndMoscow: intEnv(
        env.BOT_HUMAN_PERSONA_ACTIVE_HOUR_END,
        DEFAULT_ACTIVE_HOUR_END,
        1,
        24,
      ),
      minSilenceMs: intEnv(
        env.BOT_HUMAN_PERSONA_MIN_SILENCE_MS,
        DEFAULT_MIN_SILENCE_MS,
        0,
        24 * 60 * 60_000,
      ),
      maxInitiationsPerWindow: intEnv(
        env.BOT_HUMAN_PERSONA_MAX_INITIATIONS_PER_WINDOW,
        DEFAULT_MAX_INITIATIONS_PER_WINDOW,
        0,
        1_000,
      ),
      windowMs: intEnv(
        env.BOT_HUMAN_PERSONA_WINDOW_MS,
        DEFAULT_WINDOW_MS,
        60_000,
        30 * 24 * 60 * 60_000,
      ),
    },
  };
}

/** Approval is the safe default (plan 4c: start supervised, opt into auto later). */
function parseAutonomyMode(
  value: string | undefined,
): HumanPersonaAutonomyMode {
  return value === "auto" ? "auto" : "approval";
}

function intEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Value out of range: must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

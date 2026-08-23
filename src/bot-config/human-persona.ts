import { boundedPlain, telegramId } from "../bot/runtime-config/env-rules.js";
import type { HumanPersonaTriggerRuntimeConfig } from "../human-persona-trigger/types.js";
import type {
  BotDefinitionEntry,
  HumanPersonaBotDefinitionEntry,
} from "./schema.js";

const DEFAULT_ACTIVE_HOUR_START = 9;
const DEFAULT_ACTIVE_HOUR_END = 23;
const DEFAULT_MIN_SILENCE_MS = 20 * 60_000;
const DEFAULT_MAX_INITIATIONS_PER_WINDOW = 3;
const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

export interface SelectedHumanPersona {
  trigger: HumanPersonaTriggerRuntimeConfig;
  approvalChatId: string;
}

/**
 * Filters `BOT_BOTS_CONFIG_PATH` entries down to the `role: "human-persona"`
 * one, if any. Returns `undefined` when no such entry exists -- the role
 * stays opt-in, same as the `BOT_HUMAN_PERSONA_*` scalars it replaces (ADR
 * 0005). Only a single human-persona entry is supported today (Фаза 8);
 * more than one is a config error, not a silent "use the first one".
 */
export function selectHumanPersona(
  entries: readonly BotDefinitionEntry[],
  configPath: string,
): SelectedHumanPersona | undefined {
  const humanPersonaEntries = entries.filter(
    (entry): entry is HumanPersonaBotDefinitionEntry =>
      entry.role === "human-persona",
  );
  if (humanPersonaEntries.length === 0) {
    return undefined;
  }
  if (humanPersonaEntries.length > 1) {
    throw new Error(
      `Bot config file "${configPath}" lists more than one entry with role ` +
        `"human-persona"; only a single human-persona bot is supported today.`,
    );
  }
  const entry = humanPersonaEntries[0]!;
  const fieldLabel = `${configPath}[human-persona]`;

  return {
    trigger: {
      personaId: boundedPlain(entry.personaId, `${fieldLabel}.personaId`, 256),
      chatId: telegramId(entry.chatId, `${fieldLabel}.chatId`, "negative"),
      chatTitle: boundedPlain(entry.chatTitle, `${fieldLabel}.chatTitle`, 160),
      targetUserKey: boundedPlain(
        entry.targetUserKey,
        `${fieldLabel}.targetUserKey`,
        256,
      ),
      autonomyMode: entry.autonomyMode ?? "approval",
      heuristics: {
        activeHourStartMoscow:
          entry.activeHourStart ?? DEFAULT_ACTIVE_HOUR_START,
        activeHourEndMoscow: entry.activeHourEnd ?? DEFAULT_ACTIVE_HOUR_END,
        minSilenceMs: entry.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS,
        maxInitiationsPerWindow:
          entry.maxInitiationsPerWindow ?? DEFAULT_MAX_INITIATIONS_PER_WINDOW,
        windowMs: entry.windowMs ?? DEFAULT_WINDOW_MS,
      },
    },
    approvalChatId: telegramId(
      entry.approvalChatId,
      `${fieldLabel}.approvalChatId`,
      "negative",
    ),
  };
}

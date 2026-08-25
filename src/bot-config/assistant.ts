import { readFileSync } from "node:fs";
import { boundedPersonaPrompt } from "../bot/prompt.js";
import {
  boundedPlain,
  existingAbsoluteFile,
  telegramId,
} from "../bot/runtime-config/env-rules.js";
import type {
  AssistantBotDefinitionEntry,
  BotDefinitionEntry,
} from "./schema.js";

/**
 * Small on purpose (Фаза 4 vision): the operator runs a handful of
 * personally-managed chats, not a multi-tenant fleet. Raising it later is a
 * one-line change, not an architectural one.
 */
export const MAX_ASSISTANT_CHATS = 5;

export interface AssistantCuriosityChatConfig {
  enabled: boolean;
  activeHourStartMoscow: number;
  activeHourEndMoscow: number;
  minSilenceMs: number;
  minSilenceSinceOwnQuestionMs: number;
  maxInitiationsPerWindow: number;
  windowMs: number;
  pendingAnswerGraceMs: number;
  idleIntervalMs: number;
}

/**
 * Conservative so an operator who merely sets `curiosityTrigger.enabled`
 * without tuning every field gets a low-frequency, non-spammy default
 * rather than an aggressive one.
 */
const DEFAULT_CURIOSITY_ACTIVE_HOUR_START = 9;
const DEFAULT_CURIOSITY_ACTIVE_HOUR_END = 23;
const DEFAULT_CURIOSITY_MIN_SILENCE_MS = 30 * 60_000;
const DEFAULT_CURIOSITY_MIN_SILENCE_SINCE_OWN_QUESTION_MS = 6 * 60 * 60_000;
const DEFAULT_CURIOSITY_MAX_INITIATIONS_PER_WINDOW = 2;
const DEFAULT_CURIOSITY_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_CURIOSITY_PENDING_ANSWER_GRACE_MS = 12 * 60 * 60_000;
const DEFAULT_CURIOSITY_IDLE_INTERVAL_MS = 5 * 60_000;

export interface AssistantChatConfig {
  allowedChatId: string;
  chatTitle: string;
  approximateMemberCount?: number;
  personaPrompt: string;
  curiosityTrigger?: AssistantCuriosityChatConfig;
}

/**
 * Filters `BOT_BOTS_CONFIG_PATH` entries down to the `role: "assistant"`
 * ones and resolves each into a ready-to-use chat config, reading its
 * persona prose from `personaPromptPath` (Фаза 6/7 precedent: persona text
 * is a standalone readable document, not inlined JSON).
 */
export function selectAssistantChats(
  entries: readonly BotDefinitionEntry[],
  configPath: string,
): readonly AssistantChatConfig[] {
  const assistantEntries = entries.filter(
    (entry): entry is AssistantBotDefinitionEntry => entry.role === "assistant",
  );

  if (
    assistantEntries.length === 0 ||
    assistantEntries.length > MAX_ASSISTANT_CHATS
  ) {
    throw new Error(
      `Bot config file "${configPath}" must list between 1 and ${MAX_ASSISTANT_CHATS} ` +
        `entries with role "assistant", got ${assistantEntries.length}.`,
    );
  }

  const chats = assistantEntries.map((entry, index) =>
    parseAssistantEntry(entry, index, configPath),
  );

  const seenChatIds = new Set<string>();
  for (const chat of chats) {
    if (seenChatIds.has(chat.allowedChatId)) {
      throw new Error(
        `Bot config file "${configPath}" lists assistant chatId ${chat.allowedChatId} more than once.`,
      );
    }
    seenChatIds.add(chat.allowedChatId);
  }

  return Object.freeze(chats);
}

function parseAssistantEntry(
  entry: AssistantBotDefinitionEntry,
  index: number,
  configPath: string,
): AssistantChatConfig {
  const fieldLabel = `${configPath}[assistant #${index}]`;
  const allowedChatId = telegramId(
    entry.chatId,
    `${fieldLabel}.chatId`,
    "negative",
  );
  const chatTitle = boundedPlain(
    entry.chatTitle,
    `${fieldLabel}.chatTitle`,
    160,
  );
  const personaPromptFilePath = existingAbsoluteFile(
    entry.personaPromptPath,
    `${fieldLabel}.personaPromptPath`,
  );
  let personaPromptSource: string;
  try {
    personaPromptSource = readFileSync(personaPromptFilePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read persona prompt file "${personaPromptFilePath}" referenced from "${configPath}".`,
      { cause: error },
    );
  }
  const personaPrompt = boundedPersonaPrompt(personaPromptSource);

  return {
    allowedChatId,
    chatTitle,
    personaPrompt,
    ...(entry.approximateMemberCount === undefined
      ? {}
      : { approximateMemberCount: entry.approximateMemberCount }),
    ...(entry.curiosityTrigger === undefined
      ? {}
      : { curiosityTrigger: parseCuriosityTrigger(entry.curiosityTrigger) }),
  };
}

function parseCuriosityTrigger(
  curiosityTrigger: NonNullable<
    AssistantBotDefinitionEntry["curiosityTrigger"]
  >,
): AssistantCuriosityChatConfig {
  return {
    enabled: curiosityTrigger.enabled,
    activeHourStartMoscow:
      curiosityTrigger.activeHourStart ?? DEFAULT_CURIOSITY_ACTIVE_HOUR_START,
    activeHourEndMoscow:
      curiosityTrigger.activeHourEnd ?? DEFAULT_CURIOSITY_ACTIVE_HOUR_END,
    minSilenceMs:
      curiosityTrigger.minSilenceMs ?? DEFAULT_CURIOSITY_MIN_SILENCE_MS,
    minSilenceSinceOwnQuestionMs:
      curiosityTrigger.minSilenceSinceOwnQuestionMs ??
      DEFAULT_CURIOSITY_MIN_SILENCE_SINCE_OWN_QUESTION_MS,
    maxInitiationsPerWindow:
      curiosityTrigger.maxInitiationsPerWindow ??
      DEFAULT_CURIOSITY_MAX_INITIATIONS_PER_WINDOW,
    windowMs: curiosityTrigger.windowMs ?? DEFAULT_CURIOSITY_WINDOW_MS,
    pendingAnswerGraceMs:
      curiosityTrigger.pendingAnswerGraceMs ??
      DEFAULT_CURIOSITY_PENDING_ANSWER_GRACE_MS,
    idleIntervalMs:
      curiosityTrigger.idleIntervalMs ?? DEFAULT_CURIOSITY_IDLE_INTERVAL_MS,
  };
}

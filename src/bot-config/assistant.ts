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

export interface AssistantChatConfig {
  allowedChatId: string;
  chatTitle: string;
  approximateMemberCount?: number;
  personaPrompt: string;
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
  };
}

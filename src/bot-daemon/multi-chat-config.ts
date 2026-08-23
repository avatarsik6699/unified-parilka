import { readFileSync } from "node:fs";
import { z } from "zod";
import { boundedPersonaPrompt } from "../bot/prompt.js";
import {
  boundedPlain,
  existingAbsoluteFile,
  requiredPlain,
  telegramId,
} from "../bot/runtime-config/env-rules.js";
import type { BotRuntimeEnvironment } from "../bot/runtime-config.js";

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

const chatEntrySchema = z
  .object({
    chatId: z.string(),
    chatTitle: z.string(),
    personaPromptPath: z.string(),
    approximateMemberCount: z.number().int().positive().optional(),
  })
  .strict();

const multiChatFileSchema = z.array(chatEntrySchema);

/**
 * Reads `BOT_MULTI_CHAT_CONFIG_PATH`: a JSON array of per-chat entries, one
 * per assistant-role chat this process serves. Persona prose lives in its
 * own markdown file per chat (`personaPromptPath`), not inlined in the JSON
 * -- multi-paragraph text in a JSON string needs escaping that a real
 * editor doesn't, and this mirrors the already-accepted pattern of a
 * persona as a standalone readable document (Фаза 6).
 */
export function loadAssistantChatsFromEnv(
  env: BotRuntimeEnvironment,
): readonly AssistantChatConfig[] {
  const configPath = existingAbsoluteFile(
    requiredPlain(env, "BOT_MULTI_CHAT_CONFIG_PATH"),
    "BOT_MULTI_CHAT_CONFIG_PATH",
  );

  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read BOT_MULTI_CHAT_CONFIG_PATH file "${configPath}".`,
      { cause: error },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `BOT_MULTI_CHAT_CONFIG_PATH file "${configPath}" is not valid JSON.`,
      { cause: error },
    );
  }

  const result = multiChatFileSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `BOT_MULTI_CHAT_CONFIG_PATH file "${configPath}" does not match the expected ` +
        `array of {chatId, chatTitle, personaPromptPath, approximateMemberCount?}: ` +
        `${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const entries = result.data;

  if (entries.length === 0 || entries.length > MAX_ASSISTANT_CHATS) {
    throw new Error(
      `BOT_MULTI_CHAT_CONFIG_PATH must list between 1 and ${MAX_ASSISTANT_CHATS} chats, got ${entries.length}.`,
    );
  }

  const chats = entries.map((entry, index) =>
    parseAssistantChatEntry(entry, index, configPath),
  );

  const seenChatIds = new Set<string>();
  for (const chat of chats) {
    if (seenChatIds.has(chat.allowedChatId)) {
      throw new Error(
        `BOT_MULTI_CHAT_CONFIG_PATH file "${configPath}" lists chatId ${chat.allowedChatId} more than once.`,
      );
    }
    seenChatIds.add(chat.allowedChatId);
  }

  return Object.freeze(chats);
}

function parseAssistantChatEntry(
  entry: z.infer<typeof chatEntrySchema>,
  index: number,
  configPath: string,
): AssistantChatConfig {
  const fieldLabel = `BOT_MULTI_CHAT_CONFIG_PATH[${index}]`;
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

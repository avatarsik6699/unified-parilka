import { createHash } from "node:crypto";
import type { StoredMessage } from "../store.js";
import { StyleProfileGenerationError } from "./types.js";

export function renderStyleSource(
  messages: readonly StoredMessage[],
  maxChars: number,
): string {
  const lines: string[] = [];
  let size = 0;
  for (const message of messages) {
    const line = JSON.stringify({
      messageId: message.messageId,
      date: message.date ?? null,
      text: message.text,
    });
    size += line.length + (size === 0 ? 0 : 1);
    if (size > maxChars) {
      throw new StyleProfileGenerationError(
        "input_too_large",
        `Style-profile source contains ${size} characters, above the configured ${maxChars} character limit.`,
      );
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function hashStyleSource(
  personaId: string,
  targetUserKey: string,
  messages: readonly StoredMessage[],
): string {
  const hash = createHash("sha256");
  hash.update("bot-agi/human-persona-style-source/v1\n");
  hash.update(JSON.stringify([personaId, targetUserKey, messages.length]));
  for (const message of messages) {
    hash.update("\n");
    hash.update(
      JSON.stringify([message.messageId, message.date ?? null, message.text]),
    );
  }
  return hash.digest("hex");
}

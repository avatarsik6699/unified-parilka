import type { StoredMessage } from "../store.js";

/**
 * Renders the recent chat tail as bounded NDJSON-like lines, chronological
 * (oldest first) so the model reads it the way a person would scroll it.
 */
export function renderRecentMessages(
  messagesNewestFirst: readonly StoredMessage[],
  maxChars: number,
): string {
  const chronological = [...messagesNewestFirst].reverse();
  const lines: string[] = [];
  let size = 0;
  for (const message of chronological) {
    const line = JSON.stringify({
      messageId: message.messageId,
      date: message.date ?? null,
      sender: message.senderName ?? message.senderId ?? null,
      text: message.text,
    });
    size += line.length + (size === 0 ? 0 : 1);
    if (size > maxChars) {
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function lastMessageTimestampMs(
  messagesNewestFirst: readonly StoredMessage[],
): number | undefined {
  for (const message of messagesNewestFirst) {
    if (!message.date) {
      continue;
    }
    const parsed = Date.parse(message.date);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

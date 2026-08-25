import type { StoredMessage } from "../store.js";

/**
 * Renders the recent chat tail as bounded NDJSON-like lines, chronological
 * (oldest first) so the model reads it the way a person would scroll it.
 * Mirrors `src/human-persona-trigger/render.ts`'s `renderRecentMessages`.
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

/** Counts messages within `windowMs` before `nowMs` -- a cheap busyness proxy for the quiet-probability curve. */
export function countRecentMessages(
  messagesNewestFirst: readonly StoredMessage[],
  windowMs: number,
  nowMs: number,
): number {
  const cutoffMs = nowMs - windowMs;
  let count = 0;
  for (const message of messagesNewestFirst) {
    if (!message.date) {
      continue;
    }
    const parsed = Date.parse(message.date);
    if (Number.isFinite(parsed) && parsed >= cutoffMs) {
      count += 1;
    }
  }
  return count;
}

/** Renders recent topics as a bullet list the decision prompt can tell the model to avoid repeating. */
export function renderAvoidTopics(topics: readonly string[]): string {
  if (topics.length === 0) {
    return "(пока нет — это будет первый вопрос)";
  }
  return topics.map((topic) => `- ${topic}`).join("\n");
}

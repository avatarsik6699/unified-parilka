import { createHash } from "node:crypto";
import type { StoredDayDigest, StoredMessage } from "../store.js";
import { dayStartInstant, isoWeekForDay, nextCalendarDay } from "./calendar.js";
import { DigestGenerationError, type DigestStore } from "./types.js";

export interface WeeklyDigestGroup {
  period: string;
  dayFrom: string;
  dayTo: string;
  digests: StoredDayDigest[];
}

export function renderDaySource(
  messages: readonly StoredMessage[],
  maxChars: number,
): string {
  return mapToBoundedLines(
    messages,
    (message) =>
      JSON.stringify({
        messageId: message.messageId,
        date: message.date ?? null,
        sender: {
          id: message.senderId ?? null,
          name: message.senderName ?? null,
        },
        replyToMessageId: message.replyToMessageId ?? null,
        topicId: message.topicId ?? null,
        text: message.text,
      }),
    maxChars,
  );
}

export function renderWeekSource(
  digests: readonly StoredDayDigest[],
  maxChars: number,
): string {
  return mapToBoundedLines(
    digests,
    (digest) =>
      JSON.stringify({
        day: digest.day,
        messageCount: digest.messageCount,
        sourceHash: digest.sourceHash ?? null,
        digest: digest.text,
      }),
    maxChars,
  );
}

export function messageIdBounds(messages: readonly StoredMessage[]): {
  start: number;
  end: number;
} {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    start = Math.min(start, message.messageId);
    end = Math.max(end, message.messageId);
  }
  if (
    !Number.isSafeInteger(start) ||
    start <= 0 ||
    !Number.isSafeInteger(end) ||
    end < start
  ) {
    throw new Error("Digest source contains invalid message identifiers.");
  }
  return { start, end };
}

export function hashDaySource(
  chatId: string,
  day: string,
  messages: readonly StoredMessage[],
): string {
  const hash = createHash("sha256");
  hash.update("bot-agi/day-source/v1\n");
  hash.update(JSON.stringify([chatId, day, messages.length]));
  for (const message of messages) {
    hash.update("\n");
    hash.update(
      JSON.stringify([
        message.messageId,
        message.date ?? null,
        message.senderId ?? null,
        message.senderName ?? null,
        message.replyToMessageId ?? null,
        message.topicId ?? null,
        message.text,
      ]),
    );
  }
  return hash.digest("hex");
}

export function hashHistoricalDayPrefix(
  chatId: string,
  day: string,
  messages: readonly StoredMessage[],
  storedEndMessageId: number,
): string {
  return hashDaySource(
    chatId,
    day,
    messages.filter(({ messageId }) => messageId <= storedEndMessageId),
  );
}

export function hashWeekSource(
  chatId: string,
  group: WeeklyDigestGroup,
): string {
  const hash = createHash("sha256");
  hash.update("bot-agi/week-source/v1\n");
  hash.update(
    JSON.stringify([
      chatId,
      group.period,
      group.dayFrom,
      group.dayTo,
      group.digests.length,
    ]),
  );
  for (const digest of group.digests) {
    hash.update("\n");
    hash.update(
      JSON.stringify([
        digest.day,
        digest.startMessageId,
        digest.endMessageId,
        digest.messageCount,
        digest.text,
        digest.promptVersion,
        digest.model ?? null,
        digest.sourceHash ?? null,
      ]),
    );
  }
  return hash.digest("hex");
}

export function groupDayDigestsByIsoWeek(
  digests: readonly StoredDayDigest[],
): WeeklyDigestGroup[] {
  const groups = new Map<string, WeeklyDigestGroup>();
  for (const digest of [...digests].sort((left, right) =>
    left.day.localeCompare(right.day),
  )) {
    const week = isoWeekForDay(digest.day);
    const group = groups.get(week.period) ?? {
      period: week.period,
      dayFrom: week.dayFrom,
      dayTo: week.dayTo,
      digests: [],
    };
    group.digests.push(digest);
    groups.set(group.period, group);
  }
  return [...groups.values()].sort((left, right) =>
    left.period.localeCompare(right.period),
  );
}

export function messagesForDay(
  store: DigestStore,
  chatId: string,
  day: string,
): StoredMessage[] {
  return store.getDigestSourceMessages({
    chatId,
    startInclusive: dayStartInstant(day),
    endExclusive: dayStartInstant(nextCalendarDay(day)),
  });
}

function mapToBoundedLines<T>(
  values: readonly T[],
  render: (value: T) => string,
  maxChars: number,
): string {
  const lines: string[] = [];
  let size = 0;
  for (const value of values) {
    const line = render(value);
    size += line.length + (size === 0 ? 0 : 1);
    if (size > maxChars) {
      throw new DigestGenerationError(
        "input_too_large",
        `Digest source contains ${size} characters, above the configured ${maxChars} character limit.`,
      );
    }
    lines.push(line);
  }
  return lines.join("\n");
}

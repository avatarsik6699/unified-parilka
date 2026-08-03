import type { ChatInfo } from "../telegram/types.js";
import { stringify } from "../json.js";
import type { StoredMessage } from "./types.js";

const MAX_ADAPTER_TEXT_CHARS = 2_000_000;
type UnknownRecord = Record<string, unknown>;

export function gramMessageToStored(
  chat: ChatInfo,
  message: unknown,
): StoredMessage | undefined {
  const source = asRecord(message);
  const messageId = numberOrUndefined(source?.id);
  if (messageId == null) {
    return undefined;
  }
  const text = boundedString(
    source?.message ?? source?.text ?? "",
    MAX_ADAPTER_TEXT_CHARS,
  );
  const replyHeader = asRecord(source?.replyTo);
  const date = telegramDate(source?.date);
  const sender = asRecord(source?.sender);
  const rawJson = safeStringify({
    groupedId: safeString(source?.groupedId),
    views: source?.views,
    forwards: source?.forwards,
    post: source?.post,
  });

  return {
    chatId: chat.chatId,
    messageId,
    date,
    senderId: safeString(source?.senderId),
    senderName:
      safeString(sender?.username) ??
      safeString(sender?.firstName) ??
      safeString(sender?.title),
    text,
    replyToMessageId: numberOrUndefined(replyHeader?.replyToMsgId),
    topicId: numberOrUndefined(replyHeader?.topMsgId),
    ...(rawJson === undefined ? {} : { rawJson }),
  };
}

export function numberOrUndefined(value: unknown): number | undefined {
  const parsed = safeNumber(value);
  return parsed != null && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value != null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;
}

function boundedString(value: unknown, maxChars: number): string {
  const stringValue = safeString(value) ?? "";
  return stringValue.length <= maxChars
    ? stringValue
    : stringValue.slice(0, maxChars);
}

function safeString(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

function telegramDate(value: unknown): string | undefined {
  const seconds = safeNumber(value);
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString();
}

function safeStringify(value: unknown): string | undefined {
  try {
    return stringify(value);
  } catch {
    return undefined;
  }
}

function safeNumber(value: unknown): number | undefined {
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

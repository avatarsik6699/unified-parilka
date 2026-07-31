import type { StoredMessage } from "../store.js";
import type {
  ChatInfo,
  TelegramHistoryMessage,
} from "./types.js";

export function telegramMessageToStored(
  chat: ChatInfo,
  message: TelegramHistoryMessage,
): StoredMessage | undefined {
  if (!Number.isSafeInteger(message.messageId) || message.messageId <= 0) {
    return undefined;
  }

  return {
    chatId: chat.chatId,
    messageId: message.messageId,
    date: normalizeIsoDate(message.sentAt),
    senderId: message.sender?.id,
    senderName:
      message.sender?.username || message.sender?.displayName || undefined,
    text: message.text,
    ...(message.textAvailable === false ? { textAvailable: false } : {}),
    replyToMessageId: positiveInteger(message.replyToMessageId),
    topicId: positiveInteger(message.topicId),
    rawJson: JSON.stringify({
      groupedId: message.metadata?.groupedId,
      views: message.metadata?.views,
      forwards: message.metadata?.forwards,
      post: message.isChannelPost,
    }),
  };
}

function normalizeIsoDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value != null && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

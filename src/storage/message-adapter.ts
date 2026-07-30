import type { ChatInfo } from "../telegram/types.js";
import type { StoredMessage } from "./types.js";

export function gramMessageToStored(chat: ChatInfo, message: any): StoredMessage | undefined {
  const messageId = Number(message?.id);
  if (!Number.isFinite(messageId)) {
    return undefined;
  }
  const text = String(message?.message ?? message?.text ?? "");
  const replyHeader = message?.replyTo;
  const date = message?.date ? new Date(Number(message.date) * 1000).toISOString() : undefined;

  return {
    chatId: chat.chatId,
    messageId,
    date,
    senderId: message?.senderId?.toString?.(),
    senderName: message?.sender?.username || message?.sender?.firstName || message?.sender?.title,
    text,
    replyToMessageId: numberOrUndefined(replyHeader?.replyToMsgId),
    topicId: numberOrUndefined(replyHeader?.topMsgId),
    rawJson: JSON.stringify({
      groupedId: message?.groupedId?.toString?.(),
      views: message?.views,
      forwards: message?.forwards,
      post: message?.post,
    }),
  };
}

export function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

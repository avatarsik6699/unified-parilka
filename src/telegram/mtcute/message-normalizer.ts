import type {
  TelegramHistoryMessage,
  TelegramMessageSender,
} from "../types.js";
import type {
  MtcuteMessageSource,
  MtcutePeerSource,
} from "./contracts.js";
import { unsupportedMtcuteMessage } from "./errors.js";

export function normalizeMtcuteMessage(
  message: MtcuteMessageSource,
): TelegramHistoryMessage {
  if (!Number.isSafeInteger(message.id) || message.id <= 0) {
    throw unsupportedMtcuteMessage("History message has an invalid ID.");
  }
  if (typeof message.text !== "string") {
    throw unsupportedMtcuteMessage(
      "History message text is not a string.",
    );
  }
  const sentAt = dateToIso(message.date, "History message date is invalid.");
  const editedAt =
    message.editDate == null
      ? undefined
      : dateToIso(message.editDate, "History message edit date is invalid.");
  const replyToMessageId = positiveIdOrUndefined(message.replyToMessage?.id);
  const topicId =
    positiveIdOrUndefined(message.replyToMessage?.threadId) ??
    (message.replyToMessage?.isForumTopic
      ? positiveIdOrUndefined(message.replyToMessage.id)
      : undefined);

  return {
    messageId: message.id,
    text: message.text,
    ...(message.richMessage == null ? {} : { textAvailable: false }),
    sentAt,
    editedAt,
    sender: normalizeSender(message.sender),
    replyToMessageId,
    topicId,
    isTopicMessage: message.isTopicMessage === true,
    isOutgoing: message.isOutgoing === true,
    isService: message.isService === true,
    isChannelPost: message.isChannelPost === true,
  };
}

function normalizeSender(peer: MtcutePeerSource): TelegramMessageSender {
  if (!Number.isSafeInteger(peer.id)) {
    throw unsupportedMtcuteMessage(
      "History message sender has an invalid ID.",
    );
  }
  const kind =
    peer.type === "user"
      ? peer.isBot
        ? "bot"
        : "user"
      : peer.chatType;
  return {
    id: String(peer.id),
    kind,
    displayName: peer.displayName || undefined,
    username: peer.username || undefined,
  };
}

function positiveIdOrUndefined(
  value: number | null | undefined,
): number | undefined {
  return value != null && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function dateToIso(date: Date, message: string): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw unsupportedMtcuteMessage(message);
  }
  return date.toISOString();
}

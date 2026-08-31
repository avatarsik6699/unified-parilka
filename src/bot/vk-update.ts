import type { MessageContext } from "vk-io";
import type { StoredMessage } from "../store.js";
import type { ChatInfo } from "../telegram/types.js";
import { vkChatId } from "../vk/types.js";
import type { TelegramUpdateReason } from "./telegram-update.js";

export interface VkUpdateOptions {
  /** One entry per assistant-role VK chat this process serves. */
  allowedChatIds: ReadonlySet<string>;
  /** Numeric VK community id (not the peer_id namespacing prefix). */
  groupId: number;
}

export interface NormalizedVkUpdate {
  ingest: boolean;
  addressed: boolean;
  reason: TelegramUpdateReason;
  replyToBot?: boolean;
  /**
   * Synthesized `bot_updates.update_id` for the `transport: "vk"` identity
   * space -- VK's own `message.id` is monotonic per community (confirmed:
   * the Long Poll stream never redelivers the bot's own outgoing sends as
   * `message_new`, so this is incoming-message-only, same shape Telegram's
   * per-bot-token `update_id` counter has).
   */
  updateId?: number;
  chat?: ChatInfo;
  message?: StoredMessage;
}

/**
 * VK community mention marker (`[club<id>|Name]`) is NOT confirmed by any
 * official dev.vk.com page (verified during research) -- this is long-
 * standing, widely observed VK client behavior, kept as a documented
 * assumption, matching the project's existing precedent for VK-side
 * unknowns rather than a guarantee.
 */
function mentionPattern(groupId: number): RegExp {
  return new RegExp(`\\[club${String(groupId)}\\|`, "u");
}

/**
 * Normalizes one vk-io `MessageContext` (from `message_new`/`message_edit`)
 * and classifies whether it may start a turn. Mirrors
 * `normalizeTelegramUpdate`'s contract/shape so both feed the same
 * `BotUpdateProcessor` dedupe/routing path -- see
 * `applyBotUpdatesTransportMigration` for why `updateId` alone is not
 * globally unique once VK is a second transport.
 */
export function normalizeVkUpdate(
  context: MessageContext,
  options: VkUpdateOptions,
): NormalizedVkUpdate {
  const chatId = vkChatId(context.peerId);
  const isEdit = context.subTypes.includes("message_edit");
  const isReply = context.subTypes.includes("message_reply");

  // `message_reply` (the bot's own outgoing sends) is never ingested here:
  // it carries no useful trigger state and, unlike Telegram, VK's Long Poll
  // never delivers the bot's own sends as `message_new` in the first place,
  // so there is no "own_message" filter to apply on the ingest path itself.
  if (isReply) {
    return { ingest: false, addressed: false, reason: "bot_message" };
  }

  if (!options.allowedChatIds.has(chatId)) {
    return { ingest: false, addressed: false, reason: "chat_not_allowed" };
  }

  const messageId = context.id;
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return { ingest: false, addressed: false, reason: "malformed_message" };
  }

  const senderId = String(context.senderId);
  const chat: ChatInfo = {
    chatId,
    requested: chatId,
    kind: "chat",
  };
  const replyToMessageId = context.hasReplyMessage
    ? context.replyMessage?.id
    : undefined;
  const message: StoredMessage = {
    chatId,
    messageId,
    date: vkDate(context.createdAt),
    senderId,
    text: context.text?.trim() ? context.text : mediaPlaceholder(context),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  };

  const base = {
    ingest: true,
    addressed: false,
    updateId: messageId,
    chat,
    message,
  } as const;

  if (isEdit) {
    return { ...base, reason: "edited_message" };
  }

  const replyToBot =
    context.hasReplyMessage && context.replyMessage !== undefined
      ? context.replyMessage.senderId === -options.groupId
      : undefined;

  if (replyToBot === true) {
    return {
      ...base,
      addressed: true,
      reason: "reply_to_bot",
      replyToBot: true,
    };
  }

  const text = context.text ?? "";
  const addressedByCommand = text.trimStart().startsWith("/");
  const addressedByMention = mentionPattern(options.groupId).test(text);
  if (addressedByCommand || addressedByMention) {
    return {
      ...base,
      addressed: true,
      reason: "username_mention",
      ...(replyToBot === undefined ? {} : { replyToBot }),
    };
  }

  return {
    ...base,
    reason: "not_addressed",
    ...(replyToBot === undefined ? {} : { replyToBot }),
  };
}

function vkDate(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  try {
    return new Date(seconds * 1_000).toISOString();
  } catch {
    return undefined;
  }
}

function mediaPlaceholder(context: MessageContext): string {
  if (context.hasAttachments()) {
    return "[вложение]";
  }
  if (context.hasGeo) {
    return "[геопозиция]";
  }
  return "";
}

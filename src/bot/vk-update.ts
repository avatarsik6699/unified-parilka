import type { MessageContext } from "vk-io";
import type { StoredMessage } from "../store.js";
import type { ChatInfo } from "../telegram/types.js";
import type { VkSenderNameCache } from "../vk/sender-name-cache.js";
import { vkChatId, vkSyntheticUpdateId } from "../vk/types.js";
import type { TelegramUpdateReason } from "./telegram-update.js";

export interface VkUpdateOptions {
  /** One entry per assistant-role VK chat this process serves. */
  allowedChatIds: ReadonlySet<string>;
  /** Numeric VK community id (not the peer_id namespacing prefix). */
  groupId: number;
  /**
   * Optional: when present and already warm for this sender, stamps
   * `senderName` on the stored message so keyword_search's sender filter
   * can find it immediately. Absent/cold-cache senders stay unresolved
   * until `VkSenderNameEnrichmentLoop`'s next tick backfills them.
   */
  senderNameCache?: VkSenderNameCache;
}

export interface NormalizedVkUpdate {
  ingest: boolean;
  addressed: boolean;
  reason: TelegramUpdateReason;
  replyToBot?: boolean;
  /**
   * Synthesized `bot_updates.update_id` for the `transport: "vk"` identity
   * space -- see `vkSyntheticUpdateId`: VK's `message.id` is 0 for messages
   * delivered to a community (confirmed empirically, not the monotonic
   * per-community counter this codebase originally assumed), so this is
   * derived from `(peer_id, conversation_message_id)` instead.
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
    // `chat` is included even though `ingest: false` means this is never
    // stored -- only so the rejection log can show which peer_id was
    // rejected (see BotUpdateProcessor#recordPoison), which matters in
    // practice: onboarding a new VK беседа always starts with one rejected
    // message before its peer_id is known.
    return {
      ingest: false,
      addressed: false,
      reason: "chat_not_allowed",
      chat: { chatId, requested: chatId, kind: "chat" },
    };
  }

  // `conversation_message_id`, not `id`: `id` is 0 for messages this
  // community receives (see vkSyntheticUpdateId's doc comment), but
  // conversation_message_id is populated and, scoped to this one peer_id,
  // matches Telegram's own per-chat message_id semantics exactly.
  const messageId = context.conversationMessageId;
  const updateId =
    messageId === undefined
      ? undefined
      : vkSyntheticUpdateId(context.peerId, messageId);
  if (messageId === undefined || updateId === undefined) {
    return { ingest: false, addressed: false, reason: "malformed_message" };
  }

  const senderId = String(context.senderId);
  const chat: ChatInfo = {
    chatId,
    requested: chatId,
    kind: "chat",
  };
  const replyToMessageId = context.hasReplyMessage
    ? context.replyMessage?.conversationMessageId
    : undefined;
  const photo = extractVkPhoto(context);
  const voice = extractVkVoice(context);
  const rawJson = vkAttachmentsRawJson(photo, voice);
  const senderName = options.senderNameCache?.get(senderId);
  const message: StoredMessage = {
    chatId,
    messageId,
    date: vkDate(context.createdAt),
    senderId,
    text: context.text?.trim()
      ? context.text
      : mediaPlaceholder(context, {
          hasPhoto: photo !== undefined,
          hasVoice: voice !== undefined,
        }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    ...(rawJson === undefined ? {} : { rawJson }),
    ...(senderName === undefined ? {} : { senderName }),
  };

  const base = {
    ingest: true,
    addressed: false,
    updateId,
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

function mediaPlaceholder(
  context: MessageContext,
  flags: { hasPhoto: boolean; hasVoice: boolean },
): string {
  if (flags.hasPhoto) {
    return "[фото]";
  }
  if (flags.hasVoice) {
    return "[голосовое]";
  }
  if (context.hasAttachments()) {
    return "[вложение]";
  }
  if (context.hasGeo) {
    return "[геопозиция]";
  }
  return "";
}

const MAX_VK_ATTACHMENT_RAW_CHARS = 4_000;

interface ExtractedVkPhoto {
  url: string;
  width?: number;
  height?: number;
}

interface ExtractedVkVoice {
  url: string;
  mediaType: "audio/ogg" | "audio/mpeg";
  durationSeconds?: number;
}

/**
 * Picks the largest available size of the first photo attachment. Uses
 * `context.getAttachments("photo")` rather than `context.attachments`
 * directly so the result is already narrowed to `PhotoAttachment[]`.
 */
function extractVkPhoto(context: MessageContext): ExtractedVkPhoto | undefined {
  const photo = context.getAttachments("photo")[0];
  if (!photo) {
    return undefined;
  }
  let best: ExtractedVkPhoto | undefined;
  let bestArea = -1;
  for (const size of photo.sizes ?? []) {
    if (typeof size.url !== "string" || size.url.length === 0) {
      continue;
    }
    const area = (size.width ?? 0) * (size.height ?? 0);
    if (area > bestArea) {
      best = { url: size.url, width: size.width, height: size.height };
      bestArea = area;
    }
  }
  if (best) {
    return best;
  }
  const fallbackUrl =
    photo.largeSizeUrl ?? photo.mediumSizeUrl ?? photo.smallSizeUrl;
  return fallbackUrl === undefined
    ? undefined
    : { url: fallbackUrl, width: photo.width, height: photo.height };
}

/**
 * Picks the ogg URL (Telegram-equivalent Opus container Flov already
 * handles) when available, falling back to mp3 -- VK's own voice-message
 * player prefers ogg for the same reason (smaller, native web/mobile
 * support).
 */
function extractVkVoice(context: MessageContext): ExtractedVkVoice | undefined {
  const voice = context.getAttachments("audio_message")[0];
  if (!voice) {
    return undefined;
  }
  const oggUrl = voice.oggUrl;
  const mp3Url = voice.mp3Url;
  const url = oggUrl ?? mp3Url;
  if (url === undefined) {
    return undefined;
  }
  return {
    url,
    mediaType: oggUrl !== undefined ? "audio/ogg" : "audio/mpeg",
    ...(voice.duration === undefined
      ? {}
      : { durationSeconds: voice.duration }),
  };
}

/**
 * Nested under `vkPhoto`/`vkVoice` (never the top-level `photo`/`voice`/
 * `audio`/`video_note` fields Telegram's Bot API uses) so
 * `parseStoredVkPhoto`/`parseStoredVkVoice`/`parseStoredTelegramMedia` never
 * collide over the same `messages.raw_json` column.
 */
function vkAttachmentsRawJson(
  photo: ExtractedVkPhoto | undefined,
  voice: ExtractedVkVoice | undefined,
): string | undefined {
  if (photo === undefined && voice === undefined) {
    return undefined;
  }
  const json = JSON.stringify({
    ...(photo === undefined ? {} : { vkPhoto: photo }),
    ...(voice === undefined ? {} : { vkVoice: voice }),
  });
  return json.length <= MAX_VK_ATTACHMENT_RAW_CHARS ? json : undefined;
}

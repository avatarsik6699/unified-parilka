import type { StoredMessage } from "../store.js";
import type { ChatInfo } from "../telegram/types.js";

export type TelegramUpdateKind = "message" | "edited_message";

export type TelegramUpdateReason =
  | "username_mention"
  | "text_mention"
  | "not_addressed"
  | "edited_message"
  | "own_message"
  | "bot_message"
  | "chat_not_allowed"
  | "malformed_update"
  | "malformed_message"
  | "unsupported_update";

export interface TelegramUpdateOptions {
  allowedChatId: string | number;
  botId: string | number;
  botUsername: string;
}

export interface NormalizedTelegramUpdate {
  /**
   * Whether the message is valid input for the local message store.
   *
   * Edits and bot-authored messages are deliberately ingested even though
   * they can never start an agent turn.
   */
  ingest: boolean;
  addressed: boolean;
  reason: TelegramUpdateReason;
  /** True when the update is a proven reply to a message from the bot. */
  replyToBot?: boolean;
  updateId?: number;
  updateKind?: TelegramUpdateKind;
  chat?: ChatInfo;
  message?: StoredMessage;
}

type JsonObject = Record<string, unknown>;
type MentionReason = Extract<
  TelegramUpdateReason,
  "username_mention" | "text_mention"
>;

interface Sender {
  id?: string;
  name?: string;
  isBot: boolean;
  kind: "user" | "sender_chat" | "unknown";
}

/**
 * Normalizes one grammY/Telegram Bot API Update and classifies whether it may
 * start a turn. The function has no I/O and does not mutate its input.
 */
export function normalizeTelegramUpdate(
  input: unknown,
  options: TelegramUpdateOptions,
): NormalizedTelegramUpdate {
  const allowedChatId = configuredId(options.allowedChatId, "allowedChatId");
  const botId = configuredId(options.botId, "botId");
  const botUsername = normalizeBotUsername(options.botUsername);
  const update = asObject(input);
  const updateId = nonNegativeSafeInteger(update?.update_id);
  const selected = selectMessage(update);

  if (!selected) {
    return compactResult({
      ingest: false,
      addressed: false,
      reason: "unsupported_update",
      updateId,
    });
  }
  if (updateId === undefined) {
    return {
      ingest: false,
      addressed: false,
      reason: "malformed_update",
      updateKind: selected.kind,
    };
  }

  const chat = asObject(selected.message.chat);
  const chatId = telegramId(chat?.id);
  const messageId = positiveSafeInteger(selected.message.message_id);
  if (!chat || !chatId || messageId === undefined) {
    return compactResult({
      ingest: false,
      addressed: false,
      reason: "malformed_message",
      updateId,
      updateKind: selected.kind,
    });
  }

  if (chatId !== allowedChatId) {
    return compactResult({
      ingest: false,
      addressed: false,
      reason: "chat_not_allowed",
      updateId,
      updateKind: selected.kind,
    });
  }

  const sender = senderOf(selected.message);
  const chatInfo = toChatInfo(chat, chatId);
  const storedMessage = toStoredMessage(
    selected.message,
    chatId,
    messageId,
    sender,
  );
  const base = {
    ingest: true,
    addressed: false,
    updateId,
    updateKind: selected.kind,
    chat: chatInfo,
    message: storedMessage,
  } as const;

  // Edited messages update history, but must never replay or create a turn.
  if (selected.kind === "edited_message") {
    return compactResult({ ...base, reason: "edited_message" });
  }

  // sender_chat identifies the actual anonymous/channel sender and takes
  // precedence over Telegram's placeholder `from` user.
  if (sender.kind === "user" && sender.id === botId) {
    return compactResult({ ...base, reason: "own_message" });
  }
  if (sender.isBot) {
    return compactResult({ ...base, reason: "bot_message" });
  }

  // replyToBot is computed only for routable user messages.
  const replyToBot = replyToBotFromReplyToMessage(
    selected.message,
    botId,
  );

  const mention = explicitBotMention(
    selected.message,
    botUsername,
    botId,
  );
  if (mention) {
    return compactResult({
      ...base,
      addressed: true,
      reason: mention,
      ...(replyToBot === undefined ? {} : { replyToBot }),
    });
  }

  return compactResult({
    ...base,
    reason: "not_addressed",
    ...(replyToBot === undefined ? {} : { replyToBot }),
  });
}

function toChatInfo(chat: JsonObject, chatId: string): ChatInfo {
  const kind = firstNonEmptyString(chat.type) ?? "unknown";
  const title = firstNonEmptyString(chat.title);
  const username = firstNonEmptyString(chat.username);
  return {
    chatId,
    requested: chatId,
    kind,
    ...(title === undefined ? {} : { title }),
    ...(username === undefined ? {} : { username }),
    ...(chat.is_forum === true ? { isForum: true } : {}),
  };
}

function selectMessage(
  update: JsonObject | undefined,
):
  | { kind: TelegramUpdateKind; message: JsonObject }
  | undefined {
  if (!update) {
    return undefined;
  }
  const message = asObject(update.message);
  if (message) {
    return { kind: "message", message };
  }
  const editedMessage = asObject(update.edited_message);
  return editedMessage
    ? { kind: "edited_message", message: editedMessage }
    : undefined;
}

function toStoredMessage(
  message: JsonObject,
  chatId: string,
  messageId: number,
  sender: Sender,
): StoredMessage {
  const date = botApiDate(message.date);
  const replyToMessageId = positiveSafeInteger(
    asObject(message.reply_to_message)?.message_id,
  );
  const topicId = positiveSafeInteger(message.message_thread_id);
  const rawJson = safeJson(message);

  return {
    chatId,
    messageId,
    ...(date === undefined ? {} : { date }),
    ...(sender.id === undefined ? {} : { senderId: sender.id }),
    ...(sender.name === undefined ? {} : { senderName: sender.name }),
    text: messageText(message),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    ...(topicId === undefined ? {} : { topicId }),
    ...(rawJson === undefined ? {} : { rawJson }),
  };
}

function senderOf(message: JsonObject): Sender {
  const senderChat = asObject(message.sender_chat);
  if (senderChat) {
    return {
      id: telegramId(senderChat.id),
      name: firstNonEmptyString(senderChat.title, senderChat.username),
      isBot: false,
      kind: "sender_chat",
    };
  }

  const from = asObject(message.from);
  if (!from) {
    return { isBot: false, kind: "unknown" };
  }
  return {
    id: telegramId(from.id),
    name: firstNonEmptyString(from.username, from.first_name),
    isBot: from.is_bot === true,
    kind: "user",
  };
}

/**
 * Type-safe extraction: returns true only when the message is a proven reply
 * to a message authored by the bot. Malformed reply_to_message, missing from,
 * sender_chat, and non-matching sender ids all produce undefined.
 */
function replyToBotFromReplyToMessage(
  message: JsonObject,
  botId: string,
): boolean | undefined {
  const replyToMessage = asObject(message.reply_to_message);
  if (!replyToMessage) {
    return undefined;
  }
  // Only user-level from is trusted; sender_chat in reply_to_message
  // is deliberately ignored.
  const from = asObject(replyToMessage.from);
  if (!from) {
    return undefined;
  }
  const senderId = telegramId(from.id);
  if (senderId === undefined || senderId !== botId) {
    return undefined;
  }
  return true;
}

function explicitBotMention(
  message: JsonObject,
  botUsername: string,
  botId: string,
): MentionReason | undefined {
  const sources = [
    { text: message.text, entities: message.entities },
    { text: message.caption, entities: message.caption_entities },
  ];

  for (const source of sources) {
    if (typeof source.text !== "string" || !Array.isArray(source.entities)) {
      continue;
    }
    for (const candidate of source.entities) {
      const entity = asObject(candidate);
      if (!entity) {
        continue;
      }
      const span = entitySpan(source.text, entity.offset, entity.length);
      if (!span) {
        continue;
      }

      if (
        entity.type === "mention" &&
        span.startsWith("@") &&
        span.slice(1).toLowerCase() === botUsername
      ) {
        return "username_mention";
      }

      if (
        entity.type === "text_mention" &&
        telegramId(asObject(entity.user)?.id) === botId
      ) {
        return "text_mention";
      }
    }
  }
  return undefined;
}

/**
 * Telegram offsets and lengths count UTF-16 code units. JavaScript's slice
 * uses the same unit; explicit boundary checks make malformed entities inert.
 */
function entitySpan(
  text: string,
  rawOffset: unknown,
  rawLength: unknown,
): string | undefined {
  const offset = nonNegativeSafeInteger(rawOffset);
  const length = nonNegativeSafeInteger(rawLength);
  if (
    offset === undefined ||
    length === undefined ||
    length === 0 ||
    offset > text.length ||
    length > text.length - offset
  ) {
    return undefined;
  }
  const end = offset + length;
  if (
    isInsideSurrogatePair(text, offset) ||
    isInsideSurrogatePair(text, end)
  ) {
    return undefined;
  }
  return text.slice(offset, end);
}

function isInsideSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function messageText(message: JsonObject): string {
  let text =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";

  if (text.trim().length === 0) {
    text = mediaPlaceholder(message);
  }
  return text;
}

function mediaPlaceholder(message: JsonObject): string {
  if (present(message.photo)) {
    return "[фото]";
  }

  const sticker = asObject(message.sticker);
  if (sticker) {
    const emoji = firstNonEmptyString(sticker.emoji);
    return emoji ? `[стикер ${emoji}]` : "[стикер]";
  }

  const voice = asObject(message.voice);
  if (voice) {
    const duration = positiveSafeInteger(voice.duration);
    return duration === undefined
      ? "[голосовое]"
      : `[голосовое ${duration}с]`;
  }

  if (present(message.video_note)) {
    return "[кружок]";
  }
  if (present(message.video)) {
    return "[видео]";
  }
  if (present(message.animation)) {
    return "[гифка]";
  }
  if (present(message.document)) {
    return "[файл]";
  }
  if (present(message.audio)) {
    return "[аудио]";
  }
  if (present(message.poll)) {
    return "[опрос]";
  }
  if (present(message.location)) {
    return "[геопозиция]";
  }
  if (present(message.contact)) {
    return "[контакт]";
  }
  if (present(message.new_chat_members)) {
    return "[зашёл в чат]";
  }
  if (present(message.left_chat_member)) {
    return "[вышел из чата]";
  }
  if (present(message.pinned_message)) {
    return "[закрепил сообщение]";
  }
  return "";
}

function configuredId(value: string | number, name: string): string {
  const id = telegramId(value);
  if (!id) {
    throw new TypeError(`${name} must be a Telegram integer id.`);
  }
  return id;
}

function normalizeBotUsername(value: string): string {
  const username = value.trim().replace(/^@/, "").toLowerCase();
  if (!username) {
    throw new TypeError("botUsername must not be empty.");
  }
  return username;
}

function telegramId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return value.replace(/^-?0+(?=\d)/, (zeroes) =>
      zeroes.startsWith("-") ? "-" : "",
    );
  }
  return undefined;
}

function botApiDate(value: unknown): string | undefined {
  const seconds = nonNegativeSafeInteger(value);
  if (seconds === undefined) {
    return undefined;
  }
  const timestamp = seconds * 1_000;
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  const parsed = safeInteger(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = safeInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function compactResult(
  result: NormalizedTelegramUpdate,
): NormalizedTelegramUpdate {
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  ) as unknown as NormalizedTelegramUpdate;
}

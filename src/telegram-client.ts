import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { AppConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { StderrGramJsLogger } from "./gramjs-logger.js";
import type {
  ChatInfo,
  TelegramGateway,
  TelegramHistoryMessage,
  TelegramHistoryRequest,
  TelegramSendRequest,
} from "./telegram/types.js";

export type {
  ChatInfo,
  TelegramGateway,
  TelegramHistoryMessage,
} from "./telegram/types.js";

type ResolvedChat = {
  input: unknown;
  entity: any;
  info: ChatInfo;
};

export class TelegramService implements TelegramGateway {
  private client: TelegramClient | undefined;
  private readonly chatCache = new Map<string, ResolvedChat>();

  constructor(private readonly config: AppConfig) {}

  get isConfigured(): boolean {
    return Boolean(
      this.config.telegram.apiId &&
      this.config.telegram.apiHash &&
      this.config.telegram.session,
    );
  }

  async getClient(): Promise<TelegramClient> {
    if (!this.config.telegram.apiId || !this.config.telegram.apiHash) {
      throw new ToolError({
        category: "auth",
        retryable: false,
        message: "TELEGRAM_API_ID and TELEGRAM_API_HASH are required.",
      });
    }
    if (!this.config.telegram.session) {
      throw new ToolError({
        category: "auth",
        retryable: false,
        message:
          "TELEGRAM_SESSION is missing. Run telegram-bot-agi-mcp-generate-session first.",
      });
    }
    if (this.client) {
      return this.client;
    }

    const session = new StringSession(this.config.telegram.session);
    const client = new TelegramClient(
      session,
      this.config.telegram.apiId,
      this.config.telegram.apiHash,
      telegramClientOptions(this.config) as never,
    );
    await client.connect();
    this.client = client;
    return client;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }
    const client = this.client;
    this.client = undefined;
    // TelegramClient.disconnect() leaves GramJS's update/ping loop alive. The
    // daemon creates a fresh client on the next tick, so using disconnect()
    // leaked one background loop per tick; every leaked loop then printed raw
    // TIMEOUT stacks forever. destroy() terminates the loop and its senders.
    await client.destroy();
  }

  async destroy(): Promise<void> {
    this.chatCache.clear();
    await this.disconnect();
  }

  assertChatAllowed(chat: string): void {
    if (!this.config.telegram.requireAllowlistedChat) {
      return;
    }
    const allowed = new Set(
      this.config.telegram.allowedChatIds.map(normalizeChatRef),
    );
    if (!allowed.has(normalizeChatRef(chat))) {
      throw new ToolError({
        category: "permission",
        retryable: false,
        message: `Chat ${chat} is not in TELEGRAM_ALLOWED_CHAT_IDS.`,
      });
    }
  }

  async resolveChat(chat?: string, refresh = false): Promise<ResolvedChat> {
    const requested = chat?.trim() || this.config.telegram.defaultChatId;
    this.assertChatAllowed(requested);
    const cacheKey = normalizeChatRef(requested);
    if (!refresh && this.chatCache.has(cacheKey)) {
      return this.chatCache.get(cacheKey)!;
    }

    const client = await this.getClient();
    const peer = coercePeer(requested);
    const input = await client.getInputEntity(peer as never);
    const entity = await client.getEntity(input as never);
    const info = entityToChatInfo(entity, requested);
    this.assertChatAllowed(info.chatId);
    const resolved = { input, entity, info };
    this.chatCache.set(cacheKey, resolved);
    this.chatCache.set(normalizeChatRef(info.chatId), resolved);
    return resolved;
  }

  async sendMessage(
    params: TelegramSendRequest,
  ): Promise<{ id?: number; chat: ChatInfo }> {
    const resolved = await this.resolveChat(params.chat);
    const client = await this.getClient();
    const sent = await client.sendMessage(
      resolved.input as never,
      {
        message: params.text,
        replyTo: params.replyToMessageId ?? params.topicId,
        parseMode: params.parseMode === "none" ? false : params.parseMode,
        linkPreview: params.linkPreview,
        silent: params.silent,
      } as never,
    );
    return {
      id: positiveSafeInteger(readProperty(sent, "id")),
      chat: resolved.info,
    };
  }

  async getMessages(
    params: TelegramHistoryRequest,
  ): Promise<{ chat: ChatInfo; messages: TelegramHistoryMessage[] }> {
    const resolved = await this.resolveChat(params.chat);
    const client = await this.getClient();
    const options: Record<string, unknown> = { limit: params.limit };
    setIfDefined(options, "offsetId", params.offsetId);
    setIfDefined(options, "minId", params.minId);
    setIfDefined(options, "maxId", params.maxId);
    setIfDefined(options, "ids", params.ids);
    const messages = await client.getMessages(
      resolved.input as never,
      options as never,
    );
    return {
      chat: resolved.info,
      messages: Array.from(messages as Iterable<unknown>)
        .map(gramMessageToTelegramHistory)
        .filter(
          (message): message is TelegramHistoryMessage => message != null,
        ),
    };
  }

  async iterateMessages(
    params: Omit<TelegramHistoryRequest, "ids">,
  ): Promise<{
    chat: ChatInfo;
    messages: AsyncIterable<TelegramHistoryMessage>;
  }> {
    const resolved = await this.resolveChat(params.chat);
    const client = await this.getClient();
    const options: Record<string, unknown> = { limit: params.limit };
    setIfDefined(options, "offsetId", params.offsetId);
    setIfDefined(options, "minId", params.minId);
    setIfDefined(options, "maxId", params.maxId);
    const messages = client.iterMessages(
      resolved.input as never,
      options as never,
    ) as AsyncIterable<unknown>;

    return {
      chat: resolved.info,
      messages: normalizeGramMessageStream(messages),
    };
  }
}

export function gramMessageToTelegramHistory(
  message: unknown,
): TelegramHistoryMessage | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const messageId = positiveSafeInteger(message.id);
  const kind = classNameOf(message);
  if (
    messageId == null ||
    kind.toLowerCase().includes("empty") ||
    message.deleted === true
  ) {
    return undefined;
  }

  const replyHeader = isRecord(message.replyTo) ? message.replyTo : undefined;
  const sender = isRecord(message.sender) ? message.sender : undefined;
  const senderKind = sender ? classNameOf(sender) : "";
  const senderId = stringifyIdentifier(message.senderId ?? sender?.id);
  const senderDisplayName = firstNonEmptyString(
    sender?.firstName,
    sender?.lastName,
    sender?.title,
  );
  const senderUsername = nonEmptyString(sender?.username);

  return {
    messageId,
    text: textValue(message.message ?? message.text),
    sentAt: isoDate(message.date),
    editedAt: isoDate(message.editDate),
    sender:
      senderId || senderDisplayName || senderUsername || senderKind
        ? {
            id: senderId,
            kind: senderKind || "Unknown",
            displayName: senderDisplayName,
            username: senderUsername,
          }
        : undefined,
    replyToMessageId: positiveSafeInteger(replyHeader?.replyToMsgId),
    topicId: positiveSafeInteger(replyHeader?.topMsgId),
    isTopicMessage:
      message.forumTopic === true || replyHeader?.forumTopic === true,
    isOutgoing: message.out === true,
    isService: kind.toLowerCase().includes("service"),
    isChannelPost: message.post === true,
    metadata: {
      groupedId: stringifyIdentifier(message.groupedId),
      views: finiteNumber(message.views),
      forwards: finiteNumber(message.forwards),
    },
  };
}

export function telegramClientOptions(
  config: AppConfig,
): Record<string, unknown> {
  return {
    connectionRetries: config.telegram.connectionRetries,
    floodSleepThreshold: config.sync.floodWaitMaxSleepSec,
    baseLogger: new StderrGramJsLogger(),
  };
}

function setIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value != null) {
    target[key] = value;
  }
}

async function* normalizeGramMessageStream(
  messages: AsyncIterable<unknown>,
): AsyncIterable<TelegramHistoryMessage> {
  for await (const message of messages) {
    const normalized = gramMessageToTelegramHistory(message);
    if (normalized) {
      yield normalized;
    }
  }
}

export function normalizeChatRef(chat: string): string {
  const trimmed = chat.trim();
  if (trimmed.startsWith("@")) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

function coercePeer(chat: string): string | bigint {
  const trimmed = chat.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  return trimmed;
}

function entityToChatInfo(entity: any, requested: string): ChatInfo {
  const kind = entity?.className || entity?.constructor?.name || "Unknown";
  const rawId = entity?.id?.toString?.() ?? String(entity?.id ?? requested);
  let chatId = rawId;
  if (kind === "Channel" && !rawId.startsWith("-100")) {
    chatId = `-100${rawId}`;
  } else if (kind === "Chat" && !rawId.startsWith("-")) {
    chatId = `-${rawId}`;
  }

  return {
    chatId,
    requested,
    title: entity?.title,
    username: entity?.username,
    kind,
    canSendMessages: entity?.defaultBannedRights?.sendMessages !== true,
    isForum: Boolean(entity?.forum),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function readProperty(value: unknown, property: string): unknown {
  return isRecord(value) ? value[property] : undefined;
}

function classNameOf(value: Record<string, unknown>): string {
  const explicit = nonEmptyString(value.className);
  if (explicit) {
    return explicit;
  }
  const constructor = value.constructor;
  return typeof constructor === "function" && constructor.name
    ? constructor.name
    : "Unknown";
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringifyIdentifier(value: unknown): string | undefined {
  if (typeof value === "bigint" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return nonEmptyString(value);
  }
  if (isRecord(value) && typeof value.toString === "function") {
    const rendered = value.toString();
    return rendered === "[object Object]"
      ? undefined
      : nonEmptyString(rendered);
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  const parts = values
    .map(nonEmptyString)
    .filter((value): value is string => value != null);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isoDate(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    const milliseconds =
      Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }
  return undefined;
}

import type { VK } from "vk-io";
import type { ChatInfo } from "../telegram/types.js";
import type { StoredMessage, SyncState } from "../store.js";
import type { JsonEventLogger } from "../bot/worker.js";

/**
 * VK's own `messages.getHistory` page cap.
 * (dev.vk.com/en/method/messages.getHistory)
 */
const DEFAULT_PAGE_SIZE = 200;
/** One page per chat per tick keeps this well under VK's ~3 req/s per-token
 * limit without any bespoke pacing logic -- the tick interval alone paces
 * it. */
const DEFAULT_TICK_INTERVAL_MS = 60_000;

export interface VkHistoryMessage {
  conversationMessageId: number;
  /** Unix seconds; absent/invalid values are stored with no date. */
  date?: number;
  fromId: number;
  text: string;
  hasAttachments: boolean;
  replyConversationMessageId?: number;
}

export interface VkHistoryPort {
  /** One page, newest-first within the page, starting `offset` messages
   * back from the most recent. Empty result means the beседа's start was
   * reached. */
  getHistory(params: {
    peerId: number;
    count: number;
    offset: number;
  }): Promise<readonly VkHistoryMessage[]>;
}

export interface VkHistoryBackfillChat {
  chatId: string;
  /**
   * The beседа's `peer_id` as seen by the *personal* account behind
   * `BOT_VK_USER_TOKEN` -- NOT the same number as `chatId`'s own
   * `vk:<peer_id>` (that one is the community/group token's view).
   * Confirmed directly against the live API that these can differ for the
   * very same beседа; see `AssistantChatConfig.vkHistoryPeerId`'s doc
   * comment (`src/bot-config/assistant.ts`) for the incident that made
   * this an explicit, separately-configured field rather than an assumed
   * equality.
   */
  peerId: number;
  chatTitle: string;
}

export interface VkHistoryBackfillStore {
  getSyncState(chatId: string): SyncState | undefined;
  updateSyncState(
    chat: ChatInfo,
    state: {
      oldestMessageId?: number;
      newestMessageId?: number;
      nextBackfillOffsetId?: number;
      syncedCount: number;
      mode?: "recent" | "backfill" | "manual";
      error?: string | null;
    },
  ): void;
  setBackfillExhausted(chat: ChatInfo, exhausted: boolean): void;
  upsertMessages(chat: ChatInfo, messages: StoredMessage[]): number;
}

export interface VkHistoryBackfillTickReport {
  chatId: string;
  status: "progress" | "exhausted" | "already_exhausted" | "error";
  fetched?: number;
  saved?: number;
  error?: string;
}

/**
 * One bounded page of one VK chat's pre-join history. Reuses the same
 * `sync_state` row Telegram's own backfill uses (`nextBackfillOffsetId`
 * doubling here as VK's `offset` cursor, `syncedCount` as the running total
 * against `totalLimit`) -- both are already chatId-scoped and already
 * min/max-merge correctly across ticks, so no VK-specific storage was
 * needed for this.
 */
export async function runVkHistoryBackfillTick(options: {
  store: VkHistoryBackfillStore;
  port: VkHistoryPort;
  chat: VkHistoryBackfillChat;
  pageSize?: number;
  totalLimit: number;
}): Promise<VkHistoryBackfillTickReport> {
  const { store, port, chat } = options;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const chatInfo: ChatInfo = {
    chatId: chat.chatId,
    requested: chat.chatId,
    kind: "chat",
    title: chat.chatTitle,
  };

  const state = store.getSyncState(chat.chatId);
  if (state?.backfillExhaustedAt !== undefined) {
    return { chatId: chat.chatId, status: "already_exhausted" };
  }

  const alreadySynced = state?.syncedCount ?? 0;
  const remaining = options.totalLimit - alreadySynced;
  if (remaining <= 0) {
    store.setBackfillExhausted(chatInfo, true);
    return { chatId: chat.chatId, status: "exhausted", fetched: 0 };
  }
  const offset = state?.nextBackfillOffsetId ?? 0;
  const count = Math.min(pageSize, remaining);

  let items: readonly VkHistoryMessage[];
  try {
    items = await port.getHistory({ peerId: chat.peerId, count, offset });
  } catch (error) {
    return {
      chatId: chat.chatId,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (items.length === 0) {
    store.setBackfillExhausted(chatInfo, true);
    return { chatId: chat.chatId, status: "exhausted", fetched: 0 };
  }

  const messages = items.map((item) => toStoredMessage(chat.chatId, item));
  const saved = store.upsertMessages(chatInfo, messages);
  const minId = Math.min(...items.map((item) => item.conversationMessageId));
  const nextOffset = offset + items.length;
  const syncedCount = alreadySynced + items.length;
  const exhausted = items.length < count || syncedCount >= options.totalLimit;

  store.updateSyncState(chatInfo, {
    oldestMessageId: minId,
    ...(exhausted ? {} : { nextBackfillOffsetId: nextOffset }),
    syncedCount,
    mode: "backfill",
  });
  if (exhausted) {
    store.setBackfillExhausted(chatInfo, true);
  }

  return {
    chatId: chat.chatId,
    status: exhausted ? "exhausted" : "progress",
    fetched: items.length,
    saved,
  };
}

function toStoredMessage(
  chatId: string,
  item: VkHistoryMessage,
): StoredMessage {
  const text = item.text.trim()
    ? item.text
    : item.hasAttachments
      ? "[вложение]"
      : "";
  return {
    chatId,
    messageId: item.conversationMessageId,
    ...(item.date === undefined ? {} : { date: vkDate(item.date) }),
    senderId: String(item.fromId),
    text,
    ...(item.replyConversationMessageId === undefined
      ? {}
      : { replyToMessageId: item.replyConversationMessageId }),
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

/**
 * Adapts a personal-account `VK` client (never the community/group one --
 * see `createVkUserClient`) to `VkHistoryPort` via raw `messages.getHistory`.
 * vk-io's own typings return a bare array for this call rather than a typed
 * `MessagesMessage[]`, so each item is read defensively.
 */
export function createVkHistoryBackfillPort(vk: VK): VkHistoryPort {
  return {
    async getHistory({ peerId, count, offset }) {
      const response = await vk.api.messages.getHistory({
        peer_id: peerId,
        count,
        offset,
        rev: 0,
      });
      const items = Array.isArray((response as { items?: unknown }).items)
        ? (response as { items: unknown[] }).items
        : [];
      return items
        .map(readHistoryMessage)
        .filter((item): item is VkHistoryMessage => item !== undefined);
    },
  };
}

function readHistoryMessage(value: unknown): VkHistoryMessage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const conversationMessageId = record.conversation_message_id;
  const fromId = record.from_id;
  if (
    typeof conversationMessageId !== "number" ||
    !Number.isSafeInteger(conversationMessageId) ||
    conversationMessageId <= 0 ||
    typeof fromId !== "number" ||
    !Number.isSafeInteger(fromId)
  ) {
    return undefined;
  }
  const text = typeof record.text === "string" ? record.text : "";
  const date = typeof record.date === "number" ? record.date : undefined;
  const attachments = record.attachments;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const replyMessage = record.reply_message;
  const replyConversationMessageId =
    typeof replyMessage === "object" &&
    replyMessage !== null &&
    typeof (replyMessage as Record<string, unknown>).conversation_message_id ===
      "number"
      ? ((replyMessage as Record<string, unknown>)
          .conversation_message_id as number)
      : undefined;
  return {
    conversationMessageId,
    fromId,
    text,
    hasAttachments,
    ...(date === undefined ? {} : { date }),
    ...(replyConversationMessageId === undefined
      ? {}
      : { replyConversationMessageId }),
  };
}

export interface VkHistoryBackfillLoopOptions {
  store: VkHistoryBackfillStore;
  port: VkHistoryPort;
  /** One entry per `transport: "vk"` chat this process serves. */
  chats: readonly VkHistoryBackfillChat[];
  totalLimit: number;
  pageSize?: number;
  tickIntervalMs?: number;
  logger?: JsonEventLogger;
  onTick?: (report: VkHistoryBackfillTickReport) => void;
}

/**
 * Small standalone interval loop, run concurrently with the live bot inside
 * `BotApiRuntime` -- same shape as `CuriosityTriggerLoop`
 * (`src/assistant-curiosity-loop.ts`): one pass over every configured chat,
 * then sleep. Once every chat is exhausted, each pass is a cheap no-op
 * `getSyncState` read per chat; the loop is not worth stopping outright for
 * that.
 */
export class VkHistoryBackfillLoop {
  readonly #options: VkHistoryBackfillLoopOptions;
  readonly #tickIntervalMs: number;
  #running = false;

  constructor(options: VkHistoryBackfillLoopOptions) {
    this.#options = options;
    this.#tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) {
      throw new Error("VkHistoryBackfillLoop is already running.");
    }
    if (this.#options.chats.length === 0) {
      return;
    }
    this.#running = true;
    try {
      while (!signal.aborted) {
        for (const chat of this.#options.chats) {
          if (signal.aborted) {
            break;
          }
          const report = await runVkHistoryBackfillTick({
            store: this.#options.store,
            port: this.#options.port,
            chat,
            totalLimit: this.#options.totalLimit,
            ...(this.#options.pageSize === undefined
              ? {}
              : { pageSize: this.#options.pageSize }),
          });
          this.#options.onTick?.(report);
          this.#log(report);
        }
        await abortableSleep(this.#tickIntervalMs, signal);
      }
    } finally {
      this.#running = false;
    }
  }

  #log(report: VkHistoryBackfillTickReport): void {
    try {
      this.#options.logger?.info({
        event: "vk.history_backfill.tick",
        chatId: report.chatId,
        status: report.status,
        ...(report.fetched === undefined ? {} : { fetched: report.fetched }),
        ...(report.saved === undefined ? {} : { saved: report.saved }),
        ...(report.error === undefined ? {} : { error: report.error }),
      });
    } catch {
      // Logging is best-effort.
    }
  }
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

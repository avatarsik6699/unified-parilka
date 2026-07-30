import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppConfig } from "../src/config.js";
import { MessageStore } from "../src/store.js";
import { TelegramTools } from "../src/tools.js";
import type {
  ChatInfo,
  TelegramHistoryMessage,
  TelegramService,
} from "../src/telegram-client.js";

export type ToolPayload = Record<string, unknown> & { ok: boolean };

export class FakeTelegram {
  sends: Array<Record<string, unknown>> = [];
  getMessageCalls: Array<Record<string, unknown>> = [];
  missingMessageIds = new Set<number>();
  deletedMessageIds = new Set<number>();
  replyTexts = new Map<number, string>();
  failNextSend: Error | undefined;
  onSend: ((callNumber: number, params: Record<string, unknown>) => Promise<void> | void) | undefined;

  get isConfigured(): boolean {
    return true;
  }

  async resolveChat(chat?: string): Promise<{ info: ChatInfo }> {
    const chatId = chat?.trim() || "-1001";
    return {
      info: {
        chatId,
        requested: chatId,
        kind: "Fake",
      },
    };
  }

  async getMessages(params: { chat?: string; ids?: number | number[]; limit: number }): Promise<{ chat: ChatInfo; messages: TelegramHistoryMessage[] }> {
    this.getMessageCalls.push(params as Record<string, unknown>);
    const chatId = String(params.chat ?? "-1001");
    const ids = Array.isArray(params.ids) ? params.ids : params.ids == null ? [] : [params.ids];
    return {
      chat: {
        chatId,
        requested: chatId,
        kind: "Fake",
      },
      messages: ids.flatMap((id) => {
        if (this.missingMessageIds.has(id)) {
          return [];
        }
        if (this.deletedMessageIds.has(id)) {
          return [];
        }
        return [
          {
            messageId: id,
            text: this.replyTexts.get(id) ?? `reply target ${id}`,
            sentAt: new Date(1_700_000_000 * 1_000).toISOString(),
            sender: {
              id: "42",
              kind: "User",
              username: "reply_author",
            },
            isTopicMessage: false,
            isOutgoing: false,
            isService: false,
            isChannelPost: false,
          },
        ];
      }),
    };
  }

  async sendMessage(params: Record<string, unknown>): Promise<{ id: number; chat: ChatInfo }> {
    this.sends.push(params);
    const callNumber = this.sends.length;
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      throw error;
    }
    await this.onSend?.(callNumber, params);
    const chatId = String(params.chat ?? "-1001");
    return {
      id: 9000 + callNumber,
      chat: {
        chatId,
        requested: chatId,
        kind: "Fake",
      },
    };
  }
}

export function makeTools(
  telegram: FakeTelegram,
  options: {
    dbPath?: string;
    safety?: Partial<AppConfig["safety"]>;
    throttle?: Partial<AppConfig["throttle"]>;
  } = {},
): { tools: TelegramTools; store: MessageStore } {
  const store = new MessageStore(options.dbPath ?? ":memory:");
  const tools = new TelegramTools(
    {
      telegram: {
        apiId: 1,
        apiHash: "hash",
        session: "session",
        phone: "",
        defaultChatId: "-1001",
        allowedChatIds: ["-1001", "-1002"],
        requireAllowlistedChat: true,
        connectionRetries: 1,
      },
      storage: {
        dbPath: ":memory:",
      },
      safety: {
        sendEnabled: true,
        dryRunDefault: false,
        maxSendChars: 4096,
        liveSendApprovalTtlMs: 60_000,
        liveSendApprovalBypass: false,
        ...options.safety,
      },
      sync: {
        batchSize: 100,
        maxSyncLimit: 500_000,
        floodWaitMaxSleepSec: 10,
        historyWaitTimeSec: 1,
        historyOperationTimeoutMs: 120_000,
        intervalMs: 60_000,
        recentLimit: 300,
        backfillLimit: 1000,
        transientBackoffInitialMs: 5_000,
        transientBackoffMaxMs: 300_000,
      },
      embeddings: {
        enabled: false,
        apiKey: "",
        baseUrl: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        dimensions: 256,
        apiBatchSize: 64,
        requestTimeoutMs: 60_000,
        maxRetries: 2,
        retryInitialMs: 0,
        retryMaxMs: 30_000,
        tickIntervalMs: 60_000,
        tickBudgetMs: 30_000,
        chunkMessages: 12,
        chunkOverlapMessages: 0,
        chunkMaxChars: 1600,
        tickChunkLimit: 100,
        maxChunksPerRun: 1000,
        maxCharsPerRun: 500_000,
        vectorCandidateLimit: 20_000,
        searchLimit: 12,
      },
      throttle: {
        userCooldownMs: 0,
        maxPendingPerUserPerChat: 10,
        maxQueuePerChat: 25,
        maxAgeMs: 120_000,
        globalConcurrency: 2,
        maxRunningPerChat: 1,
        ...options.throttle,
      },
    },
    telegram as unknown as TelegramService,
    store,
  );
  return { tools, store };
}

export async function callTool(tools: TelegramTools, name: string, args: unknown): Promise<ToolPayload> {
  const result = await tools.callTool(name, args);
  return JSON.parse(result.content[0]!.text) as ToolPayload;
}

export function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-parilka-mcp-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}

export async function waitForSendOutbox(store: MessageStore, dedupeKey: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const item = store.getSendOutboxByDedupeKey(dedupeKey);
    if (item) {
      return item;
    }
    await sleep(5);
  }
  throw new Error(`Timed out waiting for send outbox row ${dedupeKey}`);
}

export function seedSend(
  store: MessageStore,
  status: "queued" | "sending" | "sent" | "failed" | "expired",
  dedupeKey: string,
  error?: string,
): string {
  const reservation = store.reserveSend({
    outboxId: `seed/${dedupeKey}`,
    dedupeKey,
    payloadHash: "payload/hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 1000,
    maxAgeMs: 60_000,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 100,
    maxQueuePerChat: 100,
  });
  assert.equal(reservation.kind, "queued");
  if (status === "sending" || status === "sent") {
    assert.equal(store.markSendSending(reservation.outboxId, 1001), true);
  }
  if (status === "sent") {
    assert.equal(store.markSendSent(reservation.outboxId, 9001, 1002), true);
  } else if (status === "failed") {
    assert.equal(store.markSendFailed(reservation.outboxId, error ?? "failed", 1002), true);
  } else if (status === "expired") {
    assert.equal(store.markSendExpired(reservation.outboxId, error ?? "expired", 1002), true);
  }
  return reservation.outboxId;
}

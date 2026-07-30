import assert from "node:assert/strict";
import type { AppConfig } from "../../src/config.js";
import { embeddingNamespace, vectorToBlob } from "../../src/embeddings.js";
import { MessageStore } from "../../src/store.js";
import { TelegramTools } from "../../src/tools.js";
import type { ChatInfo, TelegramService } from "../../src/telegram-client.js";

export const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

export class FakeTelegram {
  get isConfigured(): boolean {
    return true;
  }

  assertChatAllowed(): void {
    return;
  }

  async resolveChat(): Promise<{ info: ChatInfo }> {
    return { info: CHAT };
  }

  async iterateMessages(): Promise<{ chat: ChatInfo; messages: AsyncIterable<Record<string, unknown>> }> {
    return {
      chat: CHAT,
      messages: (async function* () {
        throw new Error("simulated sync failure");
      })(),
    };
  }
}

export function makeTools(store = new MessageStore(":memory:"), appConfig = config()): TelegramTools {
  return new TelegramTools(appConfig, new FakeTelegram() as unknown as TelegramService, store);
}

export function config(): AppConfig {
  return {
    telegram: {
      apiId: 1,
      apiHash: "hash",
      session: "session",
      phone: "",
      defaultChatId: CHAT.chatId,
      allowedChatIds: [CHAT.chatId],
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
    },
  };
}

export function configuredEmbeddingsConfig(embeddings: Partial<AppConfig["embeddings"]> = {}): AppConfig {
  const cfg = config();
  cfg.embeddings = {
    ...cfg.embeddings,
    enabled: true,
    apiKey: "test-key",
    dimensions: 2,
    maxRetries: 0,
    ...embeddings,
  };
  return cfg;
}

export function addEmbeddingChunk(
  store: MessageStore,
  cfg: AppConfig,
  params: { messageIds: number[]; text: string; vector: number[] },
): void {
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: Math.min(...params.messageIds),
      endMessageId: Math.max(...params.messageIds),
      messageIds: params.messageIds,
      messageCount: params.messageIds.length,
      text: params.text,
      namespace: embeddingNamespace(cfg),
      model: cfg.embeddings.model,
      dimensions: cfg.embeddings.dimensions ?? params.vector.length,
      embedding: vectorToBlob(params.vector),
      contentHash: `test-${params.messageIds.join("-")}`,
    },
  ]);
}

export function assertCanonicalSearchCounts(result: Record<string, unknown>): void {
  const hybrid = result.hybrid as { count: number; raw_candidate_count: number; hits: unknown[] };
  const keyword = result.keyword as { count: number };
  const vector = result.vector as { hits: unknown[] };
  const results = result.results as unknown[];

  assert.equal(hybrid.count, hybrid.hits.length);
  assert.equal(hybrid.raw_candidate_count, keyword.count + vector.hits.length);
  assert.equal(result.result_count, results.length);
  assert.deepEqual(results, hybrid.hits);
}

export function assertVectorDegraded(result: Record<string, unknown>, reason: RegExp): void {
  const degraded = result.degraded_channels as Array<{ channel: string; reason: string }>;
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0]?.channel, "vector");
  assert.match(degraded[0]?.reason ?? "", reason);
  assert.deepEqual(result.partial_failure, { degraded_channels: degraded });
}

export function cacheMeta(result: Record<string, unknown>): {
  relation: { completeness: string };
  empty_reason?: string;
} {
  return result.cache as {
    relation: { completeness: string };
    empty_reason?: string;
  };
}

export function mockFetch(t: { after(fn: () => void): void }, handler: typeof globalThis.fetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

export function embeddingResponse(vector: number[]): Response {
  return new Response(
    JSON.stringify({
      data: [{ index: 0, embedding: vector }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function callTool(
  tools: TelegramTools,
  name: string,
  args: unknown,
): Promise<Record<string, unknown> & { ok: boolean }> {
  const result = await tools.callTool(name, args);
  return parseToolPayload(result);
}

export function parseToolPayload(
  result: { content: Array<{ type: "text"; text: string }> },
): Record<string, unknown> & { ok: boolean } {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown> & { ok: boolean };
}

import type { AppConfig } from "../../src/config.js";
import { embeddingNamespace } from "../../src/embeddings.js";
import type { ChatInfo } from "../../src/telegram-client.js";

export const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

export function mockEmbeddingFetch(t: { after(fn: () => void): void }): void {
  mockFetch(t, async (_url, init) => embeddingResponse(init as RequestInit));
}

export function mockFetch(
  t: { after(fn: () => void): void },
  handler: typeof globalThis.fetch,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

export function embeddingResponse(init: RequestInit): Response {
  const body = JSON.parse(String(init.body ?? "{}")) as { input?: string | string[] };
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  return new Response(
    JSON.stringify({
      data: inputs.map((input, index) => ({
        index,
        embedding: embeddingForText(String(input)),
      })),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export function embeddingForText(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes("older") || normalized.includes("needle")) {
    return [1, 0];
  }
  return [0, 1];
}

export function config(
  embeddings: Partial<AppConfig["embeddings"]> = {},
): AppConfig {
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
      enabled: true,
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimensions: 2,
      apiBatchSize: 64,
      requestTimeoutMs: 60_000,
      maxRetries: 2,
      retryInitialMs: 0,
      retryMaxMs: 30_000,
      tickIntervalMs: 60_000,
      tickBudgetMs: 30_000,
      chunkMessages: 2,
      chunkOverlapMessages: 0,
      chunkMaxChars: 1600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1000,
      maxCharsPerRun: 500_000,
      vectorCandidateLimit: 20_000,
      searchLimit: 12,
      ...embeddings,
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

export function namespace(
  embeddings: Partial<AppConfig["embeddings"]> = {},
): string {
  return embeddingNamespace(config(embeddings));
}

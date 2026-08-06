import type { AppConfig } from "../../src/config.js";

export const DEFAULT_MTCUTE: AppConfig["telegram"]["mtcute"] = {
  authStoragePath: "/tmp/parilka-mtcute-auth.sqlite",
  historyPageSize: 100,
  maxHistoryMessages: 1_000,
  connectionMaxAttempts: 5,
  connectionTimeoutMs: 30_000,
  connectionRetryInitialMs: 250,
  connectionRetryMaxMs: 4_000,
  requestTimeoutMs: 120_000,
  requestMaxRetries: 2,
  requestRetryDelayMs: 1_000,
  floodWaitMaxMs: 10_000,
};

export const DEFAULT_MEMORY: AppConfig["memory"] = {
  memoryMaxChars: 10_000,
};

export function baseAppConfig(): AppConfig {
  return {
    telegram: {
      apiId: 1,
      apiHash: "hash",
      session: "session",
      phone: "",
      defaultChatId: "-1001",
      allowedChatIds: ["-1001"],
      requireAllowlistedChat: true,
      connectionRetries: 1,
      transport: "mtcute",
      mtcute: DEFAULT_MTCUTE,
    },
    storage: {
      dbPath: ":memory:",
    },
    safety: {
      sendEnabled: true,
      dryRunDefault: false,
      maxSendChars: 4_096,
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
      backfillLimit: 1_000,
      transientBackoffInitialMs: 5_000,
      transientBackoffMaxMs: 300_000,
    },
    embeddings: {
      enabled: false,
      backend: "external_openai",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      localEndpoint: "",
      localRequestTimeoutMs: 30_000,
      rerankTimeoutMs: 10_000,
      rerankMaxCandidates: 0,
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
      chunkMaxChars: 1_600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1_000,
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
    memory: DEFAULT_MEMORY,
  };
}

export function appConfigWithEmbeddings(
  embeddings: Partial<AppConfig["embeddings"]> = {},
): AppConfig {
  const cfg = baseAppConfig();
  cfg.embeddings = {
    ...cfg.embeddings,
    enabled: true,
    apiKey: "test-key",
    dimensions: 2,
    ...embeddings,
  };
  return cfg;
}

export function appConfigWithSync(
  sync: Partial<AppConfig["sync"]> = {},
): AppConfig {
  const cfg = baseAppConfig();
  cfg.sync = { ...cfg.sync, ...sync };
  return cfg;
}

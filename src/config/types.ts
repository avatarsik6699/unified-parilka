import { z } from "zod";

export const ToolSchemas = {
  chatRef: z.string().min(1).optional(),
};

export type TelegramTransport = "mtcute" | "gramjs";

export type TelegramAuthConfig = {
  apiId: number;
  apiHash: string;
  session: string;
  phone: string;
  defaultChatId: string;
  allowedChatIds: string[];
  requireAllowlistedChat: boolean;
  connectionRetries: number;
};

export type MtcuteRuntimeConfig = {
  authStoragePath: string;
  historyPageSize: number;
  maxHistoryMessages: number;
  connectionMaxAttempts: number;
  connectionTimeoutMs: number;
  connectionRetryInitialMs: number;
  connectionRetryMaxMs: number;
  requestTimeoutMs: number;
  requestMaxRetries: number;
  requestRetryDelayMs: number;
  floodWaitMaxMs: number;
};

export type AppConfig = {
  telegram: TelegramAuthConfig & {
    transport: TelegramTransport;
    mtcute: MtcuteRuntimeConfig;
  };
  storage: {
    dbPath: string;
  };
  safety: {
    sendEnabled: boolean;
    dryRunDefault: boolean;
    maxSendChars: number;
    liveSendApprovalTtlMs: number;
    liveSendApprovalBypass: boolean;
  };
  sync: {
    batchSize: number;
    maxSyncLimit: number;
    floodWaitMaxSleepSec: number;
    historyWaitTimeSec: number;
    historyOperationTimeoutMs: number;
    intervalMs: number;
    recentLimit: number;
    backfillLimit: number;
    transientBackoffInitialMs: number;
    transientBackoffMaxMs: number;
  };
  embeddings: {
    enabled: boolean;
    apiKey: string;
    baseUrl: string;
    model: string;
    dimensions?: number;
    apiBatchSize: number;
    requestTimeoutMs: number;
    maxRetries: number;
    retryInitialMs: number;
    retryMaxMs: number;
    tickIntervalMs: number;
    tickBudgetMs: number;
    chunkMessages: number;
    chunkOverlapMessages: number;
    chunkMaxChars: number;
    tickChunkLimit: number;
    maxChunksPerRun: number;
    maxCharsPerRun: number;
    vectorCandidateLimit: number;
    searchLimit: number;
  };
  throttle: {
    userCooldownMs: number;
    maxPendingPerUserPerChat: number;
    maxQueuePerChat: number;
    maxAgeMs: number;
    globalConcurrency: number;
    maxRunningPerChat: number;
  };
};

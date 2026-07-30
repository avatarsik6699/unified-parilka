import { z } from "zod";
import { redactUrlCredentials } from "../config/redaction.js";
import { ok } from "../errors.js";
import {
  healthSummary,
  recentCatchupSummary,
  syncOnceStatus,
} from "./cache-metadata.js";
import {
  chatSchema,
  limitSchema,
  type TelegramToolContext,
} from "./contracts.js";

export function safeConfig(
  context: TelegramToolContext,
): Record<string, unknown> {
  const { config, telegram } = context;
  return {
    defaultChatId: config.telegram.defaultChatId,
    allowedChatIds: config.telegram.allowedChatIds,
    sendEnabled: config.safety.sendEnabled,
    dryRunDefault: config.safety.dryRunDefault,
    liveSendApprovalTtlMs:
      config.safety.liveSendApprovalTtlMs,
    liveSendApprovalBypass:
      config.safety.liveSendApprovalBypass,
    dbPath: config.storage.dbPath,
    isTelegramConfigured: telegram.isConfigured,
    sync: config.sync,
    embeddings: {
      enabled: config.embeddings.enabled,
      configured: Boolean(config.embeddings.apiKey),
      baseUrl: redactUrlCredentials(
        config.embeddings.baseUrl,
      ),
      model: config.embeddings.model,
      dimensions: config.embeddings.dimensions,
      requestTimeoutMs:
        config.embeddings.requestTimeoutMs,
      maxRetries: config.embeddings.maxRetries,
      retryInitialMs: config.embeddings.retryInitialMs,
      retryMaxMs: config.embeddings.retryMaxMs,
      tickIntervalMs: config.embeddings.tickIntervalMs,
      tickBudgetMs: config.embeddings.tickBudgetMs,
      chunkMessages: config.embeddings.chunkMessages,
      chunkOverlapMessages:
        config.embeddings.chunkOverlapMessages,
      chunkMaxChars: config.embeddings.chunkMaxChars,
      tickChunkLimit: config.embeddings.tickChunkLimit,
      maxChunksPerRun:
        config.embeddings.maxChunksPerRun,
      maxCharsPerRun: config.embeddings.maxCharsPerRun,
      vectorCandidateLimit:
        config.embeddings.vectorCandidateLimit,
    },
    throttle: config.throttle,
  };
}

export function getStatus(
  context: TelegramToolContext,
  rawArgs: unknown,
): Record<string, unknown> {
  const args = chatSchema.parse(rawArgs ?? {});
  const chat = context.cacheChat(args.chat);
  const status = context.store.getChatStatus(chat.chatId);
  return ok({
    health: healthSummary(
      status,
      context.config.sync.intervalMs,
    ),
    service: {
      dbPath: context.config.storage.dbPath,
      isTelegramConfigured: context.telegram.isConfigured,
      sendEnabled: context.config.safety.sendEnabled,
      dryRunDefault: context.config.safety.dryRunDefault,
      defaultChatId: context.config.telegram.defaultChatId,
      allowedChatIds:
        context.config.telegram.allowedChatIds,
      sync: {
        intervalMs: context.config.sync.intervalMs,
        recentLimit: context.config.sync.recentLimit,
        backfillLimit: context.config.sync.backfillLimit,
        historyOperationTimeoutMs:
          context.config.sync.historyOperationTimeoutMs,
      },
    },
    chat,
    cache: {
      messageCount: status.messages.count,
      oldestMessageId: status.messages.oldestMessageId,
      newestMessageId: status.messages.newestMessageId,
    },
    sync: {
      lastRecentSyncAt: status.syncState?.lastRecentSyncAt,
      lastBackfillAt:
        status.syncState?.lastBackfillAt,
      lastError: status.syncState?.lastError,
      backfillExhausted: Boolean(
        status.syncState?.backfillExhaustedAt,
      ),
      backfillExhaustedAt:
        status.syncState?.backfillExhaustedAt,
      recentCatchup: recentCatchupSummary(status.syncState),
      state: status.syncState,
    },
    daemon: status.daemonStatus,
    embeddings: {
      enabled: context.config.embeddings.enabled,
      configured: Boolean(
        context.config.embeddings.apiKey,
      ),
      model: context.config.embeddings.model,
      dimensions: context.config.embeddings.dimensions,
      coverage: status.embeddings,
    },
    maintenance: status.maintenance,
  });
}

export async function resolveChat(
  context: TelegramToolContext,
  rawArgs: unknown,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({ refresh: z.boolean().optional() })
    .strict()
    .parse(rawArgs ?? {});
  const resolved = await context.telegram.resolveChat(
    args.chat,
    args.refresh,
  );
  context.store.upsertChat(resolved.info);
  return ok({ chat: resolved.info });
}

export async function getChatInfo(
  context: TelegramToolContext,
  rawArgs: unknown,
): Promise<Record<string, unknown>> {
  const args = chatSchema.parse(rawArgs ?? {});
  const resolved = await context.telegram.resolveChat(args.chat);
  context.store.upsertChat(resolved.info);
  return ok({
    chat: resolved.info,
    stats: context.store.getStats(resolved.info.chatId),
  });
}

export async function syncHistory(
  context: TelegramToolContext,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      mode: z
        .enum(["both", "recent", "backfill"])
        .default("backfill"),
      limit: limitSchema
        .max(context.config.sync.maxSyncLimit)
        .default(1000),
      batch_size: limitSchema
        .max(1000)
        .default(context.config.sync.batchSize),
      offset_id: z.number().int().nonnegative().optional(),
      commit_cursor: z.boolean().optional(),
      reset_backfill_exhausted: z.boolean().default(false),
    })
    .strict()
    .parse(rawArgs ?? {});

  if (args.mode === "both") {
    const result = await context.syncer.syncOnce({
      chat: args.chat,
      recentLimit: args.limit,
      backfillLimit: args.limit,
      batchSize: args.batch_size,
      signal,
    });
    return ok({
      status: syncOnceStatus(result),
      chat:
        result.chat == null
          ? undefined
          : { chatId: result.chat },
      result,
      stats:
        result.chat == null
          ? undefined
          : context.store.getStats(result.chat),
    });
  }

  const result = await context.syncer.syncDirection({
    chat: args.chat,
    mode: args.mode,
    limit: args.limit,
    batchSize: args.batch_size,
    offsetId: args.offset_id,
    resetBackfillExhausted:
      args.reset_backfill_exhausted,
    commitCursor:
      args.commit_cursor ?? args.offset_id == null,
    signal,
  });
  return ok({
    status: result.status,
    chat: result.chat,
    result,
    stats: context.store.getStats(result.chat.chatId),
  });
}

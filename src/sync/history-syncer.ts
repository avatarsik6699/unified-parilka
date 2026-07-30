import type { AppConfig } from "../config.js";
import { normalizeError, ToolError } from "../errors.js";
import type { MessageStore } from "../store.js";
import type { TelegramGateway } from "../telegram/types.js";
import {
  combineSyncSignals,
  sleepMs,
  syncAbortReason,
  throwIfSyncAborted,
  withOperationTimeout,
} from "./abort.js";
import { fetchBackfillHistory } from "./backfill.js";
import type {
  HistoryFetchContext,
  HistoryFetchProgress,
  HistorySleep,
  HistorySyncPort,
  SyncDirectionParams,
  SyncOnceParams,
  SyncOnceResult,
  SyncResult,
} from "./contracts.js";
import {
  fetchRecentHistory,
  reconcileRecentWindow,
} from "./recent.js";

export class HistorySyncer implements HistorySyncPort {
  constructor(
    private readonly config: AppConfig,
    private readonly telegram: TelegramGateway,
    private readonly store: MessageStore,
    private readonly historySleep: HistorySleep = sleepMs,
    private readonly shutdownSignal?: AbortSignal,
  ) {}

  async syncOnce(
    params: SyncOnceParams = {},
  ): Promise<SyncOnceResult> {
    const signal = combineSyncSignals(
      this.shutdownSignal,
      params.signal,
    );
    throwIfSyncAborted(signal);
    const recentLimit =
      params.recentLimit ?? this.config.sync.recentLimit;
    const backfillLimit =
      params.backfillLimit ?? this.config.sync.backfillLimit;
    const batchSize =
      params.batchSize ?? this.config.sync.batchSize;
    const result: SyncOnceResult = {};

    if (recentLimit > 0) {
      result.recent = await this.syncDirection({
        chat: params.chat,
        mode: "recent",
        limit: recentLimit,
        batchSize,
        signal,
      });
      result.chat = result.recent.chat.chatId;
    }
    if (backfillLimit > 0) {
      result.backfill = await this.syncDirection({
        chat: params.chat,
        mode: "backfill",
        limit: backfillLimit,
        batchSize,
        signal,
      });
      result.chat = result.backfill.chat.chatId;
    }
    return result;
  }

  async syncDirection(
    params: SyncDirectionParams,
  ): Promise<SyncResult> {
    const signal = combineSyncSignals(
      this.shutdownSignal,
      params.signal,
    );
    throwIfSyncAborted(signal);
    const resolved = await withOperationTimeout(
      this.telegram.resolveChat(params.chat),
      this.config.sync.historyOperationTimeoutMs,
      "Telegram chat resolution",
      signal,
    );
    const chat = resolved.info;
    const currentState = this.store.getSyncState(chat.chatId);
    const batchSize = Math.max(
      1,
      Math.min(
        params.batchSize ?? this.config.sync.batchSize,
        100,
      ),
    );
    const target = Math.max(
      0,
      Math.min(params.limit, this.config.sync.maxSyncLimit),
    );

    if (
      params.mode === "backfill" &&
      params.resetBackfillExhausted
    ) {
      this.store.setBackfillExhausted(chat, false);
    } else if (
      params.mode === "backfill" &&
      currentState?.backfillExhaustedAt
    ) {
      return this.skipExhaustedBackfill(
        chat,
        currentState,
      );
    }

    const backfillOffsets = [
      currentState?.nextBackfillOffsetId,
      currentState?.oldestMessageId,
    ].filter(
      (value): value is number => value != null && value > 0,
    );
    const shouldUseRecentCatchup =
      params.mode === "recent" && params.offsetId == null;
    const activeRecentCatchup =
      shouldUseRecentCatchup &&
      currentState?.recentCatchupNextOffsetId != null
        ? {
            minMessageId:
              currentState.recentCatchupMinId ??
              currentState.newestMessageId,
            nextOffsetId:
              currentState.recentCatchupNextOffsetId,
            newestMessageId:
              currentState.recentCatchupNewestId,
          }
        : undefined;
    let offsetId =
      params.offsetId ??
      (params.mode === "recent"
        ? (activeRecentCatchup?.nextOffsetId ?? 0)
        : backfillOffsets.length > 0
          ? Math.min(...backfillOffsets)
          : 0);
    const minId =
      params.mode === "recent"
        ? (activeRecentCatchup?.minMessageId ??
          currentState?.newestMessageId)
        : undefined;
    const hasManualOffset =
      params.mode === "backfill" && params.offsetId != null;
    const shouldAdvanceBackfillPointer =
      params.mode === "backfill" &&
      (params.commitCursor ?? !hasManualOffset);
    if (hasManualOffset && params.commitCursor) {
      const currentCursor =
        backfillOffsets.length > 0
          ? Math.min(...backfillOffsets)
          : undefined;
      if (
        currentCursor != null &&
        params.offsetId !== currentCursor
      ) {
        throw new ToolError({
          category: "internal",
          retryable: false,
          message: `commit_cursor:true requires offset_id to match current backfill cursor ${currentCursor}.`,
        });
      }
    }

    const jobId = this.store.startHistoryJob(
      chat.chatId,
      params.mode,
      target,
    );
    const progress: HistoryFetchProgress = {
      fetched: 0,
      saved: 0,
      batches: 0,
      catchupNewestMessageId:
        activeRecentCatchup?.newestMessageId,
    };
    const context: HistoryFetchContext = {
      config: this.config,
      telegram: this.telegram,
      store: this.store,
      chat,
      target,
      batchSize,
      offsetId,
      minId,
      signal,
      historySleep: this.historySleep,
      progress,
    };

    try {
      if (params.mode === "recent") {
        offsetId = await fetchRecentHistory(context);
      } else {
        await fetchBackfillHistory(context);
        if (
          progress.oldestMessageId != null &&
          shouldAdvanceBackfillPointer
        ) {
          offsetId = progress.oldestMessageId;
        }
      }

      const status: SyncResult["status"] =
        params.mode === "recent" &&
        progress.catchupNextOffsetId != null
          ? "catching_up"
          : "done";
      const committedNewestMessageId =
        params.mode === "recent" && status === "done"
          ? (progress.catchupNewestMessageId ??
            progress.newestMessageId)
          : progress.newestMessageId;
      const pendingRecentCatchup =
        status === "catching_up" &&
        progress.catchupNextOffsetId != null
          ? {
              minMessageId: minId,
              nextOffsetId: progress.catchupNextOffsetId,
              newestMessageId:
                progress.catchupNewestMessageId,
            }
          : undefined;
      const catchup =
        params.mode === "recent" && shouldUseRecentCatchup
          ? status === "catching_up"
            ? {
                status: "catching_up" as const,
                ...pendingRecentCatchup,
              }
            : {
                status: "complete" as const,
                minMessageId: minId,
                newestMessageId: committedNewestMessageId,
              }
          : undefined;
      const reconciliation =
        params.mode === "recent"
          ? await reconcileRecentWindow(
              context,
              Math.max(
                1,
                Math.min(
                  target,
                  this.config.sync.recentLimit,
                ),
              ),
            )
          : undefined;

      throwIfSyncAborted(signal);
      this.store.updateSyncState(chat, {
        oldestMessageId:
          shouldAdvanceBackfillPointer ||
          params.mode === "recent"
            ? progress.oldestMessageId
            : undefined,
        newestMessageId:
          shouldAdvanceBackfillPointer ||
          (params.mode === "recent" && status === "done")
            ? committedNewestMessageId
            : undefined,
        nextBackfillOffsetId:
          shouldAdvanceBackfillPointer && offsetId > 0
            ? offsetId
            : undefined,
        syncedCount: this.store.countMessages(chat.chatId),
        mode:
          shouldAdvanceBackfillPointer ||
          params.mode === "recent"
            ? params.mode
            : "manual",
        error: null,
        recentCatchup:
          params.mode === "recent" &&
          shouldUseRecentCatchup
            ? status === "catching_up"
              ? pendingRecentCatchup
              : null
            : undefined,
      });
      if (params.mode === "backfill") {
        this.store.setBackfillExhausted(
          chat,
          progress.fetched === 0,
        );
      }
      this.store.finishHistoryJob(jobId, {
        status,
        batches: progress.batches,
        messagesSeen: progress.fetched,
        messagesUpserted: progress.saved,
      });

      return {
        mode: params.mode,
        status,
        chat: { chatId: chat.chatId, title: chat.title },
        jobId,
        requested: target,
        fetched: progress.fetched,
        saved: progress.saved,
        batches: progress.batches,
        nextOffsetId: offsetId,
        oldestMessageId: progress.oldestMessageId,
        newestMessageId: committedNewestMessageId,
        reconciliation,
        catchup,
      };
    } catch (error) {
      const partialRecentCatchup =
        params.mode === "recent" &&
        shouldUseRecentCatchup &&
        progress.lastFlushedRecentOffsetId != null
          ? {
              minMessageId: minId,
              nextOffsetId:
                progress.lastFlushedRecentOffsetId,
              newestMessageId:
                progress.catchupNewestMessageId,
            }
          : undefined;
      if (signal?.aborted) {
        this.store.updateSyncState(chat, {
          syncedCount: this.store.countMessages(chat.chatId),
          mode: "manual",
          error: null,
          ...(partialRecentCatchup
            ? { recentCatchup: partialRecentCatchup }
            : {}),
        });
        this.store.finishHistoryJob(jobId, {
          status: "failed",
          batches: progress.batches,
          messagesSeen: progress.fetched,
          messagesUpserted: progress.saved,
          error: "History sync cancelled.",
        });
        throw syncAbortReason(signal);
      }
      const normalized = normalizeError(error);
      this.store.updateSyncState(chat, {
        syncedCount: this.store.countMessages(chat.chatId),
        mode: "manual",
        error: normalized.message,
        ...(partialRecentCatchup
          ? { recentCatchup: partialRecentCatchup }
          : {}),
      });
      this.store.finishHistoryJob(jobId, {
        status: "failed",
        batches: progress.batches,
        messagesSeen: progress.fetched,
        messagesUpserted: progress.saved,
        error: normalized.message,
      });
      return {
        mode: params.mode,
        status: "failed",
        chat: { chatId: chat.chatId, title: chat.title },
        jobId,
        requested: target,
        fetched: progress.fetched,
        saved: progress.saved,
        batches: progress.batches,
        nextOffsetId:
          partialRecentCatchup?.nextOffsetId ?? offsetId,
        oldestMessageId: progress.oldestMessageId,
        newestMessageId: progress.newestMessageId,
        catchup: partialRecentCatchup
          ? {
              status: "catching_up",
              ...partialRecentCatchup,
            }
          : undefined,
        error: normalized,
      };
    }
  }

  private skipExhaustedBackfill(
    chat: Awaited<ReturnType<TelegramGateway["resolveChat"]>>["info"],
    currentState: NonNullable<
      ReturnType<MessageStore["getSyncState"]>
    >,
  ): SyncResult {
    const jobId = this.store.startHistoryJob(
      chat.chatId,
      "backfill",
      0,
    );
    this.store.finishHistoryJob(jobId, {
      status: "skipped",
      batches: 0,
      messagesSeen: 0,
      messagesUpserted: 0,
    });
    return {
      mode: "backfill",
      status: "skipped",
      chat: { chatId: chat.chatId, title: chat.title },
      jobId,
      requested: 0,
      fetched: 0,
      saved: 0,
      batches: 0,
      nextOffsetId: currentState.nextBackfillOffsetId,
      oldestMessageId: currentState.oldestMessageId,
      newestMessageId: currentState.newestMessageId,
      skipped: "backfill_exhausted",
    };
  }
}

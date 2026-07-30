import type { AppConfig } from "../config.js";
import type { NormalizedError } from "../errors.js";
import type {
  MessageStore,
  StoredMessage,
} from "../store.js";
import type {
  ChatInfo,
  TelegramGateway,
} from "../telegram/types.js";

export type SyncDirection = "recent" | "backfill";

export type SyncResult = {
  mode: SyncDirection;
  status: "done" | "failed" | "skipped" | "catching_up";
  chat: {
    chatId: string;
    title?: string;
  };
  jobId: string;
  requested: number;
  fetched: number;
  saved: number;
  batches: number;
  nextOffsetId?: number;
  oldestMessageId?: number;
  newestMessageId?: number;
  skipped?: "backfill_exhausted";
  reconciliation?: {
    checked: number;
    refreshed: number;
    deleted: number;
  };
  catchup?: {
    status: "catching_up" | "complete";
    minMessageId?: number;
    nextOffsetId?: number;
    newestMessageId?: number;
  };
  error?: NormalizedError;
};

export type SyncOnceResult = {
  chat?: string;
  recent?: SyncResult;
  backfill?: SyncResult;
};

export interface SyncOnceParams {
  chat?: string;
  recentLimit?: number;
  backfillLimit?: number;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface SyncDirectionParams {
  chat?: string;
  mode: SyncDirection;
  limit: number;
  batchSize?: number;
  offsetId?: number;
  resetBackfillExhausted?: boolean;
  commitCursor?: boolean;
  signal?: AbortSignal;
}

export interface HistorySyncPort {
  syncOnce(params?: SyncOnceParams): Promise<SyncOnceResult>;
  syncDirection(params: SyncDirectionParams): Promise<SyncResult>;
}

export type HistorySleep = (
  delayMs: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface HistoryFetchProgress {
  fetched: number;
  saved: number;
  batches: number;
  newestMessageId?: number;
  oldestMessageId?: number;
  catchupNewestMessageId?: number;
  catchupNextOffsetId?: number;
  lastFlushedRecentOffsetId?: number;
}

export interface HistoryFetchContext {
  config: AppConfig;
  telegram: TelegramGateway;
  store: MessageStore;
  chat: ChatInfo;
  target: number;
  batchSize: number;
  offsetId: number;
  minId?: number;
  signal?: AbortSignal;
  historySleep: HistorySleep;
  progress: HistoryFetchProgress;
}

export interface HistoryBatchBuffer {
  rows: StoredMessage[];
  seen: Set<string>;
}

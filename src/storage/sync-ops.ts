import type { ChatInfo } from "../telegram/types.js";
import { StoreCore } from "./core.js";
import {
  rowToDaemonStatus,
  rowToSyncState,
} from "./mappers.js";
import type {
  DaemonStatus,
  SyncState,
} from "./types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class SyncOpsMethods extends StoreCore {
  declare protected upsertChatLocked: (chat: ChatInfo) => void;
  declare countMessages: (chatId: string) => number;

  updateSyncState(
    chat: ChatInfo,
    state: {
      oldestMessageId?: number;
      newestMessageId?: number;
      nextBackfillOffsetId?: number;
      syncedCount: number;
      mode?: "recent" | "backfill" | "manual";
      error?: string | null;
      recentCatchup?: { minMessageId?: number; nextOffsetId: number; newestMessageId?: number } | null;
    },
  ): void {
    this.immediateTransaction("updateSyncState", () => {
      this.upsertChatLocked(chat);
      this.db
        .prepare(
          `INSERT INTO sync_state (
             chat_id, oldest_message_id, newest_message_id, next_backfill_offset_id,
             synced_count, last_recent_sync_at, last_backfill_at, last_error, updated_at
           )
           VALUES (
             ?, ?, ?, ?, ?,
             CASE WHEN ? = 'recent' THEN datetime('now') ELSE NULL END,
             CASE WHEN ? = 'backfill' THEN datetime('now') ELSE NULL END,
             ?, datetime('now')
           )
           ON CONFLICT(chat_id) DO UPDATE SET
             oldest_message_id = CASE
               WHEN excluded.oldest_message_id IS NULL THEN sync_state.oldest_message_id
               WHEN sync_state.oldest_message_id IS NULL THEN excluded.oldest_message_id
               WHEN excluded.oldest_message_id < sync_state.oldest_message_id THEN excluded.oldest_message_id
               ELSE sync_state.oldest_message_id
             END,
             newest_message_id = CASE
               WHEN excluded.newest_message_id IS NULL THEN sync_state.newest_message_id
               WHEN sync_state.newest_message_id IS NULL THEN excluded.newest_message_id
               WHEN excluded.newest_message_id > sync_state.newest_message_id THEN excluded.newest_message_id
               ELSE sync_state.newest_message_id
             END,
             next_backfill_offset_id = COALESCE(excluded.next_backfill_offset_id, sync_state.next_backfill_offset_id),
             synced_count = excluded.synced_count,
             last_recent_sync_at = COALESCE(excluded.last_recent_sync_at, sync_state.last_recent_sync_at),
             last_backfill_at = COALESCE(excluded.last_backfill_at, sync_state.last_backfill_at),
             last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
        )
        .run(
          chat.chatId,
          state.oldestMessageId ?? null,
          state.newestMessageId ?? null,
          state.nextBackfillOffsetId ?? null,
          state.syncedCount,
          state.mode ?? "manual",
          state.mode ?? "manual",
          state.error ?? null,
        );
      if (Object.prototype.hasOwnProperty.call(state, "recentCatchup")) {
        if (state.recentCatchup == null) {
          this.db
            .prepare(
              `UPDATE sync_state
               SET recent_catchup_min_id = NULL,
                   recent_catchup_next_offset_id = NULL,
                   recent_catchup_newest_id = NULL,
                   updated_at = datetime('now')
               WHERE chat_id = ?`,
            )
            .run(chat.chatId);
        } else {
          this.db
            .prepare(
              `UPDATE sync_state
               SET recent_catchup_min_id = ?,
                   recent_catchup_next_offset_id = ?,
                   recent_catchup_newest_id = ?,
                   updated_at = datetime('now')
               WHERE chat_id = ?`,
            )
            .run(
              state.recentCatchup.minMessageId ?? null,
              state.recentCatchup.nextOffsetId,
              state.recentCatchup.newestMessageId ?? null,
              chat.chatId,
            );
        }
      }
    });
  }

  getSyncState(chatId: string): SyncState | undefined {
    const row = this.db.prepare("SELECT * FROM sync_state WHERE chat_id = ?").get(chatId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return undefined;
    }
    return rowToSyncState(row);
  }

  setBackfillExhausted(chat: ChatInfo, exhausted: boolean): void {
    this.immediateTransaction("setBackfillExhausted", () => {
      this.upsertChatLocked(chat);
      this.db
        .prepare(
          `INSERT INTO sync_state (
             chat_id, synced_count, backfill_exhausted_at, updated_at
           )
           VALUES (?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
           ON CONFLICT(chat_id) DO UPDATE SET
             backfill_exhausted_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
             updated_at = datetime('now')`,
        )
        .run(chat.chatId, this.countMessages(chat.chatId), exhausted ? 1 : 0, exhausted ? 1 : 0);
    });
  }

  startHistoryJob(chatId: string, direction: "recent" | "backfill" | "manual", targetCount: number): string {
    const jobId = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.writeWithRetry("startHistoryJob", () => {
      this.db
        .prepare(
          `INSERT INTO history_jobs (job_id, chat_id, direction, status, target_count, started_at)
           VALUES (?, ?, ?, 'running', ?, datetime('now'))`,
        )
        .run(jobId, chatId, direction, targetCount);
    });
    return jobId;
  }

  finishHistoryJob(
    jobId: string,
    result: {
      status: "done" | "failed" | "skipped" | "catching_up";
      batches: number;
      messagesSeen: number;
      messagesUpserted: number;
      error?: string;
    },
  ): void {
    this.writeWithRetry("finishHistoryJob", () => {
      this.db
        .prepare(
          `UPDATE history_jobs
           SET status = ?, finished_at = datetime('now'), batches = ?, messages_seen = ?,
               messages_upserted = ?, error = ?
           WHERE job_id = ?`,
        )
        .run(result.status, result.batches, result.messagesSeen, result.messagesUpserted, result.error ?? null, jobId);
    });
  }

  recordDaemonTickStarted(service = "sync-daemon"): void {
    this.writeWithRetry("recordDaemonTickStarted", () => {
      this.db
        .prepare(
          `INSERT INTO daemon_status (service, last_started_at, consecutive_failures, updated_at)
           VALUES (?, datetime('now'), 0, datetime('now'))
           ON CONFLICT(service) DO UPDATE SET
             last_started_at = excluded.last_started_at,
             updated_at = excluded.updated_at`,
        )
        .run(service);
    });
  }

  recordDaemonTickSuccess(service = "sync-daemon"): void {
    this.writeWithRetry("recordDaemonTickSuccess", () => {
      this.db
        .prepare(
          `INSERT INTO daemon_status (service, last_success_at, last_error, consecutive_failures, updated_at)
           VALUES (?, datetime('now'), NULL, 0, datetime('now'))
           ON CONFLICT(service) DO UPDATE SET
             last_success_at = excluded.last_success_at,
             last_error = NULL,
             consecutive_failures = 0,
             updated_at = excluded.updated_at`,
        )
        .run(service);
    });
  }

  recordDaemonTickFailure(error: string, service = "sync-daemon"): void {
    this.writeWithRetry("recordDaemonTickFailure", () => {
      this.db
        .prepare(
          `INSERT INTO daemon_status (service, last_failure_at, last_error, consecutive_failures, updated_at)
           VALUES (?, datetime('now'), ?, 1, datetime('now'))
           ON CONFLICT(service) DO UPDATE SET
             last_failure_at = excluded.last_failure_at,
             last_error = excluded.last_error,
             consecutive_failures = daemon_status.consecutive_failures + 1,
             updated_at = excluded.updated_at`,
        )
        .run(service, error);
    });
  }

  getDaemonStatus(service = "sync-daemon"): DaemonStatus | undefined {
    const row = this.db.prepare("SELECT * FROM daemon_status WHERE service = ?").get(service) as
      | Record<string, unknown>
      | undefined;
    return row == null ? undefined : rowToDaemonStatus(row);
  }
}

export type SyncOpsApi = Pick<
  SyncOpsMethods,
  | "updateSyncState"
  | "getSyncState"
  | "setBackfillExhausted"
  | "startHistoryJob"
  | "finishHistoryJob"
  | "recordDaemonTickStarted"
  | "recordDaemonTickSuccess"
  | "recordDaemonTickFailure"
  | "getDaemonStatus"
>;

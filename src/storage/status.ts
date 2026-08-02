import { StoreCore } from "./core.js";
import { optionalNumber, rowToMaintenanceJob } from "./mappers.js";
import type {
  ChatCacheStatus,
  DaemonStatus,
  DurableQueueStatus,
  MaintenanceJob,
  MaintenanceJobName,
  SyncState,
} from "./types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class StatusMethods extends StoreCore {
declare getSyncState: (chatId: string) => SyncState | undefined;
  declare getDaemonStatus: (service?: string) => DaemonStatus | undefined;
  declare getEmbeddingStats: (
    chatId: string,
    params?: { namespace?: string },
  ) => Array<Record<string, unknown>>;

  getMaintenanceJobs(): MaintenanceJob[] {
    const rows = this.db
      .prepare("SELECT * FROM maintenance_jobs ORDER BY status DESC, name ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToMaintenanceJob);
  }

  isMaintenanceJobPending(name: MaintenanceJobName): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS pending
         FROM maintenance_jobs
         WHERE name = ? AND status = 'pending'`,
      )
      .get(name) as Record<string, unknown> | undefined;
    return row?.pending === 1;
  }

  getChatStatus(chatId: string): ChatCacheStatus {
    const messageStats = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(message_id) AS oldest_message_id, MAX(message_id) AS newest_message_id
         FROM messages WHERE chat_id = ?`,
      )
      .get(chatId) as Record<string, unknown>;
    return {
      chatId,
      messages: {
        count: Number(messageStats.count ?? 0),
        oldestMessageId: optionalNumber(messageStats.oldest_message_id),
        newestMessageId: optionalNumber(messageStats.newest_message_id),
      },
      syncState: this.getSyncState(chatId) ?? null,
      daemonStatus: this.getDaemonStatus() ?? null,
      embeddings: this.getEmbeddingStats(chatId),
      maintenance: this.getMaintenanceJobs(),
    };
  }

  getStats(chatId: string): Record<string, unknown> {
    const messageStats = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(message_id) AS oldest_message_id, MAX(message_id) AS newest_message_id
         FROM messages WHERE chat_id = ?`,
      )
      .get(chatId) as Record<string, unknown>;
    const syncState =
      (this.db.prepare("SELECT * FROM sync_state WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined) ??
      {};
    return {
      ...messageStats,
      syncState,
      daemonStatus: this.getDaemonStatus(),
      embeddings: this.getEmbeddingStats(chatId),
      maintenance: this.getMaintenanceJobs(),
    };
  }

  getDurableQueueStatus(chatId: string): DurableQueueStatus {
    const turnStatuses = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count, MIN(updated_at_ms) AS oldest_updated_at_ms
         FROM bot_turns WHERE chat_id = ? GROUP BY status`,
      )
      .all(chatId) as Array<{ status: string; count: number; oldest_updated_at_ms: number | null }>;
    const updateStatuses = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count, MIN(received_at_ms) AS oldest_received_at_ms
         FROM bot_updates WHERE chat_id = ? GROUP BY status`,
      )
      .all(chatId) as Array<{ status: string; count: number; oldest_received_at_ms: number | null }>;
    const outboxStatuses = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count, MIN(created_at_ms) AS oldest_created_at_ms
         FROM send_outbox WHERE chat_id = ? GROUP BY status`,
      )
      .all(chatId) as Array<{ status: string; count: number; oldest_created_at_ms: number | null }>;
    return {
      botTurns: Object.fromEntries(turnStatuses.map((r) => [r.status, { count: r.count, oldestUpdatedAtMs: r.oldest_updated_at_ms ?? undefined }])),
      botUpdates: Object.fromEntries(updateStatuses.map((r) => [r.status, { count: r.count, oldestReceivedAtMs: r.oldest_received_at_ms ?? undefined }])),
      sendOutbox: Object.fromEntries(outboxStatuses.map((r) => [r.status, { count: r.count, oldestCreatedAtMs: r.oldest_created_at_ms ?? undefined }])),
    };
  }
}

export type StatusApi = Pick<
  StatusMethods,
  | "getMaintenanceJobs"
  | "isMaintenanceJobPending"
  | "getChatStatus"
  | "getStats"
  | "getDurableQueueStatus"
>;

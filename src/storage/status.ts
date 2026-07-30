import { StoreCore } from "./core.js";
import { optionalNumber, rowToMaintenanceJob } from "./mappers.js";
import type {
  ChatCacheStatus,
  DaemonStatus,
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
}

export type StatusApi = Pick<
  StatusMethods,
  | "getMaintenanceJobs"
  | "isMaintenanceJobPending"
  | "getChatStatus"
  | "getStats"
>;

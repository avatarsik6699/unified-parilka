import { StoreCore } from "./core.js";

/** Method module installed on MessageStore.prototype (never instantiated). */
export abstract class VkSenderMethods extends StoreCore {
  /** Distinct (chat, sender) pairs still missing a display name -- VK sender-name enrichment's work queue. */
  listDistinctUnresolvedVkSenderIds(
    chatIds: readonly string[],
    limit: number,
  ): { chatId: string; senderId: string }[] {
    if (chatIds.length === 0) {
      return [];
    }
    const placeholders = chatIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT chat_id, sender_id
         FROM messages
         WHERE chat_id IN (${placeholders})
           AND sender_name IS NULL
           AND sender_id IS NOT NULL
         LIMIT ?`,
      )
      .all(...chatIds, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      chatId: String(row.chat_id),
      senderId: String(row.sender_id),
    }));
  }

  /** Fills in a previously-unresolved sender's display name. Never overwrites an already-known name. */
  backfillSenderName(
    chatId: string,
    senderId: string,
    senderName: string,
  ): number {
    return this.immediateTransaction("backfillSenderName", () => {
      const result = this.db
        .prepare(
          `UPDATE messages
           SET sender_name = ?, updated_at = datetime('now')
           WHERE chat_id = ? AND sender_id = ? AND sender_name IS NULL`,
        )
        .run(senderName, chatId, senderId);
      return Number(result.changes ?? 0);
    });
  }
}

export type VkSenderApi = Pick<
  VkSenderMethods,
  "listDistinctUnresolvedVkSenderIds" | "backfillSenderName"
>;

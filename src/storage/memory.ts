import { StoreCore } from "./core.js";
import {
  assertNonEmptyBounded,
  assertTimestamp,
} from "./validation.js";
import type {
  StoredChatMemory,
  UpsertChatMemoryInput,
} from "./types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class MemoryMethods extends StoreCore {
  getChatMemory(chatId: string): StoredChatMemory | undefined {
    assertNonEmptyBounded(chatId, 256, "chatId");
    const row = this.db
      .prepare(
        `SELECT
           chat_id,
           memory_text,
           last_consolidated_message_id,
           revision,
           updated_at_ms
         FROM bot_chat_memory
         WHERE chat_id = ?`,
      )
      .get(chatId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return rowToStoredChatMemory(row);
  }

  upsertChatMemory(input: UpsertChatMemoryInput): StoredChatMemory {
    return this.immediateTransaction("upsertChatMemory", () =>
      this.upsertChatMemoryLocked(input),
    );
  }

  /**
   * Assumes the caller already owns a `BEGIN IMMEDIATE` boundary.
   */
  protected upsertChatMemoryLocked(
    input: UpsertChatMemoryInput,
  ): StoredChatMemory {
    assertNonEmptyBounded(input.chatId, 256, "chatId");
    const updatedAtMs = input.updatedAtMs ?? Date.now();
    assertTimestamp(updatedAtMs, "updatedAtMs");
    this.db
      .prepare(
        `INSERT INTO bot_chat_memory (
           chat_id, memory_text, last_consolidated_message_id,
           revision, updated_at_ms
         )
         VALUES (
           ?, ?, ?,
           COALESCE((SELECT revision FROM bot_chat_memory WHERE chat_id = ?), 0) + 1,
           ?
         )
         ON CONFLICT(chat_id) DO UPDATE SET
           memory_text = excluded.memory_text,
           last_consolidated_message_id = excluded.last_consolidated_message_id,
           revision = excluded.revision,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        input.chatId,
        input.memoryText,
        input.lastConsolidatedMessageId ?? null,
        input.chatId,
        updatedAtMs,
      );
    const stored = this.getChatMemory(input.chatId);
    if (!stored) {
      throw new Error("Chat memory disappeared after upsert.");
    }
    return stored;
  }

  countMessagesSince(params: {
    chatId: string;
    messageId?: number;
  }): number {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    const row = this.db
      .prepare(
        params.messageId == null
          ? `SELECT COUNT(*) AS count
             FROM messages
             WHERE chat_id = ? AND deleted_at IS NULL`
          : `SELECT COUNT(*) AS count
             FROM messages
             WHERE chat_id = ?
               AND message_id > ?
               AND deleted_at IS NULL`,
      )
      .get(
        ...(params.messageId == null
          ? [params.chatId]
          : [params.chatId, params.messageId]),
      ) as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  }

  listChatsPendingDream(threshold: number): string[] {
    if (
      !Number.isSafeInteger(threshold) ||
      threshold < 1
    ) {
      throw new Error(
        "Dream threshold must be a positive integer.",
      );
    }
    const rows = this.db
      .prepare(
        `SELECT m.chat_id
         FROM (
           SELECT chat_id, COALESCE(MAX(message_id), 0) AS max_id
           FROM messages
           WHERE deleted_at IS NULL
           GROUP BY chat_id
         ) AS m
         LEFT JOIN bot_chat_memory AS mem ON mem.chat_id = m.chat_id
         WHERE m.max_id > COALESCE(mem.last_consolidated_message_id, 0)
           AND (
             SELECT COUNT(*)
             FROM messages AS msg
             WHERE msg.chat_id = m.chat_id
               AND msg.deleted_at IS NULL
               AND msg.message_id > COALESCE(mem.last_consolidated_message_id, 0)
           ) >= ?`,
      )
      .all(threshold) as Record<string, unknown>[];
    return rows.map((row) => String(row.chat_id));
  }
}

export type MemoryApi = Pick<
  MemoryMethods,
  | "getChatMemory"
  | "upsertChatMemory"
  | "countMessagesSince"
  | "listChatsPendingDream"
>;

function rowToStoredChatMemory(
  row: Record<string, unknown>,
): StoredChatMemory {
  return {
    chatId: String(row.chat_id),
    memoryText: String(row.memory_text ?? ""),
    lastConsolidatedMessageId:
      row.last_consolidated_message_id == null
        ? undefined
        : Number(row.last_consolidated_message_id),
    revision: Number(row.revision ?? 0),
    updatedAtMs: Number(row.updated_at_ms ?? 0),
  };
}

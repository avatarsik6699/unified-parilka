import type { ChatInfo } from "../telegram/types.js";
import { embeddingMessageSourceChanged } from "../embedding-source.js";
import { StoreCore } from "./core.js";
import {
  chatAliases,
  normalizeChatAlias,
  rowToChatInfo,
  rowToStoredMessage,
} from "./mappers.js";
import { escapeFtsQuery, toSqlValues } from "./sqlite-utils.js";
import type {
  KeywordSearchHit,
  MaintenanceJobName,
  StoredMessage,
} from "./types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class MessageMethods extends StoreCore {
declare protected assertMaintenanceJobReady: (
    name: MaintenanceJobName,
    message: string,
  ) => void;

  upsertChat(chat: ChatInfo): void {
    this.writeWithRetry("upsertChat", () => this.upsertChatLocked(chat));
  }

  protected upsertChatLocked(chat: ChatInfo): void {
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, title, username, kind, is_forum, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET
           title = excluded.title,
           username = excluded.username,
           kind = excluded.kind,
           is_forum = excluded.is_forum,
           updated_at = excluded.updated_at`,
      )
      .run(chat.chatId, chat.title ?? null, chat.username ?? null, chat.kind, chat.isForum ? 1 : 0);
    for (const alias of chatAliases(chat)) {
      this.db
        .prepare(
          `INSERT INTO chat_aliases (alias, chat_id, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(alias) DO UPDATE SET
             chat_id = excluded.chat_id,
             updated_at = excluded.updated_at`,
        )
        .run(alias, chat.chatId);
    }
  }

  upsertMessages(chat: ChatInfo, messages: StoredMessage[]): number {
    return this.immediateTransaction("upsertMessages", () => {
      this.upsertChatLocked(chat);
      const stmt = this.db.prepare(
        `INSERT INTO messages (
           chat_id, message_id, date, sender_id, sender_name, text,
           reply_to_message_id, topic_id, raw_json, deleted_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           date = excluded.date,
           sender_id = excluded.sender_id,
           sender_name = excluded.sender_name,
           text = excluded.text,
           reply_to_message_id = excluded.reply_to_message_id,
           topic_id = excluded.topic_id,
           raw_json = excluded.raw_json,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at`,
      );
      for (const row of messages) {
        const previous = this.getMessageForDirtyCheck(row.chatId, row.messageId);
        stmt.run(
          row.chatId,
          row.messageId,
          row.date ?? null,
          row.senderId ?? null,
          row.senderName ?? null,
          row.text,
          row.replyToMessageId ?? null,
          row.topicId ?? null,
          row.rawJson ?? null,
          row.deletedAt ?? null,
        );
        if (
          previous &&
          embeddingMessageSourceChanged(previous, row)
        ) {
          this.markEmbeddingChunksDirtyForMessagesLocked(row.chatId, [row.messageId]);
        }
      }
      return new Set(messages.map((message) => `${message.chatId}:${message.messageId}`)).size;
    });
  }

  getCachedChat(chatId: string): ChatInfo | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return rowToChatInfo(row);
  }

  resolveCachedChat(chat: string): ChatInfo | undefined {
    const direct = this.getCachedChat(chat);
    if (direct) {
      return direct;
    }
    const alias = normalizeChatAlias(chat);
    const row = this.db
      .prepare(
        `SELECT c.*
         FROM chat_aliases a
         JOIN chats c ON c.chat_id = a.chat_id
         WHERE a.alias = ?`,
      )
      .get(alias) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return { ...rowToChatInfo(row), requested: chat };
  }

  getHistory(params: {
    chatId: string;
    limit: number;
    beforeId?: number;
    afterId?: number;
    order?: "asc" | "desc";
  }): StoredMessage[] {
    const order = params.order === "asc" ? "ASC" : "DESC";
    const clauses = ["chat_id = ?"];
    const values: unknown[] = [params.chatId];
    if (params.beforeId != null) {
      clauses.push("message_id < ?");
      values.push(params.beforeId);
    }
    if (params.afterId != null) {
      clauses.push("message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY message_id ${order}
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  getRecentMessageIds(chatId: string, limit: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT message_id
         FROM messages
         WHERE chat_id = ? AND deleted_at IS NULL
         ORDER BY message_id DESC
         LIMIT ?`,
      )
      .all(chatId, limit) as Record<string, unknown>[];
    return rows.map((row) => Number(row.message_id));
  }

  markMessagesDeleted(chatId: string, messageIds: number[]): number {
    if (messageIds.length === 0) {
      return 0;
    }
    return this.immediateTransaction("markMessagesDeleted", () => {
      let changed = 0;
      const stmt = this.db.prepare(
        `UPDATE messages
         SET text = '', deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE chat_id = ? AND message_id = ? AND deleted_at IS NULL`,
      );
      for (const messageId of messageIds) {
        const result = stmt.run(chatId, messageId);
        if (Number(result.changes ?? 0) > 0) {
          changed += Number(result.changes ?? 0);
          this.markEmbeddingChunksDirtyForMessagesLocked(chatId, [messageId]);
        }
      }
      return changed;
    });
  }

  search(params: { chatId: string; query: string; limit: number; beforeId?: number; afterId?: number }): StoredMessage[] {
    return this.searchWithRank(params).map((hit) => hit.message);
  }

  searchWithRank(params: { chatId: string; query: string; limit: number; beforeId?: number; afterId?: number }): KeywordSearchHit[] {
    this.assertMaintenanceJobReady(
      "messages_fts_rebuild",
      "Keyword search is temporarily unavailable while the FTS index rebuild is pending. Run state maintenance with --apply.",
    );
    const clauses = ["m.chat_id = ?", "m.deleted_at IS NULL", "messages_fts MATCH ?"];
    const values: unknown[] = [params.chatId, escapeFtsQuery(params.query)];
    if (params.beforeId != null) {
      clauses.push("m.message_id < ?");
      values.push(params.beforeId);
    }
    if (params.afterId != null) {
      clauses.push("m.message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(messages_fts) AS fts_rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY fts_rank ASC, m.message_id DESC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map((row) => ({
      message: rowToStoredMessage(row),
      rank: Number(row.fts_rank ?? 0),
    }));
  }

  getThreadContext(params: { chatId: string; messageId: number; before: number; after: number }): StoredMessage[] {
    const min = params.messageId - params.before;
    const max = params.messageId + params.after;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND message_id BETWEEN ? AND ?
         ORDER BY message_id ASC`,
      )
      .all(params.chatId, min, max) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  getMessagesForEmbedding(params: { chatId: string; afterId?: number; limit: number }): StoredMessage[] {
    const clauses = ["chat_id = ?", "length(trim(text)) > 0"];
    const values: unknown[] = [params.chatId];
    if (params.afterId != null) {
      clauses.push("message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY message_id ASC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  getMessagesNeedingEmbedding(params: {
    chatId: string;
    namespace: string;
    model: string;
    dimensions?: number;
    afterId?: number;
    limit: number;
  }): StoredMessage[] {
    this.assertMaintenanceJobReady(
      "embedding_chunk_membership_backfill",
      "Embedding indexing is temporarily unavailable while chunk membership backfill is pending. Run state maintenance with --apply.",
    );
    const clauses = [
      "m.chat_id = ?",
      "length(trim(m.text)) > 0",
      "m.deleted_at IS NULL",
      `NOT EXISTS (
        SELECT 1
        FROM message_embedding_chunk_messages cm
        JOIN message_embedding_chunks c ON c.id = cm.chunk_id
        WHERE cm.chat_id = m.chat_id
          AND cm.message_id = m.message_id
          AND c.embedding_model = ?
          AND c.embedding_namespace = ?
          AND (? IS NULL OR c.embedding_dimensions = ?)
          AND c.dirty_at IS NULL
      )`,
    ];
    const values: unknown[] = [
      params.chatId,
      params.model,
      params.namespace,
      params.dimensions ?? null,
      params.dimensions ?? null,
    ];
    if (params.afterId != null) {
      clauses.push("m.message_id > ?");
      values.push(params.afterId);
    }
    values.push(params.limit);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.*
         FROM messages m
         WHERE ${clauses.join(" AND ")}
         ORDER BY m.message_id ASC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  getMessagesInRange(params: { chatId: string; startMessageId: number; endMessageId: number; limit?: number }): StoredMessage[] {
    const limit = params.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND message_id BETWEEN ? AND ?
         ORDER BY message_id ASC
         LIMIT ?`,
      )
      .all(params.chatId, params.startMessageId, params.endMessageId, limit) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  getMessagesByIds(params: { chatId: string; messageIds: number[] }): StoredMessage[] {
    if (params.messageIds.length === 0) {
      return [];
    }
    const uniqueIds = [...new Set(params.messageIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE chat_id = ? AND message_id IN (${placeholders})`)
      .all(params.chatId, ...uniqueIds) as Record<string, unknown>[];
    const byId = new Map(rows.map((row) => [Number(row.message_id), rowToStoredMessage(row)]));
    return params.messageIds.map((id) => byId.get(id)).filter((message): message is StoredMessage => message != null);
  }

  countMessages(chatId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get(chatId) as
      | Record<string, unknown>
      | undefined;
    return Number(row?.count ?? 0);
  }

  protected getMessageForDirtyCheck(chatId: string, messageId: number): StoredMessage | undefined {
    const row = this.db
      .prepare("SELECT text, deleted_at FROM messages WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return rowToStoredMessage(row);
  }

  protected markEmbeddingChunksDirtyForMessagesLocked(chatId: string, messageIds: number[]): void {
    const stmt = this.db.prepare(
      `UPDATE message_embedding_chunks
       SET dirty_at = COALESCE(dirty_at, datetime('now')), updated_at = datetime('now')
       WHERE id IN (
         SELECT chunk_id
         FROM message_embedding_chunk_messages
         WHERE chat_id = ? AND message_id = ?
       )`,
    );
    for (const messageId of messageIds) {
      stmt.run(chatId, messageId);
    }
  }
}

export type MessageApi = Pick<
  MessageMethods,
  | "upsertChat"
  | "upsertMessages"
  | "getCachedChat"
  | "resolveCachedChat"
  | "getHistory"
  | "getRecentMessageIds"
  | "markMessagesDeleted"
  | "search"
  | "searchWithRank"
  | "getThreadContext"
  | "getMessagesForEmbedding"
  | "getMessagesNeedingEmbedding"
  | "getMessagesInRange"
  | "getMessagesByIds"
  | "countMessages"
>;

import type { ChatInfo } from "../telegram/types.js";
import { embeddingMessageSourceChanged } from "../embedding-source.js";
import { StoreCore } from "./core.js";
import { rowToStoredBotUpdate } from "./mappers.js";
import { toSqlValues } from "./sqlite-utils.js";
import type {
  BotDurableStatus,
  BotUpdateFailureResult,
  BotUpdateIngestResult,
  StoredBotTurn,
  StoredBotUpdate,
  StoredMessage,
} from "./types.js";
import {
  assertBotUpdateId,
  assertTimestamp,
  botTriggerCooldownKey,
  normalizeBotMaxAttempts,
  normalizeBotStatuses,
  normalizeBotTriggerCooldown,
  normalizeQueryLimit,
} from "./validation.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class BotUpdateMethods extends StoreCore {
declare protected upsertChatLocked: (chat: ChatInfo) => void;
  declare protected getBotTurnByTriggerLocked: (
    chatId: string,
    triggerMessageId: number,
  ) => StoredBotTurn | undefined;
  declare protected getBotTriggerCooldownRetryAfterLocked: (
    chatId: string,
    userKey: string,
    nowMs: number,
  ) => number;
  declare protected updateSendCooldownLocked: (
    chatId: string,
    userKey: string,
    nextAllowedAtMs: number,
    nowMs: number,
  ) => void;
  declare protected getMessageForDirtyCheck: (
    chatId: string,
    messageId: number,
  ) => StoredMessage | undefined;
  declare protected markEmbeddingChunksDirtyForMessagesLocked: (
    chatId: string,
    messageIds: number[],
  ) => void;

  ingestBotUpdate(params: {
    updateId: number;
    rawJson: string;
    chat: ChatInfo;
    message: StoredMessage;
    addressed: boolean;
    triggerCooldown?: {
      userKey: string;
      cooldownMs: number;
    };
    maxAttempts?: number;
    nowMs?: number;
  }): BotUpdateIngestResult {
    assertBotUpdateId(params.updateId);
    const nowMs = params.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    const maxAttempts = normalizeBotMaxAttempts(params.maxAttempts);
    if (params.message.chatId !== params.chat.chatId) {
      throw new Error("Bot update message chatId must match chat.chatId.");
    }
    if (!Number.isSafeInteger(params.message.messageId)) {
      throw new Error("Bot update trigger messageId must be a safe integer.");
    }
    const triggerCooldown = normalizeBotTriggerCooldown(
      params.triggerCooldown,
    );
    if (triggerCooldown) {
      assertTimestamp(
        nowMs + triggerCooldown.cooldownMs,
        "triggerCooldownExpiresAtMs",
      );
    }

    return this.immediateTransaction("ingestBotUpdate", () => {
      const existing = this.getBotUpdateLocked(params.updateId);
      const recoveringPoisonUpdate =
        existing?.status === "failed" &&
        existing.chatId == null &&
        existing.triggerMessageId == null;
      if (existing && !recoveringPoisonUpdate) {
        return {
          disposition: "duplicate",
          ackUpdateId: params.updateId,
          update: existing,
          turn:
            existing.chatId == null || existing.triggerMessageId == null
              ? undefined
              : this.getBotTurnByTriggerLocked(existing.chatId, existing.triggerMessageId),
        };
      }

      this.upsertChatLocked(params.chat);
      this.upsertBotMessageLocked(params.message);

      const cooldownRetryAfterMs =
        params.addressed && triggerCooldown
          ? this.getBotTriggerCooldownRetryAfterLocked(
              params.chat.chatId,
              triggerCooldown.userKey,
              nowMs,
            )
          : 0;
      const reserveTurn = params.addressed && cooldownRetryAfterMs === 0;
      const initialStatus: BotDurableStatus = reserveTurn
        ? "queued"
        : "skipped";
      const initialError =
        params.addressed && cooldownRetryAfterMs > 0
          ? "Bot trigger cooldown is active."
          : null;
      if (existing) {
        this.db
          .prepare(
            `UPDATE bot_updates
             SET raw_json = ?, status = ?, addressed = ?, chat_id = ?, trigger_message_id = ?,
                 attempts = 0, max_attempts = ?, error = ?, updated_at_ms = ?,
                 completed_at_ms = CASE WHEN ? = 'skipped' THEN ? ELSE NULL END
             WHERE update_id = ? AND status = 'failed'
               AND chat_id IS NULL AND trigger_message_id IS NULL`,
          )
          .run(
            params.rawJson,
            initialStatus,
            params.addressed ? 1 : 0,
            params.chat.chatId,
            params.message.messageId,
            maxAttempts,
            initialError,
            nowMs,
            initialStatus,
            nowMs,
            params.updateId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO bot_updates (
               update_id, raw_json, status, addressed, chat_id, trigger_message_id,
               attempts, max_attempts, error, received_at_ms, updated_at_ms,
               completed_at_ms
             )
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?,
                     CASE WHEN ? = 'skipped' THEN ? ELSE NULL END)`,
          )
          .run(
            params.updateId,
            params.rawJson,
            initialStatus,
            params.addressed ? 1 : 0,
            params.chat.chatId,
            params.message.messageId,
            maxAttempts,
            initialError,
            nowMs,
            nowMs,
            initialStatus,
            nowMs,
          );
      }

      let turn: StoredBotTurn | undefined;
      if (reserveTurn) {
        const reservation = this.db
          .prepare(
            `INSERT INTO bot_turns (
               update_id, chat_id, trigger_message_id, status, attempts, max_attempts,
               created_at_ms, updated_at_ms
             )
             VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)
             ON CONFLICT(chat_id, trigger_message_id) DO NOTHING`,
          )
          .run(params.updateId, params.chat.chatId, params.message.messageId, maxAttempts, nowMs, nowMs);
        turn = this.getBotTurnByTriggerLocked(params.chat.chatId, params.message.messageId);
        if (reservation.changes > 0 && triggerCooldown) {
          this.updateSendCooldownLocked(
            params.chat.chatId,
            botTriggerCooldownKey(triggerCooldown.userKey),
            nowMs + triggerCooldown.cooldownMs,
            nowMs,
          );
        } else if (reservation.changes === 0) {
          this.db
            .prepare(
              `UPDATE bot_updates
               SET status = 'skipped',
                   error = 'A bot turn is already reserved for this trigger message.',
                   updated_at_ms = ?, completed_at_ms = ?
               WHERE update_id = ?`,
            )
            .run(nowMs, nowMs, params.updateId);
        }
      }

      const update = this.getBotUpdateLocked(params.updateId);
      if (!update) {
        throw new Error("Durable bot update disappeared before transaction commit.");
      }
      if (reserveTurn && !turn) {
        throw new Error("Addressed bot update committed without a durable bot turn reservation.");
      }
      return {
        disposition: existing ? "recovered" : "ingested",
        ackUpdateId: params.updateId,
        update,
        turn,
        ...(cooldownRetryAfterMs > 0
          ? { throttled: { retryAfterMs: cooldownRetryAfterMs } }
          : {}),
      };
    });
  }

  recordBotUpdateFailure(params: {
    updateId: number;
    rawJson: string;
    error: string;
    maxAttempts?: number;
    nowMs?: number;
  }): BotUpdateFailureResult {
    assertBotUpdateId(params.updateId);
    const nowMs = params.nowMs ?? Date.now();
    assertTimestamp(nowMs, "nowMs");
    const requestedMaxAttempts = normalizeBotMaxAttempts(params.maxAttempts);
    const error = params.error.trim() || "Bot update could not be decoded.";

    return this.immediateTransaction("recordBotUpdateFailure", () => {
      const existing = this.getBotUpdateLocked(params.updateId);
      if (!existing) {
        const status: BotDurableStatus = requestedMaxAttempts === 1 ? "dead_letter" : "failed";
        this.db
          .prepare(
            `INSERT INTO bot_updates (
               update_id, raw_json, status, addressed, attempts, max_attempts, error,
               received_at_ms, updated_at_ms, completed_at_ms
             )
             VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, CASE WHEN ? = 'dead_letter' THEN ? ELSE NULL END)`,
          )
          .run(
            params.updateId,
            params.rawJson,
            status,
            requestedMaxAttempts,
            error,
            nowMs,
            nowMs,
            status,
            nowMs,
          );
      } else if (existing.status === "failed" && existing.chatId == null && existing.triggerMessageId == null) {
        const attempts = Math.min(existing.attempts + 1, existing.maxAttempts);
        const status: BotDurableStatus = attempts >= existing.maxAttempts ? "dead_letter" : "failed";
        this.db
          .prepare(
            `UPDATE bot_updates
             SET status = ?, attempts = ?, error = ?, updated_at_ms = ?,
                 completed_at_ms = CASE WHEN ? = 'dead_letter' THEN ? ELSE NULL END
             WHERE update_id = ? AND status = 'failed'
               AND chat_id IS NULL AND trigger_message_id IS NULL`,
          )
          .run(status, attempts, error, nowMs, status, nowMs, params.updateId);
      }

      const update = this.getBotUpdateLocked(params.updateId);
      if (!update) {
        throw new Error("Durable poison-update row disappeared before transaction commit.");
      }
      return {
        update,
        // A row that was already decoded and durably committed remains
        // acknowledgeable even if a later binary/configuration can no longer
        // decode its redelivery. Only a still-retryable poison row with no
        // chat/trigger identity may hold the Bot API offset.
        ackUpdateId:
          update.status === "dead_letter" ||
          (update.chatId != null && update.triggerMessageId != null)
            ? update.updateId
            : undefined,
      };
    });
  }

  getBotUpdate(updateId: number): StoredBotUpdate | undefined {
    assertBotUpdateId(updateId);
    return this.getBotUpdateLocked(updateId);
  }

  queryBotUpdates(params: { statuses?: BotDurableStatus[]; limit?: number } = {}): StoredBotUpdate[] {
    const limit = normalizeQueryLimit(params.limit);
    const statuses = normalizeBotStatuses(params.statuses);
    const where = statuses.length > 0 ? `WHERE status IN (${statuses.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM bot_updates ${where} ORDER BY update_id ASC LIMIT ?`)
      .all(...toSqlValues([...statuses, limit])) as Record<string, unknown>[];
    return rows.map(rowToStoredBotUpdate);
  }

  protected upsertBotMessageLocked(message: StoredMessage): void {
    const previous = this.getMessageForDirtyCheck(message.chatId, message.messageId);
    this.db
      .prepare(
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
      )
      .run(
        message.chatId,
        message.messageId,
        message.date ?? null,
        message.senderId ?? null,
        message.senderName ?? null,
        message.text,
        message.replyToMessageId ?? null,
        message.topicId ?? null,
        message.rawJson ?? null,
        message.deletedAt ?? null,
      );
    if (
      previous &&
      embeddingMessageSourceChanged(previous, message)
    ) {
      this.markEmbeddingChunksDirtyForMessagesLocked(message.chatId, [message.messageId]);
    }
  }

  protected getBotUpdateLocked(updateId: number): StoredBotUpdate | undefined {
    const row = this.db.prepare("SELECT * FROM bot_updates WHERE update_id = ?").get(updateId) as
      | Record<string, unknown>
      | undefined;
    return row == null ? undefined : rowToStoredBotUpdate(row);
  }
}

export type BotUpdateApi = Pick<
  BotUpdateMethods,
  | "ingestBotUpdate"
  | "recordBotUpdateFailure"
  | "getBotUpdate"
  | "queryBotUpdates"
>;

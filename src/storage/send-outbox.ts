import { ToolError } from "../errors.js";
import { StoreCore } from "./core.js";
import {
  RESTART_EXPIRED_SEND_ERROR,
  UNKNOWN_DELIVERY_ERROR,
} from "./constants.js";
import { rowToSendOutboxItem } from "./mappers.js";
import { toSqlValues } from "./sqlite-utils.js";
import type {
  SendReservation,
  SendStartupReconciliation,
  StoredSendOutboxItem,
} from "./types.js";
import {
  assertTimestamp,
  botTriggerCooldownKey,
  isUnknownDelivery,
} from "./validation.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class SendOutboxMethods extends StoreCore {

  reserveSend(params: {
    outboxId: string;
    dedupeKey?: string;
    payloadHash: string;
    chatId: string;
    replyToMessageId?: number;
    userKey: string;
    nowMs: number;
    maxAgeMs: number;
    userCooldownMs: number;
    maxPendingPerUserPerChat: number;
    maxQueuePerChat: number;
  }): SendReservation {
    const expiresAtMs = params.nowMs + params.maxAgeMs;
    return this.immediateTransaction("reserveSend", () => {
      this.expireStaleSendsLocked(params.nowMs);
      const existing = params.dedupeKey == null ? undefined : this.getSendByDedupeKeyLocked(params.dedupeKey);
      if (existing) {
        if (isUnknownDelivery(existing)) {
          throw new ToolError({
            category: "internal",
            retryable: false,
            message:
              "Previous send with this dedupe_key has an unknown Telegram delivery state; refusing automatic retry.",
          });
        }
        if (existing.status === "sending") {
          throw new ToolError({
            category: "internal",
            retryable: false,
            message:
              "Send with this dedupe_key is or was in-flight; Telegram delivery state is unknown, so automatic retry is refused.",
          });
        }
        if (existing.payloadHash !== params.payloadHash) {
          throw new ToolError({
            category: "rate_limit",
            retryable: false,
            message: "dedupe_key has already been used for a different send payload.",
          });
        }
        if (existing.status === "sent") {
          return {
            kind: "duplicate_sent",
            outboxId: existing.id,
            chatId: existing.chatId,
            telegramMessageId: existing.telegramMessageId,
          };
        }
        if (existing.status === "queued" && existing.expiresAtMs > params.nowMs) {
          throw new ToolError({
            category: "rate_limit",
            retryable: true,
            message: "Send with this dedupe_key is already queued or sending.",
          });
        }
      }

      this.assertSendThrottleAvailable(params);

      if (existing) {
        this.db
          .prepare(
            `UPDATE send_outbox
             SET chat_id = ?, reply_to_message_id = ?, user_key = ?, status = 'queued',
                 telegram_message_id = NULL, error = NULL, updated_at_ms = ?,
                 queued_at_ms = ?, sending_at_ms = NULL, sent_at_ms = NULL, expires_at_ms = ?
             WHERE id = ?`,
          )
          .run(
            params.chatId,
            params.replyToMessageId ?? null,
            params.userKey,
            params.nowMs,
            params.nowMs,
            expiresAtMs,
            existing.id,
          );
        this.updateSendCooldownLocked(params.chatId, params.userKey, params.nowMs + params.userCooldownMs, params.nowMs);
        return { kind: "queued", outboxId: existing.id, expiresAtMs };
      }

      this.db
        .prepare(
          `INSERT INTO send_outbox (
             id, dedupe_key, payload_hash, chat_id, reply_to_message_id, user_key,
             status, created_at_ms, updated_at_ms, queued_at_ms, expires_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(
          params.outboxId,
          params.dedupeKey ?? null,
          params.payloadHash,
          params.chatId,
          params.replyToMessageId ?? null,
          params.userKey,
          params.nowMs,
          params.nowMs,
          params.nowMs,
          expiresAtMs,
        );
      this.updateSendCooldownLocked(params.chatId, params.userKey, params.nowMs + params.userCooldownMs, params.nowMs);
      return { kind: "queued", outboxId: params.outboxId, expiresAtMs };
    });
  }

  markSendSending(outboxId: string, nowMs = Date.now()): boolean {
    return this.writeWithRetry("markSendSending", () => {
      const result = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'sending', sending_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(nowMs, nowMs, outboxId);
      return result.changes > 0;
    });
  }

  markSendSent(outboxId: string, telegramMessageId: number | undefined, nowMs = Date.now()): boolean {
    return this.writeWithRetry("markSendSent", () => {
      const result = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'sent', telegram_message_id = ?, sent_at_ms = ?, updated_at_ms = ?, error = NULL
           WHERE id = ? AND status = 'sending'`,
        )
        .run(telegramMessageId ?? null, nowMs, nowMs, outboxId);
      return result.changes > 0;
    });
  }

  markSendFailed(outboxId: string, error: string, nowMs = Date.now()): boolean {
    return this.writeWithRetry("markSendFailed", () => {
      const result = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'failed', error = ?, updated_at_ms = ?
           WHERE id = ? AND status IN ('queued', 'sending')`,
        )
        .run(error, nowMs, outboxId);
      return result.changes > 0;
    });
  }

  markSendDeliveryUnknown(outboxId: string, nowMs = Date.now()): boolean {
    return this.writeWithRetry("markSendDeliveryUnknown", () => {
      const result = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'failed', error = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'sending'`,
        )
        .run(UNKNOWN_DELIVERY_ERROR, nowMs, outboxId);
      return result.changes > 0;
    });
  }

  markSendExpired(outboxId: string, error = "Queued send expired before execution.", nowMs = Date.now()): boolean {
    return this.writeWithRetry("markSendExpired", () => {
      const result = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'expired', error = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(error, nowMs, outboxId);
      return result.changes > 0;
    });
  }

  getSendOutboxByDedupeKey(dedupeKey: string): StoredSendOutboxItem | undefined {
    return this.getSendByDedupeKeyLocked(dedupeKey);
  }

  reconcileActiveSendsOnStartup(nowMs = Date.now()): SendStartupReconciliation {
    return this.immediateTransaction("reconcileActiveSendsOnStartup", () => {
      const queued = this.db
        .prepare(
          `UPDATE send_outbox
           SET status = 'expired',
               error = COALESCE(error, ?),
               updated_at_ms = ?
           WHERE status = 'queued' AND expires_at_ms <= ?`,
        )
        .run(RESTART_EXPIRED_SEND_ERROR, nowMs, nowMs);
      return {
        expiredQueued: Number(queued.changes ?? 0),
        // A MessageStore does not own the process that created an outbox row.
        // Another MCP process may still be sending it, so startup must never
        // rewrite `sending`. The row itself is the durable unknown-delivery
        // guard: reserveSend refuses to reuse its dedupe key.
        markedUnknownDelivery: 0,
      };
    });
  }

  protected assertSendThrottleAvailable(params: {
    chatId: string;
    userKey: string;
    nowMs: number;
    maxPendingPerUserPerChat: number;
    maxQueuePerChat: number;
  }): void {
    const cooldown = this.db
      .prepare(
        `SELECT next_allowed_at_ms
         FROM send_throttle_state
         WHERE chat_id = ? AND user_key = ?`,
      )
      .get(params.chatId, params.userKey) as Record<string, unknown> | undefined;
    const nextAllowedAtMs = Number(cooldown?.next_allowed_at_ms ?? 0);
    if (nextAllowedAtMs > params.nowMs) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        retryAfterSec: Math.ceil((nextAllowedAtMs - params.nowMs) / 1000),
        message: "Per-user cooldown is active.",
      });
    }

    const pendingUser = this.countActiveSendsLocked({
      chatId: params.chatId,
      userKey: params.userKey,
      nowMs: params.nowMs,
    });
    if (pendingUser >= params.maxPendingPerUserPerChat) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        message: "Per-user pending limit reached.",
      });
    }

    const pendingChat = this.countActiveSendsLocked({
      chatId: params.chatId,
      nowMs: params.nowMs,
    });
    if (pendingChat >= params.maxQueuePerChat) {
      throw new ToolError({
        category: "rate_limit",
        retryable: true,
        message: "Per-chat queue is full.",
      });
    }
  }

  protected countActiveSendsLocked(params: { chatId: string; userKey?: string; nowMs: number }): number {
    const clauses = ["chat_id = ?", "status IN ('queued', 'sending')", "expires_at_ms > ?"];
    const values: unknown[] = [params.chatId, params.nowMs];
    if (params.userKey != null) {
      clauses.push("user_key = ?");
      values.push(params.userKey);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM send_outbox WHERE ${clauses.join(" AND ")}`)
      .get(...toSqlValues(values)) as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  }

  protected updateSendCooldownLocked(chatId: string, userKey: string, nextAllowedAtMs: number, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO send_throttle_state (chat_id, user_key, next_allowed_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, user_key) DO UPDATE SET
           next_allowed_at_ms = excluded.next_allowed_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(chatId, userKey, nextAllowedAtMs, nowMs);
  }

  protected getBotTriggerCooldownRetryAfterLocked(
    chatId: string,
    userKey: string,
    nowMs: number,
  ): number {
    const row = this.db
      .prepare(
        `SELECT next_allowed_at_ms
         FROM send_throttle_state
         WHERE chat_id = ? AND user_key = ?`,
      )
      .get(
        chatId,
        botTriggerCooldownKey(userKey),
      ) as Record<string, unknown> | undefined;
    const nextAllowedAtMs = Number(row?.next_allowed_at_ms ?? 0);
    return Number.isSafeInteger(nextAllowedAtMs) && nextAllowedAtMs > nowMs
      ? nextAllowedAtMs - nowMs
      : 0;
  }

  protected expireStaleSendsLocked(nowMs: number): void {
    this.db
      .prepare(
        `UPDATE send_outbox
         SET status = 'expired', error = COALESCE(error, 'Queued send expired before execution.'), updated_at_ms = ?
         WHERE status = 'queued' AND expires_at_ms <= ?`,
      )
      .run(nowMs, nowMs);
  }

  protected getSendByDedupeKeyLocked(dedupeKey: string): StoredSendOutboxItem | undefined {
    const row = this.db.prepare("SELECT * FROM send_outbox WHERE dedupe_key = ?").get(dedupeKey) as
      | Record<string, unknown>
      | undefined;
    return row == null ? undefined : rowToSendOutboxItem(row);
  }
}

export type SendOutboxApi = Pick<
  SendOutboxMethods,
  | "reserveSend"
  | "markSendSending"
  | "markSendSent"
  | "markSendFailed"
  | "markSendDeliveryUnknown"
  | "markSendExpired"
  | "getSendOutboxByDedupeKey"
  | "reconcileActiveSendsOnStartup"
>;

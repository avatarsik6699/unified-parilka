import { StoreCore } from "./core.js";
import { toSqlValues } from "./sqlite-utils.js";
import {
  assertCalendarDay,
  assertNonEmptyBounded,
  assertPositiveSafeInteger,
  assertTimestamp,
} from "./validation.js";
import type {
  DreamDayStatus,
  StoredDreamDay,
  UpsertDreamDayInput,
} from "./types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * Tracks idempotent per-chat, per-day Dream review jobs. A day is only
 * considered completed after the review result has been applied.
 */
export abstract class DreamDaysMethods extends StoreCore {
  getDreamDay(params: {
    chatId: string;
    day: string;
  }): StoredDreamDay | undefined {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    assertCalendarDay(params.day, "day");
    const row = this.db
      .prepare(
        `SELECT
           chat_id, day, status, source_hash, interaction_count,
           first_message_id, last_message_id, attempts, error,
           model, provider, created_at_ms, updated_at_ms, completed_at_ms
         FROM bot_chat_dream_days
         WHERE chat_id = ? AND day = ?`,
      )
      .get(params.chatId, params.day) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToStoredDreamDay(row);
  }

  listDreamDays(params: {
    chatId: string;
    limit?: number;
    status?: DreamDayStatus;
  }): StoredDreamDay[] {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    const limit = params.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("limit must be an integer between 1 and 1000.");
    }
    const clauses = ["chat_id = ?"];
    const values: unknown[] = [params.chatId];
    if (params.status !== undefined) {
      clauses.push("status = ?");
      values.push(params.status);
    }
    values.push(limit);
    const rows = this.db
      .prepare(
        `SELECT
           chat_id, day, status, source_hash, interaction_count,
           first_message_id, last_message_id, attempts, error,
           model, provider, created_at_ms, updated_at_ms, completed_at_ms
         FROM bot_chat_dream_days
         WHERE ${clauses.join(" AND ")}
         ORDER BY day ASC
         LIMIT ?`,
      )
      .all(...toSqlValues(values)) as Record<string, unknown>[];
    return rows.map(rowToStoredDreamDay);
  }

  upsertDreamDay(input: UpsertDreamDayInput): StoredDreamDay {
    return this.immediateTransaction("upsertDreamDay", () =>
      this.upsertDreamDayLocked(input),
    );
  }

  /**
   * Assumes the caller already owns a `BEGIN IMMEDIATE` boundary.
   */
  protected upsertDreamDayLocked(input: UpsertDreamDayInput): StoredDreamDay {
    assertNonEmptyBounded(input.chatId, 256, "chatId");
    assertCalendarDay(input.day, "day");
    if (input.firstMessageId !== undefined) {
      assertPositiveSafeInteger(input.firstMessageId, "firstMessageId");
    }
    if (input.lastMessageId !== undefined) {
      assertPositiveSafeInteger(input.lastMessageId, "lastMessageId");
    }
    const nowMs = input.updatedAtMs ?? Date.now();
    assertTimestamp(nowMs, "updatedAtMs");
    this.db
      .prepare(
        `INSERT INTO bot_chat_dream_days (
           chat_id, day, status, source_hash, interaction_count,
           first_message_id, last_message_id, attempts, error,
           model, provider, created_at_ms, updated_at_ms, completed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, day) DO UPDATE SET
           status = excluded.status,
           source_hash = excluded.source_hash,
           interaction_count = excluded.interaction_count,
           first_message_id = excluded.first_message_id,
           last_message_id = excluded.last_message_id,
           attempts = excluded.attempts,
           error = excluded.error,
           model = excluded.model,
           provider = excluded.provider,
           updated_at_ms = excluded.updated_at_ms,
           completed_at_ms = excluded.completed_at_ms`,
      )
      .run(
        input.chatId,
        input.day,
        input.status,
        input.sourceHash ?? null,
        input.interactionCount,
        input.firstMessageId ?? null,
        input.lastMessageId ?? null,
        input.attempts,
        input.error ?? null,
        input.model ?? null,
        input.provider ?? null,
        input.createdAtMs ?? nowMs,
        nowMs,
        input.completedAtMs ?? null,
      );
    const stored = this.getDreamDay({
      chatId: input.chatId,
      day: input.day,
    });
    if (!stored) {
      throw new Error("Dream day disappeared after upsert.");
    }
    return stored;
  }
}

function rowToStoredDreamDay(row: Record<string, unknown>): StoredDreamDay {
  return {
    chatId: String(row.chat_id),
    day: String(row.day),
    status: String(row.status) as DreamDayStatus,
    ...(row.source_hash == null
      ? {}
      : { sourceHash: String(row.source_hash) }),
    interactionCount: Number(row.interaction_count ?? 0),
    ...(row.first_message_id == null
      ? {}
      : { firstMessageId: Number(row.first_message_id) }),
    ...(row.last_message_id == null
      ? {}
      : { lastMessageId: Number(row.last_message_id) }),
    attempts: Number(row.attempts ?? 0),
    ...(row.error == null ? {} : { error: String(row.error) }),
    ...(row.model == null ? {} : { model: String(row.model) }),
    ...(row.provider == null ? {} : { provider: String(row.provider) }),
    createdAtMs: Number(row.created_at_ms ?? 0),
    updatedAtMs: Number(row.updated_at_ms ?? 0),
    ...(row.completed_at_ms == null
      ? {}
      : { completedAtMs: Number(row.completed_at_ms) }),
  };
}

export type DreamDaysApi = Pick<
  DreamDaysMethods,
  "getDreamDay" | "listDreamDays" | "upsertDreamDay"
>;

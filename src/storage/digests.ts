import { StoreCore } from "./core.js";
import {
  rowToStoredDayDigest,
  rowToStoredDigestRollup,
  rowToStoredMessage,
} from "./mappers.js";
import type {
  DigestMessageDateBounds,
  StoredDayDigest,
  StoredDigestRollup,
  StoredMessage,
  UpsertDayDigestInput,
  UpsertDigestRollupInput,
} from "./types.js";
import {
  assertCalendarDay,
  assertNonEmptyBounded,
  assertTimestamp,
  boundedDigestQueryLimit,
  validateDayDigestInput,
  validateDigestRollupInput,
} from "./validation.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class DigestMethods extends StoreCore {

  upsertDayDigest(input: UpsertDayDigestInput): StoredDayDigest {
    const stored = this.commitDayDigestIfCurrent(input, () => true);
    if (!stored) {
      throw new Error("Day digest disappeared after upsert.");
    }
    return stored;
  }

  /**
   * Revalidates a digest source while holding SQLite's write reservation, then
   * commits on the same connection. A concurrent sync writer therefore cannot
   * change source messages between the caller's final hash check and the row
   * upsert.
   */
  commitDayDigestIfCurrent(
    input: UpsertDayDigestInput,
    sourceIsCurrent: () => boolean,
  ): StoredDayDigest | undefined {
    validateDayDigestInput(input);
    const createdAtMs = input.createdAtMs ?? Date.now();
    assertTimestamp(createdAtMs, "createdAtMs");
    return this.immediateTransaction("commitDayDigestIfCurrent", () => {
      if (!sourceIsCurrent()) {
        return undefined;
      }
      this.db
        .prepare(
          `INSERT INTO chat_day_digests (
             chat_id, day, start_message_id, end_message_id, message_count,
             text, prompt_version, model, input_tokens, output_tokens,
             source_hash, created_at_ms, updated_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, day) DO UPDATE SET
             start_message_id = excluded.start_message_id,
             end_message_id = excluded.end_message_id,
             message_count = excluded.message_count,
             text = excluded.text,
             prompt_version = excluded.prompt_version,
             model = excluded.model,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             source_hash = excluded.source_hash,
             created_at_ms = excluded.created_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          input.chatId,
          input.day,
          input.startMessageId,
          input.endMessageId,
          input.messageCount,
          input.text,
          input.promptVersion,
          input.model ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.sourceHash ?? null,
          createdAtMs,
          createdAtMs,
        );
      const stored = this.getDayDigests({
        chatId: input.chatId,
        dayFrom: input.day,
        dayTo: input.day,
        limit: 1,
      })[0];
      if (!stored) {
        throw new Error("Day digest disappeared before transaction commit.");
      }
      return stored;
    });
  }

  /**
   * Removes a stale day digest and every weekly rollup that depended on it in
   * one transaction. Keeping the cascade here avoids a crash window in which
   * callers could expose a weekly digest after its source day disappeared.
   */
  deleteDayDigest(params: {
    chatId: string;
    day: string;
  }): { dayDeleted: boolean; weekRollupsDeleted: number } {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    assertCalendarDay(params.day, "day");
    return this.immediateTransaction("deleteDayDigest", () => {
      const weeks = this.db
        .prepare(
          `DELETE FROM chat_digest_rollups
           WHERE chat_id = ?
             AND kind = 'week'
             AND day_from <= ?
             AND day_to >= ?`,
        )
        .run(params.chatId, params.day, params.day);
      const day = this.db
        .prepare(
          `DELETE FROM chat_day_digests
           WHERE chat_id = ? AND day = ?`,
        )
        .run(params.chatId, params.day);
      return {
        dayDeleted: Number(day.changes ?? 0) > 0,
        weekRollupsDeleted: Number(weeks.changes ?? 0),
      };
    });
  }

  getDayDigests(params: {
    chatId: string;
    dayFrom: string;
    dayTo: string;
    limit?: number;
  }): StoredDayDigest[] {
    assertCalendarDay(params.dayFrom, "dayFrom");
    assertCalendarDay(params.dayTo, "dayTo");
    const [dayFrom, dayTo] =
      params.dayFrom <= params.dayTo
        ? [params.dayFrom, params.dayTo]
        : [params.dayTo, params.dayFrom];
    const limit = boundedDigestQueryLimit(params.limit);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM chat_day_digests
         WHERE chat_id = ? AND day BETWEEN ? AND ?
         ORDER BY day DESC
         LIMIT ?`,
      )
      .all(params.chatId, dayFrom, dayTo, limit) as Record<string, unknown>[];
    return rows.map(rowToStoredDayDigest);
  }

  listDayDigests(chatId: string): StoredDayDigest[] {
    assertNonEmptyBounded(chatId, 256, "chatId");
    const rows = this.db
      .prepare(
        `SELECT *
         FROM chat_day_digests
         WHERE chat_id = ?
         ORDER BY day ASC`,
      )
      .all(chatId) as Record<string, unknown>[];
    return rows.map(rowToStoredDayDigest);
  }

  getDigestMessageDateBounds(
    chatId: string,
  ): DigestMessageDateBounds | undefined {
    assertNonEmptyBounded(chatId, 256, "chatId");
    const baseSql = `FROM messages
      WHERE chat_id = ?
        AND deleted_at IS NULL
        AND length(trim(text)) > 0
        AND date IS NOT NULL
        AND julianday(date) IS NOT NULL`;
    const first = this.db
      .prepare(
        `SELECT date ${baseSql}
         ORDER BY date ASC, message_id ASC
         LIMIT 1`,
      )
      .get(chatId) as Record<string, unknown> | undefined;
    if (first?.date == null) {
      return undefined;
    }
    const last = this.db
      .prepare(
        `SELECT date ${baseSql}
         ORDER BY date DESC, message_id DESC
         LIMIT 1`,
      )
      .get(chatId) as Record<string, unknown> | undefined;
    if (last?.date == null) {
      throw new Error("Digest message date bounds became inconsistent.");
    }
    return {
      firstDate: String(first.date),
      lastDate: String(last.date),
    };
  }

  getDigestSourceMessages(params: {
    chatId: string;
    startInclusive: string;
    endExclusive: string;
  }): StoredMessage[] {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    const startMs = Date.parse(params.startInclusive);
    const endMs = Date.parse(params.endExclusive);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      throw new Error(
        "Digest source range must contain valid increasing ISO instants.",
      );
    }
    const rows = this.db
      .prepare(
        `SELECT *
         FROM messages
         WHERE chat_id = ?
           AND deleted_at IS NULL
           AND length(trim(text)) > 0
           AND date IS NOT NULL
           AND date >= ?
           AND date < ?
           AND julianday(date) IS NOT NULL
         ORDER BY date ASC, message_id ASC`,
      )
      .all(
        params.chatId,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
      ) as Record<string, unknown>[];
    return rows.map(rowToStoredMessage);
  }

  upsertDigestRollup(input: UpsertDigestRollupInput): StoredDigestRollup {
    const stored = this.commitDigestRollupIfCurrent(input, () => true);
    if (!stored) {
      throw new Error("Digest rollup disappeared after upsert.");
    }
    return stored;
  }

  commitDigestRollupIfCurrent(
    input: UpsertDigestRollupInput,
    sourceIsCurrent: () => boolean,
  ): StoredDigestRollup | undefined {
    validateDigestRollupInput(input);
    const createdAtMs = input.createdAtMs ?? Date.now();
    assertTimestamp(createdAtMs, "createdAtMs");
    return this.immediateTransaction(
      "commitDigestRollupIfCurrent",
      () => {
        if (!sourceIsCurrent()) {
          return undefined;
        }
        this.db
          .prepare(
            `INSERT INTO chat_digest_rollups (
             chat_id, kind, period, day_from, day_to, day_count,
             text, prompt_version, model, input_tokens, output_tokens,
             source_hash, created_at_ms, updated_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chat_id, kind, period) DO UPDATE SET
             day_from = excluded.day_from,
             day_to = excluded.day_to,
             day_count = excluded.day_count,
             text = excluded.text,
             prompt_version = excluded.prompt_version,
             model = excluded.model,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             source_hash = excluded.source_hash,
             created_at_ms = excluded.created_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
          )
          .run(
            input.chatId,
            input.kind,
            input.period,
            input.dayFrom,
            input.dayTo,
            input.dayCount,
            input.text,
            input.promptVersion,
            input.model ?? null,
            input.inputTokens ?? null,
            input.outputTokens ?? null,
            input.sourceHash ?? null,
            createdAtMs,
            createdAtMs,
          );
        const stored = this.getDigestRollups({
          chatId: input.chatId,
          kind: input.kind,
          dayFrom: input.dayFrom,
          dayTo: input.dayTo,
          limit: 400,
        }).find((digest) => digest.period === input.period);
        if (!stored) {
          throw new Error(
            "Digest rollup disappeared before transaction commit.",
          );
        }
        return stored;
      },
    );
  }

  deleteDigestRollup(params: {
    chatId: string;
    kind: "week" | "month";
    period: string;
  }): boolean {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    assertNonEmptyBounded(params.period, 32, "period");
    return this.writeWithRetry(
      "deleteDigestRollup",
      () =>
        Number(
          this.db
            .prepare(
              `DELETE FROM chat_digest_rollups
               WHERE chat_id = ? AND kind = ? AND period = ?`,
            )
            .run(params.chatId, params.kind, params.period).changes ??
            0,
        ) > 0,
    );
  }

  getDigestRollups(params: {
    chatId: string;
    kind: "week" | "month";
    dayFrom: string;
    dayTo: string;
    limit?: number;
  }): StoredDigestRollup[] {
    assertCalendarDay(params.dayFrom, "dayFrom");
    assertCalendarDay(params.dayTo, "dayTo");
    const [dayFrom, dayTo] =
      params.dayFrom <= params.dayTo
        ? [params.dayFrom, params.dayTo]
        : [params.dayTo, params.dayFrom];
    const limit = boundedDigestQueryLimit(params.limit);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM chat_digest_rollups
         WHERE chat_id = ? AND kind = ?
           AND day_to >= ? AND day_from <= ?
         ORDER BY day_from DESC, period DESC
         LIMIT ?`,
      )
      .all(
        params.chatId,
        params.kind,
        dayFrom,
        dayTo,
        limit,
      ) as Record<string, unknown>[];
    return rows.map(rowToStoredDigestRollup);
  }
}

export type DigestApi = Pick<
  DigestMethods,
  | "upsertDayDigest"
  | "commitDayDigestIfCurrent"
  | "deleteDayDigest"
  | "getDayDigests"
  | "listDayDigests"
  | "getDigestMessageDateBounds"
  | "getDigestSourceMessages"
  | "upsertDigestRollup"
  | "commitDigestRollupIfCurrent"
  | "deleteDigestRollup"
  | "getDigestRollups"
>;

import { StoreCore } from "./core.js";
import { rowToAssistantCuriosityTriggerState } from "./mappers.js";
import type { StoredAssistantCuriosityTriggerState } from "./types.js";

const MAX_RECENT_TOPICS = 20;

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 *
 * Backs the assistant persona's "curiosity" trigger: per-chat
 * rate-limit/cooldown state (mirrors `human-persona.ts`'s trigger state) plus
 * a bounded recent-topic log the decision prompt uses to avoid repeating
 * itself. There is no proposal queue here -- the assistant persona sends
 * directly, see `src/storage/schema/migrations.ts`'s
 * `applyAssistantCuriosityMigration`.
 */
export abstract class AssistantCuriosityMethods extends StoreCore {
  getAssistantCuriosityTriggerState(
    chatId: string,
  ): StoredAssistantCuriosityTriggerState | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM assistant_curiosity_trigger_state WHERE chat_id = ?`,
      )
      .get(chatId) as Record<string, unknown> | undefined;
    return row == null ? undefined : rowToAssistantCuriosityTriggerState(row);
  }

  recordAssistantCuriosityTriggerCheck(
    chatId: string,
    nowMs = Date.now(),
  ): void {
    this.writeWithRetry("recordAssistantCuriosityTriggerCheck", () => {
      this.db
        .prepare(
          `INSERT INTO assistant_curiosity_trigger_state (
             chat_id, last_checked_at_ms, updated_at_ms
           )
           VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             last_checked_at_ms = excluded.last_checked_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(chatId, nowMs, nowMs);
    });
  }

  /**
   * Records that the assistant asked a curiosity question, resetting the
   * rate-limit counter when the caller's window has rolled over (window
   * bookkeeping is the caller's responsibility, same contract as
   * `recordHumanPersonaInitiation`) and storing the sent message id so a
   * later reply can be matched back to it.
   */
  recordAssistantCuriosityInitiation(params: {
    chatId: string;
    windowStartMs: number;
    askedMessageId: number;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    this.writeWithRetry("recordAssistantCuriosityInitiation", () => {
      const existing = this.db
        .prepare(
          `SELECT window_start_ms, initiated_count_in_window
           FROM assistant_curiosity_trigger_state
           WHERE chat_id = ?`,
        )
        .get(params.chatId) as Record<string, unknown> | undefined;
      const sameWindow =
        Number(existing?.window_start_ms ?? -1) === params.windowStartMs;
      const nextCount = sameWindow
        ? Number(existing?.initiated_count_in_window ?? 0) + 1
        : 1;
      this.db
        .prepare(
          `INSERT INTO assistant_curiosity_trigger_state (
             chat_id, last_initiated_at_ms, last_checked_at_ms,
             window_start_ms, initiated_count_in_window,
             last_asked_message_id, last_asked_answered_at_ms, updated_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             last_initiated_at_ms = excluded.last_initiated_at_ms,
             last_checked_at_ms = excluded.last_checked_at_ms,
             window_start_ms = excluded.window_start_ms,
             initiated_count_in_window = excluded.initiated_count_in_window,
             last_asked_message_id = excluded.last_asked_message_id,
             last_asked_answered_at_ms = NULL,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          params.chatId,
          nowMs,
          nowMs,
          params.windowStartMs,
          nextCount,
          params.askedMessageId,
          nowMs,
        );
    });
  }

  /**
   * Marks the currently-pending curiosity question answered, but only if
   * `replyToMessageId` is the exact message the assistant is waiting on --
   * a stale or foreign reply id is silently ignored. Mirrors
   * `getClaimedHumanPersonaProposalByApprovalMessage`'s "match by id, no-op
   * otherwise" shape.
   */
  recordAssistantCuriosityAnswerIfMatches(
    chatId: string,
    replyToMessageId: number,
    nowMs = Date.now(),
  ): boolean {
    return this.writeWithRetry(
      "recordAssistantCuriosityAnswerIfMatches",
      () => {
        const result = this.db
          .prepare(
            `UPDATE assistant_curiosity_trigger_state
             SET last_asked_answered_at_ms = ?, updated_at_ms = ?
             WHERE chat_id = ?
               AND last_asked_message_id = ?
               AND last_asked_answered_at_ms IS NULL`,
          )
          .run(nowMs, nowMs, chatId, replyToMessageId);
        return result.changes > 0;
      },
    );
  }

  recordAssistantCuriosityTopic(
    chatId: string,
    topicSummary: string,
    nowMs = Date.now(),
  ): void {
    this.writeWithRetry("recordAssistantCuriosityTopic", () => {
      this.db
        .prepare(
          `INSERT INTO assistant_curiosity_topic_log (chat_id, asked_at_ms, topic_summary)
           VALUES (?, ?, ?)`,
        )
        .run(chatId, nowMs, topicSummary);
      this.db
        .prepare(
          `DELETE FROM assistant_curiosity_topic_log
           WHERE chat_id = ?
             AND id NOT IN (
               SELECT id FROM assistant_curiosity_topic_log
               WHERE chat_id = ?
               ORDER BY asked_at_ms DESC
               LIMIT ?
             )`,
        )
        .run(chatId, chatId, MAX_RECENT_TOPICS);
    });
  }

  getRecentAssistantCuriosityTopics(
    chatId: string,
    limit = MAX_RECENT_TOPICS,
  ): string[] {
    const boundedLimit = Math.min(Math.max(1, limit), MAX_RECENT_TOPICS);
    const rows = this.db
      .prepare(
        `SELECT topic_summary FROM assistant_curiosity_topic_log
         WHERE chat_id = ?
         ORDER BY asked_at_ms DESC
         LIMIT ?`,
      )
      .all(chatId, boundedLimit) as Record<string, unknown>[];
    return rows.map((row) => String(row.topic_summary));
  }
}

export type AssistantCuriosityApi = Pick<
  AssistantCuriosityMethods,
  | "getAssistantCuriosityTriggerState"
  | "recordAssistantCuriosityTriggerCheck"
  | "recordAssistantCuriosityInitiation"
  | "recordAssistantCuriosityAnswerIfMatches"
  | "recordAssistantCuriosityTopic"
  | "getRecentAssistantCuriosityTopics"
>;

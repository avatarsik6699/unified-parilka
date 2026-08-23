import { StoreCore } from "./core.js";
import {
  rowToHumanPersonaProposal,
  rowToHumanPersonaStyleProfile,
  rowToHumanPersonaTriggerState,
  rowToStoredMessage,
} from "./mappers.js";
import type {
  HumanPersonaAutonomyMode,
  HumanPersonaProposalStatus,
  StoredHumanPersonaProposal,
  StoredHumanPersonaStyleProfile,
  StoredHumanPersonaTriggerState,
  StoredMessage,
  UpsertHumanPersonaStyleProfileInput,
} from "./types.js";

const MAX_STYLE_SOURCE_MESSAGES = 5_000;

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 *
 * Backs the "human" persona role (plan Фаза 4a-4f/5): style-profile
 * documents, per-(persona, chat) trigger/rate-limit state, and the
 * approval-workflow proposal queue shared between `bot-agi-sync` (proposes,
 * sends) and `bot-agi-bot` (posts/decides approvals, see 4d).
 */
export abstract class HumanPersonaMethods extends StoreCore {
  upsertHumanPersonaStyleProfile(
    input: UpsertHumanPersonaStyleProfileInput,
    nowMs = Date.now(),
  ): void {
    this.writeWithRetry("upsertHumanPersonaStyleProfile", () => {
      this.db
        .prepare(
          `INSERT INTO human_persona_style_profile (
             persona_id, target_user_key, profile_text, example_messages_json,
             source_hash, consent_basis, model, provider, created_at_ms, updated_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(persona_id, target_user_key) DO UPDATE SET
             profile_text = excluded.profile_text,
             example_messages_json = excluded.example_messages_json,
             source_hash = excluded.source_hash,
             consent_basis = excluded.consent_basis,
             model = excluded.model,
             provider = excluded.provider,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          input.personaId,
          input.targetUserKey,
          input.profileText,
          JSON.stringify(input.exampleMessages),
          input.sourceHash,
          input.consentBasis,
          input.model,
          input.provider,
          nowMs,
          nowMs,
        );
    });
  }

  /**
   * Source messages for the style-profile pipeline (4f): a target person's
   * own text in one chat, newest first, bounded so a very long history
   * cannot blow the source budget. `targetUserKey` matches either the
   * Telegram sender id or sender display name, mirroring `searchLexical`'s
   * `sender` filter.
   */
  getHumanPersonaStyleSourceMessages(
    chatId: string,
    targetUserKey: string,
    limit = MAX_STYLE_SOURCE_MESSAGES,
  ): StoredMessage[] {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      MAX_STYLE_SOURCE_MESSAGES,
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ?
           AND deleted_at IS NULL
           AND length(trim(text)) > 0
           AND (sender_id = ? OR sender_name = ?)
         ORDER BY message_id DESC
         LIMIT ?`,
      )
      .all(chatId, targetUserKey, targetUserKey, boundedLimit) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToStoredMessage);
  }

  getHumanPersonaStyleProfile(
    personaId: string,
    targetUserKey: string,
  ): StoredHumanPersonaStyleProfile | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM human_persona_style_profile
         WHERE persona_id = ? AND target_user_key = ?`,
      )
      .get(personaId, targetUserKey) as Record<string, unknown> | undefined;
    return row == null ? undefined : rowToHumanPersonaStyleProfile(row);
  }

  getHumanPersonaTriggerState(
    personaId: string,
    chatId: string,
  ): StoredHumanPersonaTriggerState | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM human_persona_trigger_state
         WHERE persona_id = ? AND chat_id = ?`,
      )
      .get(personaId, chatId) as Record<string, unknown> | undefined;
    return row == null ? undefined : rowToHumanPersonaTriggerState(row);
  }

  recordHumanPersonaTriggerCheck(
    personaId: string,
    chatId: string,
    nowMs = Date.now(),
  ): void {
    this.writeWithRetry("recordHumanPersonaTriggerCheck", () => {
      this.db
        .prepare(
          `INSERT INTO human_persona_trigger_state (
             persona_id, chat_id, last_checked_at_ms, updated_at_ms
           )
           VALUES (?, ?, ?, ?)
           ON CONFLICT(persona_id, chat_id) DO UPDATE SET
             last_checked_at_ms = excluded.last_checked_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(personaId, chatId, nowMs, nowMs);
    });
  }

  /**
   * Records that the persona initiated a message, resetting the rate-limit
   * counter when the caller's window has rolled over. Window bookkeeping
   * (what "window" means for a given persona's rate limit) is the caller's
   * responsibility; this only stores the counter and its start.
   */
  recordHumanPersonaInitiation(
    personaId: string,
    chatId: string,
    windowStartMs: number,
    nowMs = Date.now(),
  ): void {
    this.writeWithRetry("recordHumanPersonaInitiation", () => {
      const existing = this.db
        .prepare(
          `SELECT window_start_ms, initiated_count_in_window
           FROM human_persona_trigger_state
           WHERE persona_id = ? AND chat_id = ?`,
        )
        .get(personaId, chatId) as Record<string, unknown> | undefined;
      const sameWindow =
        Number(existing?.window_start_ms ?? -1) === windowStartMs;
      const nextCount = sameWindow
        ? Number(existing?.initiated_count_in_window ?? 0) + 1
        : 1;
      this.db
        .prepare(
          `INSERT INTO human_persona_trigger_state (
             persona_id, chat_id, last_initiated_at_ms, last_checked_at_ms,
             window_start_ms, initiated_count_in_window, updated_at_ms
           )
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(persona_id, chat_id) DO UPDATE SET
             last_initiated_at_ms = excluded.last_initiated_at_ms,
             last_checked_at_ms = excluded.last_checked_at_ms,
             window_start_ms = excluded.window_start_ms,
             initiated_count_in_window = excluded.initiated_count_in_window,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(personaId, chatId, nowMs, nowMs, windowStartMs, nextCount, nowMs);
    });
  }

  createHumanPersonaProposal(params: {
    id: string;
    personaId: string;
    chatId: string;
    proposedText: string;
    autonomyMode: HumanPersonaAutonomyMode;
    nowMs?: number;
  }): StoredHumanPersonaProposal {
    const nowMs = params.nowMs ?? Date.now();
    return this.immediateTransaction("createHumanPersonaProposal", () => {
      this.db
        .prepare(
          `INSERT INTO human_persona_pending_proposal (
             id, persona_id, chat_id, proposed_text, status, autonomy_mode,
             created_at_ms, updated_at_ms
           )
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          params.id,
          params.personaId,
          params.chatId,
          params.proposedText,
          params.autonomyMode,
          nowMs,
          nowMs,
        );
      return this.getHumanPersonaProposalLocked(params.id)!;
    });
  }

  /**
   * Claims the oldest pending proposal for a persona so exactly one caller
   * (the `bot-agi-bot` approval poster, see plan 4d/5 Шаг 5) posts it to the
   * approval chat. Returns undefined when nothing is pending.
   */
  claimNextPendingHumanPersonaProposal(
    personaId: string,
    claimedBy: string,
    nowMs = Date.now(),
  ): StoredHumanPersonaProposal | undefined {
    return this.immediateTransaction(
      "claimNextPendingHumanPersonaProposal",
      () => {
        const row = this.db
          .prepare(
            `SELECT id FROM human_persona_pending_proposal
           WHERE persona_id = ? AND status = 'pending'
           ORDER BY created_at_ms ASC
           LIMIT 1`,
          )
          .get(personaId) as Record<string, unknown> | undefined;
        if (row == null) {
          return undefined;
        }
        this.db
          .prepare(
            `UPDATE human_persona_pending_proposal
           SET status = 'claimed', claimed_by = ?, claimed_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'pending'`,
          )
          .run(claimedBy, nowMs, nowMs, String(row.id));
        return this.getHumanPersonaProposalLocked(String(row.id));
      },
    );
  }

  recordHumanPersonaApprovalPosted(
    id: string,
    approvalChatId: string,
    approvalMessageId: number,
    nowMs = Date.now(),
  ): boolean {
    return this.writeWithRetry("recordHumanPersonaApprovalPosted", () => {
      const result = this.db
        .prepare(
          `UPDATE human_persona_pending_proposal
           SET approval_chat_id = ?, approval_message_id = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'claimed'`,
        )
        .run(approvalChatId, approvalMessageId, nowMs, id);
      return result.changes > 0;
    });
  }

  recordHumanPersonaProposalDecision(
    id: string,
    status: Extract<
      HumanPersonaProposalStatus,
      "approved" | "rejected" | "regenerate_requested" | "edited"
    >,
    finalText: string | undefined,
    nowMs = Date.now(),
  ): boolean {
    return this.writeWithRetry("recordHumanPersonaProposalDecision", () => {
      const result = this.db
        .prepare(
          `UPDATE human_persona_pending_proposal
           SET status = ?, final_text = ?, decided_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'claimed'`,
        )
        .run(status, finalText ?? null, nowMs, nowMs, id);
      return result.changes > 0;
    });
  }

  markHumanPersonaProposalSent(id: string, nowMs = Date.now()): boolean {
    return this.writeWithRetry("markHumanPersonaProposalSent", () => {
      const result = this.db
        .prepare(
          `UPDATE human_persona_pending_proposal
           SET status = 'sent', updated_at_ms = ?
           WHERE id = ? AND status IN ('approved', 'edited')`,
        )
        .run(nowMs, id);
      return result.changes > 0;
    });
  }

  getHumanPersonaProposal(id: string): StoredHumanPersonaProposal | undefined {
    return this.getHumanPersonaProposalLocked(id);
  }

  protected getHumanPersonaProposalLocked(
    id: string,
  ): StoredHumanPersonaProposal | undefined {
    const row = this.db
      .prepare("SELECT * FROM human_persona_pending_proposal WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row == null ? undefined : rowToHumanPersonaProposal(row);
  }
}

export type HumanPersonaApi = Pick<
  HumanPersonaMethods,
  | "getHumanPersonaStyleSourceMessages"
  | "upsertHumanPersonaStyleProfile"
  | "getHumanPersonaStyleProfile"
  | "getHumanPersonaTriggerState"
  | "recordHumanPersonaTriggerCheck"
  | "recordHumanPersonaInitiation"
  | "createHumanPersonaProposal"
  | "claimNextPendingHumanPersonaProposal"
  | "recordHumanPersonaApprovalPosted"
  | "recordHumanPersonaProposalDecision"
  | "markHumanPersonaProposalSent"
  | "getHumanPersonaProposal"
>;

import { StoreCore } from "./core.js";
import { assertCalendarDay, assertNonEmptyBounded, assertTimestamp } from "./validation.js";
import type { DreamAudit, StoredDreamAudit } from "./dream-audit-types.js";
import {
  deserializeAndValidateAudit,
  serializeAudit,
  validateAndBoundAudit,
} from "./dream-audit-codec.js";

export { MAX_AUDIT_JSON_BYTES } from "./dream-audit-codec.js";
export type { DreamAudit, StoredDreamAudit } from "./dream-audit-types.js";
export {
  computeDreamAudit,
  deserializeAndValidateAudit,
  serializeAudit,
  validateAndBoundAudit,
} from "./dream-audit-codec.js";
export type { DreamAuditSnapshots } from "./dream-audit-types.js";

export abstract class DreamAuditMethods extends StoreCore {
  getDreamAudit(params: { chatId: string; day: string }): StoredDreamAudit | undefined {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    assertCalendarDay(params.day, "day");
    const row = this.db
      .prepare(
        `SELECT chat_id, day, audit_json, created_at_ms
         FROM bot_chat_dream_audits WHERE chat_id = ? AND day = ?`,
      )
      .get(params.chatId, params.day) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const rowChatId = String(row.chat_id);
    const rowDay = String(row.day);
    assertNonEmptyBounded(rowChatId, 256, "chatId");
    assertCalendarDay(rowDay, "day");
    if (rowChatId !== params.chatId) throw new Error("Audit row chat_id mismatch.");
    if (rowDay !== params.day) throw new Error("Audit row day mismatch.");
    const createdAtMs = Number(row.created_at_ms);
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new Error("Audit row invalid created_at_ms.");
    }
    const audit = deserializeAndValidateAudit(String(row.audit_json));
    if (audit.chatId !== params.chatId) throw new Error("Audit root chatId mismatch with row.");
    if (audit.day !== params.day) throw new Error("Audit root day mismatch with row.");
    return { chatId: rowChatId, day: rowDay, audit, createdAtMs };
  }

  listDreamAudits(params: { chatId: string; limit?: number }): StoredDreamAudit[] {
    assertNonEmptyBounded(params.chatId, 256, "chatId");
    const limit = params.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("limit must be an integer between 1 and 1000.");
    }
    const rows = this.db
      .prepare(
        `SELECT chat_id, day, audit_json, created_at_ms
         FROM bot_chat_dream_audits WHERE chat_id = ? ORDER BY day DESC LIMIT ?`,
      )
      .all(params.chatId, limit) as Record<string, unknown>[];
    return rows.map((row) => {
      const rowChatId = String(row.chat_id);
      const rowDay = String(row.day);
      assertNonEmptyBounded(rowChatId, 256, "chatId");
      if (rowChatId !== params.chatId) throw new Error("Audit row chat_id mismatch.");
      assertCalendarDay(rowDay, "day");
      const createdAtMs = Number(row.created_at_ms);
      if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
        throw new Error("Audit row invalid created_at_ms.");
      }
      const audit = deserializeAndValidateAudit(String(row.audit_json));
      if (audit.chatId !== rowChatId) throw new Error("Audit root chatId mismatch with row.");
      if (audit.day !== rowDay) throw new Error("Audit root day mismatch with row.");
      return { chatId: rowChatId, day: rowDay, audit, createdAtMs };
    });
  }

  protected insertDreamAuditLocked(input: {
    chatId: string;
    day: string;
    audit: DreamAudit;
    nowMs: number;
  }): void {
    assertNonEmptyBounded(input.chatId, 256, "chatId");
    assertCalendarDay(input.day, "day");
    if (input.audit.chatId !== input.chatId) throw new Error("Audit root chatId must match input chatId.");
    if (input.audit.day !== input.day) throw new Error("Audit root day must match input day.");
    assertTimestamp(input.nowMs, "nowMs");
    validateAndBoundAudit(input.audit);
    const json = serializeAudit(input.audit);
    this.db
      .prepare(
        `INSERT INTO bot_chat_dream_audits (chat_id, day, audit_json, created_at_ms) VALUES (?, ?, ?, ?)`,
      )
      .run(input.chatId, input.day, json, input.nowMs);
  }

  protected dreamAuditExistsLocked(chatId: string, day: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM bot_chat_dream_audits WHERE chat_id = ? AND day = ?`)
      .get(chatId, day) as Record<string, unknown> | undefined;
    return row?.present === 1;
  }
}

export type DreamAuditApi = Pick<DreamAuditMethods, "getDreamAudit" | "listDreamAudits">;

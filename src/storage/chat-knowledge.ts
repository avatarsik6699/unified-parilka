import { StoreCore } from "./core.js";
import {
  assertNonEmptyBounded,
  assertPositiveSafeInteger,
  assertTimestamp,
} from "./validation.js";
import type {
  StoredChatLesson,
  StoredChatSkill,
  StoredFastChatMemory,
  UpsertChatLessonInput,
  UpsertChatSkillInput,
  UpsertFastChatMemoryInput,
} from "./types.js";

export const MAX_FAST_CHAT_MEMORY_ITEMS = 12;
export const MAX_CHAT_LESSONS = 64;
export const MAX_CHAT_SKILLS = 32;

export const MAX_FAST_TITLE_CHARS = 160;
export const MAX_FAST_NOTE_CHARS = 800;
export const MAX_LESSON_TITLE_CHARS = 160;
export const MAX_LESSON_FIELD_CHARS = 1_200;
export const MAX_SKILL_NAME_CHARS = 120;
export const MAX_SKILL_DESCRIPTION_CHARS = 400;
export const MAX_SKILL_INSTRUCTIONS_CHARS = 4_000;
export const MAX_KNOWLEDGE_QUERY_CHARS = 240;

const EMBEDDED_SECRET = /(?:\b(?:sk[-_][A-Za-z0-9._-]{12,}|ya29\.[A-Za-z0-9._-]{16,}|\d{6,16}:[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b|[?&](?:access[_-]?token|api[_-]?(?:key|hash)|authorization|bearer|credential|password|secret|token)=[^&\s]{8,})/iu;
const SENSITIVE_ASSIGNMENT = /\b(?:api[_ -]?(?:key|hash)|authorization|bearer|credential|password|private[_ -]?key|secret|token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/iu;

/**
 * Chat-local memory beyond the periodic Dream summary:
 *
 * - fast notes are short and eagerly injected;
 * - lessons retain problem/solution/guardrail and are searched on demand;
 * - skills use progressive disclosure (index first, full instructions later).
 *
 * Every mutation is bounded, source-attributed and rejects likely credentials.
 */
export abstract class ChatKnowledgeMethods extends StoreCore {
  listFastChatMemory(
    chatId: string,
    limit = MAX_FAST_CHAT_MEMORY_ITEMS,
  ): StoredFastChatMemory[] {
    assertChatId(chatId);
    const boundedLimit = boundedLimitFor(
      limit,
      MAX_FAST_CHAT_MEMORY_ITEMS,
      "fast memory limit",
    );
    return (this.db
      .prepare(
        `SELECT chat_id, memory_key, title, note, source_message_id,
                created_at_ms, updated_at_ms
         FROM bot_chat_fast_memory
         WHERE chat_id = ?
         ORDER BY updated_at_ms DESC, rowid DESC
         LIMIT ?`,
      )
      .all(chatId, boundedLimit) as Record<string, unknown>[])
      .map(rowToStoredFastMemory);
  }

  upsertFastChatMemory(
    input: UpsertFastChatMemoryInput,
  ): StoredFastChatMemory {
    return this.immediateTransaction("upsertFastChatMemory", () =>
      this.upsertFastChatMemoryLocked(input),
    );
  }

  /**
   * Assumes the caller already owns a `BEGIN IMMEDIATE` boundary.
   */
  protected upsertFastChatMemoryLocked(
    input: UpsertFastChatMemoryInput,
  ): StoredFastChatMemory {
    assertChatId(input.chatId);
    assertSafeKnowledgeText(input.title, MAX_FAST_TITLE_CHARS, "title");
    assertSafeKnowledgeText(input.note, MAX_FAST_NOTE_CHARS, "note");
    assertSourceMessageId(input.sourceMessageId);
    const key = normalizedKnowledgeKey(input.title, MAX_FAST_TITLE_CHARS);
    const requestedAtMs = input.updatedAtMs ?? Date.now();
    assertTimestamp(requestedAtMs, "updatedAtMs");

    const updatedAtMs = this.nextKnowledgeUpdatedAt(
      "bot_chat_fast_memory",
      "memory_key",
      input.chatId,
      key,
      requestedAtMs,
    );
    this.db
      .prepare(
        `INSERT INTO bot_chat_fast_memory (
           chat_id, memory_key, title, note, source_message_id,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, memory_key) DO UPDATE SET
           title = excluded.title,
           note = excluded.note,
           source_message_id = excluded.source_message_id,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        input.chatId,
        key,
        input.title.trim(),
        input.note.trim(),
        input.sourceMessageId ?? null,
        updatedAtMs,
        updatedAtMs,
      );
    this.pruneKnowledgeRows(
      "bot_chat_fast_memory",
      input.chatId,
      MAX_FAST_CHAT_MEMORY_ITEMS,
    );
    return this.requireFastMemory(input.chatId, key);
  }

  listChatLessons(
    chatId: string,
    limit = MAX_CHAT_LESSONS,
  ): StoredChatLesson[] {
    assertChatId(chatId);
    const boundedLimit = boundedLimitFor(
      limit,
      MAX_CHAT_LESSONS,
      "lesson limit",
    );
    return (this.db
      .prepare(
        `SELECT chat_id, lesson_key, title, problem, solution, when_to_apply,
                source_message_id, created_at_ms, updated_at_ms
         FROM bot_chat_lessons
         WHERE chat_id = ?
         ORDER BY updated_at_ms DESC, rowid DESC
         LIMIT ?`,
      )
      .all(chatId, boundedLimit) as Record<string, unknown>[])
      .map(rowToStoredLesson);
  }

  searchChatLessons(input: {
    chatId: string;
    query: string;
    limit?: number;
  }): StoredChatLesson[] {
    assertChatId(input.chatId);
    assertNonEmptyBounded(
      input.query,
      MAX_KNOWLEDGE_QUERY_CHARS,
      "lesson query",
    );
    const limit = boundedLimitFor(
      input.limit ?? 6,
      12,
      "lesson search limit",
    );
    // SQLite's built-in NOCASE/LOWER only covers ASCII. The table is bounded
    // to 64 rows per chat, so normalize and search the complete local lesson
    // set in TypeScript to make Cyrillic lookup behave predictably too.
    const query = normalizedKnowledgeSearchText(input.query);
    return this.listChatLessons(input.chatId, MAX_CHAT_LESSONS)
      .filter((lesson) => [
        lesson.title,
        lesson.problem,
        lesson.solution,
        lesson.whenToApply,
      ].some((value) => normalizedKnowledgeSearchText(value).includes(query)))
      .slice(0, limit);
  }

  upsertChatLesson(input: UpsertChatLessonInput): StoredChatLesson {
    return this.immediateTransaction("upsertChatLesson", () =>
      this.upsertChatLessonLocked(input),
    );
  }

  /**
   * Assumes the caller already owns a `BEGIN IMMEDIATE` boundary.
   */
  protected upsertChatLessonLocked(
    input: UpsertChatLessonInput,
  ): StoredChatLesson {
    assertChatId(input.chatId);
    assertSafeKnowledgeText(input.title, MAX_LESSON_TITLE_CHARS, "title");
    assertSafeKnowledgeText(input.problem, MAX_LESSON_FIELD_CHARS, "problem");
    assertSafeKnowledgeText(input.solution, MAX_LESSON_FIELD_CHARS, "solution");
    assertSafeKnowledgeText(
      input.whenToApply,
      MAX_LESSON_FIELD_CHARS,
      "whenToApply",
    );
    assertSourceMessageId(input.sourceMessageId);
    const key = normalizedKnowledgeKey(input.title, MAX_LESSON_TITLE_CHARS);
    const requestedAtMs = input.updatedAtMs ?? Date.now();
    assertTimestamp(requestedAtMs, "updatedAtMs");

    const updatedAtMs = this.nextKnowledgeUpdatedAt(
      "bot_chat_lessons",
      "lesson_key",
      input.chatId,
      key,
      requestedAtMs,
    );
    this.db
      .prepare(
        `INSERT INTO bot_chat_lessons (
           chat_id, lesson_key, title, problem, solution, when_to_apply,
           source_message_id, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, lesson_key) DO UPDATE SET
           title = excluded.title,
           problem = excluded.problem,
           solution = excluded.solution,
           when_to_apply = excluded.when_to_apply,
           source_message_id = excluded.source_message_id,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        input.chatId,
        key,
        input.title.trim(),
        input.problem.trim(),
        input.solution.trim(),
        input.whenToApply.trim(),
        input.sourceMessageId ?? null,
        updatedAtMs,
        updatedAtMs,
      );
    this.pruneKnowledgeRows(
      "bot_chat_lessons",
      input.chatId,
      MAX_CHAT_LESSONS,
    );
    return this.requireLesson(input.chatId, key);
  }

  listChatSkills(
    chatId: string,
    limit = MAX_CHAT_SKILLS,
  ): StoredChatSkill[] {
    assertChatId(chatId);
    const boundedLimit = boundedLimitFor(
      limit,
      MAX_CHAT_SKILLS,
      "skill limit",
    );
    return (this.db
      .prepare(
        `SELECT chat_id, skill_key, name, description, instructions,
                source_message_id, created_at_ms, updated_at_ms
         FROM bot_chat_skills
         WHERE chat_id = ?
         ORDER BY updated_at_ms DESC, rowid DESC
         LIMIT ?`,
      )
      .all(chatId, boundedLimit) as Record<string, unknown>[])
      .map(rowToStoredSkill);
  }

  getChatSkill(input: {
    chatId: string;
    name: string;
  }): StoredChatSkill | undefined {
    assertChatId(input.chatId);
    assertNonEmptyBounded(input.name, MAX_SKILL_NAME_CHARS, "skill name");
    const key = normalizedKnowledgeKey(input.name, MAX_SKILL_NAME_CHARS);
    const row = this.db
      .prepare(
        `SELECT chat_id, skill_key, name, description, instructions,
                source_message_id, created_at_ms, updated_at_ms
         FROM bot_chat_skills
         WHERE chat_id = ? AND skill_key = ?`,
      )
      .get(input.chatId, key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToStoredSkill(row);
  }

  upsertChatSkill(input: UpsertChatSkillInput): StoredChatSkill {
    return this.immediateTransaction("upsertChatSkill", () =>
      this.upsertChatSkillLocked(input),
    );
  }

  /**
   * Assumes the caller already owns a `BEGIN IMMEDIATE` boundary.
   */
  protected upsertChatSkillLocked(
    input: UpsertChatSkillInput,
  ): StoredChatSkill {
    assertChatId(input.chatId);
    assertSafeKnowledgeText(input.name, MAX_SKILL_NAME_CHARS, "name");
    assertSafeKnowledgeText(
      input.description,
      MAX_SKILL_DESCRIPTION_CHARS,
      "description",
    );
    assertSafeKnowledgeText(
      input.instructions,
      MAX_SKILL_INSTRUCTIONS_CHARS,
      "instructions",
    );
    assertSourceMessageId(input.sourceMessageId);
    const key = normalizedKnowledgeKey(input.name, MAX_SKILL_NAME_CHARS);
    const requestedAtMs = input.updatedAtMs ?? Date.now();
    assertTimestamp(requestedAtMs, "updatedAtMs");

    const updatedAtMs = this.nextKnowledgeUpdatedAt(
      "bot_chat_skills",
      "skill_key",
      input.chatId,
      key,
      requestedAtMs,
    );
    this.db
      .prepare(
        `INSERT INTO bot_chat_skills (
           chat_id, skill_key, name, description, instructions,
           source_message_id, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, skill_key) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           instructions = excluded.instructions,
           source_message_id = excluded.source_message_id,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        input.chatId,
        key,
        input.name.trim(),
        input.description.trim(),
        input.instructions.trim(),
        input.sourceMessageId ?? null,
        updatedAtMs,
        updatedAtMs,
      );
    this.pruneKnowledgeRows(
      "bot_chat_skills",
      input.chatId,
      MAX_CHAT_SKILLS,
    );
    const stored = this.getChatSkill({ chatId: input.chatId, name: key });
    if (!stored) {
      throw new Error("Chat skill disappeared after upsert.");
    }
    return stored;
  }

  private requireFastMemory(
    chatId: string,
    key: string,
  ): StoredFastChatMemory {
    const row = this.db
      .prepare(
        `SELECT chat_id, memory_key, title, note, source_message_id,
                created_at_ms, updated_at_ms
         FROM bot_chat_fast_memory
         WHERE chat_id = ? AND memory_key = ?`,
      )
      .get(chatId, key) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("Fast chat memory disappeared after upsert.");
    }
    return rowToStoredFastMemory(row);
  }

  private requireLesson(chatId: string, key: string): StoredChatLesson {
    const row = this.db
      .prepare(
        `SELECT chat_id, lesson_key, title, problem, solution, when_to_apply,
                source_message_id, created_at_ms, updated_at_ms
         FROM bot_chat_lessons
         WHERE chat_id = ? AND lesson_key = ?`,
      )
      .get(chatId, key) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("Chat lesson disappeared after upsert.");
    }
    return rowToStoredLesson(row);
  }

  private nextKnowledgeUpdatedAt(
    table: "bot_chat_fast_memory" | "bot_chat_lessons" | "bot_chat_skills",
    keyColumn: "memory_key" | "lesson_key" | "skill_key",
    chatId: string,
    key: string,
    requestedAtMs: number,
  ): number {
    const row = this.db
      .prepare(
        `SELECT updated_at_ms FROM ${table}
         WHERE chat_id = ? AND ${keyColumn} = ?`,
      )
      .get(chatId, key) as Record<string, unknown> | undefined;
    const previous = Number(row?.updated_at_ms ?? -1);
    return Math.max(requestedAtMs, previous + 1);
  }

  private pruneKnowledgeRows(
    table: "bot_chat_fast_memory" | "bot_chat_lessons" | "bot_chat_skills",
    chatId: string,
    keep: number,
  ): void {
    this.db
      .prepare(
        `DELETE FROM ${table}
         WHERE chat_id = ?
           AND rowid NOT IN (
             SELECT rowid FROM ${table}
             WHERE chat_id = ?
             ORDER BY updated_at_ms DESC, rowid DESC
             LIMIT ?
           )`,
      )
      .run(chatId, chatId, keep);
  }
}

export type ChatKnowledgeApi = Pick<
  ChatKnowledgeMethods,
  | "listFastChatMemory"
  | "upsertFastChatMemory"
  | "listChatLessons"
  | "searchChatLessons"
  | "upsertChatLesson"
  | "listChatSkills"
  | "getChatSkill"
  | "upsertChatSkill"
>;

function assertChatId(chatId: string): void {
  assertNonEmptyBounded(chatId, 256, "chatId");
}

function assertSourceMessageId(value: number | undefined): void {
  if (value !== undefined) {
    assertPositiveSafeInteger(value, "sourceMessageId");
  }
}

export function assertSafeKnowledgeText(
  value: string,
  maximumLength: number,
  fieldName: string,
): void {
  assertNonEmptyBounded(value, maximumLength, fieldName);
  if (EMBEDDED_SECRET.test(value) || SENSITIVE_ASSIGNMENT.test(value)) {
    throw new Error(`${fieldName} must not contain credentials or secrets.`);
  }
}

export function normalizedKnowledgeKey(
  value: string,
  maximumLength: number,
): string {
  const key = value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
  assertNonEmptyBounded(key, maximumLength, "knowledge key");
  return key;
}

function boundedLimitFor(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizedKnowledgeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

function rowToStoredFastMemory(
  row: Record<string, unknown>,
): StoredFastChatMemory {
  return {
    chatId: String(row.chat_id),
    key: String(row.memory_key),
    title: String(row.title),
    note: String(row.note),
    ...(row.source_message_id == null
      ? {}
      : { sourceMessageId: Number(row.source_message_id) }),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function rowToStoredLesson(row: Record<string, unknown>): StoredChatLesson {
  return {
    chatId: String(row.chat_id),
    key: String(row.lesson_key),
    title: String(row.title),
    problem: String(row.problem),
    solution: String(row.solution),
    whenToApply: String(row.when_to_apply),
    ...(row.source_message_id == null
      ? {}
      : { sourceMessageId: Number(row.source_message_id) }),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function rowToStoredSkill(row: Record<string, unknown>): StoredChatSkill {
  return {
    chatId: String(row.chat_id),
    key: String(row.skill_key),
    name: String(row.name),
    description: String(row.description),
    instructions: String(row.instructions),
    ...(row.source_message_id == null
      ? {}
      : { sourceMessageId: Number(row.source_message_id) }),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

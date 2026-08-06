import {
  assertSafeKnowledgeText,
  MAX_CHAT_LESSONS,
  MAX_CHAT_SKILLS,
  MAX_FAST_CHAT_MEMORY_ITEMS,
  MAX_FAST_NOTE_CHARS,
  MAX_FAST_TITLE_CHARS,
  MAX_KNOWLEDGE_QUERY_CHARS,
  MAX_LESSON_FIELD_CHARS,
  MAX_LESSON_TITLE_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_SKILL_NAME_CHARS,
  normalizedKnowledgeKey,
} from "../storage/chat-knowledge.js";
import {
  assertNonEmptyBounded,
  assertPositiveSafeInteger,
  assertTimestamp,
} from "../storage/validation.js";
import type {
  StoredChatLesson,
  StoredChatMemory,
  StoredChatSkill,
  StoredFastChatMemory,
  UpsertChatLessonInput,
  UpsertChatMemoryInput,
  UpsertChatSkillInput,
  UpsertFastChatMemoryInput,
} from "../store.js";
import type { DreamKnowledgeStore } from "./skill-manager.js";

/**
 * Shared across a day overlay and every fork (including discarded attempts).
 * Guarantees strictly increasing logical timestamps even when wall-clock is
 * fixed, so capacity pruning follows tool-call order rather than key order.
 */
export type LogicalClock = {
  /** Allocate the next strictly increasing timestamp. */
  next: () => number;
  /** Advance the clock to at least `value` and return the effective stamp. */
  observe: (value: number) => number;
};

export function createLogicalClock(now: () => number = () => Date.now()): LogicalClock {
  let last = 0;
  return {
    next(): number {
      const wall = now();
      last = Math.max(wall, last + 1);
      return last;
    },
    observe(value: number): number {
      assertTimestamp(value, "updatedAtMs");
      last = Math.max(last, value);
      // Effective stamp is the advanced clock, never a stale older raw value.
      return last;
    },
  };
}

/**
 * In-memory Dream knowledge overlay.
 *
 * Read tools see committed base rows plus staged rows; staged keys shadow
 * committed. Successful earlier batches remain visible to later batches via
 * the day-level overlay. Generation attempts fork a child overlay so timed-out
 * or invalid candidates discard their writes without leaking into the day
 * stage or SQLite.
 */
export class StagedKnowledgeOverlay implements DreamKnowledgeStore {
  readonly #base: DreamKnowledgeStore;
  readonly #clock: LogicalClock;
  readonly #fast = new Map<string, StoredFastChatMemory>();
  readonly #lessons = new Map<string, StoredChatLesson>();
  readonly #skills = new Map<string, StoredChatSkill>();
  #memoryOverride: StoredChatMemory | undefined;

  constructor(
    base: DreamKnowledgeStore,
    options: { now?: () => number; clock?: LogicalClock } = {},
  ) {
    this.#base = base;
    this.#clock =
      options.clock ?? createLogicalClock(options.now ?? (() => Date.now()));
  }

  /** Child overlay whose base is this stage (for attempt isolation). */
  fork(): StagedKnowledgeOverlay {
    // Share the same logical clock so discarded attempts still advance it.
    return new StagedKnowledgeOverlay(this, { clock: this.#clock });
  }

  /** Absorb a successful attempt's staged writes into this day stage. */
  mergeFrom(child: StagedKnowledgeOverlay): void {
    for (const [key, value] of child.#fast) {
      this.#fast.set(key, value);
    }
    for (const [key, value] of child.#lessons) {
      this.#lessons.set(key, value);
    }
    for (const [key, value] of child.#skills) {
      this.#skills.set(key, value);
    }
    if (child.#memoryOverride !== undefined) {
      this.#memoryOverride = child.#memoryOverride;
    }
  }

  /** Replace the staged semantic memory block after a successful batch final. */
  setStagedSemanticMemory(input: {
    chatId: string;
    memoryText: string;
    lastConsolidatedMessageId?: number;
    revision?: number;
    updatedAtMs?: number;
  }): void {
    const updatedAtMs = this.#allocateUpdatedAtMs(
      input.updatedAtMs,
      this.getChatMemory(input.chatId)?.updatedAtMs,
    );
    const previous = this.getChatMemory(input.chatId);
    this.#memoryOverride = {
      chatId: input.chatId,
      memoryText: input.memoryText,
      lastConsolidatedMessageId:
        input.lastConsolidatedMessageId ?? previous?.lastConsolidatedMessageId,
      revision: input.revision ?? (previous?.revision ?? 0) + 1,
      updatedAtMs,
    };
  }

  getChatMemory(chatId: string): StoredChatMemory | undefined {
    if (this.#memoryOverride?.chatId === chatId) {
      return this.#memoryOverride;
    }
    return this.#base.getChatMemory(chatId);
  }

  listFastChatMemory(
    chatId: string,
    limit = MAX_FAST_CHAT_MEMORY_ITEMS,
  ): StoredFastChatMemory[] {
    const bounded = boundedLimit(limit, MAX_FAST_CHAT_MEMORY_ITEMS, "fast memory limit");
    const merged = new Map<string, StoredFastChatMemory>();
    for (const item of this.#base.listFastChatMemory(chatId, MAX_FAST_CHAT_MEMORY_ITEMS)) {
      if (item.chatId === chatId) {
        merged.set(item.key, item);
      }
    }
    for (const item of this.#fast.values()) {
      if (item.chatId === chatId) {
        merged.set(item.key, item);
      }
    }
    return sortByRecency([...merged.values()]).slice(0, bounded);
  }

  upsertFastChatMemory(
    input: UpsertFastChatMemoryInput,
  ): StoredFastChatMemory {
    assertChatId(input.chatId);
    assertSafeKnowledgeText(input.title, MAX_FAST_TITLE_CHARS, "title");
    assertSafeKnowledgeText(input.note, MAX_FAST_NOTE_CHARS, "note");
    assertSourceMessageId(input.sourceMessageId);
    const key = normalizedKnowledgeKey(input.title, MAX_FAST_TITLE_CHARS);
    const previous =
      this.#fast.get(key) ??
      this.#base
        .listFastChatMemory(input.chatId, MAX_FAST_CHAT_MEMORY_ITEMS)
        .find((item) => item.key === key);
    const updatedAtMs = this.#allocateUpdatedAtMs(
      input.updatedAtMs,
      previous?.updatedAtMs,
    );
    const stored: StoredFastChatMemory = {
      chatId: input.chatId,
      key,
      title: input.title.trim(),
      note: input.note.trim(),
      ...(input.sourceMessageId == null
        ? {}
        : { sourceMessageId: input.sourceMessageId }),
      createdAtMs: previous?.createdAtMs ?? updatedAtMs,
      updatedAtMs,
    };
    this.#fast.set(key, stored);
    this.#pruneLocalMap("fast", this.#fast, input.chatId, MAX_FAST_CHAT_MEMORY_ITEMS);
    return stored;
  }

  listChatLessons(
    chatId: string,
    limit = MAX_CHAT_LESSONS,
  ): StoredChatLesson[] {
    const bounded = boundedLimit(limit, MAX_CHAT_LESSONS, "lesson limit");
    const merged = new Map<string, StoredChatLesson>();
    for (const item of this.#base.listChatLessons(chatId, MAX_CHAT_LESSONS)) {
      if (item.chatId === chatId) {
        merged.set(item.key, item);
      }
    }
    for (const item of this.#lessons.values()) {
      if (item.chatId === chatId) {
        merged.set(item.key, item);
      }
    }
    return sortByRecency([...merged.values()]).slice(0, bounded);
  }

  searchChatLessons(input: {
    chatId: string;
    query: string;
    limit?: number;
  }): StoredChatLesson[] {
    assertChatId(input.chatId);
    assertNonEmptyBounded(input.query, MAX_KNOWLEDGE_QUERY_CHARS, "lesson query");
    const limit = boundedLimit(input.limit ?? 6, 12, "lesson search limit");
    const query = normalizeSearch(input.query);
    return this.listChatLessons(input.chatId, MAX_CHAT_LESSONS)
      .filter((lesson) =>
        [lesson.title, lesson.problem, lesson.solution, lesson.whenToApply].some(
          (value) => normalizeSearch(value).includes(query),
        ),
      )
      .slice(0, limit);
  }

  upsertChatLesson(input: UpsertChatLessonInput): StoredChatLesson {
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
    const previous =
      this.#lessons.get(key) ??
      this.#base
        .listChatLessons(input.chatId, MAX_CHAT_LESSONS)
        .find((item) => item.key === key);
    const updatedAtMs = this.#allocateUpdatedAtMs(
      input.updatedAtMs,
      previous?.updatedAtMs,
    );
    const stored: StoredChatLesson = {
      chatId: input.chatId,
      key,
      title: input.title.trim(),
      problem: input.problem.trim(),
      solution: input.solution.trim(),
      whenToApply: input.whenToApply.trim(),
      ...(input.sourceMessageId == null
        ? {}
        : { sourceMessageId: input.sourceMessageId }),
      createdAtMs: previous?.createdAtMs ?? updatedAtMs,
      updatedAtMs,
    };
    this.#lessons.set(key, stored);
    this.#pruneLocalMap("lessons", this.#lessons, input.chatId, MAX_CHAT_LESSONS);
    return stored;
  }

  listChatSkills(
    chatId: string,
    limit = MAX_CHAT_SKILLS,
  ): StoredChatSkill[] {
    const bounded = boundedLimit(limit, MAX_CHAT_SKILLS, "skill limit");
    const merged = new Map<string, StoredChatSkill>();
    for (const item of this.#base.listChatSkills(chatId, MAX_CHAT_SKILLS)) {
      if (item.chatId === chatId) {
        merged.set(item.key, item);
      }
    }
    for (const item of this.#skills.values()) {
      if (item.chatId === chatId) {
        merged.set(item.key, item);
      }
    }
    return sortByRecency([...merged.values()]).slice(0, bounded);
  }

  getChatSkill(input: {
    chatId: string;
    name: string;
  }): StoredChatSkill | undefined {
    assertChatId(input.chatId);
    assertNonEmptyBounded(input.name, MAX_SKILL_NAME_CHARS, "skill name");
    const key = normalizedKnowledgeKey(input.name, MAX_SKILL_NAME_CHARS);
    const staged = this.#skills.get(key);
    if (staged !== undefined && staged.chatId === input.chatId) {
      return staged;
    }
    return this.#base.getChatSkill(input);
  }

  upsertChatSkill(input: UpsertChatSkillInput): StoredChatSkill {
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
    const previous =
      this.#skills.get(key) ?? this.#base.getChatSkill({
        chatId: input.chatId,
        name: input.name,
      });
    const updatedAtMs = this.#allocateUpdatedAtMs(
      input.updatedAtMs,
      previous?.updatedAtMs,
    );
    const stored: StoredChatSkill = {
      chatId: input.chatId,
      key,
      name: input.name.trim(),
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      ...(input.sourceMessageId == null
        ? {}
        : { sourceMessageId: input.sourceMessageId }),
      createdAtMs: previous?.createdAtMs ?? updatedAtMs,
      updatedAtMs,
    };
    this.#skills.set(key, stored);
    this.#pruneLocalMap("skills", this.#skills, input.chatId, MAX_CHAT_SKILLS);
    return stored;
  }

  /**
   * Export only rows staged on this overlay (not parent/base), ready for the
   * atomic Dream day commit.
   */
  exportStagedWrites(chatId: string): {
    fast: UpsertFastChatMemoryInput[];
    lessons: UpsertChatLessonInput[];
    skills: UpsertChatSkillInput[];
    memory?: UpsertChatMemoryInput;
  } {
    const fast: UpsertFastChatMemoryInput[] = [];
    for (const item of this.#fast.values()) {
      if (item.chatId !== chatId) {
        continue;
      }
      fast.push({
        chatId: item.chatId,
        title: item.title,
        note: item.note,
        ...(item.sourceMessageId == null
          ? {}
          : { sourceMessageId: item.sourceMessageId }),
        updatedAtMs: item.updatedAtMs,
      });
    }
    const lessons: UpsertChatLessonInput[] = [];
    for (const item of this.#lessons.values()) {
      if (item.chatId !== chatId) {
        continue;
      }
      lessons.push({
        chatId: item.chatId,
        title: item.title,
        problem: item.problem,
        solution: item.solution,
        whenToApply: item.whenToApply,
        ...(item.sourceMessageId == null
          ? {}
          : { sourceMessageId: item.sourceMessageId }),
        updatedAtMs: item.updatedAtMs,
      });
    }
    const skills: UpsertChatSkillInput[] = [];
    for (const item of this.#skills.values()) {
      if (item.chatId !== chatId) {
        continue;
      }
      skills.push({
        chatId: item.chatId,
        name: item.name,
        description: item.description,
        instructions: item.instructions,
        ...(item.sourceMessageId == null
          ? {}
          : { sourceMessageId: item.sourceMessageId }),
        updatedAtMs: item.updatedAtMs,
      });
    }
    const memory =
      this.#memoryOverride?.chatId === chatId
        ? {
            chatId,
            memoryText: this.#memoryOverride.memoryText,
            lastConsolidatedMessageId:
              this.#memoryOverride.lastConsolidatedMessageId,
            updatedAtMs: this.#memoryOverride.updatedAtMs,
          }
        : undefined;
    return { fast, lessons, skills, memory };
  }

  #allocateUpdatedAtMs(
    requested: number | undefined,
    previousUpdatedAtMs: number | undefined,
  ): number {
    if (requested !== undefined) {
      assertTimestamp(requested, "updatedAtMs");
    }
    // Floor covers explicit request and per-key previous+1. Always take a
    // unique next() step first so a stale explicit updatedAtMs cannot collide
    // with an earlier write; raise to floor only when floor is still ahead.
    const floor = Math.max(
      requested ?? 0,
      (previousUpdatedAtMs ?? -1) + 1,
    );
    const stamp = this.#clock.next();
    return stamp >= floor ? stamp : this.#clock.observe(floor);
  }

  #pruneLocalMap(
    kind: "fast" | "lessons" | "skills",
    map: Map<string, { chatId: string; key: string }>,
    chatId: string,
    keep: number,
  ): void {
    // Capacity is enforced on the merged view (base + stage). Local map only
    // holds this stage's keys; drop the oldest staged entries that would fall
    // outside the merged keep-window so reads stay bounded.
    const merged =
      kind === "fast"
        ? this.listFastChatMemory(
            chatId,
            Math.min(keep, MAX_FAST_CHAT_MEMORY_ITEMS),
          )
        : kind === "lessons"
          ? this.listChatLessons(chatId, Math.min(keep, MAX_CHAT_LESSONS))
          : this.listChatSkills(chatId, Math.min(keep, MAX_CHAT_SKILLS));
    const keepKeys = new Set(merged.map((item) => item.key));
    for (const [key, item] of map) {
      if (item.chatId === chatId && !keepKeys.has(key)) {
        map.delete(key);
      }
    }
  }
}

function assertChatId(chatId: string): void {
  assertNonEmptyBounded(chatId, 256, "chatId");
}

function assertSourceMessageId(value: number | undefined): void {
  if (value !== undefined) {
    assertPositiveSafeInteger(value, "sourceMessageId");
  }
}

function boundedLimit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

function sortByRecency<T extends { updatedAtMs: number; key: string }>(
  items: T[],
): T[] {
  return items.sort((left, right) => {
    if (right.updatedAtMs !== left.updatedAtMs) {
      return right.updatedAtMs - left.updatedAtMs;
    }
    // Stable fallback only; monotonic clock makes this rare for new writes.
    return right.key.localeCompare(left.key, "ru-RU");
  });
}

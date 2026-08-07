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

export type LogicalClock = {
  next: () => number;
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
      return last;
    },
  };
}

/**
 * In-memory Dream knowledge overlay.
 *
 * Tomstones track explicitly-deleted keys. Upsert of a tombstoned key cancels
 * the tombstone (revive). mergeFrom ordering: delete→upsert = revived/update,
 * upsert→delete = delete. Parent tombstone→child upsert revives too. Forked
 * children inherit parent tombstones; discarded children never leak.
 */
export class StagedKnowledgeOverlay implements DreamKnowledgeStore {
  readonly #base: DreamKnowledgeStore;
  readonly #clock: LogicalClock;
  readonly #fast = new Map<string, StoredFastChatMemory>();
  readonly #lessons = new Map<string, StoredChatLesson>();
  readonly #skills = new Map<string, StoredChatSkill>();
  readonly #fastTombstones = new Set<string>();
  readonly #lessonTombstones = new Set<string>();
  readonly #skillTombstones = new Set<string>();
  #memoryOverride: StoredChatMemory | undefined;

  constructor(
    base: DreamKnowledgeStore,
    options: { now?: () => number; clock?: LogicalClock } = {},
  ) {
    this.#base = base;
    this.#clock =
      options.clock ?? createLogicalClock(options.now ?? (() => Date.now()));
  }

  fork(): StagedKnowledgeOverlay {
    const child = new StagedKnowledgeOverlay(this, { clock: this.#clock });
    for (const key of this.#fastTombstones) child.#fastTombstones.add(key);
    for (const key of this.#lessonTombstones) child.#lessonTombstones.add(key);
    for (const key of this.#skillTombstones) child.#skillTombstones.add(key);
    return child;
  }

  mergeFrom(child: StagedKnowledgeOverlay): void {
    // Process child upserts first: they may cancel parent tombstones.
    for (const [key, value] of child.#fast) {
      this.#fast.set(key, value);
      this.#fastTombstones.delete(key);
    }
    for (const [key, value] of child.#lessons) {
      this.#lessons.set(key, value);
      this.#lessonTombstones.delete(key);
    }
    for (const [key, value] of child.#skills) {
      this.#skills.set(key, value);
      this.#skillTombstones.delete(key);
    }
    // Then apply child tombstones: they delete parent staged entries.
    for (const key of child.#fastTombstones) {
      this.#fastTombstones.add(key);
      this.#fast.delete(key);
    }
    for (const key of child.#lessonTombstones) {
      this.#lessonTombstones.add(key);
      this.#lessons.delete(key);
    }
    for (const key of child.#skillTombstones) {
      this.#skillTombstones.add(key);
      this.#skills.delete(key);
    }
    if (child.#memoryOverride !== undefined) {
      this.#memoryOverride = child.#memoryOverride;
    }
  }

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
    if (this.#memoryOverride?.chatId === chatId) return this.#memoryOverride;
    return this.#base.getChatMemory(chatId);
  }

  listFastChatMemory(
    chatId: string,
    limit = MAX_FAST_CHAT_MEMORY_ITEMS,
  ): StoredFastChatMemory[] {
    const bounded = boundedLimit(limit, MAX_FAST_CHAT_MEMORY_ITEMS, "fast memory limit");
    const merged = new Map<string, StoredFastChatMemory>();
    for (const item of this.#base.listFastChatMemory(chatId, MAX_FAST_CHAT_MEMORY_ITEMS)) {
      if (item.chatId === chatId && !this.#fastTombstones.has(item.key)) {
        merged.set(item.key, item);
      }
    }
    for (const item of this.#fast.values()) {
      if (item.chatId === chatId && !this.#fastTombstones.has(item.key)) {
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
    // Upsert cancels tombstone (revive).
    this.#fastTombstones.delete(key);
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
      if (item.chatId === chatId && !this.#lessonTombstones.has(item.key)) {
        merged.set(item.key, item);
      }
    }
    for (const item of this.#lessons.values()) {
      if (item.chatId === chatId && !this.#lessonTombstones.has(item.key)) {
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
    this.#lessonTombstones.delete(key);
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
      if (item.chatId === chatId && !this.#skillTombstones.has(item.key)) {
        merged.set(item.key, item);
      }
    }
    for (const item of this.#skills.values()) {
      if (item.chatId === chatId && !this.#skillTombstones.has(item.key)) {
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
    if (this.#skillTombstones.has(key)) return undefined;
    const staged = this.#skills.get(key);
    if (staged !== undefined && staged.chatId === input.chatId) return staged;
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
    this.#skillTombstones.delete(key);
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

  deleteFastChatMemory(chatId: string, key: string): void {
    assertChatId(chatId);
    assertNonEmptyBounded(key, MAX_FAST_TITLE_CHARS, "key");
    this.#clock.next();
    const nk = normalizedKnowledgeKey(key, MAX_FAST_TITLE_CHARS);
    this.#fastTombstones.add(nk);
    this.#fast.delete(nk);
  }

  deleteChatLesson(chatId: string, key: string): void {
    assertChatId(chatId);
    assertNonEmptyBounded(key, MAX_LESSON_TITLE_CHARS, "key");
    this.#clock.next();
    const nk = normalizedKnowledgeKey(key, MAX_LESSON_TITLE_CHARS);
    this.#lessonTombstones.add(nk);
    this.#lessons.delete(nk);
  }

  deleteChatSkill(chatId: string, key: string): void {
    assertChatId(chatId);
    assertNonEmptyBounded(key, MAX_SKILL_NAME_CHARS, "key");
    this.#clock.next();
    const nk = normalizedKnowledgeKey(key, MAX_SKILL_NAME_CHARS);
    this.#skillTombstones.add(nk);
    this.#skills.delete(nk);
  }

  exportStagedWrites(chatId: string): {
    fast: UpsertFastChatMemoryInput[];
    lessons: UpsertChatLessonInput[];
    skills: UpsertChatSkillInput[];
    memory?: UpsertChatMemoryInput;
    deletedFastKeys: string[];
    deletedLessonKeys: string[];
    deletedSkillKeys: string[];
  } {
    const fast: UpsertFastChatMemoryInput[] = [];
    for (const item of this.#fast.values()) {
      if (item.chatId !== chatId || this.#fastTombstones.has(item.key)) continue;
      fast.push({
        chatId: item.chatId,
        title: item.title,
        note: item.note,
        ...(item.sourceMessageId == null ? {} : { sourceMessageId: item.sourceMessageId }),
        updatedAtMs: item.updatedAtMs,
      });
    }
    const lessons: UpsertChatLessonInput[] = [];
    for (const item of this.#lessons.values()) {
      if (item.chatId !== chatId || this.#lessonTombstones.has(item.key)) continue;
      lessons.push({
        chatId: item.chatId,
        title: item.title,
        problem: item.problem,
        solution: item.solution,
        whenToApply: item.whenToApply,
        ...(item.sourceMessageId == null ? {} : { sourceMessageId: item.sourceMessageId }),
        updatedAtMs: item.updatedAtMs,
      });
    }
    const skills: UpsertChatSkillInput[] = [];
    for (const item of this.#skills.values()) {
      if (item.chatId !== chatId || this.#skillTombstones.has(item.key)) continue;
      skills.push({
        chatId: item.chatId,
        name: item.name,
        description: item.description,
        instructions: item.instructions,
        ...(item.sourceMessageId == null ? {} : { sourceMessageId: item.sourceMessageId }),
        updatedAtMs: item.updatedAtMs,
      });
    }
    const memory =
      this.#memoryOverride?.chatId === chatId
        ? {
            chatId,
            memoryText: this.#memoryOverride.memoryText,
            lastConsolidatedMessageId: this.#memoryOverride.lastConsolidatedMessageId,
            updatedAtMs: this.#memoryOverride.updatedAtMs,
          }
        : undefined;
    const deletedFastKeys = [...this.#fastTombstones];
    const deletedLessonKeys = [...this.#lessonTombstones];
    const deletedSkillKeys = [...this.#skillTombstones];
    return { fast, lessons, skills, memory, deletedFastKeys, deletedLessonKeys, deletedSkillKeys };
  }

  #allocateUpdatedAtMs(
    requested: number | undefined,
    previousUpdatedAtMs: number | undefined,
  ): number {
    if (requested !== undefined) assertTimestamp(requested, "updatedAtMs");
    const floor = Math.max(requested ?? 0, (previousUpdatedAtMs ?? -1) + 1);
    const stamp = this.#clock.next();
    return stamp >= floor ? stamp : this.#clock.observe(floor);
  }

  #pruneLocalMap(
    kind: "fast" | "lessons" | "skills",
    map: Map<string, { chatId: string; key: string }>,
    chatId: string,
    keep: number,
  ): void {
    const merged =
      kind === "fast"
        ? this.listFastChatMemory(chatId, Math.min(keep, MAX_FAST_CHAT_MEMORY_ITEMS))
        : kind === "lessons"
          ? this.listChatLessons(chatId, Math.min(keep, MAX_CHAT_LESSONS))
          : this.listChatSkills(chatId, Math.min(keep, MAX_CHAT_SKILLS));
    const keepKeys = new Set(merged.map((item) => item.key));
    for (const [key, item] of map) {
      if (item.chatId === chatId && !keepKeys.has(key)) map.delete(key);
    }
  }
}

function assertChatId(chatId: string): void {
  assertNonEmptyBounded(chatId, 256, "chatId");
}

function assertSourceMessageId(value: number | undefined): void {
  if (value !== undefined) assertPositiveSafeInteger(value, "sourceMessageId");
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
    if (right.updatedAtMs !== left.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
    return right.key.localeCompare(left.key, "ru-RU");
  });
}

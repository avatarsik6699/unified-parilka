import { StoreCore } from "./core.js";
import type {
  StoredChatLesson,
  StoredChatMemory,
  StoredChatSkill,
  StoredDreamDay,
  StoredFastChatMemory,
  UpsertChatLessonInput,
  UpsertChatMemoryInput,
  UpsertChatSkillInput,
  UpsertDreamDayInput,
  UpsertFastChatMemoryInput,
} from "./types.js";

/**
 * Atomic Dream day commit after all model work has finished.
 *
 * Knowledge tool writes during generation are staged in memory. Only a fully
 * successful day reaches this boundary, which applies fast memory, lessons,
 * skills, semantic memory (+ watermark), and the completed dream-day row in
 * one short `BEGIN IMMEDIATE` transaction — never across a model call.
 */
export type CommitDreamDayInput = {
  day: UpsertDreamDayInput;
  memory?: UpsertChatMemoryInput;
  fast: readonly UpsertFastChatMemoryInput[];
  lessons: readonly UpsertChatLessonInput[];
  skills: readonly UpsertChatSkillInput[];
};

export abstract class DreamCommitMethods extends StoreCore {
  declare protected upsertFastChatMemoryLocked: (
    input: UpsertFastChatMemoryInput,
  ) => StoredFastChatMemory;
  declare protected upsertChatLessonLocked: (
    input: UpsertChatLessonInput,
  ) => StoredChatLesson;
  declare protected upsertChatSkillLocked: (
    input: UpsertChatSkillInput,
  ) => StoredChatSkill;
  declare protected upsertChatMemoryLocked: (
    input: UpsertChatMemoryInput,
  ) => StoredChatMemory;
  declare protected upsertDreamDayLocked: (
    input: UpsertDreamDayInput,
  ) => StoredDreamDay;

  commitDreamDay(input: CommitDreamDayInput): StoredDreamDay {
    assertSameChatBundle(input);
    return this.immediateTransaction("commitDreamDay", () => {
      for (const item of input.fast) {
        this.upsertFastChatMemoryLocked(item);
      }
      for (const item of input.lessons) {
        this.upsertChatLessonLocked(item);
      }
      for (const item of input.skills) {
        this.upsertChatSkillLocked(item);
      }
      if (input.memory !== undefined) {
        this.upsertChatMemoryLocked(input.memory);
      }
      return this.upsertDreamDayLocked(input.day);
    });
  }
}

/**
 * Fail closed before opening a transaction: the public atomic API must not
 * silently apply a cross-chat knowledge/memory bundle under another day row.
 */
function assertSameChatBundle(input: CommitDreamDayInput): void {
  const chatId = input.day.chatId;
  for (const item of input.fast) {
    if (item.chatId !== chatId) {
      throw new Error("commitDreamDay fast write chatId must match day.chatId.");
    }
  }
  for (const item of input.lessons) {
    if (item.chatId !== chatId) {
      throw new Error(
        "commitDreamDay lesson write chatId must match day.chatId.",
      );
    }
  }
  for (const item of input.skills) {
    if (item.chatId !== chatId) {
      throw new Error(
        "commitDreamDay skill write chatId must match day.chatId.",
      );
    }
  }
  if (input.memory !== undefined && input.memory.chatId !== chatId) {
    throw new Error(
      "commitDreamDay memory write chatId must match day.chatId.",
    );
  }
}

export type DreamCommitApi = Pick<DreamCommitMethods, "commitDreamDay">;

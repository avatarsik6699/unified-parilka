import type {
  StoredChatMemory,
  StoredChatSkill,
  StoredFastChatMemory,
  StoredChatLesson,
  UpsertChatSkillInput,
  UpsertFastChatMemoryInput,
  UpsertChatLessonInput,
} from "../store.js";

export interface DreamKnowledgeStore {
  getChatMemory(chatId: string): StoredChatMemory | undefined;
  listFastChatMemory(chatId: string, limit?: number): StoredFastChatMemory[];
  upsertFastChatMemory(input: UpsertFastChatMemoryInput): StoredFastChatMemory;
  listChatLessons(chatId: string, limit?: number): StoredChatLesson[];
  searchChatLessons(input: { chatId: string; query: string; limit?: number }): StoredChatLesson[];
  upsertChatLesson(input: UpsertChatLessonInput): StoredChatLesson;
  listChatSkills(chatId: string, limit?: number): StoredChatSkill[];
  getChatSkill(input: { chatId: string; name: string }): StoredChatSkill | undefined;
  upsertChatSkill(input: UpsertChatSkillInput): StoredChatSkill;
}

export type RememberFastInput = Omit<
  UpsertFastChatMemoryInput,
  "updatedAtMs"
>;

export type RememberLessonInput = Omit<
  UpsertChatLessonInput,
  "updatedAtMs"
>;

export type SaveSkillInput = Omit<UpsertChatSkillInput, "updatedAtMs">;

/**
 * Patch-before-create skill manager. Background review always lists/indexes and
 * loads the most similar existing skill before deciding whether to patch it or
 * create a new one.
 */
export function findSimilarSkill(
  skills: StoredChatSkill[],
  candidate: { name: string; description: string },
): StoredChatSkill | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  const normalizedName = normalizeForMatch(candidate.name);
  const normalizedDescription = normalizeForMatch(candidate.description);

  let best: StoredChatSkill | undefined;
  let bestScore = 0;
  const NAME_WEIGHT = 3;
  const DESCRIPTION_WEIGHT = 1;

  for (const skill of skills) {
    const nameScore = jaccard(
      normalizedName,
      normalizeForMatch(skill.name),
    );
    const descScore = jaccard(
      normalizedDescription,
      normalizeForMatch(skill.description),
    );
    const score = NAME_WEIGHT * nameScore + DESCRIPTION_WEIGHT * descScore;
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  // Threshold: meaningful name overlap or strong description overlap.
  if (bestScore >= 0.25) {
    return best;
  }
  return undefined;
}

/**
 * Build a patched skill from an existing one plus the reviewer's proposed
 * update. The key is preserved so the upsert is idempotent on retry.
 */
export function patchSkill(
  existing: StoredChatSkill,
  patch: SaveSkillInput,
): UpsertChatSkillInput {
  return {
    chatId: existing.chatId,
    name: existing.name,
    description: patch.description,
    instructions: patch.instructions,
    sourceMessageId: patch.sourceMessageId ?? existing.sourceMessageId,
  };
}

function normalizeForMatch(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("ru-RU")
      .split(/[^\p{L}\p{N}]+/gu)
      .filter(Boolean),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

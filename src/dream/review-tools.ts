import { jsonSchema, tool, type ToolSet } from "ai";
import type {
  StoredChatMemory,
  StoredChatSkill,
  StoredFastChatMemory,
  StoredChatLesson,
  UpsertChatSkillInput,
  UpsertFastChatMemoryInput,
  UpsertChatLessonInput,
} from "../store.js";
import { findSimilarSkill, patchSkill } from "./skill-manager.js";

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

export interface ReviewToolContext {
  chatId: string;
  sourceMessageId: number;
  nowMs: number;
  store: DreamKnowledgeStore;
}

const searchLongMemorySchema = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      maxLength: 240,
      description: "Short search query in any language.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

const loadChatSkillSchema = {
  type: "object" as const,
  properties: {
    name: {
      type: "string" as const,
      maxLength: 120,
      description: "Exact skill name.",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

const rememberFastSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string" as const,
      maxLength: 160,
      description: "Short unique title for the note.",
    },
    note: {
      type: "string" as const,
      maxLength: 800,
      description: "Compact fact with sender attribution.",
    },
  },
  required: ["title", "note"],
  additionalProperties: false,
};

const rememberLessonSchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string" as const,
      maxLength: 160,
      description: "Short lesson title.",
    },
    problem: {
      type: "string" as const,
      maxLength: 1200,
      description: "What went wrong or what to avoid.",
    },
    solution: {
      type: "string" as const,
      maxLength: 1200,
      description: "The corrected approach or accepted solution.",
    },
    whenToApply: {
      type: "string" as const,
      maxLength: 1200,
      description: "When this lesson is relevant.",
    },
  },
  required: ["title", "problem", "solution", "whenToApply"],
  additionalProperties: false,
};

const saveChatSkillSchema = {
  type: "object" as const,
  properties: {
    name: {
      type: "string" as const,
      maxLength: 120,
      description: "Short unique skill name.",
    },
    description: {
      type: "string" as const,
      maxLength: 400,
      description: "One-line index for similarity search.",
    },
    instructions: {
      type: "string" as const,
      maxLength: 4000,
      description: "Full playbook: triggers, procedure, pitfalls, verification.",
    },
  },
  required: ["name", "description", "instructions"],
  additionalProperties: false,
};

export function buildReviewToolSet(context: ReviewToolContext): ToolSet {
  return {
    review_search_long_memory: tool({
      description:
        "Search existing long-memory semantic summary, lessons and skills for relevant context.",
      inputSchema: jsonSchema<Record<string, unknown>>(searchLongMemorySchema),
      execute: async (input) => {
        const args = input as { query: string };
        const memory = context.store.getChatMemory(context.chatId);
        const lessons = context.store.searchChatLessons({
          chatId: context.chatId,
          query: args.query,
          limit: 6,
        });
        const skills = context.store.listChatSkills(context.chatId, 12);
        const fast = context.store.listFastChatMemory(context.chatId, 12);
        return JSON.stringify(
          {
            memory: memory?.memoryText ?? "",
            fast: fast.map((m) => ({ title: m.title, note: m.note })),
            lessons: lessons.map((l) => ({
              title: l.title,
              problem: l.problem,
              solution: l.solution,
              whenToApply: l.whenToApply,
            })),
            skills: skills.map((s) => ({ name: s.name, description: s.description })),
          },
          null,
          2,
        );
      },
    }),
    review_load_chat_skill: tool({
      description:
        "Load the full instructions of an existing chat-local skill by name. Use this before patching a skill.",
      inputSchema: jsonSchema<Record<string, unknown>>(loadChatSkillSchema),
      execute: async (input) => {
        const args = input as { name: string };
        const skill = context.store.getChatSkill({
          chatId: context.chatId,
          name: args.name,
        });
        if (!skill) {
          return JSON.stringify({ found: false, name: args.name });
        }
        return JSON.stringify(
          {
            found: true,
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions,
          },
          null,
          2,
        );
      },
    }),
    review_remember_fast: tool({
      description:
        "Store a short, chat-wide hot fact that should affect upcoming turns. Use only for stable agreements or precisely attributed facts, not for every line.",
      inputSchema: jsonSchema<Record<string, unknown>>(rememberFastSchema),
      execute: async (input) => {
        const args = input as { title: string; note: string };
        const upsertInput: RememberFastInput = {
          chatId: context.chatId,
          title: args.title,
          note: args.note,
          sourceMessageId: context.sourceMessageId,
        };
        context.store.upsertFastChatMemory(upsertInput);
        return JSON.stringify({ ok: true, title: args.title });
      },
    }),
    review_remember_lesson: tool({
      description:
        "Store a durable problem → solution → when-to-use lesson learned from a correction or successful outcome.",
      inputSchema: jsonSchema<Record<string, unknown>>(rememberLessonSchema),
      execute: async (input) => {
        const args = input as {
          title: string;
          problem: string;
          solution: string;
          whenToApply: string;
        };
        const upsertInput: RememberLessonInput = {
          chatId: context.chatId,
          title: args.title,
          problem: args.problem,
          solution: args.solution,
          whenToApply: args.whenToApply,
          sourceMessageId: context.sourceMessageId,
        };
        context.store.upsertChatLesson(upsertInput);
        return JSON.stringify({ ok: true, title: args.title });
      },
    }),
    review_save_chat_skill: tool({
      description:
        "Create or patch a reusable class-level skill. First search/list skills and load the most similar existing skill; patch it when applicable, otherwise create a new one. Skills must contain triggers, procedure, pitfalls, and verification steps — not a single date or answer.",
      inputSchema: jsonSchema<Record<string, unknown>>(saveChatSkillSchema),
      execute: async (input) => {
        const args = input as {
          name: string;
          description: string;
          instructions: string;
        };
        // Default limit is MAX_CHAT_SKILLS; do not pass a larger value —
        // listChatSkills hard-rejects limits above the exported max.
        const allSkills = context.store.listChatSkills(context.chatId);
        const similar = findSimilarSkill(allSkills, {
          name: args.name,
          description: args.description,
        });
        if (similar) {
          context.store.upsertChatSkill(
            patchSkill(similar, {
              chatId: context.chatId,
              name: similar.name,
              description: args.description,
              instructions: args.instructions,
              sourceMessageId: context.sourceMessageId,
            }),
          );
        } else {
          context.store.upsertChatSkill({
            chatId: context.chatId,
            name: args.name,
            description: args.description,
            instructions: args.instructions,
            sourceMessageId: context.sourceMessageId,
          });
        }
        return JSON.stringify({ ok: true, name: args.name, patched: similar != null });
      },
    }),
  };
}



import type {
  StoredChatLesson,
  StoredChatMemory,
  StoredChatSkill,
  StoredFastChatMemory,
} from "./types.js";

// ── Audit version and bound ─────────────────────────────────────────────────

export const AUDIT_VERSION = 1;
export const MAX_AUDIT_JSON_BYTES = 5 * 1024 * 1024; // 5 MiB

// ── Layer-specific exact audit records ─────────────────────────────────────

export type AuditFastRecord = StoredFastChatMemory;
export type AuditLessonRecord = StoredChatLesson;
export type AuditSkillRecord = StoredChatSkill;

// ── Generic layer delta ────────────────────────────────────────────────────

export interface AuditLayerDelta<T> {
  created: T[];
  updated: { before: T; after: T }[];
  deleted: T[];
  evicted: T[];
  beforeCount: number;
  afterCount: number;
  changed: boolean;
}

// ── Top-level audit structure ──────────────────────────────────────────────

export interface DreamAudit {
  version: typeof AUDIT_VERSION;
  chatId: string;
  day: string;
  semanticMemory: {
    before: StoredChatMemory | null;
    after: StoredChatMemory | null;
    changed: boolean;
  };
  fastMemory: AuditLayerDelta<AuditFastRecord>;
  lessons: AuditLayerDelta<AuditLessonRecord>;
  skills: AuditLayerDelta<AuditSkillRecord>;
}

export type StoredDreamAudit = {
  chatId: string;
  day: string;
  audit: DreamAudit;
  createdAtMs: number;
};

// ── Before/after snapshots ──────────────────────────────────────────────────

export interface DreamAuditSnapshots {
  memoryBefore: StoredChatMemory | undefined;
  memoryAfter: StoredChatMemory | undefined;
  fastBefore: StoredFastChatMemory[];
  fastAfter: StoredFastChatMemory[];
  lessonsBefore: StoredChatLesson[];
  lessonsAfter: StoredChatLesson[];
  skillsBefore: StoredChatSkill[];
  skillsAfter: StoredChatSkill[];
}

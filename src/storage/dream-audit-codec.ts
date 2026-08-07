import type {
  StoredChatMemory,
} from "./types.js";
import {
  MAX_CHAT_LESSONS,
  MAX_CHAT_SKILLS,
  MAX_FAST_CHAT_MEMORY_ITEMS,
  MAX_FAST_NOTE_CHARS,
  MAX_FAST_TITLE_CHARS,
  MAX_LESSON_FIELD_CHARS,
  MAX_LESSON_TITLE_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_SKILL_NAME_CHARS,
  normalizedKnowledgeKey,
} from "./chat-knowledge.js";
import { assertCalendarDay } from "./validation.js";
import {
  type AuditFastRecord,
  type AuditLayerDelta,
  type AuditLessonRecord,
  type AuditSkillRecord,
  type DreamAudit,
  type DreamAuditSnapshots,
  AUDIT_VERSION,
  MAX_AUDIT_JSON_BYTES,
} from "./dream-audit-types.js";

export { AUDIT_VERSION, MAX_AUDIT_JSON_BYTES };
export type { DreamAuditSnapshots };

// ── Codepoint sorting ──────────────────────────────────────────────────────

function codepointCmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortByKey<T extends { key: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => codepointCmp(a.key, b.key));
}

// ── Delta computation ──────────────────────────────────────────────────────

function shallowEq(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a).sort(codepointCmp);
  const bKeys = Object.keys(b).sort(codepointCmp);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function memoryFullEq(
  a: StoredChatMemory | undefined,
  b: StoredChatMemory | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.chatId === b.chatId &&
    a.memoryText === b.memoryText &&
    a.lastConsolidatedMessageId === b.lastConsolidatedMessageId &&
    a.revision === b.revision &&
    a.updatedAtMs === b.updatedAtMs
  );
}

function computeLayerDelta<T extends { key: string }>(
  before: T[],
  after: T[],
  tombstonedKeys: Set<string>,
): AuditLayerDelta<T> {
  const beforeMap = new Map(before.map((item) => [item.key, item]));
  const afterMap = new Map(after.map((item) => [item.key, item]));
  const created: T[] = [];
  const updated: { before: T; after: T }[] = [];
  const deleted: T[] = [];
  const evicted: T[] = [];

  for (const [key, afterItem] of afterMap) {
    const beforeItem = beforeMap.get(key);
    if (!beforeItem) {
      created.push(afterItem);
    } else if (!shallowEq(beforeItem as unknown as Record<string, unknown>, afterItem as unknown as Record<string, unknown>)) {
      updated.push({ before: beforeItem, after: afterItem });
    }
  }
  for (const [key, beforeItem] of beforeMap) {
    if (!afterMap.has(key)) {
      if (tombstonedKeys.has(key)) deleted.push(beforeItem);
      else evicted.push(beforeItem);
    }
  }
  const changed = created.length > 0 || updated.length > 0 || deleted.length > 0 || evicted.length > 0;
  return {
    created: sortByKey(created),
    updated: sortByKey(updated.map((u) => ({ ...u, key: u.before.key })) as Array<{ before: T; after: T; key: string }>).map((u) => {
      const { key: _, ...rest } = u as { before: T; after: T; key: string };
      return rest;
    }),
    deleted: sortByKey(deleted),
    evicted: sortByKey(evicted),
    beforeCount: before.length,
    afterCount: after.length,
    changed,
  };
}

function stripMemoryRecord(m: StoredChatMemory): StoredChatMemory {
  return { chatId: m.chatId, memoryText: m.memoryText, lastConsolidatedMessageId: m.lastConsolidatedMessageId, revision: m.revision, updatedAtMs: m.updatedAtMs };
}

export function computeDreamAudit(
  chatId: string,
  day: string,
  snapshots: DreamAuditSnapshots,
  tombstonedKeys: { fast: Set<string>; lessons: Set<string>; skills: Set<string> },
): DreamAudit {
  return {
    version: AUDIT_VERSION,
    chatId,
    day,
    semanticMemory: {
      before: snapshots.memoryBefore ? stripMemoryRecord(snapshots.memoryBefore) : null,
      after: snapshots.memoryAfter ? stripMemoryRecord(snapshots.memoryAfter) : null,
      changed: !memoryFullEq(snapshots.memoryBefore, snapshots.memoryAfter),
    },
    fastMemory: computeLayerDelta(snapshots.fastBefore, snapshots.fastAfter, tombstonedKeys.fast),
    lessons: computeLayerDelta(snapshots.lessonsBefore, snapshots.lessonsAfter, tombstonedKeys.lessons),
    skills: computeLayerDelta(snapshots.skillsBefore, snapshots.skillsAfter, tombstonedKeys.skills),
  };
}

// ── Canonical serialization ─────────────────────────────────────────────────

function replacerSortedKeys(_key: string, value: unknown): unknown {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort(codepointCmp)) sorted[k] = (value as Record<string, unknown>)[k];
    return sorted;
  }
  return value;
}

export function serializeAudit(audit: DreamAudit): string {
  return JSON.stringify(audit, replacerSortedKeys);
}

// ── Assert helpers ─────────────────────────────────────────────────────────

function assertStr(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || v.length > max) throw new Error(`Audit ${name}: invalid string.`);
  return v;
}
function assertNonEmptyStr(v: unknown, name: string, max: number): string {
  const s = assertStr(v, name, max);
  if (s.trim().length === 0) throw new Error(`Audit ${name}: must be non-empty.`);
  return s;
}
function assertInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`Audit ${name}: must be a safe integer.`);
  return v;
}
function assertNonNegInt(v: unknown, name: string): number {
  const n = assertInt(v, name);
  if (n < 0) throw new Error(`Audit ${name}: must be non-negative.`);
  return n;
}
function assertOptPositiveInt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = assertInt(v, name);
  if (n <= 0) throw new Error(`Audit ${name}: must be a positive safe integer.`);
  return n;
}
function assertBool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new Error(`Audit ${name}: must be a boolean.`);
  return v;
}
function assertObj(v: unknown, name: string): Record<string, unknown> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw new Error(`Audit ${name}: must be an object.`);
  return v as Record<string, unknown>;
}
function assertArr(v: unknown, name: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`Audit ${name}: must be an array.`);
  return v;
}
function assertKnownKeys(obj: Record<string, unknown>, allowed: Set<string>, name: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`Audit ${name}: unknown key "${k}".`);
  }
}
function assertSorted(entries: Array<{ key: string }>, name: string): void {
  for (let i = 1; i < entries.length; i++) {
    if (codepointCmp(entries[i - 1]!.key, entries[i]!.key) >= 0) {
      throw new Error(`Audit ${name}: entries not sorted or duplicate key.`);
    }
  }
}

function assertKeysDisjoint(sets: Array<{ keys: Set<string>; label: string }>, name: string): void {
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const k of sets[i]!.keys) {
        if (sets[j]!.keys.has(k)) {
          throw new Error(`Audit ${name}: key "${k}" appears in both ${sets[i]!.label} and ${sets[j]!.label}.`);
        }
      }
    }
  }
}

// ── Per-layer record validation ────────────────────────────────────────────

const FAST_KEYS = new Set(["chatId","key","title","note","sourceMessageId","createdAtMs","updatedAtMs"]);
const LESSON_KEYS = new Set(["chatId","key","title","problem","solution","whenToApply","sourceMessageId","createdAtMs","updatedAtMs"]);
const SKILL_KEYS = new Set(["chatId","key","name","description","instructions","sourceMessageId","createdAtMs","updatedAtMs"]);

function validateFastRec(r: Record<string, unknown>, chatId: string, ctx: string): AuditFastRecord {
  assertKnownKeys(r, FAST_KEYS, ctx);
  const key = assertNonEmptyStr(r.key, `${ctx}.key`, MAX_FAST_TITLE_CHARS);
  const title = assertNonEmptyStr(r.title, `${ctx}.title`, MAX_FAST_TITLE_CHARS);
  if (normalizedKnowledgeKey(title, MAX_FAST_TITLE_CHARS) !== key) throw new Error(`Audit ${ctx}: key not normalizedKnowledgeKey of title.`);
  return {
    chatId: assertNonEmptyStr(r.chatId, `${ctx}.chatId`, 256),
    key, title,
    note: assertNonEmptyStr(r.note, `${ctx}.note`, MAX_FAST_NOTE_CHARS),
    sourceMessageId: r.sourceMessageId === undefined ? undefined : assertInt(r.sourceMessageId, `${ctx}.sourceMessageId`),
    createdAtMs: assertNonNegInt(r.createdAtMs, `${ctx}.createdAtMs`),
    updatedAtMs: assertNonNegInt(r.updatedAtMs, `${ctx}.updatedAtMs`),
  };
}

function validateLessonRec(r: Record<string, unknown>, chatId: string, ctx: string): AuditLessonRecord {
  assertKnownKeys(r, LESSON_KEYS, ctx);
  const key = assertNonEmptyStr(r.key, `${ctx}.key`, MAX_LESSON_TITLE_CHARS);
  const title = assertNonEmptyStr(r.title, `${ctx}.title`, MAX_LESSON_TITLE_CHARS);
  if (normalizedKnowledgeKey(title, MAX_LESSON_TITLE_CHARS) !== key) throw new Error(`Audit ${ctx}: key not normalizedKnowledgeKey of title.`);
  return {
    chatId: assertNonEmptyStr(r.chatId, `${ctx}.chatId`, 256),
    key, title,
    problem: assertNonEmptyStr(r.problem, `${ctx}.problem`, MAX_LESSON_FIELD_CHARS),
    solution: assertNonEmptyStr(r.solution, `${ctx}.solution`, MAX_LESSON_FIELD_CHARS),
    whenToApply: assertNonEmptyStr(r.whenToApply, `${ctx}.whenToApply`, MAX_LESSON_FIELD_CHARS),
    sourceMessageId: r.sourceMessageId === undefined ? undefined : assertInt(r.sourceMessageId, `${ctx}.sourceMessageId`),
    createdAtMs: assertNonNegInt(r.createdAtMs, `${ctx}.createdAtMs`),
    updatedAtMs: assertNonNegInt(r.updatedAtMs, `${ctx}.updatedAtMs`),
  };
}

function validateSkillRec(r: Record<string, unknown>, chatId: string, ctx: string): AuditSkillRecord {
  assertKnownKeys(r, SKILL_KEYS, ctx);
  const key = assertNonEmptyStr(r.key, `${ctx}.key`, MAX_SKILL_NAME_CHARS);
  const name = assertNonEmptyStr(r.name, `${ctx}.name`, MAX_SKILL_NAME_CHARS);
  if (normalizedKnowledgeKey(name, MAX_SKILL_NAME_CHARS) !== key) throw new Error(`Audit ${ctx}: key not normalizedKnowledgeKey of name.`);
  return {
    chatId: assertNonEmptyStr(r.chatId, `${ctx}.chatId`, 256),
    key, name,
    description: assertNonEmptyStr(r.description, `${ctx}.description`, MAX_SKILL_DESCRIPTION_CHARS),
    instructions: assertNonEmptyStr(r.instructions, `${ctx}.instructions`, MAX_SKILL_INSTRUCTIONS_CHARS),
    sourceMessageId: r.sourceMessageId === undefined ? undefined : assertInt(r.sourceMessageId, `${ctx}.sourceMessageId`),
    createdAtMs: assertNonNegInt(r.createdAtMs, `${ctx}.createdAtMs`),
    updatedAtMs: assertNonNegInt(r.updatedAtMs, `${ctx}.updatedAtMs`),
  };
}

function validateSourceMsgPositive(rec: { sourceMessageId?: number }, ctx: string): void {
  if (rec.sourceMessageId !== undefined && rec.sourceMessageId <= 0) throw new Error(`Audit ${ctx}: sourceMessageId must be positive.`);
}
function validateChatIdMatch(rec: { chatId: string }, expected: string, ctx: string): void {
  if (rec.chatId !== expected) throw new Error(`Audit ${ctx}: chatId mismatch.`);
}

// ── Array validators ───────────────────────────────────────────────────────

function validateFastArr(arr: unknown[], name: string, chatId: string): AuditFastRecord[] {
  const out: AuditFastRecord[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rec = validateFastRec(assertObj(arr[i], `${name}[${i}]`), chatId, `${name}[${i}]`);
    validateSourceMsgPositive(rec, `${name}[${i}]`);
    validateChatIdMatch(rec, chatId, `${name}[${i}]`);
    out.push(rec);
  }
  assertSorted(out, name);
  return out;
}

function validateLessonArr(arr: unknown[], name: string, chatId: string): AuditLessonRecord[] {
  const out: AuditLessonRecord[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rec = validateLessonRec(assertObj(arr[i], `${name}[${i}]`), chatId, `${name}[${i}]`);
    validateSourceMsgPositive(rec, `${name}[${i}]`);
    validateChatIdMatch(rec, chatId, `${name}[${i}]`);
    out.push(rec);
  }
  assertSorted(out, name);
  return out;
}

function validateSkillArr(arr: unknown[], name: string, chatId: string): AuditSkillRecord[] {
  const out: AuditSkillRecord[] = [];
  for (let i = 0; i < arr.length; i++) {
    const rec = validateSkillRec(assertObj(arr[i], `${name}[${i}]`), chatId, `${name}[${i}]`);
    validateSourceMsgPositive(rec, `${name}[${i}]`);
    validateChatIdMatch(rec, chatId, `${name}[${i}]`);
    out.push(rec);
  }
  assertSorted(out, name);
  return out;
}

function fastUpd(arr: unknown[], name: string, chatId: string): { before: AuditFastRecord; after: AuditFastRecord }[] {
  return arr.map((v, i) => {
    const o = assertObj(v, `${name}[${i}]`);
    assertKnownKeys(o, new Set(["before", "after"]), `${name}[${i}]`);
    const b = validateFastRec(assertObj(o.before, `${name}[${i}].before`), chatId, `${name}[${i}].before`);
    const a = validateFastRec(assertObj(o.after, `${name}[${i}].after`), chatId, `${name}[${i}].after`);
    validateSourceMsgPositive(b, `${name}[${i}].before`);
    validateSourceMsgPositive(a, `${name}[${i}].after`);
    validateChatIdMatch(b, chatId, `${name}[${i}].before`);
    validateChatIdMatch(a, chatId, `${name}[${i}].after`);
    if (b.key !== a.key) throw new Error(`Audit ${name}[${i}]: before.key != after.key.`);
    return { before: b, after: a };
  });
}

function lessonUpd(arr: unknown[], name: string, chatId: string): { before: AuditLessonRecord; after: AuditLessonRecord }[] {
  return arr.map((v, i) => {
    const o = assertObj(v, `${name}[${i}]`);
    assertKnownKeys(o, new Set(["before", "after"]), `${name}[${i}]`);
    const b = validateLessonRec(assertObj(o.before, `${name}[${i}].before`), chatId, `${name}[${i}].before`);
    const a = validateLessonRec(assertObj(o.after, `${name}[${i}].after`), chatId, `${name}[${i}].after`);
    validateSourceMsgPositive(b, `${name}[${i}].before`);
    validateSourceMsgPositive(a, `${name}[${i}].after`);
    validateChatIdMatch(b, chatId, `${name}[${i}].before`);
    validateChatIdMatch(a, chatId, `${name}[${i}].after`);
    if (b.key !== a.key) throw new Error(`Audit ${name}[${i}]: before.key != after.key.`);
    return { before: b, after: a };
  });
}

function skillUpd(arr: unknown[], name: string, chatId: string): { before: AuditSkillRecord; after: AuditSkillRecord }[] {
  return arr.map((v, i) => {
    const o = assertObj(v, `${name}[${i}]`);
    assertKnownKeys(o, new Set(["before", "after"]), `${name}[${i}]`);
    const b = validateSkillRec(assertObj(o.before, `${name}[${i}].before`), chatId, `${name}[${i}].before`);
    const a = validateSkillRec(assertObj(o.after, `${name}[${i}].after`), chatId, `${name}[${i}].after`);
    validateSourceMsgPositive(b, `${name}[${i}].before`);
    validateSourceMsgPositive(a, `${name}[${i}].after`);
    validateChatIdMatch(b, chatId, `${name}[${i}].before`);
    validateChatIdMatch(a, chatId, `${name}[${i}].after`);
    if (b.key !== a.key) throw new Error(`Audit ${name}[${i}]: before.key != after.key.`);
    return { before: b, after: a };
  });
}

// ── Delta validation with cardinality and disjointness ────────────────────

type ValidateRecFn<T> = (arr: unknown[], name: string, chatId: string) => T[];
type ValidateUpdFn<T> = (arr: unknown[], name: string, chatId: string) => { before: T; after: T }[];

function validateDelta<T extends { key: string }>(
  delta: Record<string, unknown>,
  chatId: string,
  maxItems: number,
  name: string,
  vRec: ValidateRecFn<T>,
  vUpd: ValidateUpdFn<T>,
): AuditLayerDelta<T> {
  const allowed = new Set(["created","updated","deleted","evicted","beforeCount","afterCount","changed"]);
  assertKnownKeys(delta, allowed, name);
  const created = vRec(assertArr(delta.created, `${name}.created`), `${name}.created`, chatId);
  const updated = vUpd(assertArr(delta.updated, `${name}.updated`), `${name}.updated`, chatId);
  const deleted = vRec(assertArr(delta.deleted, `${name}.deleted`), `${name}.deleted`, chatId);
  const evicted = vRec(assertArr(delta.evicted, `${name}.evicted`), `${name}.evicted`, chatId);
  const beforeCount = assertNonNegInt(delta.beforeCount, `${name}.beforeCount`);
  const afterCount = assertNonNegInt(delta.afterCount, `${name}.afterCount`);
  const changed = assertBool(delta.changed, `${name}.changed`);

  if (beforeCount > maxItems || afterCount > maxItems) throw new Error(`Audit ${name} count exceeds capacity.`);
  if (created.length > maxItems) throw new Error(`Audit ${name}.created exceeds capacity.`);
  if (updated.length > maxItems) throw new Error(`Audit ${name}.updated exceeds capacity.`);
  if (deleted.length > maxItems) throw new Error(`Audit ${name}.deleted exceeds capacity.`);
  if (evicted.length > maxItems) throw new Error(`Audit ${name}.evicted exceeds capacity.`);

  // Updated keys must be strictly codepoint-sorted and unique.
  assertSorted(updated.map((u) => u.before as unknown as { key: string }), `${name}.updated`);

  // Disjoint keys across all four classifications.
  const sets = [
    { keys: new Set(created.map((r) => r.key)), label: "created" },
    { keys: new Set(updated.map((u) => u.before.key)), label: "updated" },
    { keys: new Set(deleted.map((r) => r.key)), label: "deleted" },
    { keys: new Set(evicted.map((r) => r.key)), label: "evicted" },
  ];
  assertKeysDisjoint(sets, name);

  // Cardinality: afterCount - beforeCount == created.length - deleted.length - evicted.length.
  const expectedDelta = created.length - deleted.length - evicted.length;
  if (afterCount - beforeCount !== expectedDelta) {
    throw new Error(`Audit ${name}: count-delta inconsistency (afterCount-beforeCount=${afterCount - beforeCount}, expected=${expectedDelta}).`);
  }

  // Containment: classified keys must not exceed count bounds.
  if (updated.length + deleted.length + evicted.length > beforeCount) {
    throw new Error(`Audit ${name}: updated+deleted+evicted (${updated.length + deleted.length + evicted.length}) exceeds beforeCount (${beforeCount}).`);
  }
  if (updated.length + created.length > afterCount) {
    throw new Error(`Audit ${name}: updated+created (${updated.length + created.length}) exceeds afterCount (${afterCount}).`);
  }

  if (changed !== (created.length > 0 || updated.length > 0 || deleted.length > 0 || evicted.length > 0)) {
    throw new Error(`Audit ${name}.changed inconsistent with deltas.`);
  }
  return { created, updated, deleted, evicted, beforeCount, afterCount, changed };
}

// ── Semantic memory validation ─────────────────────────────────────────────

function validateMemorySnapshot(v: unknown, name: string, chatId: string): StoredChatMemory | null {
  if (v === null || v === undefined) return null;
  const o = assertObj(v, name);
  assertKnownKeys(o, new Set(["chatId","memoryText","lastConsolidatedMessageId","revision","updatedAtMs"]), name);
  const cid = assertNonEmptyStr(o.chatId, `${name}.chatId`, 256);
  if (cid !== chatId) throw new Error(`Audit ${name}.chatId does not match root.`);
  const memoryText = assertStr(o.memoryText, `${name}.memoryText`, Number.MAX_SAFE_INTEGER);
  const revision = assertNonNegInt(o.revision, `${name}.revision`);
  const updatedAtMs = assertNonNegInt(o.updatedAtMs, `${name}.updatedAtMs`);
  const lastConsolidatedMessageId = assertOptPositiveInt(o.lastConsolidatedMessageId, `${name}.lastConsolidatedMessageId`);
  return { chatId: cid, memoryText, lastConsolidatedMessageId, revision, updatedAtMs };
}

// ── Canonical check ────────────────────────────────────────────────────────

function assertCanonicalKeys(keys: string[], expected: Set<string>, name: string): void {
  if (keys.length !== expected.size) throw new Error(`Audit ${name}: unexpected number of keys.`);
  for (let i = 0; i < keys.length; i++) {
    if (!expected.has(keys[i]!)) throw new Error(`Audit ${name}: unknown key "${keys[i]}".`);
    if (i > 0 && codepointCmp(keys[i - 1]!, keys[i]!) >= 0) throw new Error(`Audit ${name}: keys not canonically sorted.`);
  }
}

const ROOT = new Set(["version","chatId","day","semanticMemory","fastMemory","lessons","skills"]);

export function deserializeAndValidateAudit(json: string): DreamAudit {
  if (Buffer.byteLength(json, "utf-8") > MAX_AUDIT_JSON_BYTES) {
    throw new Error("Audit JSON exceeds maximum byte size.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("Audit JSON is not valid JSON."); }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Audit must be a JSON object.");
  const obj = parsed as Record<string, unknown>;

  const canonical = JSON.stringify(obj, replacerSortedKeys);
  if (canonical !== json) throw new Error("Audit JSON is not canonically serialized.");

  assertCanonicalKeys(Object.keys(obj), ROOT, "root");
  if (obj.version !== AUDIT_VERSION) throw new Error(`Unsupported audit version: ${String(obj.version)}.`);

  const chatId = assertNonEmptyStr(obj.chatId, "chatId", 256);
  const day = assertNonEmptyStr(obj.day, "day", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error("Audit day must be YYYY-MM-DD.");
  assertCalendarDay(day, "audit.day");

  const sm = assertObj(obj.semanticMemory, "semanticMemory");
  assertCanonicalKeys(Object.keys(sm), new Set(["before","after","changed"]), "semanticMemory");
  const before = validateMemorySnapshot(sm.before, "semanticMemory.before", chatId);
  const after = validateMemorySnapshot(sm.after, "semanticMemory.after", chatId);
  const smChanged = assertBool(sm.changed, "semanticMemory.changed");
  if (smChanged !== !memoryFullEq(before ?? undefined, after ?? undefined)) {
    throw new Error("Audit semanticMemory.changed inconsistent with snapshots.");
  }

  const fastMemory = validateDelta(assertObj(obj.fastMemory, "fastMemory"), chatId, MAX_FAST_CHAT_MEMORY_ITEMS, "fastMemory", validateFastArr, fastUpd);
  const lessons = validateDelta(assertObj(obj.lessons, "lessons"), chatId, MAX_CHAT_LESSONS, "lessons", validateLessonArr, lessonUpd);
  const skills = validateDelta(assertObj(obj.skills, "skills"), chatId, MAX_CHAT_SKILLS, "skills", validateSkillArr, skillUpd);

  return { version: AUDIT_VERSION, chatId, day, semanticMemory: { before, after, changed: smChanged }, fastMemory, lessons, skills };
}

export function validateAndBoundAudit(audit: DreamAudit): void {
  const json = serializeAudit(audit);
  if (Buffer.byteLength(json, "utf-8") > MAX_AUDIT_JSON_BYTES) {
    throw new Error(`Audit JSON is ${Buffer.byteLength(json, "utf-8")} bytes, maximum is ${MAX_AUDIT_JSON_BYTES}.`);
  }
  deserializeAndValidateAudit(json);
}

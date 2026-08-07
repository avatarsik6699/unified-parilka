import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DREAM_CHAT_ID,
  DREAM_YESTERDAY,
} from "./support/dream.js";
import {
  computeDreamAudit,
  serializeAudit,
  deserializeAndValidateAudit,
  validateAndBoundAudit,
  MAX_AUDIT_JSON_BYTES,
} from "../src/storage/dream-audit-codec.js";
import { MAX_FAST_CHAT_MEMORY_ITEMS } from "../src/storage/chat-knowledge.js";

// ── Audit compute ──────────────────────────────────────────────────────────

test("audit captures full semantic memory delta", () => {
  const audit = computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: { chatId: DREAM_CHAT_ID, memoryText: "old", lastConsolidatedMessageId: 5, revision: 3, updatedAtMs: 100 },
    memoryAfter: { chatId: DREAM_CHAT_ID, memoryText: "new", lastConsolidatedMessageId: 10, revision: 4, updatedAtMs: 200 },
    fastBefore: [], fastAfter: [], lessonsBefore: [], lessonsAfter: [], skillsBefore: [], skillsAfter: [],
  }, { fast: new Set(), lessons: new Set(), skills: new Set() });
  assert.equal(audit.semanticMemory.changed, true);
  assert.equal(audit.semanticMemory.before?.revision, 3);
  assert.equal(audit.semanticMemory.after?.updatedAtMs, 200);
});

test("revision zero is valid", () => {
  const mem = { chatId: DREAM_CHAT_ID, memoryText: "", revision: 0, updatedAtMs: 0 };
  const audit = computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: undefined, memoryAfter: mem,
    fastBefore: [], fastAfter: [], lessonsBefore: [], lessonsAfter: [], skillsBefore: [], skillsAfter: [],
  }, { fast: new Set(), lessons: new Set(), skills: new Set() });
  deserializeAndValidateAudit(serializeAudit(audit));
});

test("memoryChanged detects updatedAtMs difference", () => {
  const a = { chatId: DREAM_CHAT_ID, memoryText: "same", lastConsolidatedMessageId: 1, revision: 1, updatedAtMs: 100 };
  const b = { chatId: DREAM_CHAT_ID, memoryText: "same", lastConsolidatedMessageId: 1, revision: 1, updatedAtMs: 200 };
  assert.equal(computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: a, memoryAfter: b, fastBefore: [], fastAfter: [], lessonsBefore: [], lessonsAfter: [], skillsBefore: [], skillsAfter: [],
  }, { fast: new Set(), lessons: new Set(), skills: new Set() }).semanticMemory.changed, true);
});

test("fast: full records with chatId", () => {
  const before = [
    { chatId: DREAM_CHAT_ID, key: "upd", title: "old", note: "old", sourceMessageId: 1, createdAtMs: 10, updatedAtMs: 20 },
    { chatId: DREAM_CHAT_ID, key: "del", title: "stale", note: "gone", sourceMessageId: 2, createdAtMs: 30, updatedAtMs: 40 },
    { chatId: DREAM_CHAT_ID, key: "ev", title: "oldest", note: "pushed", sourceMessageId: 3, createdAtMs: 5, updatedAtMs: 10 },
    { chatId: DREAM_CHAT_ID, key: "un", title: "survivor", note: "stays", sourceMessageId: 4, createdAtMs: 50, updatedAtMs: 60 },
  ];
  const after = [
    { chatId: DREAM_CHAT_ID, key: "upd", title: "new", note: "new", sourceMessageId: 1, createdAtMs: 10, updatedAtMs: 100 },
    { chatId: DREAM_CHAT_ID, key: "new", title: "fresh", note: "added", sourceMessageId: 5, createdAtMs: 110, updatedAtMs: 110 },
    { chatId: DREAM_CHAT_ID, key: "un", title: "survivor", note: "stays", sourceMessageId: 4, createdAtMs: 50, updatedAtMs: 60 },
  ];
  const audit = computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: undefined, memoryAfter: undefined,
    fastBefore: before, fastAfter: after, lessonsBefore: [], lessonsAfter: [], skillsBefore: [], skillsAfter: [],
  }, { fast: new Set(["del"]), lessons: new Set(), skills: new Set() });
  assert.equal(audit.fastMemory.created.length, 1);
  assert.equal(audit.fastMemory.created[0]?.chatId, DREAM_CHAT_ID);
  assert.equal(audit.fastMemory.updated.length, 1);
  assert.equal(audit.fastMemory.updated[0]?.before.note, "old");
  assert.equal(audit.fastMemory.updated[0]?.after.note, "new");
  assert.equal(audit.fastMemory.deleted.length, 1);
  assert.equal(audit.fastMemory.evicted.length, 1);
});

test("skill: name preserved, not remapped", () => {
  const before = [{ chatId: DREAM_CHAT_ID, key: "sk", name: "My Skill", description: "desc", instructions: "do", sourceMessageId: 1, createdAtMs: 10, updatedAtMs: 20 }];
  const after = [{ chatId: DREAM_CHAT_ID, key: "sk", name: "My Skill", description: "updated", instructions: "do", sourceMessageId: 1, createdAtMs: 10, updatedAtMs: 100 }];
  const audit = computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: undefined, memoryAfter: undefined,
    fastBefore: [], fastAfter: [], lessonsBefore: [], lessonsAfter: [], skillsBefore: before, skillsAfter: after,
  }, { fast: new Set(), lessons: new Set(), skills: new Set() });
  assert.equal(audit.skills.updated[0]?.after.name, "My Skill");
});

// ── Canonical serialization ────────────────────────────────────────────────

test("serialization deterministic and canonical", () => {
  const audit = computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: undefined, memoryAfter: undefined,
    fastBefore: [], fastAfter: [], lessonsBefore: [], lessonsAfter: [], skillsBefore: [], skillsAfter: [],
  }, { fast: new Set(), lessons: new Set(), skills: new Set() });
  assert.equal(serializeAudit(audit), serializeAudit(audit));
  deserializeAndValidateAudit(serializeAudit(audit));
});

// ── Deserialize rejects ────────────────────────────────────────────────────

test("rejects non-canonical JSON", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const bad = { day: obj.day, version: obj.version, skills: obj.skills, lessons: obj.lessons, fastMemory: obj.fastMemory, semanticMemory: obj.semanticMemory, chatId: obj.chatId };
  assert.throws(() => deserializeAndValidateAudit(JSON.stringify(bad)), /not canonically serialized/);
});

test("rejects unknown key in record", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [{ chatId: DREAM_CHAT_ID, key: "k", title: "t", note: "n", unknownField: 42, createdAtMs: 0, updatedAtMs: 0 }];
  fm.changed = true; fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /unknown key/);
});

test("rejects unsorted records", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [
    { chatId: DREAM_CHAT_ID, key: "z", title: "z", note: "z", createdAtMs: 0, updatedAtMs: 0 },
    { chatId: DREAM_CHAT_ID, key: "a", title: "a", note: "a", createdAtMs: 0, updatedAtMs: 0 },
  ];
  fm.changed = true; fm.afterCount = 2;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /not sorted/);
});

test("rejects changed inconsistency", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [{ chatId: DREAM_CHAT_ID, key: "k", title: "k", note: "n", createdAtMs: 0, updatedAtMs: 0 }];
  fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /changed inconsistent/);
});

test("rejects count-delta inconsistency", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [{ chatId: DREAM_CHAT_ID, key: "k", title: "k", note: "n", createdAtMs: 0, updatedAtMs: 0 }];
  fm.changed = true; fm.beforeCount = 0; fm.afterCount = 2;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /count-delta inconsistency/);
});

test("rejects cross-class duplicate key", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [{ chatId: DREAM_CHAT_ID, key: "dupkey", title: "DupKey", note: "n", createdAtMs: 0, updatedAtMs: 0 }];
  fm.deleted = [{ chatId: DREAM_CHAT_ID, key: "dupkey", title: "DupKey", note: "n", createdAtMs: 0, updatedAtMs: 0 }];
  fm.changed = true; fm.beforeCount = 1; fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /appears in both/);
});

test("rejects malformed updated pair: before.key != after.key", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.updated = [{ before: { chatId: DREAM_CHAT_ID, key: "a", title: "a", note: "n", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "b", title: "b", note: "n", createdAtMs: 0, updatedAtMs: 0 } }];
  fm.changed = true; fm.beforeCount = 1; fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /before.key != after.key/);
});

test("rejects key not normalizedKnowledgeKey of title", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [{ chatId: DREAM_CHAT_ID, key: "wrong-key", title: "Real Title", note: "n", createdAtMs: 0, updatedAtMs: 0 }];
  fm.changed = true; fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /key not normalizedKnowledgeKey/);
});

test("rejects count exceeding capacity", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.afterCount = 999;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /exceeds capacity/);
});

test("rejects oversized blob", () => {
  assert.throws(() => deserializeAndValidateAudit("x".repeat(MAX_AUDIT_JSON_BYTES + 1)), /exceeds maximum byte size/);
});

test("validateAndBoundAudit rejects >5MiB", () => {
  const big = "x".repeat(5_500_000);
  const audit = {
    version: 1 as const, chatId: DREAM_CHAT_ID, day: DREAM_YESTERDAY,
    semanticMemory: { before: null, after: { chatId: DREAM_CHAT_ID, memoryText: big, revision: 1, updatedAtMs: 100 }, changed: true },
    fastMemory: { created: [], updated: [], deleted: [], evicted: [], beforeCount: 0, afterCount: 0, changed: false },
    lessons: { created: [], updated: [], deleted: [], evicted: [], beforeCount: 0, afterCount: 0, changed: false },
    skills: { created: [], updated: [], deleted: [], evicted: [], beforeCount: 0, afterCount: 0, changed: false },
  };
  assert.throws(() => validateAndBoundAudit(audit), /bytes, maximum/);
});

// ── lastConsolidatedMessageId must be positive (not zero) ──────────────────

test("accepts positive lastConsolidatedMessageId", () => {
  const mem = { chatId: DREAM_CHAT_ID, memoryText: "x", lastConsolidatedMessageId: 5, revision: 0, updatedAtMs: 0 };
  const audit = computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: undefined, memoryAfter: mem,
    fastBefore: [], fastAfter: [], lessonsBefore: [], lessonsAfter: [], skillsBefore: [], skillsAfter: [],
  }, { fast: new Set(), lessons: new Set(), skills: new Set() });
  deserializeAndValidateAudit(serializeAudit(audit));
});

test("rejects zero lastConsolidatedMessageId", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const sm = obj.semanticMemory as Record<string, unknown>;
  sm.after = { chatId: DREAM_CHAT_ID, memoryText: "x", lastConsolidatedMessageId: 0, revision: 1, updatedAtMs: 100 };
  sm.changed = true;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /must be a positive safe integer/);
});

// ── Optional fields: explicit null is absent only when missing ─────────────

test("rejects null sourceMessageId in fast record", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [{ chatId: DREAM_CHAT_ID, key: "k", title: "k", note: "n", sourceMessageId: null, createdAtMs: 0, updatedAtMs: 0 }];
  fm.changed = true; fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /sourceMessageId: must be a safe integer/);
});

test("rejects null sourceMessageId in lesson record", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const ls = obj.lessons as Record<string, unknown>;
  ls.created = [{ chatId: DREAM_CHAT_ID, key: "k", title: "k", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: null, createdAtMs: 0, updatedAtMs: 0 }];
  ls.changed = true; ls.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /sourceMessageId: must be a safe integer/);
});

test("rejects null sourceMessageId in skill record", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const sk = obj.skills as Record<string, unknown>;
  sk.created = [{ chatId: DREAM_CHAT_ID, key: "k", name: "k", description: "d", instructions: "i", sourceMessageId: null, createdAtMs: 0, updatedAtMs: 0 }];
  sk.changed = true; sk.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /sourceMessageId: must be a safe integer/);
});

test("rejects null lastConsolidatedMessageId", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const sm = obj.semanticMemory as Record<string, unknown>;
  sm.after = { chatId: DREAM_CHAT_ID, memoryText: "x", lastConsolidatedMessageId: null, revision: 1, updatedAtMs: 100 };
  sm.changed = true;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /lastConsolidatedMessageId: must be a safe integer/);
});

// ── Whitespace-only strings ───────────────────────────────────────────────

test("rejects whitespace-only title", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.created = [{ chatId: DREAM_CHAT_ID, key: "k", title: "   ", note: "n", createdAtMs: 0, updatedAtMs: 0 }];
  fm.changed = true; fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /must be non-empty/);
});

// ── Updated pair edge cases ────────────────────────────────────────────────

test("rejects duplicate updated fast keys", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.updated = [
    { before: { chatId: DREAM_CHAT_ID, key: "k", title: "k", note: "n", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "k", title: "  k  ", note: "n2", createdAtMs: 0, updatedAtMs: 100 } },
    { before: { chatId: DREAM_CHAT_ID, key: "k", title: "k", note: "n", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "k", title: "  k  ", note: "n3", createdAtMs: 0, updatedAtMs: 200 } },
  ];
  fm.changed = true; fm.beforeCount = 2; fm.afterCount = 2;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /not sorted or duplicate key/);
});

test("rejects unsorted updated fast keys", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.updated = [
    { before: { chatId: DREAM_CHAT_ID, key: "z", title: "z", note: "n", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "z", title: "  z  ", note: "n2", createdAtMs: 0, updatedAtMs: 100 } },
    { before: { chatId: DREAM_CHAT_ID, key: "a", title: "a", note: "n", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "a", title: "  a  ", note: "n2", createdAtMs: 0, updatedAtMs: 100 } },
  ];
  fm.changed = true; fm.beforeCount = 2; fm.afterCount = 2;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /not sorted or duplicate key/);
});

// The two containment guards (updated+deleted+evicted > beforeCount and
// updated+created > afterCount) are algebraically equivalent under the count
// equation afterCount-beforeCount = created-deleted-evicted, so only the
// beforeCount side is separately reachable: two updated keys with
// beforeCount=afterCount=1 satisfy the count equation (1-1 = 0-0-0) yet
// overflow both snapshot counts.
test("rejects updated keys overflowing both snapshot counts", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  fm.updated = [
    { before: { chatId: DREAM_CHAT_ID, key: "a", title: "a", note: "n", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "a", title: "  a  ", note: "n2", createdAtMs: 0, updatedAtMs: 100 } },
    { before: { chatId: DREAM_CHAT_ID, key: "b", title: "b", note: "n", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "b", title: "  b  ", note: "n2", createdAtMs: 0, updatedAtMs: 100 } },
  ];
  fm.changed = true; fm.beforeCount = 1; fm.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /exceeds beforeCount \(1\)/);
});

test("rejects delta array exceeding layer capacity", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const fm = obj.fastMemory as Record<string, unknown>;
  // 13 records > MAX_FAST_CHAT_MEMORY_ITEMS (12); beforeCount/afterCount stay
  // within capacity (12) so the count-capacity guard cannot fire first — the
  // per-array guard is the only one that can trip.
  fm.created = Array.from({ length: MAX_FAST_CHAT_MEMORY_ITEMS + 1 }, (_, i) => {
    const key = String.fromCodePoint(97 + i); // a..m
    return { chatId: DREAM_CHAT_ID, key, title: key, note: "n", createdAtMs: 0, updatedAtMs: 0 };
  });
  fm.changed = true; fm.beforeCount = MAX_FAST_CHAT_MEMORY_ITEMS; fm.afterCount = MAX_FAST_CHAT_MEMORY_ITEMS;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /fastMemory\.created exceeds capacity/);
});

// ── Malformed lesson updated pair ─────────────────────────────────────────

test("rejects malformed lesson updated: before.key != after.key", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const ls = obj.lessons as Record<string, unknown>;
  ls.updated = [{ before: { chatId: DREAM_CHAT_ID, key: "a", title: "a", problem: "p", solution: "s", whenToApply: "w", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "b", title: "b", problem: "p", solution: "s", whenToApply: "w", createdAtMs: 0, updatedAtMs: 0 } }];
  ls.changed = true; ls.beforeCount = 1; ls.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /before.key != after.key/);
});

test("rejects lesson updated: after chatId mismatch with root", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const ls = obj.lessons as Record<string, unknown>;
  ls.updated = [{ before: { chatId: DREAM_CHAT_ID, key: "a", title: "a", problem: "p", solution: "s", whenToApply: "w", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: "-1000000000", key: "a", title: "a", problem: "p", solution: "s", whenToApply: "w", createdAtMs: 0, updatedAtMs: 100 } }];
  ls.changed = true; ls.beforeCount = 1; ls.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /chatId mismatch/);
});

test("rejects lesson updated: zero sourceMessageId", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const ls = obj.lessons as Record<string, unknown>;
  ls.updated = [{ before: { chatId: DREAM_CHAT_ID, key: "a", title: "a", problem: "p", solution: "s", whenToApply: "w", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "a", title: "a", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 0, createdAtMs: 0, updatedAtMs: 100 } }];
  ls.changed = true; ls.beforeCount = 1; ls.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /sourceMessageId must be positive/);
});

// ── Malformed skill updated pair ──────────────────────────────────────────

test("rejects malformed skill updated: before.key != after.key", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const sk = obj.skills as Record<string, unknown>;
  sk.updated = [{ before: { chatId: DREAM_CHAT_ID, key: "a", name: "a", description: "d", instructions: "i", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "b", name: "b", description: "d", instructions: "i", createdAtMs: 0, updatedAtMs: 0 } }];
  sk.changed = true; sk.beforeCount = 1; sk.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /before.key != after.key/);
});

test("rejects skill updated: after chatId mismatch with root", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const sk = obj.skills as Record<string, unknown>;
  sk.updated = [{ before: { chatId: DREAM_CHAT_ID, key: "a", name: "a", description: "d", instructions: "i", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: "-1000000000", key: "a", name: "a", description: "d", instructions: "i", createdAtMs: 0, updatedAtMs: 100 } }];
  sk.changed = true; sk.beforeCount = 1; sk.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /chatId mismatch/);
});

test("rejects skill updated: zero sourceMessageId", () => {
  const json = serializeAudit(emptyAudit());
  const obj = JSON.parse(json) as Record<string, unknown>;
  const sk = obj.skills as Record<string, unknown>;
  sk.updated = [{ before: { chatId: DREAM_CHAT_ID, key: "a", name: "a", description: "d", instructions: "i", createdAtMs: 0, updatedAtMs: 0 }, after: { chatId: DREAM_CHAT_ID, key: "a", name: "a", description: "d", instructions: "i", sourceMessageId: 0, createdAtMs: 0, updatedAtMs: 100 } }];
  sk.changed = true; sk.beforeCount = 1; sk.afterCount = 1;
  assert.throws(() => deserializeAndValidateAudit(sFree(obj)), /sourceMessageId must be positive/);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyAudit() {
  return computeDreamAudit(DREAM_CHAT_ID, DREAM_YESTERDAY, {
    memoryBefore: undefined, memoryAfter: undefined,
    fastBefore: [], fastAfter: [], lessonsBefore: [], lessonsAfter: [], skillsBefore: [], skillsAfter: [],
  }, { fast: new Set(), lessons: new Set(), skills: new Set() });
}

function sFree(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      const s: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) s[k] = (v as Record<string, unknown>)[k];
      return s;
    }
    return v;
  });
}

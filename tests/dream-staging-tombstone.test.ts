import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DREAM_CHAT_ID,
  dreamFixtureStore,
} from "./support/dream.js";
import { StagedKnowledgeOverlay } from "../src/dream/staged-knowledge.js";

// ── Fast ──

test("fast: delete then upsert revives", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "Keep", note: "alive", sourceMessageId: 1 });
    const s = new StagedKnowledgeOverlay(store);
    s.deleteFastChatMemory(DREAM_CHAT_ID, "Keep");
    assert.equal(s.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    s.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "Keep", note: "revived", sourceMessageId: 2 });
    assert.equal(s.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    assert.equal(s.listFastChatMemory(DREAM_CHAT_ID)[0]?.note, "revived");
  } finally { cleanup(); }
});

test("fast: upsert then delete removes", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    const s = new StagedKnowledgeOverlay(store);
    s.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "New", note: "fresh", sourceMessageId: 1 });
    assert.equal(s.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    s.deleteFastChatMemory(DREAM_CHAT_ID, "New");
    assert.equal(s.listFastChatMemory(DREAM_CHAT_ID).length, 0);
  } finally { cleanup(); }
});

test("fast: parent tombstone → child upsert revives", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "Parent", note: "here", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    parent.deleteFastChatMemory(DREAM_CHAT_ID, "Parent");
    assert.equal(parent.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    const child = parent.fork();
    child.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "Parent", note: "revived", sourceMessageId: 2 });
    assert.equal(child.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    parent.mergeFrom(child);
    assert.equal(parent.listFastChatMemory(DREAM_CHAT_ID).length, 1);
  } finally { cleanup(); }
});

test("fast: child delete merged, parent reflects deletion", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "Gone", note: "doomed", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    assert.equal(parent.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    const child = parent.fork();
    child.deleteFastChatMemory(DREAM_CHAT_ID, "Gone");
    parent.mergeFrom(child);
    assert.equal(parent.listFastChatMemory(DREAM_CHAT_ID).length, 0);
  } finally { cleanup(); }
});

test("fast: discarded child tombstone does not leak — key stays visible in parent", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertFastChatMemory({ chatId: DREAM_CHAT_ID, title: "Visible", note: "stays", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    assert.equal(parent.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    // Delete only in child, never merge.
    const child = parent.fork();
    child.deleteFastChatMemory(DREAM_CHAT_ID, "Visible");
    assert.equal(child.listFastChatMemory(DREAM_CHAT_ID).length, 0);
    // child discarded — parent still sees it.
    assert.equal(parent.listFastChatMemory(DREAM_CHAT_ID).length, 1);
    assert.equal(parent.listFastChatMemory(DREAM_CHAT_ID)[0]?.title, "Visible");
  } finally { cleanup(); }
});

// ── Lesson ──

test("lesson: delete then upsert revives", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "L", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
    const s = new StagedKnowledgeOverlay(store);
    s.deleteChatLesson(DREAM_CHAT_ID, "L");
    assert.equal(s.listChatLessons(DREAM_CHAT_ID).length, 0);
    s.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "L", problem: "p2", solution: "s", whenToApply: "w", sourceMessageId: 2 });
    assert.equal(s.listChatLessons(DREAM_CHAT_ID).length, 1);
  } finally { cleanup(); }
});

test("lesson: upsert then delete removes", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    const s = new StagedKnowledgeOverlay(store);
    s.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "L", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
    s.deleteChatLesson(DREAM_CHAT_ID, "L");
    assert.equal(s.listChatLessons(DREAM_CHAT_ID).length, 0);
  } finally { cleanup(); }
});

test("lesson: parent tombstone → child upsert revives", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "LP", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    parent.deleteChatLesson(DREAM_CHAT_ID, "LP");
    assert.equal(parent.listChatLessons(DREAM_CHAT_ID).length, 0);
    const child = parent.fork();
    child.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "LP", problem: "p2", solution: "s", whenToApply: "w", sourceMessageId: 2 });
    assert.equal(child.listChatLessons(DREAM_CHAT_ID).length, 1);
    parent.mergeFrom(child);
    assert.equal(parent.listChatLessons(DREAM_CHAT_ID).length, 1);
  } finally { cleanup(); }
});

test("lesson: child delete merged, parent reflects deletion", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "LD", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    assert.equal(parent.listChatLessons(DREAM_CHAT_ID).length, 1);
    const child = parent.fork();
    child.deleteChatLesson(DREAM_CHAT_ID, "LD");
    parent.mergeFrom(child);
    assert.equal(parent.listChatLessons(DREAM_CHAT_ID).length, 0);
  } finally { cleanup(); }
});

test("lesson: discarded child tombstone does not leak", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatLesson({ chatId: DREAM_CHAT_ID, title: "VisL", problem: "p", solution: "s", whenToApply: "w", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    const child = parent.fork();
    child.deleteChatLesson(DREAM_CHAT_ID, "VisL");
    // discarded — parent still sees it.
    assert.equal(parent.listChatLessons(DREAM_CHAT_ID).length, 1);
  } finally { cleanup(); }
});

// ── Skill ──

test("skill: delete then upsert revives", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "SK", description: "d", instructions: "i", sourceMessageId: 1 });
    const s = new StagedKnowledgeOverlay(store);
    s.deleteChatSkill(DREAM_CHAT_ID, "SK");
    assert.equal(s.listChatSkills(DREAM_CHAT_ID).length, 0);
    s.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "SK", description: "d2", instructions: "i", sourceMessageId: 2 });
    assert.equal(s.listChatSkills(DREAM_CHAT_ID).length, 1);
  } finally { cleanup(); }
});

test("skill: upsert then delete removes", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    const s = new StagedKnowledgeOverlay(store);
    s.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "SKN", description: "d", instructions: "i", sourceMessageId: 1 });
    assert.equal(s.listChatSkills(DREAM_CHAT_ID).length, 1);
    s.deleteChatSkill(DREAM_CHAT_ID, "SKN");
    assert.equal(s.listChatSkills(DREAM_CHAT_ID).length, 0);
  } finally { cleanup(); }
});

test("skill: child delete merged, parent reflects deletion", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "SKD", description: "d", instructions: "i", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    assert.equal(parent.listChatSkills(DREAM_CHAT_ID).length, 1);
    const child = parent.fork();
    child.deleteChatSkill(DREAM_CHAT_ID, "SKD");
    parent.mergeFrom(child);
    assert.equal(parent.listChatSkills(DREAM_CHAT_ID).length, 0);
  } finally { cleanup(); }
});

test("skill: parent→child revive via upsert after merge", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "SK2", description: "d", instructions: "i", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    parent.deleteChatSkill(DREAM_CHAT_ID, "SK2");
    const child = parent.fork();
    child.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "SK2", description: "better", instructions: "redo", sourceMessageId: 2 });
    parent.mergeFrom(child);
    assert.equal(parent.listChatSkills(DREAM_CHAT_ID).length, 1);
    assert.equal(parent.listChatSkills(DREAM_CHAT_ID)[0]?.description, "better");
  } finally { cleanup(); }
});

test("skill: discarded child tombstone does not leak", () => {
  const { store, cleanup } = dreamFixtureStore("parilka-ts-");
  try {
    store.upsertChatSkill({ chatId: DREAM_CHAT_ID, name: "VisS", description: "d", instructions: "i", sourceMessageId: 1 });
    const parent = new StagedKnowledgeOverlay(store);
    assert.equal(parent.listChatSkills(DREAM_CHAT_ID).length, 1);
    const child = parent.fork();
    child.deleteChatSkill(DREAM_CHAT_ID, "VisS");
    assert.equal(child.listChatSkills(DREAM_CHAT_ID).length, 0);
    // discarded — parent still sees it.
    assert.equal(parent.listChatSkills(DREAM_CHAT_ID).length, 1);
    assert.equal(parent.listChatSkills(DREAM_CHAT_ID)[0]?.name, "VisS");
  } finally { cleanup(); }
});

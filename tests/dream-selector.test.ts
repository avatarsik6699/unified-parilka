import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDreamDay } from "../src/dream/projection.js";
import { selectDreamInteractions } from "../src/dream/selector.js";
import { MessageStore } from "../src/store.js";
import type { StoredMessage } from "../src/store.js";

const CHAT_ID = "-1003179772905";
const BOT_SENDER_ID = "100000000";
const HUMAN_SENDER_ID = "200000000";

function fixtureStore() {
  const directory = mkdtempSync(join(tmpdir(), "parilka-dream-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Dream Test",
    kind: "channel",
    isForum: false,
  });
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function utcDate(
  day: string,
  hour: number,
  minute: number,
  second: number,
): string {
  return new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`).toISOString();
}

function seedMessages(store: MessageStore, messages: StoredMessage[]): void {
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Dream Test",
      kind: "channel",
      isForum: false,
    },
    messages,
  );
}

function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i += 1) {
    result.push(i);
  }
  return result;
}

test("selector reads exactly 8 previous and 30 next live rows and crosses midnight", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const dayD = "2026-07-31";
    const dayNext = "2026-08-01";
    const messages: StoredMessage[] = [];
    // 8 live rows before the trigger, all on the previous calendar day.
    for (const id of range(12, 19)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: utcDate(dayD, 20, 50 + (id - 12), 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: `filler ${id}`,
      });
    }
    // Trigger and answer on the next Moscow day (starts at 21:00 UTC).
    messages.push({
      chatId: CHAT_ID,
      messageId: 20,
      date: utcDate(dayD, 21, 5, 0),
      senderId: HUMAN_SENDER_ID,
      senderName: "Alice",
      text: "trigger",
    });
    messages.push({
      chatId: CHAT_ID,
      messageId: 21,
      date: utcDate(dayD, 21, 6, 0),
      senderId: BOT_SENDER_ID,
      senderName: "Bot",
      text: "answer",
      replyToMessageId: 20,
    });
    // 30 live rows after the answer.
    for (const id of range(22, 51)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: utcDate(dayD, 21, 6 + id - 20, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: `after ${id}`,
      });
    }
    seedMessages(store, messages);

    const { interactions } = selectDreamInteractions(
      store,
      CHAT_ID,
      dayNext,
      BOT_SENDER_ID,
    );
    assert.equal(interactions.length, 1);
    const window = interactions[0]!.window;
    const ids = window.messages.map((m) => m.messageId);
    assert.deepEqual(ids, range(12, 51));
    assert.deepEqual(window.triggerIndices, [8]);
    assert.deepEqual(window.answerIndices, [9]);
  } finally {
    cleanup();
  }
});

test("selector skips continuation chunks anchored in another day", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const dayD = "2026-07-31";
    const dayNext = "2026-08-01";
    seedMessages(store, [
      {
        chatId: CHAT_ID,
        messageId: 30,
        date: utcDate("2026-07-30", 12, 0, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger",
      },
      {
        chatId: CHAT_ID,
        messageId: 31,
        date: utcDate(dayD, 20, 55, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "chunk one",
        replyToMessageId: 30,
      },
      {
        chatId: CHAT_ID,
        messageId: 32,
        date: utcDate(dayNext, 0, 5, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "chunk two",
        replyToMessageId: 30,
      },
    ]);

    const nextDay = selectDreamInteractions(store, CHAT_ID, dayNext, BOT_SENDER_ID);
    assert.equal(nextDay.interactions.length, 0);
    assert.equal(nextDay.incomplete.length, 0);

    const dayDResult = selectDreamInteractions(store, CHAT_ID, dayD, BOT_SENDER_ID);
    assert.equal(dayDResult.interactions.length, 1);
    assert.deepEqual(dayDResult.interactions[0]!.answerMessageIds, [31, 32]);
  } finally {
    cleanup();
  }
});

test("selector overlap merge preserves multiple trigger and answer markers", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const day = "2026-07-31";
    const messages: StoredMessage[] = [];
    for (const id of range(1, 15)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: utcDate(day, 10, id, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: `filler ${id}`,
      });
    }
    messages.push(
      {
        chatId: CHAT_ID,
        messageId: 16,
        date: utcDate(day, 11, 0, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger one",
      },
      {
        chatId: CHAT_ID,
        messageId: 17,
        date: utcDate(day, 11, 1, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "answer one",
        replyToMessageId: 16,
      },
      {
        chatId: CHAT_ID,
        messageId: 18,
        date: utcDate(day, 11, 2, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Bob",
        text: "trigger two",
      },
      {
        chatId: CHAT_ID,
        messageId: 19,
        date: utcDate(day, 11, 3, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "answer two",
        replyToMessageId: 18,
      },
    );
    for (const id of range(20, 49)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: utcDate(day, 11, 3 + id - 19, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: `after ${id}`,
      });
    }
    seedMessages(store, messages);

    const { interactions } = selectDreamInteractions(store, CHAT_ID, day, BOT_SENDER_ID);
    assert.equal(interactions.length, 1);
    assert.deepEqual(interactions[0]!.triggerMessageIds, [16, 18]);
    assert.deepEqual(interactions[0]!.answerMessageIds, [17, 19]);
    const window = interactions[0]!.window;
    const triggerIndices = window.triggerIndices.sort((a, b) => a - b);
    const answerIndices = window.answerIndices.sort((a, b) => a - b);
    assert.deepEqual(
      triggerIndices.map((i) => window.messages[i]!.messageId),
      [16, 18],
    );
    assert.deepEqual(
      answerIndices.map((i) => window.messages[i]!.messageId),
      [17, 19],
    );
  } finally {
    cleanup();
  }
});

test("selector rejects deleted or bot-owned triggers as incomplete", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const day = "2026-07-31";
    seedMessages(store, [
      {
        chatId: CHAT_ID,
        messageId: 100,
        date: utcDate(day, 12, 0, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger",
      },
      {
        chatId: CHAT_ID,
        messageId: 101,
        date: utcDate(day, 12, 1, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "answer",
        replyToMessageId: 100,
      },
    ]);
    store.markMessagesDeleted(CHAT_ID, [100]);
    seedMessages(store, [
      {
        chatId: CHAT_ID,
        messageId: 102,
        date: utcDate(day, 12, 2, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "answer to deleted",
        replyToMessageId: 100,
      },
      {
        chatId: CHAT_ID,
        messageId: 200,
        date: utcDate(day, 12, 3, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "own trigger",
      },
      {
        chatId: CHAT_ID,
        messageId: 201,
        date: utcDate(day, 12, 4, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "answer to own",
        replyToMessageId: 200,
      },
    ]);

    const { incomplete } = selectDreamInteractions(store, CHAT_ID, day, BOT_SENDER_ID);
    const reasons = new Set(incomplete.map((i) => i.reason));
    assert.ok(reasons.has("deleted_trigger"));
    assert.ok(reasons.has("invalid_trigger_sender"));
  } finally {
    cleanup();
  }
});

test("projection keeps whole windows and never splits one across batches", () => {
  const messages: StoredMessage[] = [];
  for (let i = 1; i <= 2; i += 1) {
    const base = i * 100;
    messages.push(
      {
        chatId: CHAT_ID,
        messageId: base + 1,
        date: new Date("2026-07-31T12:00:00.000Z").toISOString(),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger",
      },
      {
        chatId: CHAT_ID,
        messageId: base + 2,
        date: new Date("2026-07-31T12:00:01.000Z").toISOString(),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "a".repeat(10_000),
        replyToMessageId: base + 1,
      },
    );
  }
  const interaction1 = {
    triggerMessageIds: [101],
    answerMessageIds: [102],
    rawInteractionCount: 2,
    window: {
      messages,
      triggerIndices: [0, 2],
      answerIndices: [1, 3],
    },
  };
  const projection = projectDreamDay([interaction1], {
    botSenderId: BOT_SENDER_ID,
    maxInputChars: 100,
  });
  assert.equal(projection.batches.length, 1);
  assert.equal(projection.batched, false);
  assert.equal(projection.interactionCount, 2);
  assert.equal(
    projection.batches[0]!.sourceText.split("\n").length,
    4,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDreamDay } from "../src/dream/projection.js";
import {
  selectDreamInteractions,
  type DreamSelectorStore,
} from "../src/dream/selector.js";
import { MessageStore } from "../src/store.js";
import type { StoredMessage } from "../src/store.js";

const CHAT_ID = "-1003179772905";
const BOT_SENDER_ID = "100000000";
const HUMAN_SENDER_ID = "200000000";

function fixtureStore() {
  const directory = mkdtempSync(join(tmpdir(), "parilka-dream-edge-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Dream Edge Test",
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
  return new Date(
    `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`,
  ).toISOString();
}

function seedMessages(store: MessageStore, messages: StoredMessage[]): void {
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Dream Edge Test",
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

test("selector uses Moscow midnight boundary, not UTC midnight", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const day = "2026-07-31";
    const nextDay = "2026-08-01";
    // 20:55 UTC is still the previous Moscow day (Moscow midnight is 21:00 UTC).
    seedMessages(store, [
      {
        chatId: CHAT_ID,
        messageId: 1,
        date: utcDate(day, 20, 55, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger before moscow midnight",
      },
      {
        chatId: CHAT_ID,
        messageId: 2,
        date: utcDate(day, 20, 56, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "answer before moscow midnight",
        replyToMessageId: 1,
      },
    ]);

    const dayResult = selectDreamInteractions(store, CHAT_ID, day, BOT_SENDER_ID);
    const nextDayResult = selectDreamInteractions(
      store,
      CHAT_ID,
      nextDay,
      BOT_SENDER_ID,
    );

    assert.equal(dayResult.interactions.length, 1);
    assert.equal(nextDayResult.interactions.length, 0);
  } finally {
    cleanup();
  }
});

test("selector paginates candidates without a hidden hard cap", () => {
  const pages: number[][] = [];
  const allCandidates: StoredMessage[] = [];
  for (let i = 1; i <= 2_500; i += 1) {
    allCandidates.push({
      chatId: CHAT_ID,
      messageId: i,
      date: new Date("2026-07-31T12:00:00.000Z").toISOString(),
      senderId: BOT_SENDER_ID,
      senderName: "Bot",
      text: `candidate ${i}`,
      replyToMessageId: i + 10_000,
    });
  }

  const fakeStore: DreamSelectorStore = {
    getMessagesByDateRange(params) {
      const startIndex =
        params.afterMessageId === undefined
          ? 0
          : allCandidates.findIndex((m) => m.messageId > params.afterMessageId!);
      const page = allCandidates.slice(
        Math.max(0, startIndex),
        Math.max(0, startIndex) + (params.limit ?? 1_000),
      );
      pages.push(page.map((m) => m.messageId));
      return page;
    },
    getMessagesByIds: () => [],
    getHistory: () => [],
  };

  const { interactions, incomplete } = selectDreamInteractions(
    fakeStore,
    CHAT_ID,
    "2026-07-31",
    BOT_SENDER_ID,
  );

  assert.equal(interactions.length, 0);
  assert.equal(incomplete.length, 2_500);
  assert.ok(pages.length > 1, "expected keyset pagination over multiple pages");
});

test("selector includes arbitrary live messages between trigger and later bot chunks", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const day = "2026-07-31";
    const messages: StoredMessage[] = [
      {
        chatId: CHAT_ID,
        messageId: 10,
        date: utcDate(day, 10, 0, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger",
      },
      {
        chatId: CHAT_ID,
        messageId: 11,
        date: utcDate(day, 10, 1, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "chunk one",
        replyToMessageId: 10,
      },
      {
        chatId: CHAT_ID,
        messageId: 12,
        date: utcDate(day, 10, 2, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Bob",
        text: "interleaved",
      },
      {
        chatId: CHAT_ID,
        messageId: 13,
        date: utcDate(day, 10, 3, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Carol",
        text: "also interleaved",
      },
      {
        chatId: CHAT_ID,
        messageId: 14,
        date: utcDate(day, 10, 4, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "chunk two",
        replyToMessageId: 10,
      },
    ];
    seedMessages(store, messages);

    const { interactions } = selectDreamInteractions(store, CHAT_ID, day, BOT_SENDER_ID);
    assert.equal(interactions.length, 1);
    const window = interactions[0]!.window;
    assert.deepEqual(
      window.messages.map((m) => m.messageId),
      [10, 11, 12, 13, 14],
    );
    assert.deepEqual(window.triggerIndices, [0]);
    assert.deepEqual(window.answerIndices, [1, 4]);
  } finally {
    cleanup();
  }
});

test("selector pages through-answer range and keeps every live row past 1000", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const day = "2026-07-31";
    const base = Date.UTC(2026, 6, 31, 10, 0, 0);
    const date = (id: number) => new Date(base + id * 1000).toISOString();
    const messages: StoredMessage[] = [
      {
        chatId: CHAT_ID,
        messageId: 10,
        date: date(10),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger",
      },
    ];
    // More than one full 1000-row page of live rows between the trigger and
    // the last consecutive bot chunk, so the through-answer range spans
    // multiple keyset pages.
    for (const id of range(11, 1510)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: date(id),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: `filler ${id}`,
      });
    }
    messages.push(
      {
        chatId: CHAT_ID,
        messageId: 1511,
        date: date(1511),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "chunk one",
        replyToMessageId: 10,
      },
      {
        chatId: CHAT_ID,
        messageId: 1512,
        date: date(1512),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "chunk two",
        replyToMessageId: 10,
      },
    );
    for (const id of range(1513, 1542)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: date(id),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: `after ${id}`,
      });
    }
    seedMessages(store, messages);

    const { interactions } = selectDreamInteractions(
      store,
      CHAT_ID,
      day,
      BOT_SENDER_ID,
    );
    assert.equal(interactions.length, 1);
    assert.deepEqual(interactions[0]!.answerMessageIds, [1511, 1512]);
    const window = interactions[0]!.window;
    assert.deepEqual(window.messages.map((m) => m.messageId), range(10, 1542));
    assert.deepEqual(window.triggerIndices, [0]);
    assert.deepEqual(window.answerIndices, [1501, 1502]);
  } finally {
    cleanup();
  }
});

test("selector preserves sparse cross-midnight context", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const dayD = "2026-07-31";
    const dayNext = "2026-08-01";
    const messages: StoredMessage[] = [];
    for (const id of range(1, 8)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: utcDate(dayD, 20, 50 + id, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: `before ${id}`,
      });
    }
    messages.push(
      {
        chatId: CHAT_ID,
        messageId: 9,
        date: utcDate(dayD, 21, 5, 0),
        senderId: HUMAN_SENDER_ID,
        senderName: "Alice",
        text: "trigger",
      },
      {
        chatId: CHAT_ID,
        messageId: 10,
        date: utcDate(dayD, 21, 6, 0),
        senderId: BOT_SENDER_ID,
        senderName: "Bot",
        text: "answer",
        replyToMessageId: 9,
      },
    );
    for (const id of range(11, 40)) {
      messages.push({
        chatId: CHAT_ID,
        messageId: id,
        date: utcDate(dayD, 21, 6 + id - 10, 0),
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
    const ids = interactions[0]!.window.messages.map((m) => m.messageId);
    assert.deepEqual(ids, range(1, 40));
  } finally {
    cleanup();
  }
});

test("projection preserves raw interaction count across merged windows", () => {
  const interactionA = {
    triggerMessageIds: [1],
    answerMessageIds: [2],
    rawInteractionCount: 1,
    window: {
      messages: [
        { chatId: CHAT_ID, messageId: 1, senderId: HUMAN_SENDER_ID, text: "a" },
        { chatId: CHAT_ID, messageId: 2, senderId: BOT_SENDER_ID, text: "A", replyToMessageId: 1 },
      ] as StoredMessage[],
      triggerIndices: [0],
      answerIndices: [1],
    },
  };
  const interactionB = {
    triggerMessageIds: [3],
    answerMessageIds: [4],
    rawInteractionCount: 1,
    window: {
      messages: [
        { chatId: CHAT_ID, messageId: 3, senderId: HUMAN_SENDER_ID, text: "b" },
        { chatId: CHAT_ID, messageId: 4, senderId: BOT_SENDER_ID, text: "B", replyToMessageId: 3 },
      ] as StoredMessage[],
      triggerIndices: [0],
      answerIndices: [1],
    },
  };
  const projection = projectDreamDay([interactionA, interactionB], {
    botSenderId: BOT_SENDER_ID,
    maxInputChars: 1_000,
  });
  assert.equal(projection.interactionCount, 2);
  assert.equal(projection.batched, false);
  assert.equal(projection.batches.length, 1);
  assert.equal(projection.batches[0]!.interactionCount, 2);
});

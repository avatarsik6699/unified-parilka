import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBotTurn } from "../src/bot/worker/turn-context.js";
import { MessageStore } from "../src/store.js";
import type { StoredBotTurn, StoredMessage } from "../src/store.js";

const CHAT_ID = "-1003179772905";

function fixtureStore() {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-memory-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Memory Test",
    kind: "channel",
    isForum: false,
  });
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Memory Test",
      kind: "channel",
      isForum: false,
    },
    [
      {
        chatId: CHAT_ID,
        messageId: 1,
        date: "2026-07-29T12:00:00Z",
        senderId: "user",
        senderName: "Alice",
        text: "hello",
      },
      {
        chatId: CHAT_ID,
        messageId: 2,
        date: "2026-07-29T12:01:00Z",
        senderId: "user",
        senderName: "Bob",
        text: "hi",
      },
    ] as StoredMessage[],
  );
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function makeTurn(triggerMessageId: number): StoredBotTurn {
  return {
    id: 1,
    updateId: 1,
    chatId: CHAT_ID,
    triggerMessageId,
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

test("loadBotTurn includes chat memory when present", () => {
  const { store, cleanup } = fixtureStore();
  try {
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "Alice says hello.",
      lastConsolidatedMessageId: 1,
    });
    const loaded = loadBotTurn(store, makeTurn(2));
    assert.ok(loaded);
    assert.equal(loaded?.memory?.memoryText, "Alice says hello.");
    assert.equal(loaded?.memory?.lastConsolidatedMessageId, 1);
  } finally {
    cleanup();
  }
});

test("loadBotTurn returns undefined memory when absent", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const loaded = loadBotTurn(store, makeTurn(2));
    assert.ok(loaded);
    assert.equal(loaded?.memory, undefined);
  } finally {
    cleanup();
  }
});

test("loadBotTurn returns undefined when trigger is missing", () => {
  const { store, cleanup } = fixtureStore();
  try {
    const loaded = loadBotTurn(store, makeTurn(999));
    assert.equal(loaded, undefined);
  } finally {
    cleanup();
  }
});

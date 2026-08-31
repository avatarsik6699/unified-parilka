import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MessageStore, type StoredMessage } from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT_A: ChatInfo = {
  chatId: "vk:2000000001",
  requested: "vk:2000000001",
  kind: "supergroup",
};
const CHAT_B: ChatInfo = {
  chatId: "vk:2000000002",
  requested: "vk:2000000002",
  kind: "supergroup",
};

function fixtureStore(t: TestContext): MessageStore {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  store.upsertMessages(CHAT_A, [
    message(CHAT_A.chatId, 1, "111", undefined, "привет"),
    message(CHAT_A.chatId, 2, "111", undefined, "как дела"),
    message(CHAT_A.chatId, 3, "222", "Уже с именем", "тест"),
  ]);
  store.upsertMessages(CHAT_B, [
    message(CHAT_B.chatId, 1, "333", undefined, "hi"),
  ]);
  return store;
}

function message(
  chatId: string,
  messageId: number,
  senderId: string,
  senderName: string | undefined,
  text: string,
): StoredMessage {
  return {
    chatId,
    messageId,
    date: "2026-08-01T10:00:00.000Z",
    senderId,
    ...(senderName === undefined ? {} : { senderName }),
    text,
  };
}

test("lists distinct unresolved sender ids per chat, skipping senders that already have a name", (t) => {
  const store = fixtureStore(t);
  const unresolved = store.listDistinctUnresolvedVkSenderIds(
    [CHAT_A.chatId, CHAT_B.chatId],
    100,
  );
  const set = new Set(unresolved.map((u) => `${u.chatId}:${u.senderId}`));
  assert.deepEqual(
    set,
    new Set([`${CHAT_A.chatId}:111`, `${CHAT_B.chatId}:333`]),
  );
});

test("an empty chatIds list returns no work without querying the database", (t) => {
  const store = fixtureStore(t);
  assert.deepEqual(store.listDistinctUnresolvedVkSenderIds([], 100), []);
});

test("backfillSenderName fills only NULL sender_name rows for that (chat, sender)", (t) => {
  const store = fixtureStore(t);
  const changed = store.backfillSenderName(
    CHAT_A.chatId,
    "111",
    "Резолвленное Имя",
  );
  assert.equal(changed, 2);

  const remaining = store.listDistinctUnresolvedVkSenderIds(
    [CHAT_A.chatId, CHAT_B.chatId],
    100,
  );
  assert.deepEqual(
    new Set(remaining.map((u) => `${u.chatId}:${u.senderId}`)),
    new Set([`${CHAT_B.chatId}:333`]),
  );

  const history = store.getHistory({ chatId: CHAT_A.chatId, limit: 10 });
  const resolved = history.filter((row) => row.senderId === "111");
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every((row) => row.senderName === "Резолвленное Имя"));
});

test("backfillSenderName never overwrites an already-known sender_name", (t) => {
  const store = fixtureStore(t);
  const changed = store.backfillSenderName(CHAT_A.chatId, "222", "Другое имя");
  assert.equal(changed, 0);

  const history = store.getHistory({ chatId: CHAT_A.chatId, limit: 10 });
  const row = history.find((r) => r.messageId === 3);
  assert.equal(row?.senderName, "Уже с именем");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { gramMessageToStored } from "../src/storage/message-adapter.js";
import type { ChatInfo } from "../src/telegram/types.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

test("legacy GramJS adapter rejects invalid identifiers without throwing", () => {
  assert.equal(gramMessageToStored(CHAT, null), undefined);
  assert.equal(gramMessageToStored(CHAT, { id: 0 }), undefined);
  assert.equal(gramMessageToStored(CHAT, { id: 1.5 }), undefined);
  assert.equal(gramMessageToStored(CHAT, { id: Symbol("invalid") }), undefined);
});

test("legacy GramJS adapter bounds malformed date and cyclic metadata", () => {
  const message: Record<string, unknown> = {
    id: 42,
    message: "hello",
    date: "not-a-timestamp",
  };
  message.views = message;

  const stored = gramMessageToStored(CHAT, message);

  assert.equal(stored?.messageId, 42);
  assert.equal(stored?.text, "hello");
  assert.equal(stored?.date, undefined);
  assert.equal(stored?.rawJson, undefined);
});

test("legacy GramJS adapter keeps valid bounded fields", () => {
  const stored = gramMessageToStored(CHAT, {
    id: 42,
    message: "hello",
    date: 1_700_000_000,
    senderId: 99n,
    sender: { username: "sender" },
    replyTo: { replyToMsgId: 7, topMsgId: 3 },
    groupedId: 11n,
    views: 2,
    forwards: 1,
    post: true,
  });

  assert.deepEqual(stored, {
    chatId: "-1001",
    messageId: 42,
    date: "2023-11-14T22:13:20.000Z",
    senderId: "99",
    senderName: "sender",
    text: "hello",
    replyToMessageId: 7,
    topicId: 3,
    rawJson: '{\n  "groupedId": "11",\n  "views": 2,\n  "forwards": 1,\n  "post": true\n}',
  });
});

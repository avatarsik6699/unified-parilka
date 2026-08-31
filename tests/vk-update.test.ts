import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageContext } from "vk-io";
import { normalizeVkUpdate } from "../src/bot/vk-update.js";

const GROUP_ID = 123456;
const ALLOWED_CHAT_ID = "vk:2000000001";
const PEER_ID = 2_000_000_001;

interface FakeMessageContextInput {
  id: number;
  peerId: number;
  senderId: number;
  text?: string;
  subTypes: readonly string[];
  createdAt?: number;
  hasReplyMessage?: boolean;
  replyMessage?: { id: number; senderId: number };
  hasAttachments?: boolean;
  hasGeo?: boolean;
}

function fakeContext(input: FakeMessageContextInput): MessageContext {
  return {
    id: input.id,
    peerId: input.peerId,
    senderId: input.senderId,
    text: input.text,
    subTypes: input.subTypes,
    createdAt: input.createdAt ?? 1_700_000_000,
    hasReplyMessage: input.hasReplyMessage ?? false,
    replyMessage: input.replyMessage,
    hasAttachments: () => input.hasAttachments ?? false,
    hasGeo: input.hasGeo ?? false,
  } as unknown as MessageContext;
}

test("ingests and does not address a plain message in an allowed chat", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 1,
      peerId: PEER_ID,
      senderId: 42,
      text: "привет",
      subTypes: ["message_new"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.deepEqual(result, {
    ingest: true,
    addressed: false,
    reason: "not_addressed",
    updateId: 1,
    chat: { chatId: ALLOWED_CHAT_ID, requested: ALLOWED_CHAT_ID, kind: "chat" },
    message: {
      chatId: ALLOWED_CHAT_ID,
      messageId: 1,
      date: new Date(1_700_000_000 * 1_000).toISOString(),
      senderId: "42",
      text: "привет",
    },
  });
});

test("rejects a chat that is not in the allowlist", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 1,
      peerId: 2_000_099_999,
      senderId: 42,
      text: "hi",
      subTypes: ["message_new"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.ingest, false);
  assert.equal(result.reason, "chat_not_allowed");
});

test("never ingests the bot's own outgoing message_reply event", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 2,
      peerId: PEER_ID,
      senderId: -GROUP_ID,
      text: "ответ бота",
      subTypes: ["message_reply"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.ingest, false);
  assert.equal(result.reason, "bot_message");
});

test("edited messages ingest but are never addressed or routed", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 3,
      peerId: PEER_ID,
      senderId: 42,
      text: "исправленный текст",
      subTypes: ["message_edit"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.ingest, true);
  assert.equal(result.addressed, false);
  assert.equal(result.reason, "edited_message");
});

test("a reply to the bot's own message is addressed as reply_to_bot", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 4,
      peerId: PEER_ID,
      senderId: 42,
      text: "спасибо",
      subTypes: ["message_new"],
      hasReplyMessage: true,
      replyMessage: { id: 1, senderId: -GROUP_ID },
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.addressed, true);
  assert.equal(result.reason, "reply_to_bot");
  assert.equal(result.replyToBot, true);
  assert.equal(result.message?.replyToMessageId, 1);
});

test("a reply to another user's message is not addressed", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 5,
      peerId: PEER_ID,
      senderId: 42,
      text: "согласен",
      subTypes: ["message_new"],
      hasReplyMessage: true,
      replyMessage: { id: 1, senderId: 7 },
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.addressed, false);
  assert.equal(result.replyToBot, false);
});

test("a slash-command message is addressed", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 6,
      peerId: PEER_ID,
      senderId: 42,
      text: "/help",
      subTypes: ["message_new"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.addressed, true);
});

test("a community mention marker addresses the message", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 7,
      peerId: PEER_ID,
      senderId: 42,
      text: `[club${String(GROUP_ID)}|Джони], привет`,
      subTypes: ["message_new"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.addressed, true);
});

test("an attachment-only message gets a text placeholder", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 8,
      peerId: PEER_ID,
      senderId: 42,
      text: "",
      subTypes: ["message_new"],
      hasAttachments: true,
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.message?.text, "[вложение]");
});

test("a malformed message id is rejected", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      text: "x",
      subTypes: ["message_new"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.ingest, false);
  assert.equal(result.reason, "malformed_message");
});

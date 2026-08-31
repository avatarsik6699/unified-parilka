import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageContext } from "vk-io";
import { normalizeVkUpdate } from "../src/bot/vk-update.js";
import { vkSyntheticUpdateId } from "../src/vk/types.js";

const GROUP_ID = 123456;
const ALLOWED_CHAT_ID = "vk:2000000001";
const PEER_ID = 2_000_000_001;

interface FakePhotoAttachment {
  sizes?: ReadonlyArray<{ url: string; width: number; height: number }>;
  largeSizeUrl?: string;
  mediumSizeUrl?: string;
  smallSizeUrl?: string;
  width?: number;
  height?: number;
}

interface FakeVoiceAttachment {
  oggUrl?: string;
  mp3Url?: string;
  duration?: number;
}

interface FakeMessageContextInput {
  id: number;
  peerId: number;
  senderId: number;
  conversationMessageId: number;
  text?: string;
  subTypes: readonly string[];
  createdAt?: number;
  hasReplyMessage?: boolean;
  replyMessage?: { conversationMessageId: number; senderId: number };
  hasAttachments?: boolean;
  hasGeo?: boolean;
  photos?: readonly FakePhotoAttachment[];
  voices?: readonly FakeVoiceAttachment[];
}

function fakeContext(input: FakeMessageContextInput): MessageContext {
  return {
    id: input.id,
    peerId: input.peerId,
    senderId: input.senderId,
    conversationMessageId: input.conversationMessageId,
    text: input.text,
    subTypes: input.subTypes,
    createdAt: input.createdAt ?? 1_700_000_000,
    hasReplyMessage: input.hasReplyMessage ?? false,
    replyMessage: input.replyMessage,
    hasAttachments: () => input.hasAttachments ?? false,
    hasGeo: input.hasGeo ?? false,
    getAttachments: (type: string) =>
      type === "photo"
        ? (input.photos ?? [])
        : type === "audio_message"
          ? (input.voices ?? [])
          : [],
  } as unknown as MessageContext;
}

function expectedUpdateId(
  peerId: number,
  conversationMessageId: number,
): number {
  const updateId = vkSyntheticUpdateId(peerId, conversationMessageId);
  assert.ok(updateId !== undefined);
  return updateId;
}

test("ingests and does not address a plain message in an allowed chat", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 1,
      text: "привет",
      subTypes: ["message_new"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.deepEqual(result, {
    ingest: true,
    addressed: false,
    reason: "not_addressed",
    updateId: expectedUpdateId(PEER_ID, 1),
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
      id: 0,
      peerId: 2_000_099_999,
      senderId: 42,
      conversationMessageId: 1,
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
      id: 0,
      peerId: PEER_ID,
      senderId: -GROUP_ID,
      conversationMessageId: 2,
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
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 3,
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
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 4,
      text: "спасибо",
      subTypes: ["message_new"],
      hasReplyMessage: true,
      replyMessage: { conversationMessageId: 1, senderId: -GROUP_ID },
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
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 5,
      text: "согласен",
      subTypes: ["message_new"],
      hasReplyMessage: true,
      replyMessage: { conversationMessageId: 1, senderId: 7 },
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.addressed, false);
  assert.equal(result.replyToBot, false);
});

test("a slash-command message is addressed", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 6,
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
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 7,
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
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 8,
      text: "",
      subTypes: ["message_new"],
      hasAttachments: true,
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.message?.text, "[вложение]");
});

test("a photo-only message gets the [фото] placeholder and a parseable vkPhoto rawJson", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 9,
      text: "",
      subTypes: ["message_new"],
      hasAttachments: true,
      photos: [
        {
          sizes: [
            {
              url: "https://sun9-1.userapi.com/small.jpg",
              width: 100,
              height: 75,
            },
            {
              url: "https://sun9-1.userapi.com/large.jpg",
              width: 800,
              height: 600,
            },
          ],
        },
      ],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.message?.text, "[фото]");
  assert.ok(result.message?.rawJson);
  assert.deepEqual(JSON.parse(result.message?.rawJson ?? "{}"), {
    vkPhoto: {
      url: "https://sun9-1.userapi.com/large.jpg",
      width: 800,
      height: 600,
    },
  });
});

test("a photo with a caption keeps the caption text but still records vkPhoto rawJson", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 10,
      text: "смотри",
      subTypes: ["message_new"],
      hasAttachments: true,
      photos: [{ largeSizeUrl: "https://sun9-2.userapi.com/only.jpg" }],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.message?.text, "смотри");
  assert.deepEqual(JSON.parse(result.message?.rawJson ?? "{}"), {
    vkPhoto: { url: "https://sun9-2.userapi.com/only.jpg" },
  });
});

test("a voice-only message gets the [голосовое] placeholder and a parseable vkVoice rawJson", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 11,
      text: "",
      subTypes: ["message_new"],
      hasAttachments: true,
      voices: [
        {
          oggUrl: "https://psv4.userapi.com/voice.ogg",
          mp3Url: "https://psv4.userapi.com/voice.mp3",
          duration: 7,
        },
      ],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.message?.text, "[голосовое]");
  assert.deepEqual(JSON.parse(result.message?.rawJson ?? "{}"), {
    vkVoice: {
      url: "https://psv4.userapi.com/voice.ogg",
      mediaType: "audio/ogg",
      durationSeconds: 7,
    },
  });
});

test("a voice message with only an mp3 link falls back to audio/mpeg", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 12,
      text: "",
      subTypes: ["message_new"],
      hasAttachments: true,
      voices: [{ mp3Url: "https://psv4.userapi.com/only.mp3", duration: 3 }],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.deepEqual(JSON.parse(result.message?.rawJson ?? "{}"), {
    vkVoice: {
      url: "https://psv4.userapi.com/only.mp3",
      mediaType: "audio/mpeg",
      durationSeconds: 3,
    },
  });
});

test("a missing conversation_message_id is rejected (message.id alone is unusable -- always 0 for community-received messages)", () => {
  const result = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 0,
      text: "x",
      subTypes: ["message_new"],
    }),
    { allowedChatIds: new Set([ALLOWED_CHAT_ID]), groupId: GROUP_ID },
  );
  assert.equal(result.ingest, false);
  assert.equal(result.reason, "malformed_message");
});

test("distinct beседы never collide on the same synthesized update_id, even with matching conversation_message_id", () => {
  const first = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: PEER_ID,
      senderId: 42,
      conversationMessageId: 1,
      text: "a",
      subTypes: ["message_new"],
    }),
    {
      allowedChatIds: new Set([ALLOWED_CHAT_ID, "vk:2000000002"]),
      groupId: GROUP_ID,
    },
  );
  const second = normalizeVkUpdate(
    fakeContext({
      id: 0,
      peerId: 2_000_000_002,
      senderId: 42,
      conversationMessageId: 1,
      text: "b",
      subTypes: ["message_new"],
    }),
    {
      allowedChatIds: new Set([ALLOWED_CHAT_ID, "vk:2000000002"]),
      groupId: GROUP_ID,
    },
  );
  assert.notEqual(first.updateId, second.updateId);
});

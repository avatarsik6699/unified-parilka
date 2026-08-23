import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTelegramUpdate } from "../src/bot/telegram-update.js";

const CHAT_ID = -100_123_456_789;
const APPROVAL_CHAT_ID = -100_987_654_321;
const BOT_ID = 7_700_011;
const OPTIONS = {
  allowedChatIds: [String(CHAT_ID)],
  humanPersonaApprovalChatId: String(APPROVAL_CHAT_ID),
  botId: String(BOT_ID),
  botUsername: "@ParilkaBot",
} as const;

function approvalUpdate(overrides: Record<string, unknown> = {}): {
  update_id: number;
  message: Record<string, unknown>;
} {
  return {
    update_id: 91,
    message: {
      message_id: 17,
      date: 1_700_000_000,
      chat: { id: APPROVAL_CHAT_ID, type: "private", title: "Approvals" },
      from: {
        id: 123_456,
        is_bot: false,
        username: "owner",
        first_name: "Owner",
      },
      text: "го покерасим, но помягче",
      ...overrides,
    },
  };
}

test("a reply in the approval chat bypasses the single-chat allowlist", () => {
  const result = normalizeTelegramUpdate(approvalUpdate(), OPTIONS);
  assert.equal(result.ingest, true);
  assert.equal(result.addressed, false);
  assert.equal(result.reason, "human_persona_approval_reply");
  assert.equal(result.chat?.chatId, String(APPROVAL_CHAT_ID));
  assert.equal(result.message?.text, "го покерасим, но помягче");
});

test("without humanPersonaApprovalChatId configured, the same chat is rejected as usual", () => {
  const result = normalizeTelegramUpdate(approvalUpdate(), {
    allowedChatIds: [String(CHAT_ID)],
    botId: String(BOT_ID),
    botUsername: "@ParilkaBot",
  });
  assert.equal(result.ingest, false);
  assert.equal(result.reason, "chat_not_allowed");
});

test("a mention-shaped message in the approval chat is still never mention-routed", () => {
  const result = normalizeTelegramUpdate(
    approvalUpdate({
      text: "@ParilkaBot сделай сводку",
      entities: [{ type: "mention", offset: 0, length: "@ParilkaBot".length }],
    }),
    OPTIONS,
  );
  assert.equal(result.addressed, false);
  assert.equal(result.reason, "human_persona_approval_reply");
});

test("the approval chat still filters out the bot's own posts and other bots", () => {
  const ownPost = normalizeTelegramUpdate(
    approvalUpdate({
      from: { id: BOT_ID, is_bot: true, username: "ParilkaBot" },
    }),
    OPTIONS,
  );
  assert.equal(ownPost.reason, "own_message");

  const otherBot = normalizeTelegramUpdate(
    approvalUpdate({
      from: { id: 42, is_bot: true, username: "SomeOtherBot" },
    }),
    OPTIONS,
  );
  assert.equal(otherBot.reason, "bot_message");
});

test("the normal allowed chat is unaffected when the approval chat is configured", () => {
  const result = normalizeTelegramUpdate(
    {
      update_id: 91,
      message: {
        message_id: 17,
        date: 1_700_000_000,
        chat: { id: CHAT_ID, type: "supergroup", title: "Парилка" },
        from: { id: 123_456, is_bot: false, username: "billy" },
        text: "обычное сообщение",
      },
    },
    OPTIONS,
  );
  assert.equal(result.ingest, true);
  assert.equal(result.reason, "not_addressed");
});

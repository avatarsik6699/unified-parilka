import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTelegramUpdate } from "../src/bot/telegram-update.js";
import { BOT_ID, OPTIONS, botUpdate } from "./support/telegram-update.js";

test("reply to bot message sets replyToBot true", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: "спасибо за ответ",
      reply_to_message: {
        message_id: 10,
        from: {
          id: BOT_ID,
          is_bot: true,
          username: "ParilkaBot",
        },
      },
    }),
    OPTIONS,
  );

  assert.equal(result.replyToBot, true);
  assert.equal(result.reason, "not_addressed");
  assert.equal(result.ingest, true);
});

test("reply to another user does not set replyToBot", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: "согласен с тобой",
      reply_to_message: {
        message_id: 10,
        from: {
          id: 999_999,
          is_bot: false,
          username: "charlie",
        },
      },
    }),
    OPTIONS,
  );

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("message without reply_to_message has no replyToBot", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({ text: "обычное сообщение" }),
    OPTIONS,
  );

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("reply_to_message without from field is safe", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: "ответ",
      reply_to_message: {
        message_id: 10,
        // from deliberately absent — channel-forward edge case
      },
    }),
    OPTIONS,
  );

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("reply_to_message with sender_chat is ignored for replyToBot", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      text: "ответ на пост канала",
      reply_to_message: {
        message_id: 10,
        sender_chat: {
          id: BOT_ID,
          title: "BotChannel",
        },
      },
    }),
    OPTIONS,
  );

  // sender_chat does not count as a user reply-to-bot signal
  assert.equal(result.replyToBot, undefined);
  assert.equal(result.ingest, true);
});

test("replyToBot is absent for own message even when replying to self", () => {
  const result = normalizeTelegramUpdate(
    botUpdate({
      from: {
        id: BOT_ID,
        is_bot: true,
        username: "ParilkaBot",
      },
      text: "бот ответил",
      reply_to_message: {
        message_id: 5,
        from: {
          id: BOT_ID,
          is_bot: true,
          username: "ParilkaBot",
        },
      },
    }),
    OPTIONS,
  );

  assert.equal(result.replyToBot, undefined);
  assert.equal(result.reason, "own_message");
});

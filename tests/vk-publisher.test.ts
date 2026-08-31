import assert from "node:assert/strict";
import { test } from "node:test";
import type { VK } from "vk-io";
import { VkBotTurnPublisher } from "../src/bot/runtime/vk-adapters.js";
import type { TelegramPublishRequest } from "../src/bot/worker.js";

const CHAT_ID = "vk:2000000002";

function fakeVk(options: {
  send: (params: Record<string, unknown>) => unknown;
  messagePhoto?: (params: Record<string, unknown>) => unknown;
}): VK {
  return {
    api: { messages: { send: options.send } },
    upload: {
      messagePhoto:
        options.messagePhoto ??
        (() => Promise.resolve({ toString: () => "photo-1_1" })),
    },
  } as unknown as VK;
}

function richRequest(markdown: string): TelegramPublishRequest {
  return {
    chatId: CHAT_ID,
    replyToMessageId: 42,
    publication: {
      mode: "rich",
      markdown,
      plainText: markdown,
      maxChunkUtf16: 4_096,
    },
    signal: new AbortController().signal,
  };
}

test("publish sends Markdown-stripped plain text to VK, not the raw markdown", async () => {
  let sentMessage: string | undefined;
  const vk = fakeVk({
    send: (params) => {
      sentMessage = String(params.message);
      return Promise.resolve(1);
    },
  });
  const publisher = new VkBotTurnPublisher(vk);

  const result = await publisher.publish(
    richRequest("# Заголовок\n**жирный** и `код`"),
  );

  assert.equal(result.ok, true);
  assert.equal(sentMessage, "Заголовок\nжирный и код");
});

test("publish uploads photo bytes as a real VK photo attachment, with a markdown-stripped caption", async () => {
  let uploadParams: Record<string, unknown> | undefined;
  let sendParams: Record<string, unknown> | undefined;
  const vk = fakeVk({
    messagePhoto: (params) => {
      uploadParams = params;
      return Promise.resolve({ toString: () => "photo-1_42" });
    },
    send: (params) => {
      sendParams = params;
      return Promise.resolve(7);
    },
  });
  const publisher = new VkBotTurnPublisher(vk);
  const photoBytes = Buffer.from([1, 2, 3]);

  const result = await publisher.publish({
    chatId: CHAT_ID,
    replyToMessageId: 5,
    publication: {
      mode: "photo",
      photoBytes,
      caption: "**вот** результат",
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.telegramMessageId, 7);
  }
  const source = uploadParams?.source as { value?: unknown } | undefined;
  assert.equal(source?.value, photoBytes);
  assert.equal(uploadParams?.peer_id, 2_000_000_002);
  assert.equal(sendParams?.attachment, "photo-1_42");
  assert.equal(sendParams?.message, "вот результат");
});

test("publish allows an empty caption alongside a photo attachment", async () => {
  let sendParams: Record<string, unknown> | undefined;
  const vk = fakeVk({
    send: (params) => {
      sendParams = params;
      return Promise.resolve(1);
    },
  });
  const publisher = new VkBotTurnPublisher(vk);

  const result = await publisher.publish({
    chatId: CHAT_ID,
    replyToMessageId: 1,
    publication: { mode: "photo", photoBytes: Buffer.from([9]), caption: "" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.equal(sendParams?.message, "");
});

test("publish fails closed on an empty photo buffer without ever calling upload", async () => {
  let uploadCalls = 0;
  const vk = fakeVk({
    messagePhoto: () => {
      uploadCalls += 1;
      return Promise.resolve({ toString: () => "photo-1_1" });
    },
    send: () => Promise.resolve(1),
  });
  const publisher = new VkBotTurnPublisher(vk);

  const result = await publisher.publish({
    chatId: CHAT_ID,
    replyToMessageId: 1,
    publication: { mode: "photo", photoBytes: Buffer.from([]), caption: "x" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PUBLISH_REQUEST");
  }
  assert.equal(uploadCalls, 0);
});

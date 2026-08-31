import assert from "node:assert/strict";
import { test } from "node:test";
import type { VK } from "vk-io";
import { VkBotTurnPublisher } from "../src/bot/runtime/vk-adapters.js";
import type { TelegramPublishRequest } from "../src/bot/worker.js";

const CHAT_ID = "vk:2000000002";

function fakeVk(send: (params: Record<string, unknown>) => unknown): VK {
  return {
    api: { messages: { send } },
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
  const vk = fakeVk((params) => {
    sentMessage = String(params.message);
    return Promise.resolve(1);
  });
  const publisher = new VkBotTurnPublisher(vk);

  const result = await publisher.publish(
    richRequest("# Заголовок\n**жирный** и `код`"),
  );

  assert.equal(result.ok, true);
  assert.equal(sentMessage, "Заголовок\nжирный и код");
});

test("publish strips markdown from a photo-mode caption too", async () => {
  let sentMessage: string | undefined;
  const vk = fakeVk((params) => {
    sentMessage = String(params.message);
    return Promise.resolve(1);
  });
  const publisher = new VkBotTurnPublisher(vk);

  const result = await publisher.publish({
    chatId: CHAT_ID,
    replyToMessageId: 1,
    publication: {
      mode: "photo",
      photoBytes: Buffer.from([]),
      caption: "**вот** результат",
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.equal(sentMessage, "вот результат");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
  type VkLiveSearchProvider,
} from "../src/bot/read-tools.js";
import { asFailure, CHAT, emptyCache } from "./support/bot-read-tools.js";

test("vk_search_history returns full-history hits as ordinary chat_message evidence", async () => {
  let observedQuery: string | undefined;
  let observedLimit: number | undefined;
  let observedSignal: AbortSignal | undefined;
  const provider: VkLiveSearchProvider = {
    async search({ query, limit, signal }) {
      observedQuery = query;
      observedLimit = limit;
      observedSignal = signal;
      return {
        hits: [
          {
            messageId: 225913,
            fromId: "347952850",
            text: "Можешь помочь Мансуру подкатить к официантке?",
            date: "2026-08-31T12:16:37.000Z",
          },
        ],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    vkLiveSearch: provider,
  });

  const result = await tools.callTool("vk_search_history", {
    query: "  официантка  ",
  });

  assert.equal(observedQuery, "официантка");
  assert.equal(observedLimit, 10);
  assert.ok(observedSignal);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.result, {
    query: "официантка",
    limit: 10,
    returnedCount: 1,
  });
  assert.deepEqual(result.evidence, [
    {
      source: "chat_message",
      sourceId: "chat:225913",
      chat: { id: CHAT.chatId },
      message: { id: 225913 },
      speaker: { id: "347952850", name: null },
      authorRole: "user",
      isOwnTurn: false,
      date: "2026-08-31T12:16:37.000Z",
      text: "Можешь помочь Мансуру подкатить к официантке?",
    },
  ]);
});

test("vk_search_history respects an explicit limit argument", async () => {
  let observedLimit: number | undefined;
  const provider: VkLiveSearchProvider = {
    async search({ limit }) {
      observedLimit = limit;
      return { hits: [] };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    vkLiveSearch: provider,
  });

  const result = await tools.callTool("vk_search_history", {
    query: "тест",
    limit: 3,
  });

  assert.equal(observedLimit, 3);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, "empty");
  }
});

test("vk_search_history fails closed as provider_unavailable when unconfigured (Telegram chats, VK chats with no personal token)", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
  });

  const result = asFailure(
    await tools.callTool("vk_search_history", {
      query: "test",
    }),
  );

  assert.equal(result.error.code, "provider_unavailable");
  assert.equal(result.error.retryable, false);
});

test("vk_search_history marks the bot's own hits as authorRole assistant", async () => {
  const BOT_SENDER_ID = "8952218972";
  const provider: VkLiveSearchProvider = {
    async search() {
      return {
        hits: [
          {
            messageId: 11355,
            fromId: BOT_SENDER_ID,
            text: "BotDSL — это сокращение от Bot + DSL.",
            date: "2026-08-31T12:22:04.000Z",
          },
        ],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    vkLiveSearch: provider,
    botSenderId: BOT_SENDER_ID,
  });

  const result = await tools.callTool("vk_search_history", {
    query: "BotDSL",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.evidence[0]?.authorRole, "assistant");
  }
});

test("vk_search_history enforces timeout when the provider hangs", async () => {
  let timeoutSignalObserved = false;
  const hangingProvider: VkLiveSearchProvider = {
    async search({ signal }) {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            timeoutSignalObserved = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    vkLiveSearch: hangingProvider,
    vkLiveSearchTimeoutMs: 20,
  });

  const result = asFailure(
    await tools.callTool("vk_search_history", { query: "test" }),
  );

  assert.equal(result.error.code, "timeout");
  assert.equal(result.error.retryable, true);
  assert.equal(timeoutSignalObserved, true);
});

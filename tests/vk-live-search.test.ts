import assert from "node:assert/strict";
import { test } from "node:test";
import type { VK } from "vk-io";
import { createVkLiveSearchProvider } from "../src/vk/live-search.js";

function fakeVk(search: (params: Record<string, unknown>) => unknown): VK {
  return {
    api: { messages: { search } },
  } as unknown as VK;
}

const SIGNAL = new AbortController().signal;

test("search sends q/peer_id/count and reads valid items, dropping malformed ones", async () => {
  let captured: Record<string, unknown> | undefined;
  const vk = fakeVk((params) => {
    captured = params;
    return {
      items: [
        {
          conversation_message_id: 225913,
          from_id: 347952850,
          date: 1788179797,
          text: "Можешь помочь Мансуру подкатить к официантке?",
        },
        { conversation_message_id: 0, from_id: 1, text: "bad id" },
        { conversation_message_id: 1, from_id: 1, text: "" },
        {
          conversation_message_id: 2,
          from_id: "not-a-number",
          text: "bad from_id",
        },
        null,
      ],
    };
  });
  const provider = createVkLiveSearchProvider(vk, 2_000_000_317);

  const result = await provider.search({
    query: "официантка",
    limit: 5,
    signal: SIGNAL,
  });

  assert.deepEqual(captured, {
    q: "официантка",
    peer_id: 2_000_000_317,
    count: 5,
  });
  assert.deepEqual(result.hits, [
    {
      messageId: 225913,
      fromId: "347952850",
      text: "Можешь помочь Мансуру подкатить к официантке?",
      date: "2026-08-31T12:36:37.000Z",
    },
  ]);
});

test("search clamps limit to MAX_RESULTS(20) and defaults it when absent", async () => {
  let captured: Record<string, unknown> | undefined;
  const vk = fakeVk((params) => {
    captured = params;
    return { items: [] };
  });
  const provider = createVkLiveSearchProvider(vk, 2_000_000_317);

  await provider.search({ query: "x", limit: 500, signal: SIGNAL });
  assert.equal(captured?.count, 20);

  await provider.search({ query: "x", signal: SIGNAL });
  assert.equal(captured?.count, 20);
});

test("search is bound to the constructed peer_id regardless of any other chat context", async () => {
  let captured: Record<string, unknown> | undefined;
  const vk = fakeVk((params) => {
    captured = params;
    return { items: [] };
  });
  const provider = createVkLiveSearchProvider(vk, 2_000_000_117);

  await provider.search({ query: "x", signal: SIGNAL });

  assert.equal(captured?.peer_id, 2_000_000_117);
});

test("a non-array response.items yields no hits instead of throwing", async () => {
  const vk = fakeVk(() => ({ items: "not-an-array" }));
  const provider = createVkLiveSearchProvider(vk, 2_000_000_317);

  const result = await provider.search({ query: "x", signal: SIGNAL });

  assert.deepEqual(result.hits, []);
});

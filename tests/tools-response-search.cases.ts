import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import {
  addEmbeddingChunk,
  assertCanonicalSearchCounts,
  assertVectorDegraded,
  callTool,
  CHAT,
  configuredEmbeddingsConfig,
  embeddingResponse,
  makeTools,
  mockFetch,
} from "./support/tools-response.js";

test("search_messages reports degraded vector channel when embeddings are disabled", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, text: "needle one" },
    { chatId: CHAT.chatId, messageId: 2, text: "needle two" },
  ]);

  const result = await callTool(makeTools(store), "search_messages", {
    query: "needle",
    limit: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "partial");
  assertVectorDegraded(result, /Embeddings are disabled/);
  assert.equal((result.messages as unknown[]).length, 2);
  assertCanonicalSearchCounts(result);
});

test("search_messages reports no-index vector channel as partial success", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, text: "needle one" }]);
  const cfg = configuredEmbeddingsConfig();

  const result = await callTool(makeTools(store, cfg), "search_messages", {
    query: "needle",
    limit: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "partial");
  assertVectorDegraded(result, /No vector chunks indexed yet/);
  assertCanonicalSearchCounts(result);
});

test("search_messages reports provider vector failures as degraded channels", async (t) => {
  const providerStore = new MessageStore(":memory:");
  providerStore.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, text: "needle provider" }]);
  const providerConfig = configuredEmbeddingsConfig();
  addEmbeddingChunk(providerStore, providerConfig, {
    messageIds: [1],
    text: "needle provider",
    vector: [1, 0],
  });
  mockFetch(t, async () => {
    throw new Error("provider boom");
  });

  const providerFailure = await callTool(makeTools(providerStore, providerConfig), "search_messages", {
    query: "needle",
    limit: 10,
  });

  assert.equal(providerFailure.status, "partial");
  assertVectorDegraded(providerFailure, /provider boom/);
  assertCanonicalSearchCounts(providerFailure);
});

test("search_messages reports candidate-limit vector failures as degraded channels", async (t) => {
  const candidateStore = new MessageStore(":memory:");
  candidateStore.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, text: "needle one" },
    { chatId: CHAT.chatId, messageId: 2, text: "needle two" },
  ]);
  const candidateConfig = configuredEmbeddingsConfig({ vectorCandidateLimit: 1 });
  addEmbeddingChunk(candidateStore, candidateConfig, { messageIds: [1], text: "needle one", vector: [1, 0] });
  addEmbeddingChunk(candidateStore, candidateConfig, { messageIds: [2], text: "needle two", vector: [0.9, 0.1] });
  mockFetch(t, async () => embeddingResponse([1, 0]));

  const candidateFailure = await callTool(makeTools(candidateStore, candidateConfig), "search_messages", {
    query: "needle",
    limit: 10,
  });

  assert.equal(candidateFailure.status, "partial");
  assertVectorDegraded(candidateFailure, /candidate limit 1 exceeded/);
  assertCanonicalSearchCounts(candidateFailure);
});

test("search_messages exposes canonical mixed keyword vector and hybrid results", async (t) => {
  mockFetch(t, async () => embeddingResponse([1, 0]));
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "needle keyword only" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "needle overlap" },
    { chatId: CHAT.chatId, messageId: 3, senderName: "carol", text: "semantic only" },
  ]);
  const cfg = configuredEmbeddingsConfig();
  addEmbeddingChunk(store, cfg, { messageIds: [2], text: "needle overlap", vector: [1, 0] });
  addEmbeddingChunk(store, cfg, { messageIds: [3], text: "semantic only", vector: [0.9, 0.1] });

  const result = await callTool(makeTools(store, cfg), "search_messages", {
    query: "needle",
    limit: 10,
  });
  const results = result.results as Array<{ source: string; messageId?: number; startMessageId?: number }>;

  assert.equal(result.status, "done");
  assert.deepEqual(result.degraded_channels, []);
  assert.equal(result.partial_failure, null);
  assertCanonicalSearchCounts(result);
  assert.equal(results.some((hit) => hit.source === "keyword" && hit.messageId === 1), true);
  assert.equal(results.some((hit) => hit.source === "hybrid" && hit.messageId === 2), true);
  assert.equal(results.some((hit) => hit.source === "vector" && hit.startMessageId === 3), true);
});

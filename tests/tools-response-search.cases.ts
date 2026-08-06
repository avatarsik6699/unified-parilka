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
  const marker = "VECTOR_PROVIDER_MARKER_DO_NOT_LEAK";
  mockFetch(t, async () => {
    throw new Error(
      `${marker} https://user:pass@provider.test/v1?api_key=unit-marker Bearer unit-marker`,
    );
  });

  const providerFailure = await callTool(makeTools(providerStore, providerConfig), "search_messages", {
    query: "needle",
    limit: 10,
  });

  assert.equal(providerFailure.status, "partial");
  assertVectorDegraded(providerFailure, /temporarily unavailable/);
  const vector = providerFailure.vector as { error?: string };
  const degraded = providerFailure.degraded_channels as Array<{ reason: string }>;
  assert.equal(vector.error, degraded[0]?.reason);
  assert.deepEqual(Object.keys(vector).sort(), ["available", "error", "hits", "stats"]);
  assert.doesNotMatch(JSON.stringify(providerFailure), new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(providerFailure), /provider\.test|Bearer unit-marker/u);
  assertCanonicalSearchCounts(providerFailure);
});

test("semantic_search_messages projects only allowlisted vector fields", async () => {
  const privateMarker = "UPSTREAM_VECTOR_PRIVATE_FIELD_DO_NOT_LEAK";
  const usefulTextMarker = "LEGITIMATE_VECTOR_TEXT_MUST_REMAIN";
  const usefulChunkText = `legitimate chunk ${usefulTextMarker}`;
  const usefulMessageText = `legitimate message ${usefulTextMarker}`;
  const cfg = configuredEmbeddingsConfig();
  const tools = makeTools(new MessageStore(":memory:"), cfg);
  const runtime = (
    tools as unknown as {
      context: { vectorRag: { search: () => Promise<unknown> } };
    }
  ).context;
  runtime.vectorRag.search = async () => ({
    available: true,
    error: privateMarker,
    stats: [{
      namespace: "emb_test",
      model: cfg.embeddings.model,
      dimensions: 2,
      chunks: 1,
      runtime_extra: privateMarker,
    }],
    candidateLimit: cfg.embeddings.vectorCandidateLimit,
    candidateCount: 1,
    hits: [{
      rank: 1,
      score: 0.9,
      chunk: {
        id: 1,
        startMessageId: 1,
        endMessageId: 1,
        messageCount: 1,
        messageIds: [1],
        text: usefulChunkText,
        namespace: "emb_test",
        model: cfg.embeddings.model,
        dimensions: 2,
        runtime_extra: privateMarker,
      },
      messages: [{
        id: 99,
        chatId: CHAT.chatId,
        messageId: 1,
        date: "2026-08-02T00:00:00.000Z",
        senderId: "sender-1",
        senderName: "alice",
        text: usefulMessageText,
        replyToMessageId: 7,
        topicId: 8,
        deletedAt: "2026-08-03T00:00:00.000Z",
        textAvailable: false,
        rawJson: privateMarker,
        runtime_extra: privateMarker,
      }],
      runtime_extra: privateMarker,
    }],
    runtime_extra: privateMarker,
  });

  const available = await callTool(tools, "semantic_search_messages", {
    query: "needle",
  });
  const availableVector = available.vector as {
    candidateLimit?: number;
    candidateCount?: number;
    error?: string;
    hits: Array<Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(availableVector).sort(), [
    "available",
    "candidateCount",
    "candidateLimit",
    "hits",
    "stats",
  ]);
  assert.equal(availableVector.candidateLimit, cfg.embeddings.vectorCandidateLimit);
  assert.equal(availableVector.candidateCount, 1);
  assert.equal(availableVector.error, undefined);
  const availableHit = availableVector.hits[0]!;
  const availableChunk = availableHit.chunk as Record<string, unknown>;
  const availableMessage = (
    availableHit.messages as Array<Record<string, unknown>>
  )[0]!;
  assertExactKeys(availableHit, ["chunk", "messages", "rank", "score"]);
  assertExactKeys(availableChunk, [
    "dimensions",
    "endMessageId",
    "id",
    "messageCount",
    "messageIds",
    "model",
    "namespace",
    "startMessageId",
    "text",
  ]);
  assertExactKeys(availableMessage, [
    "chatId",
    "date",
    "deletedAt",
    "messageId",
    "replyToMessageId",
    "senderId",
    "senderName",
    "text",
    "topicId",
  ]);
  assert.equal(availableChunk.text, usefulChunkText);
  assert.equal(availableMessage.text, usefulMessageText);
  assertNoPrivateMarker(JSON.stringify(available), privateMarker);
  assert.match(JSON.stringify(available), new RegExp(usefulTextMarker));

  runtime.vectorRag.search = async () => ({
    available: false,
    error: privateMarker,
    stats: [],
    candidateLimit: cfg.embeddings.vectorCandidateLimit,
    candidateCount: 1,
    hits: [],
    runtime_extra: privateMarker,
  });
  const unavailable = await callTool(tools, "semantic_search_messages", {
    query: "needle",
  });
  const unavailableVector = unavailable.vector as { error?: string };
  assert.deepEqual(Object.keys(unavailableVector).sort(), [
    "available",
    "error",
    "hits",
    "stats",
  ]);
  assert.match(unavailableVector.error ?? "", /No vector chunks indexed yet/);
  assertNoPrivateMarker(JSON.stringify(unavailable), privateMarker);
});

test("semantic_search_messages local backend needs no API key and keeps the public allowlist", async () => {
  const cfg = configuredEmbeddingsConfig({
    backend: "local_bge_m3",
    apiKey: "",
    model: "bge-m3",
    dimensions: 1024,
    localEndpoint: "http://127.0.0.1:8767",
  });
  const tools = makeTools(new MessageStore(":memory:"), cfg);
  const result = await callTool(tools, "semantic_search_messages", {
    query: "needle",
  });
  const vector = result.vector as { available?: boolean; error?: string };
  assert.deepEqual(Object.keys(vector).sort(), [
    "available",
    "error",
    "hits",
    "stats",
  ]);
  assert.equal(vector.available, false);
  assert.match(vector.error ?? "", /No vector chunks indexed yet/);
  assert.doesNotMatch(vector.error ?? "", /API key/i);
  // Internal retrieval fields must never leak into the operator contract.
  assert.equal("sparseHits" in vector, false);
  assert.equal("sparseAvailable" in vector, false);
  assert.equal("sparseCandidateCount" in vector, false);
  assert.equal("backend" in vector, false);
});

test("read surfaces project cached messages without raw JSON", async () => {
  const privateMarker = "STORED_RAW_JSON_DO_NOT_LEAK";
  const usefulTextMarker = "LEGITIMATE_STORED_TEXT_MUST_REMAIN";
  const text = `needle ${usefulTextMarker}`;
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [{
    chatId: CHAT.chatId,
    messageId: 7,
    date: "2026-08-02T00:00:00.000Z",
    senderId: "sender-7",
    senderName: "alice",
    text,
    replyToMessageId: 6,
    topicId: 5,
    rawJson: JSON.stringify({ privateMarker }),
  }]);
  const tools = makeTools(store);
  const historyResponse = await tools.callTool("read_history", { limit: 10 });
  const searchResponse = await tools.callTool("search_messages", {
    query: "needle",
    limit: 10,
  });
  const threadResponse = await tools.callTool("get_thread_context", {
    message_id: 7,
    before: 0,
    after: 0,
  });

  for (const response of [historyResponse, searchResponse, threadResponse]) {
    const serialized = response.content[0]!.text;
    assertNoPrivateMarker(serialized, privateMarker);
    assert.match(serialized, new RegExp(usefulTextMarker));
  }

  const expectedMessageKeys = [
    "chatId",
    "date",
    "messageId",
    "replyToMessageId",
    "senderId",
    "senderName",
    "text",
    "topicId",
  ];
  const history = parseMessages(historyResponse);
  const search = parseMessages(searchResponse);
  const thread = parseMessages(threadResponse);
  assertPublicStoredMessage(history.messages[0]!, expectedMessageKeys, text);
  assertPublicStoredMessage(search.messages[0]!, expectedMessageKeys, text);
  assertPublicStoredMessage(thread.messages[0]!, expectedMessageKeys, text);

  const keyword = search.keyword as { hits: Array<Record<string, unknown>> };
  assertExactKeys(keyword.hits[0]!, ["message", "rank"]);
  assertPublicStoredMessage(
    keyword.hits[0]!.message as Record<string, unknown>,
    expectedMessageKeys,
    text,
  );
  const hybrid = search.hybrid as { hits: Array<Record<string, unknown>> };
  const results = search.results as Array<Record<string, unknown>>;
  assertExactKeys(results[0]!, [
    "messageId",
    "rank",
    "score",
    "source",
    "sources",
    "text",
  ]);
  assertExactKeys(hybrid.hits[0]!, [
    "messageId",
    "rank",
    "score",
    "source",
    "sources",
    "text",
  ]);
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

function parseMessages(response: { content: Array<{ text: string }> }): {
  messages: Array<Record<string, unknown>>;
  keyword?: unknown;
  hybrid?: unknown;
  results?: Array<Record<string, unknown>>;
} {
  return JSON.parse(response.content[0]!.text) as {
    messages: Array<Record<string, unknown>>;
    keyword?: unknown;
    hybrid?: unknown;
    results?: Array<Record<string, unknown>>;
  };
}

function assertPublicStoredMessage(
  message: Record<string, unknown>,
  expectedKeys: string[],
  text: string,
): void {
  assertExactKeys(message, expectedKeys);
  assert.equal(message.text, text);
  assert.equal(message.senderName, "alice");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertNoPrivateMarker(text: string, marker: string): void {
  assert.doesNotMatch(text, new RegExp(marker));
}

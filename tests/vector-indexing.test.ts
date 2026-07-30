import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { vectorToBlob } from "../src/embeddings.js";
import { MessageStore } from "../src/store.js";
import { VectorRag } from "../src/vector-rag.js";
import {
  CHAT,
  config,
  embeddingResponse,
  mockEmbeddingFetch,
  mockFetch,
  namespace,
} from "./support/vector-rag.js";

test("coverage indexing picks up older backfill after recent messages were indexed", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config(), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 100, senderName: "alice", text: "recent alpha" },
    { chatId: CHAT.chatId, messageId: 101, senderName: "bob", text: "recent beta" },
  ]);

  const first = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  assert.equal(first.messagesCovered, 2);

  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 90, senderName: "carol", text: "older needle one" },
    { chatId: CHAT.chatId, messageId: 91, senderName: "dave", text: "older needle two" },
  ]);
  const estimate = vectorRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(estimate.estimatedMessages, 2);
  assert.equal(estimate.coverage.cache_messages, 4);
  assert.equal(estimate.coverage.indexed_messages, 2);
  assert.equal(estimate.coverage.uncovered_messages, 2);
  assert.equal(estimate.coverage.uncovered_ranges, 1);

  const second = await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(second.messagesCovered, 2);
  assert.equal(second.coverage.cache_messages, 4);
  assert.equal(second.coverage.indexed_messages, 4);
  assert.equal(second.coverage.uncovered_messages, 0);

  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 102, senderName: "erin", text: "newer gamma" },
    { chatId: CHAT.chatId, messageId: 103, senderName: "frank", text: "newer delta" },
  ]);
  const thirdEstimate = vectorRag.estimateIndexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(thirdEstimate.estimatedMessages, 2);
  assert.equal(thirdEstimate.coverage.uncovered_messages, 2);
  const third = await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(third.messagesCovered, 2);
  assert.equal(third.coverage.cache_messages, 6);
  assert.equal(third.coverage.indexed_messages, 6);
  assert.equal(third.coverage.uncovered_messages, 0);

  const chunks = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: namespace(),
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });
  assert.deepEqual(
    chunks.map((chunk) => [chunk.startMessageId, chunk.endMessageId]),
    [
      [90, 91],
      [100, 101],
      [102, 103],
    ],
  );
  const search = await vectorRag.search({ chatId: CHAT.chatId, query: "older", limit: 1, includeMessages: true });
  assert.equal(search.hits[0]?.chunk.startMessageId, 90);
  assert.deepEqual(
    search.hits[0]?.messages.map((message) => message.messageId),
    [90, 91],
  );
});

test("vector search and indexing stay unavailable while membership maintenance is pending", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-vector-maintenance-"),
  );
  t.after(() =>
    rmSync(directory, { recursive: true, force: true }),
  );
  let fetchCalls = 0;
  mockFetch(t, async () => {
    fetchCalls += 1;
    throw new Error("embedding provider must not be called");
  });
  const dbPath = join(directory, "messages.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "pending membership",
    },
  ]);
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1,
      endMessageId: 1,
      messageIds: [1],
      messageCount: 1,
      text: "pending membership",
      namespace: namespace(),
      model: config().embeddings.model,
      dimensions: 2,
      embedding: vectorToBlob([1, 0]),
      contentHash: "pending",
    },
  ]);
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO maintenance_jobs (
         name, status, reason, details_json, updated_at, completed_at
       )
       VALUES (
         'embedding_chunk_membership_backfill', 'pending',
         'test pending membership', '{}', datetime('now'), NULL
       )
       ON CONFLICT(name) DO UPDATE SET
         status = 'pending',
         reason = excluded.reason,
         details_json = excluded.details_json,
         updated_at = excluded.updated_at,
         completed_at = NULL`,
    ).run();
  } finally {
    db.close();
  }

  const vectorRag = new VectorRag(config(), store);
  const search = await vectorRag.search({
    chatId: CHAT.chatId,
    query: "membership",
  });
  assert.equal(search.available, false);
  assert.match(
    search.error ?? "",
    /chunk membership backfill is pending/u,
  );
  assert.throws(
    () =>
      vectorRag.estimateIndexCachedMessages({
        chatId: CHAT.chatId,
      }),
    /chunk membership backfill is pending/u,
  );
  assert.throws(
    () =>
      store.getMessagesNeedingEmbedding({
        chatId: CHAT.chatId,
        namespace: namespace(),
        model: config().embeddings.model,
        dimensions: 2,
        limit: 10,
      }),
    /chunk membership backfill is pending/u,
  );
  assert.equal(fetchCalls, 0);
  store.close();
});

test("dirty chunks are excluded from search and reindexed after message edits", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config(), store);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" },
    { chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "plain beta" },
  ]);

  await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 2, senderName: "bob", text: "edited needle" }]);

  const dirtyStats = store.getEmbeddingStats(CHAT.chatId)[0]!;
  assert.equal(dirtyStats.dirty_chunks, 1);
  assert.equal(dirtyStats.indexed_messages, 0);
  assert.equal(dirtyStats.uncovered_messages, 2);
  assert.equal(
    store.getEmbeddingChunks({
      chatId: CHAT.chatId,
      namespace: namespace(),
      model: config().embeddings.model,
      dimensions: config().embeddings.dimensions,
    }).length,
    0,
  );

  const result = await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1 });
  assert.equal(result.messagesCovered, 2);
  assert.equal(result.coverage.dirty_chunks, 0);
  assert.equal(result.coverage.indexed_messages, 2);
  assert.equal(result.coverage.uncovered_messages, 0);

  const search = await vectorRag.search({ chatId: CHAT.chatId, query: "needle", limit: 1, includeMessages: true });
  assert.equal(search.hits[0]?.chunk.startMessageId, 1);
  assert.match(search.hits[0]?.chunk.text ?? "", /edited needle/);
});

test("delete during provider await cannot commit or expose stale secret text", async (t) => {
  const store = new MessageStore(":memory:");
  let providerCalls = 0;
  mockFetch(t, async (_url, init) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      assert.equal(store.markMessagesDeleted(CHAT.chatId, [1]), 1);
    }
    return embeddingResponse(init as RequestInit);
  });
  const vectorRag = new VectorRag(
    config({ chunkMessages: 1, apiBatchSize: 2 }),
    store,
  );
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "stale secret must disappear",
    },
    {
      chatId: CHAT.chatId,
      messageId: 2,
      senderName: "bob",
      text: "safe current message",
    },
  ]);

  const indexed = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 2,
    confirmFirstRun: true,
  });

  assert.equal(indexed.chunksCreated, 1);
  assert.equal(indexed.messagesCovered, 1);
  assert.equal(indexed.staleChunks, 1);
  assert.equal(indexed.nextAfterMessageId, undefined);
  const search = await vectorRag.search({
    chatId: CHAT.chatId,
    query: "stale secret",
    includeMessages: true,
  });
  assert.equal(search.available, true);
  assert.equal(search.hits.length, 1);
  assert.equal(search.hits[0]?.messages[0]?.messageId, 2);
  assert.doesNotMatch(
    search.hits.map(({ chunk }) => chunk.text).join("\n"),
    /stale secret/u,
  );
});

test("text, sender, and date edits during provider await reject the stale vector", async (t) => {
  const store = new MessageStore(":memory:");
  let mutated = false;
  mockFetch(t, async (_url, init) => {
    if (!mutated) {
      mutated = true;
      store.upsertMessages(CHAT, [
        {
          chatId: CHAT.chatId,
          messageId: 1,
          date: "2026-07-30T10:00:00.000Z",
          senderId: "2002",
          senderName: "edited-sender",
          text: "edited source text",
        },
      ]);
    }
    return embeddingResponse(init as RequestInit);
  });
  const vectorRag = new VectorRag(
    config({ chunkMessages: 1 }),
    store,
  );
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      date: "2026-07-29T10:00:00.000Z",
      senderId: "1001",
      senderName: "original-sender",
      text: "original source text",
    },
  ]);

  const indexed = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });

  assert.equal(indexed.chunksCreated, 0);
  assert.equal(indexed.messagesCovered, 0);
  assert.equal(indexed.staleChunks, 1);
  assert.equal(indexed.nextAfterMessageId, undefined);
  assert.deepEqual(
    store.getEmbeddingChunks({
      chatId: CHAT.chatId,
      namespace: namespace({ chunkMessages: 1 }),
      model: config().embeddings.model,
      dimensions: config().embeddings.dimensions,
    }),
    [],
  );
});

test("a stale middle provider batch blocks the run cursor before later commits", async (t) => {
  const store = new MessageStore(":memory:");
  let providerCalls = 0;
  mockFetch(t, async (_url, init) => {
    providerCalls += 1;
    if (providerCalls === 2) {
      store.upsertMessages(CHAT, [
        {
          chatId: CHAT.chatId,
          messageId: 2,
          senderName: "edited",
          text: "changed during second provider batch",
        },
      ]);
    }
    return embeddingResponse(init as RequestInit);
  });
  const vectorRag = new VectorRag(
    config({ chunkMessages: 1, apiBatchSize: 1 }),
    store,
  );
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "first current",
    },
    {
      chatId: CHAT.chatId,
      messageId: 2,
      senderName: "bob",
      text: "second becomes stale",
    },
    {
      chatId: CHAT.chatId,
      messageId: 3,
      senderName: "carol",
      text: "third current",
    },
  ]);

  const indexed = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 3,
    confirmFirstRun: true,
  });

  assert.equal(indexed.chunksCreated, 2);
  assert.equal(indexed.staleChunks, 1);
  assert.equal(indexed.nextAfterMessageId, 1);
  assert.deepEqual(
    store
      .getEmbeddingChunks({
        chatId: CHAT.chatId,
        namespace: namespace({
          chunkMessages: 1,
          apiBatchSize: 1,
        }),
        model: config().embeddings.model,
        dimensions: config().embeddings.dimensions,
      })
      .map(({ startMessageId }) => startMessageId),
    [1, 3],
  );
});

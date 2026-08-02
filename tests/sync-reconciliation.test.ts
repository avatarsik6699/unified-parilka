import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HistorySyncer,
  SerializedHistorySyncer,
  type HistorySyncPort,
} from "../src/sync-engine.js";
import { MessageStore } from "../src/store.js";
import type { TelegramService } from "../src/telegram-client.js";
import {
  config,
  seededStore,
} from "./support/sync-config.js";
import {
  CHAT,
  FakeTelegram,
} from "./support/sync-telegram.js";

test("recent reconciliation updates edited messages and marks embedding chunks dirty", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1000,
      text: "old searchable text",
    },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 1000,
    newestMessageId: 1000,
    syncedCount: store.countMessages(CHAT.chatId),
    mode: "recent",
    error: null,
  });
  store.upsertEmbeddingChunks([
    {
      chatId: CHAT.chatId,
      startMessageId: 1000,
      endMessageId: 1000,
      messageIds: [1000],
      messageCount: 1,
      text: "old searchable text",
      namespace: "test-namespace",
      model: "test",
      dimensions: 3,
      embedding: Buffer.from([1, 2, 3]),
      contentHash: "old",
    },
  ]);
  const telegram = new FakeTelegram([1000]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
  });

  assert.equal(result.reconciliation?.refreshed, 1);
  assert.equal(store.search({ chatId: CHAT.chatId, query: "old", limit: 10 }).length, 0);
  assert.equal(store.search({ chatId: CHAT.chatId, query: "message", limit: 10 })[0]?.messageId, 1000);
  assert.equal(store.getEmbeddingStats(CHAT.chatId)[0]?.dirty_chunks, 1);
});

test("recent reconciliation tombstones deleted messages and removes searchable content", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
  });

  const [message] = store.getHistory({ chatId: CHAT.chatId, limit: 1, order: "asc" });
  assert.equal(result.reconciliation?.deleted, 1);
  assert.equal(typeof message?.deletedAt, "string");
  assert.equal(store.search({ chatId: CHAT.chatId, query: "message", limit: 10 }).length, 0);
  assert.equal(store.search({ chatId: CHAT.chatId, query: "Alice", limit: 10 }).length, 0);
});

test("serialized history lane prevents overlapping cursor writers and bounds its queue", async () => {
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const inner: HistorySyncPort = {
    async syncOnce() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return {};
    },
    async syncDirection() {
      throw new Error("not expected");
    },
  };
  const lane = new SerializedHistorySyncer(inner, 2);
  const first = lane.syncOnce();
  const second = lane.syncOnce();
  const rejected = lane.syncOnce();
  const rejectedAssertion = assert.rejects(
    rejected,
    /history sync lane is busy/u,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  assert.equal(maximumActive, 1);
  await rejectedAssertion;

  releases.shift()?.();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  releases.shift()?.();
  await second;
  assert.equal(active, 0);
  assert.equal(maximumActive, 1);
});

test("queued cancellation skips abandoned work and releases bounded lane capacity", async () => {
  let calls = 0;
  const releases: Array<() => void> = [];
  const inner: HistorySyncPort = {
    async syncOnce() {
      calls += 1;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return {};
    },
    async syncDirection() {
      throw new Error("not expected");
    },
  };
  const lane = new SerializedHistorySyncer(inner, 2);
  const first = lane.syncOnce();
  const abandonedRequest = new AbortController();
  const abandoned = lane.syncOnce({
    signal: abandonedRequest.signal,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  abandonedRequest.abort(
    new DOMException("queued MCP request cancelled", "AbortError"),
  );
  await assert.rejects(
    abandoned,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );

  // maxQueued is two. Cancelling the waiter must release its capacity before
  // the active writer exits, while retaining ordering behind that writer.
  const replacement = lane.syncOnce();
  assert.equal(calls, 1);
  releases.shift()?.();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  releases.shift()?.();
  await replacement;
  assert.equal(calls, 2);
});

test("active cancellation settles the writer before the next lane job starts", async () => {
  let calls = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const inner: HistorySyncPort = {
    async syncOnce(params = {}) {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(params.signal?.reason),
            { once: true },
          );
        });
      }
      return {};
    },
    async syncDirection() {
      throw new Error("not expected");
    },
  };
  const lane = new SerializedHistorySyncer(inner, 2);
  const request = new AbortController();
  const active = lane.syncOnce({ signal: request.signal });
  const next = lane.syncOnce();

  await started;
  assert.equal(calls, 1);
  request.abort(
    new DOMException("active MCP request cancelled", "AbortError"),
  );
  await assert.rejects(
    active,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  await next;
  assert.equal(calls, 2);
});

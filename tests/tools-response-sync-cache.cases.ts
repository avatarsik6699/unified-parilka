import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import type { HistorySyncPort } from "../src/sync-engine.js";
import { TelegramTools } from "../src/tools.js";
import type { TelegramService } from "../src/telegram-client.js";
import {
  cacheMeta,
  callTool,
  CHAT,
  config,
  FakeTelegram,
  makeTools,
  parseToolPayload,
} from "./support/tools-response.js";

test("sync_history exposes failed status, chat, and stats", async () => {
  const tools = makeTools();
  const result = await callTool(tools, "sync_history", {
    mode: "recent",
    limit: 10,
    batch_size: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.chat, { chatId: CHAT.chatId });
  assert.equal((result.result as { status: string }).status, "failed");
  assert.equal(typeof result.stats, "object");
});

test("sync_history forwards the MCP request AbortSignal to the history lane", async () => {
  const request = new AbortController();
  let observedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const syncer: HistorySyncPort = {
    async syncOnce() {
      throw new Error("not expected");
    },
    async syncDirection(params) {
      observedSignal = params.signal;
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        params.signal?.addEventListener(
          "abort",
          () => reject(params.signal?.reason),
          { once: true },
        );
      });
      throw new Error("unreachable");
    },
  };
  const tools = new TelegramTools(
    config(),
    new FakeTelegram() as unknown as TelegramService,
    new MessageStore(":memory:"),
    syncer,
  );

  const pending = tools.callTool(
    "sync_history",
    {
      mode: "recent",
      limit: 10,
      batch_size: 5,
    },
    { signal: request.signal },
  );
  await started;
  request.abort(
    new DOMException("MCP request cancelled", "AbortError"),
  );
  const result = await pending;

  assert.equal(observedSignal, request.signal);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(result.isError, true);
  assert.equal(parseToolPayload(result).ok, false);
});

test("get_status reports cache health without Telegram network calls", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 42,
      text: "status message",
    },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 42,
    newestMessageId: 42,
    syncedCount: 1,
    mode: "recent",
    error: "transient sync issue",
    recentCatchup: {
      minMessageId: 42,
      nextOffsetId: 100,
      newestMessageId: 150,
    },
  });
  store.setBackfillExhausted(CHAT, true);
  store.recordDaemonTickStarted();
  store.recordDaemonTickFailure("rate_limit: FLOOD_WAIT_30");

  const result = await callTool(makeTools(store), "get_status", {});

  assert.equal(result.ok, true);
  assert.equal((result.health as { status: string }).status, "degraded");
  assert.equal((result.chat as { chatId: string }).chatId, CHAT.chatId);
  assert.equal((result.chat as { kind: string }).kind, "Fake");
  assert.equal((result.cache as { messageCount: number }).messageCount, 1);
  assert.equal((result.cache as { oldestMessageId: number }).oldestMessageId, 42);
  assert.equal((result.sync as { backfillExhausted: boolean }).backfillExhausted, true);
  assert.equal((result.sync as { lastError?: string }).lastError, "transient sync issue");
  const recentCatchup = (result.sync as { recentCatchup?: { status: string; nextOffsetId: number } }).recentCatchup;
  assert.equal(recentCatchup?.status, "catching_up");
  assert.equal(recentCatchup?.nextOffsetId, 100);
  assert.equal((result.daemon as { lastError?: string }).lastError, "rate_limit: FLOOD_WAIT_30");
  assert.equal(Array.isArray((result.embeddings as { coverage?: unknown }).coverage), true);
});

test("read_history reports applied filters and outside cache range", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 10, text: "cached ten" },
    { chatId: CHAT.chatId, messageId: 11, text: "cached eleven" },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 10,
    newestMessageId: 11,
    syncedCount: 2,
    mode: "recent",
    error: null,
  });

  const result = await callTool(makeTools(store), "read_history", {
    after_id: 99,
    limit: 5,
    order: "asc",
  });

  assert.equal(result.ok, true);
  assert.equal(result.returned_count, 0);
  assert.deepEqual(result.applied_filters, { limit: 5, after_id: 99, order: "asc" });
  const cache = result.cache as {
    range: { message_count: number; newest_message_id: number };
    relation: { completeness: string; requested_after_cached_range: boolean };
    empty_reason: string;
    sync_state: { newestMessageId: number };
  };
  assert.equal(cache.range.message_count, 2);
  assert.equal(cache.range.newest_message_id, 11);
  assert.equal(cache.relation.completeness, "outside_cached_range");
  assert.equal(cache.relation.requested_after_cached_range, true);
  assert.equal(cache.empty_reason, "requested_after_cached_range");
  assert.equal(cache.sync_state.newestMessageId, 11);
});

test("read_history reports empty reasons for cache range branches", async () => {
  const emptyCache = await callTool(makeTools(new MessageStore(":memory:")), "read_history", {
    limit: 5,
  });
  assert.equal(cacheMeta(emptyCache).relation.completeness, "empty_cache");
  assert.equal(cacheMeta(emptyCache).empty_reason, "cache_empty");

  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 10, text: "cached ten" },
    { chatId: CHAT.chatId, messageId: 12, text: "cached twelve" },
  ]);

  const beforeRange = await callTool(makeTools(store), "read_history", {
    before_id: 10,
    limit: 5,
  });
  assert.equal(cacheMeta(beforeRange).relation.completeness, "outside_cached_range");
  assert.equal(cacheMeta(beforeRange).empty_reason, "requested_before_cached_range");

  const afterRange = await callTool(makeTools(store), "read_history", {
    after_id: 99,
    limit: 5,
  });
  assert.equal(cacheMeta(afterRange).relation.completeness, "outside_cached_range");
  assert.equal(cacheMeta(afterRange).empty_reason, "requested_after_cached_range");

  const impossible = await callTool(makeTools(store), "read_history", {
    after_id: 12,
    before_id: 10,
    limit: 5,
  });
  assert.equal(cacheMeta(impossible).relation.completeness, "no_matching_message_ids");
  assert.equal(cacheMeta(impossible).empty_reason, "filters_exclude_all_message_ids");

  const withinGap = await callTool(makeTools(store), "read_history", {
    after_id: 10,
    before_id: 12,
    limit: 5,
  });
  assert.equal(withinGap.returned_count, 0);
  assert.equal(cacheMeta(withinGap).relation.completeness, "within_cached_range");
  assert.equal(cacheMeta(withinGap).empty_reason, "no_cached_rows_in_requested_range");
});

test("get_thread_context reports center_found and partial cache range", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 10, text: "cached ten" },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: 10,
    newestMessageId: 10,
    syncedCount: 1,
    mode: "recent",
    error: null,
  });

  const result = await callTool(makeTools(store), "get_thread_context", {
    message_id: 12,
    before: 2,
    after: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.center_found, false);
  assert.equal(result.returned_count, 1);
  assert.deepEqual(result.requested_range, {
    start_message_id: 10,
    end_message_id: 14,
    before: 2,
    after: 2,
  });
  const cache = result.cache as {
    empty_reason?: string;
    relation: { completeness: string; partial_cached_range: boolean; may_omit_newer_messages: boolean };
    requested_range: { start_message_id: number; end_message_id: number };
  };
  assert.equal(cache.relation.completeness, "partial_cached_range");
  assert.equal(cache.relation.partial_cached_range, true);
  assert.equal(cache.relation.may_omit_newer_messages, true);
  assert.equal(cache.empty_reason, undefined);
  assert.deepEqual(cache.requested_range, { start_message_id: 10, end_message_id: 14 });
});

test("get_thread_context reports outside-range and within-gap empty reasons", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 10, text: "cached ten" },
    { chatId: CHAT.chatId, messageId: 12, text: "cached twelve" },
  ]);

  const outsideBefore = await callTool(makeTools(store), "get_thread_context", {
    message_id: 1,
    before: 0,
    after: 0,
  });
  assert.equal(outsideBefore.returned_count, 0);
  assert.equal(cacheMeta(outsideBefore).relation.completeness, "outside_cached_range");
  assert.equal(cacheMeta(outsideBefore).empty_reason, "requested_before_cached_range");

  const withinGap = await callTool(makeTools(store), "get_thread_context", {
    message_id: 11,
    before: 0,
    after: 0,
  });
  assert.equal(withinGap.returned_count, 0);
  assert.equal(cacheMeta(withinGap).relation.completeness, "within_cached_range");
  assert.equal(cacheMeta(withinGap).empty_reason, "no_cached_rows_in_requested_range");
});

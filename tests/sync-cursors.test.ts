import assert from "node:assert/strict";
import { test } from "node:test";
import { HistorySyncer } from "../src/sync-engine.js";
import type { TelegramService } from "../src/telegram-client.js";
import {
  config,
  range,
  seededStore,
} from "./support/sync-config.js";
import {
  CHAT,
  FakeTelegram,
} from "./support/sync-telegram.js";

test("partial recent failure checkpoints flushed progress without advancing high-water", async () => {
  const store = seededStore(1000);
  const failingTelegram = new FakeTelegram(range(1001, 1500));
  failingTelegram.throwAfterTotal = 120;
  const failingSyncer = new HistorySyncer(config(), failingTelegram as unknown as TelegramService, store);

  const failed = await failingSyncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(failed.error?.message, "simulated iterator failure");
  assert.equal(failed.saved, 100);
  let state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.newestMessageId, 1000);
  assert.equal(state?.recentCatchupMinId, 1000);
  assert.equal(state?.recentCatchupNextOffsetId, 1401);
  assert.equal(state?.recentCatchupNewestId, 1500);
  assert.equal(failed.catchup?.status, "catching_up");
  assert.equal(failed.catchup?.nextOffsetId, 1401);
  assert.equal(store.countMessages(CHAT.chatId), 101);

  const repairingTelegram = new FakeTelegram(range(1001, 1500));
  const repairingSyncer = new HistorySyncer(config(), repairingTelegram as unknown as TelegramService, store);
  const repaired = await repairingSyncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(repaired.error, undefined);
  assert.equal(repaired.fetched, 400);
  state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.newestMessageId, 1500);
  assert.equal(state?.recentCatchupMinId, undefined);
  assert.equal(state?.recentCatchupNextOffsetId, undefined);
  assert.equal(state?.recentCatchupNewestId, undefined);
  assert.deepEqual(
    store.getHistory({ chatId: CHAT.chatId, afterId: 1000, limit: 600, order: "asc" }).map((message) => message.messageId),
    range(1001, 1500),
  );
});

test("repeated partial recent failures keep making durable progress", async () => {
  const store = seededStore(1000);
  const requestOffsets: number[] = [];
  const results = [];

  for (let tick = 0; tick < 5; tick += 1) {
    const telegram = new FakeTelegram(range(1001, 1500));
    telegram.throwAfterTotal = 120;
    const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);
    results.push(
      await syncer.syncDirection({
        mode: "recent",
        limit: 300,
        batchSize: 50,
      }),
    );
    requestOffsets.push(...telegram.requests.map((request) => request.offsetId ?? 0));
  }

  assert.deepEqual(
    results.map((result) => result.status),
    ["failed", "failed", "failed", "failed", "done"],
  );
  assert.deepEqual(requestOffsets, [0, 1401, 1301, 1201, 1101]);
  assert.equal(store.getSyncState(CHAT.chatId)?.newestMessageId, 1500);
  assert.equal(store.countMessages(CHAT.chatId), 501);
});

test("recent sync with no new messages preserves the newest id", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram(range(1, 1000));
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.fetched, 0);
  assert.equal(result.saved, 0);
  assert.equal(store.getSyncState(CHAT.chatId)?.newestMessageId, 1000);
  assert.equal(telegram.requests.length, 1);
});

test("zero-row backfill records exhausted state", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 100,
    batchSize: 50,
  });

  assert.equal(result.status, "done");
  assert.equal(result.fetched, 0);
  assert.equal(typeof store.getSyncState(CHAT.chatId)?.backfillExhaustedAt, "string");
});

test("exhausted backfill is skipped while recent sync still runs", async () => {
  const store = seededStore(1000);
  store.setBackfillExhausted(CHAT, true);
  const telegram = new FakeTelegram([1001]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncOnce({
    recentLimit: 10,
    backfillLimit: 10,
    batchSize: 5,
  });

  assert.equal(result.recent?.status, "done");
  assert.equal(result.recent?.fetched, 1);
  assert.equal(result.backfill?.status, "skipped");
  assert.equal(result.backfill?.skipped, "backfill_exhausted");
  assert.equal(telegram.requests.length, 1);
});

test("resetting backfill exhausted state resumes backfill", async () => {
  const store = seededStore(1000);
  store.setBackfillExhausted(CHAT, true);
  const telegram = new FakeTelegram([998, 999]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
    resetBackfillExhausted: true,
  });

  assert.equal(result.status, "done");
  assert.equal(result.fetched, 2);
  assert.equal(store.getSyncState(CHAT.chatId)?.backfillExhaustedAt, undefined);
  assert.equal(telegram.requests.length, 1);
});

test("manual older offset backfill does not mutate daemon cursor by default", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([398, 399]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
    offsetId: 400,
  });

  const state = store.getSyncState(CHAT.chatId);
  assert.equal(result.status, "done");
  assert.equal(result.fetched, 2);
  assert.equal(state?.oldestMessageId, 1000);
  assert.equal(state?.nextBackfillOffsetId, undefined);
});

test("manual newer overlap backfill does not mutate daemon cursor by default", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([999]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
    offsetId: 1001,
  });

  const state = store.getSyncState(CHAT.chatId);
  assert.equal(result.status, "done");
  assert.equal(result.fetched, 1);
  assert.equal(state?.oldestMessageId, 1000);
  assert.equal(state?.nextBackfillOffsetId, undefined);
});

test("normal daemon backfill advances cursor", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([998, 999]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "backfill",
    limit: 10,
    batchSize: 5,
  });

  const state = store.getSyncState(CHAT.chatId);
  assert.equal(result.status, "done");
  assert.equal(result.fetched, 2);
  assert.equal(state?.oldestMessageId, 998);
  assert.equal(state?.nextBackfillOffsetId, 998);
});

test("explicit cursor commits must match the current daemon cursor", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram([899]);
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  await assert.rejects(
    () =>
      syncer.syncDirection({
        mode: "backfill",
        limit: 10,
        batchSize: 5,
        offsetId: 900,
        commitCursor: true,
      }),
    /commit_cursor:true requires offset_id to match current backfill cursor 1000/,
  );
  assert.equal(telegram.requests.length, 0);
});

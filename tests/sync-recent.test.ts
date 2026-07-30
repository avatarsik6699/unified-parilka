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

test("recent sync catches up all pages above the previous newest id", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram(range(1001, 1500));
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.fetched, 500);
  assert.equal(result.saved, 500);
  assert.equal(result.newestMessageId, 1500);
  assert.equal(store.getSyncState(CHAT.chatId)?.newestMessageId, 1500);
  assert.equal(store.countMessages(CHAT.chatId), 501);
  assert.deepEqual(
    store.getHistory({ chatId: CHAT.chatId, afterId: 1000, limit: 600, order: "asc" }).map((message) => message.messageId),
    range(1001, 1500),
  );
  assert.deepEqual(
    telegram.requests.map((request) => request.offsetId ?? 0),
    [0, 1201],
  );
  assert.deepEqual(
    telegram.requests.map((request) => request.waitTime),
    [undefined, undefined],
  );
});

test("history pacing waits in milliseconds before each 100-message chunk without forwarding GramJS waitTime", async () => {
  for (const scenario of [
    { mode: "recent" as const, ids: range(1001, 1250) },
    { mode: "backfill" as const, ids: range(750, 999) },
  ]) {
    const store = seededStore(1000);
    const telegram = new FakeTelegram(scenario.ids);
    const sleeps: Array<{ delayMs: number; yielded: number }> = [];
    const syncer = new HistorySyncer(
      config({ historyWaitTimeSec: 2 }),
      telegram as unknown as TelegramService,
      store,
      async (delayMs) => {
        sleeps.push({ delayMs, yielded: telegram.yieldedCount });
      },
    );

    const result = await syncer.syncDirection({
      mode: scenario.mode,
      limit: 300,
      batchSize: 50,
    });

    assert.equal(result.status, "done", scenario.mode);
    assert.equal(result.fetched, 250, scenario.mode);
    assert.deepEqual(
      sleeps,
      [
        { delayMs: 2000, yielded: 100 },
        { delayMs: 2000, yielded: 200 },
      ],
      scenario.mode,
    );
    assert.equal(
      telegram.requests.every((request) => request.waitTime === undefined),
      true,
      scenario.mode,
    );
  }
});

test("degenerate recent catch-up range completes without creating a GramJS iterator", async () => {
  const store = seededStore(229_895);
  store.upsertMessages(CHAT, [
    { chatId: CHAT.chatId, messageId: 229_896, text: "already flushed cursor message" },
    { chatId: CHAT.chatId, messageId: 229_897, text: "already flushed newest message" },
  ]);
  store.updateSyncState(CHAT, {
    syncedCount: store.countMessages(CHAT.chatId),
    mode: "manual",
    error: null,
    recentCatchup: {
      minMessageId: 229_895,
      nextOffsetId: 229_896,
      newestMessageId: 229_897,
    },
  });
  const telegram = new FakeTelegram(range(229_895, 229_897));
  const syncer = new HistorySyncer(config(), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(result.status, "done");
  assert.equal(result.fetched, 0);
  assert.equal(result.catchup?.status, "complete");
  assert.equal(telegram.requests.length, 0);
  const state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.newestMessageId, 229_897);
  assert.equal(state?.recentCatchupMinId, undefined);
  assert.equal(state?.recentCatchupNextOffsetId, undefined);
  assert.equal(state?.recentCatchupNewestId, undefined);
});

test("large recent catch-up progresses across ticks before advancing high-water", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram(range(1001, 1600));
  const syncer = new HistorySyncer(config({ maxSyncLimit: 250 }), telegram as unknown as TelegramService, store);

  const first = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(first.status, "catching_up");
  assert.equal(first.fetched, 250);
  assert.equal(first.nextOffsetId, 1351);
  assert.equal(first.catchup?.status, "catching_up");
  assert.equal(first.catchup?.nextOffsetId, 1351);
  assert.equal(first.catchup?.newestMessageId, 1600);
  let state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.newestMessageId, 1000);
  assert.equal(state?.recentCatchupMinId, 1000);
  assert.equal(state?.recentCatchupNextOffsetId, 1351);
  assert.equal(state?.recentCatchupNewestId, 1600);
  assert.equal(store.countMessages(CHAT.chatId), 251);

  const second = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(second.status, "catching_up");
  assert.equal(second.fetched, 250);
  assert.equal(second.nextOffsetId, 1101);
  state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.newestMessageId, 1000);
  assert.equal(state?.recentCatchupNextOffsetId, 1101);
  assert.equal(store.countMessages(CHAT.chatId), 501);

  const third = await syncer.syncDirection({
    mode: "recent",
    limit: 300,
    batchSize: 50,
  });

  assert.equal(third.status, "done");
  assert.equal(third.fetched, 100);
  assert.equal(third.newestMessageId, 1600);
  assert.equal(third.catchup?.status, "complete");
  state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.newestMessageId, 1600);
  assert.equal(state?.recentCatchupMinId, undefined);
  assert.equal(state?.recentCatchupNextOffsetId, undefined);
  assert.equal(state?.recentCatchupNewestId, undefined);
  assert.equal(store.countMessages(CHAT.chatId), 601);
  assert.deepEqual(
    telegram.requests.map((request) => request.offsetId ?? 0),
    [0, 1351, 1101],
  );
  assert.deepEqual(
    store.getHistory({ chatId: CHAT.chatId, afterId: 1000, limit: 700, order: "asc" }).map((message) => message.messageId),
    range(1001, 1600),
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { HistorySyncer } from "../src/sync-engine.js";
import { MessageStore } from "../src/store.js";
import type { TelegramService } from "../src/telegram-client.js";
import {
  config,
  range,
  seededStore,
} from "./support/sync-config.js";
import {
  CHAT,
  FakeTelegram,
  HangingHistoryRequestTelegram,
  HangingReconciliationTelegram,
  HangingTelegram,
} from "./support/sync-telegram.js";

test("history operation watchdog fails a stuck iterator and closes it", async () => {
  const store = new MessageStore(":memory:");
  const telegram = new HangingTelegram();
  const syncer = new HistorySyncer(config({ historyOperationTimeoutMs: 15 }), telegram as unknown as TelegramService, store);

  const result = await syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error?.message ?? "", /Telegram recent history iterator timed out after 15ms/);
  assert.equal(result.error?.retryable, true);
  assert.equal(telegram.closed, true);
  assert.match(store.getSyncState(CHAT.chatId)?.lastError ?? "", /timed out/);
  assert.equal(store.getSyncState(CHAT.chatId)?.lastRecentSyncAt, undefined);
});

test("shutdown aborts a stuck history iterator without stamping sync success", async () => {
  const store = new MessageStore(":memory:");
  const telegram = new HangingTelegram();
  const shutdown = new AbortController();
  const syncer = new HistorySyncer(
    config({ historyOperationTimeoutMs: 120_000 }),
    telegram as unknown as TelegramService,
    store,
    undefined,
    shutdown.signal,
  );

  const pending = syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
  });
  while (telegram.requests.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  shutdown.abort(new DOMException("test shutdown", "AbortError"));

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  assert.equal(telegram.closed, true);
  const state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.lastRecentSyncAt, undefined);
  assert.equal(state?.lastBackfillAt, undefined);
  assert.equal(state?.lastError, undefined);
});

test("caller cancellation aborts a stuck history iterator without degrading daemon health", async () => {
  const store = new MessageStore(":memory:");
  const telegram = new HangingTelegram();
  const request = new AbortController();
  const syncer = new HistorySyncer(
    config({ historyOperationTimeoutMs: 120_000 }),
    telegram as unknown as TelegramService,
    store,
  );

  const pending = syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
    signal: request.signal,
  });
  while (telegram.requests.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  request.abort(
    new DOMException("MCP request cancelled", "AbortError"),
  );

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  assert.equal(telegram.closed, true);
  const state = store.getSyncState(CHAT.chatId);
  assert.equal(state?.lastRecentSyncAt, undefined);
  assert.equal(state?.lastBackfillAt, undefined);
  assert.equal(state?.lastError, undefined);
});

test("caller cancellation interrupts a pending Telegram history request", async () => {
  const store = new MessageStore(":memory:");
  const telegram = new HangingHistoryRequestTelegram();
  const request = new AbortController();
  const syncer = new HistorySyncer(
    config({ historyOperationTimeoutMs: 120_000 }),
    telegram as unknown as TelegramService,
    store,
  );

  const pending = syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
    signal: request.signal,
  });
  while (telegram.requests === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  request.abort(
    new DOMException("cancel pending history request", "AbortError"),
  );

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  assert.equal(
    store.getSyncState(CHAT.chatId)?.lastError,
    undefined,
  );
});

test("caller cancellation interrupts history pacing", async () => {
  const store = seededStore(1000);
  const telegram = new FakeTelegram(range(1001, 1101));
  const request = new AbortController();
  let pacingStarted!: () => void;
  const pacingReached = new Promise<void>((resolve) => {
    pacingStarted = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const syncer = new HistorySyncer(
    config({
      historyWaitTimeSec: 60,
      historyOperationTimeoutMs: 120_000,
    }),
    telegram as unknown as TelegramService,
    store,
    async (_delayMs, signal) => {
      observedSignal = signal;
      pacingStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });
    },
  );

  const pending = syncer.syncDirection({
    mode: "recent",
    limit: 200,
    batchSize: 50,
    signal: request.signal,
  });
  await pacingReached;
  request.abort(
    new DOMException("cancel during pacing", "AbortError"),
  );

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  assert.equal(observedSignal?.aborted, true);
  assert.equal(
    store.getSyncState(CHAT.chatId)?.lastError,
    undefined,
  );
});

test("caller cancellation interrupts recent-message reconciliation", async () => {
  const store = seededStore(1000);
  const telegram = new HangingReconciliationTelegram();
  const request = new AbortController();
  const syncer = new HistorySyncer(
    config({ historyOperationTimeoutMs: 120_000 }),
    telegram as unknown as TelegramService,
    store,
  );
  const stateBefore = store.getSyncState(CHAT.chatId);

  const pending = syncer.syncDirection({
    mode: "recent",
    limit: 10,
    batchSize: 5,
    signal: request.signal,
  });
  await telegram.reconciliationStarted;
  request.abort(
    new DOMException("cancel reconciliation", "AbortError"),
  );

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  const stateAfter = store.getSyncState(CHAT.chatId);
  assert.equal(
    stateAfter?.lastRecentSyncAt,
    stateBefore?.lastRecentSyncAt,
  );
  assert.equal(stateAfter?.lastError, undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { errors as telegramErrors } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import type { AppConfig } from "../src/config.js";
import { normalizeError, ToolError } from "../src/errors.js";
import { MessageStore } from "../src/store.js";
import { appConfigWithSync } from "./support/app-config.js";
import {
  assertExclusiveMtprotoOwner,
  classifyDaemonErrors,
  computeDaemonDelayMs,
  destroyTelegramBestEffort,
  disconnectTelegramBestEffort,
  EmbeddingCadenceRunner,
  findPermanentDaemonError,
  indexEmbeddings,
  recordDaemonOutcome,
  waitForDaemonShutdown,
} from "../src/sync-daemon.js";
import { runSyncDaemonLoop } from "../src/sync/daemon-runner.js";
import { SendThrottler } from "../src/throttler.js";
import { TelegramService, telegramClientOptions } from "../src/telegram-client.js";
import type { VectorRag } from "../src/vector-rag.js";

test("telegram client options include configured flood sleep threshold", () => {
  const options = telegramClientOptions(config({ floodWaitMaxSleepSec: 42 }));

  assert.equal(options.connectionRetries, 3);
  assert.equal(options.floodSleepThreshold, 42);
  assert.equal((options.baseLogger as { logLevel: LogLevel }).logLevel, LogLevel.NONE);
});

test("telegram disconnect destroys the GramJS client exactly once", async () => {
  const telegram = new TelegramService(config());
  let destroyCalls = 0;
  (telegram as unknown as { client: { destroy(): Promise<void> } }).client = {
    destroy: async () => {
      destroyCalls += 1;
    },
  };

  await telegram.disconnect();
  await telegram.disconnect();

  assert.equal(destroyCalls, 1);
});

test("flood wait retry-after delays the next daemon tick", () => {
  const error = normalizeError(new Error("FLOOD_WAIT_30"));
  const delay = computeDaemonDelayMs({
    intervalMs: 5_000,
    elapsedMs: 0,
    errors: [error],
    previousBackoffMs: 0,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryAfterSec, 30);
  assert.equal(delay.reason, "retry_after");
  assert.equal(delay.delayMs, 30_000);
  assert.equal(delay.nextBackoffMs, 0);
});

test("slow mode retry-after is normalized like flood wait", () => {
  const error = normalizeError(new Error("SLOWMODE_WAIT_12"));

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSec, 12);
});

test("real GramJS flood wait errors expose retry-after seconds", () => {
  const error = normalizeError(new telegramErrors.FloodWaitError({ capture: "42" }));

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSec, 42);
});

test("real GramJS slow mode errors expose retry-after seconds", () => {
  const error = normalizeError(new telegramErrors.SlowModeWaitError({ capture: "42" }));

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSec, 42);
});

test("send queue waits for chat flood not-before before dispatching the next job", async () => {
  const store = new MessageStore(":memory:");
  const throttler = new SendThrottler(config(), store);
  const chat = { chatId: "-1001", requested: "-1001", kind: "Fake" as const };
  let calls = 0;

  const first = throttler.run({
    chatId: chat.chatId,
    payloadHash: "first/hash",
    userKey: "mcp-server",
    action: async () => {
      calls += 1;
      throw new telegramErrors.SlowModeWaitError({ capture: "0.15" });
    },
  });

  await assert.rejects(first, /wait of 0.15 seconds/i);
  assert.equal(calls, 1);

  const started = Date.now();
  const second = throttler.run({
    chatId: chat.chatId,
    payloadHash: "second/hash",
    userKey: "mcp-server",
    action: async () => {
      calls += 1;
      return { id: 2, chat };
    },
  });

  await sleep(50);
  assert.equal(calls, 1);

  const sent = await second;
  assert.equal(sent.id, 2);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 120);
});

test("transient network errors use exponential daemon backoff", () => {
  const error = normalizeError(new Error("ECONNRESET socket hang up"));
  const first = computeDaemonDelayMs({
    intervalMs: 1_000,
    elapsedMs: 0,
    errors: [error],
    previousBackoffMs: 0,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });
  const second = computeDaemonDelayMs({
    intervalMs: 1_000,
    elapsedMs: 0,
    errors: [error],
    previousBackoffMs: first.nextBackoffMs,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });

  assert.equal(error.retryable, true);
  assert.equal(first.reason, "backoff");
  assert.equal(first.delayMs, 5_000);
  assert.equal(first.nextBackoffMs, 5_000);
  assert.equal(second.delayMs, 10_000);
  assert.equal(second.nextBackoffMs, 10_000);
});

test("embedding failures degrade daemon health without driving core backoff", async () => {
  const report = await indexEmbeddings(
    {
      isConfigured: true,
      estimateIndexCachedMessages: () => ({
        requiresConfirmation: false,
      }),
      indexCachedMessages: async () => {
        throw new ToolError({
          category: "rate_limit",
          retryable: true,
          retryAfterSec: 17,
          message: "embedding provider is throttling",
        });
      },
    } as unknown as VectorRag,
    "-1001",
  );
  assert.deepEqual(report?.failure, {
    category: "rate_limit",
    retryable: true,
    retryAfterSec: 17,
    message: "embedding provider is throttling",
  });

  const store = new MessageStore(":memory:");
  store.recordDaemonTickStarted();
  recordDaemonOutcome(store, [report!.failure!]);
  assert.equal(store.getDaemonStatus()?.consecutiveFailures, 1);
  const delay = computeDaemonDelayMs({
    intervalMs: 5_000,
    elapsedMs: 0,
    errors: [],
    previousBackoffMs: 0,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });
  assert.equal(delay.reason, "interval");
  assert.equal(delay.delayMs, 5_000);
});

test("embedding auth failures remain health-only and never transition the core owner to cache-only", () => {
  const embeddingFailure = new ToolError({
    category: "auth",
    retryable: false,
    message: "embedding subscription expired",
  }).normalized;
  const policy = classifyDaemonErrors([], embeddingFailure);

  assert.deepEqual(policy.healthErrors, [embeddingFailure]);
  assert.deepEqual(policy.stopErrors, []);
  assert.deepEqual(policy.delayErrors, []);
  assert.equal(
    findPermanentDaemonError(policy.stopErrors),
    undefined,
  );
});

test("daemon retry-after is clamped to its configured maximum", () => {
  const hostile = normalizeError(new Error("FLOOD_WAIT_86400"));
  const delay = computeDaemonDelayMs({
    intervalMs: 5_000,
    elapsedMs: 0,
    errors: [hostile],
    previousBackoffMs: 0,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });

  assert.equal(delay.reason, "retry_after");
  assert.equal(delay.delayMs, 60_000);
});

test("embedding cadence is non-blocking, budgeted, and skips premature offers", async () => {
  let indexCalls = 0;
  const vectorRag = {
    isConfigured: true,
    estimateIndexCachedMessages: () => ({
      requiresConfirmation: false,
    }),
    indexCachedMessages: async () => {
      indexCalls += 1;
      // Deliberately ignore AbortSignal. The cadence budget itself must
      // settle even when a provider adapter misbehaves.
      return await new Promise<never>(() => undefined);
    },
  } as unknown as VectorRag;
  let now = 1_000;
  const cadence = new EmbeddingCadenceRunner(vectorRag, {
    intervalMs: 100,
    budgetMs: 10,
    retryMaxMs: 20,
    now: () => now,
  });

  const started = Date.now();
  const offered = cadence.offer("-1001");
  assert.equal(Date.now() - started < 50, true);
  assert.equal(offered.active, true);
  assert.equal(indexCalls, 1);
  await cadence.settle();
  assert.equal(cadence.healthFailure()?.retryable, true);

  cadence.offer("-1001");
  assert.equal(indexCalls, 1);
  now += 100;
  cadence.offer("-1001");
  assert.equal(indexCalls, 2);
  await cadence.settle();
});

test("non-retryable core auth errors transition the daemon to cache-only", () => {
  const permanent = normalizeError(
    new Error("AUTH_KEY_UNREGISTERED"),
  );
  const transient = normalizeError(
    new Error("FLOOD_WAIT_5"),
  );
  const network = normalizeError(
    new Error("ECONNRESET socket hang up"),
  );

  assert.deepEqual(findPermanentDaemonError([permanent]), permanent);
  assert.deepEqual(
    findPermanentDaemonError([transient, permanent, network]),
    permanent,
  );
  assert.equal(findPermanentDaemonError([transient]), undefined);
  assert.equal(findPermanentDaemonError([network]), undefined);
  assert.equal(findPermanentDaemonError([]), undefined);
});

test("cache-only wait resolves only when the shutdown signal aborts", async () => {
  const shutdown = new AbortController();
  let resolved = false;
  const waiting = waitForDaemonShutdown(shutdown.signal).then(() => {
    resolved = true;
  });

  await sleep(50);
  assert.equal(resolved, false);
  shutdown.abort();
  await waiting;
  assert.equal(resolved, true);
});

test("cache-only wait resolves immediately for an already-aborted signal", async () => {
  const shutdown = new AbortController();
  shutdown.abort();
  await waitForDaemonShutdown(shutdown.signal);
});

test("daemon loop enters cache-only after a permanent auth error and waits for shutdown", async () => {
  const shutdown = new AbortController();
  const store = new MessageStore(":memory:");
  let ticks = 0;
  const exitPromise = runSyncDaemonLoop({
    signal: shutdown.signal,
    store,
    intervalMs: 20,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
    retryAfterMaxMs: 60_000,
    tick: async () => {
      ticks += 1;
      throw new Error("AUTH_KEY_UNREGISTERED");
    },
    embeddings: idleEmbeddings,
  });

  // Longer than the minimum 1s inter-tick delay: a loop that kept ticking
  // instead of entering cache-only would have retried by now.
  await sleep(1_200);
  assert.equal(ticks, 1);
  const status = store.getDaemonStatus();
  assert.equal(status?.consecutiveFailures, 1);
  assert.match(status?.lastError ?? "", /auth/u);

  // The loop stays pending on the shutdown signal, not on a retry timer.
  let exited = false;
  void exitPromise.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  await sleep(50);
  assert.equal(exited, false);

  shutdown.abort();
  const exit = await exitPromise;
  assert.equal(exit.reason, "cache_only");
  assert.deepEqual(
    exit.failure,
    normalizeError(new Error("AUTH_KEY_UNREGISTERED")),
  );
});

test("daemon loop exits with shutdown reason when aborted during a normal backoff wait", async () => {
  const shutdown = new AbortController();
  const store = new MessageStore(":memory:");
  let ticks = 0;
  const exitPromise = runSyncDaemonLoop({
    signal: shutdown.signal,
    store,
    intervalMs: 60_000,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
    retryAfterMaxMs: 60_000,
    tick: async () => {
      ticks += 1;
      return { chat: "-1001" };
    },
    embeddings: idleEmbeddings,
  });

  await sleep(50);
  assert.equal(ticks, 1);
  shutdown.abort();
  assert.deepEqual(await exitPromise, { reason: "shutdown" });
});

test("sync daemon requires an explicit exclusive MTProto ownership assertion", () => {
  assert.doesNotThrow(() =>
    assertExclusiveMtprotoOwner({
      BOT_MTPROTO_EXCLUSIVE_OWNER: "true",
    }),
  );
  for (const value of [undefined, "", "TRUE", "1"]) {
    assert.throws(
      () =>
        assertExclusiveMtprotoOwner({
          BOT_MTPROTO_EXCLUSIVE_OWNER: value,
        }),
      /BOT_MTPROTO_EXCLUSIVE_OWNER/u,
    );
  }
});

test("disconnect failures are recorded and treated as retryable when normalized that way", async () => {
  const store = new MessageStore(":memory:");
  store.recordDaemonTickStarted();

  const error = await disconnectTelegramBestEffort({
    disconnect: async () => {
      throw new Error("ECONNRESET during disconnect");
    },
  });

  assert.equal(error?.category, "internal");
  assert.equal(error?.retryable, true);
  recordDaemonOutcome(store, error ? [error] : []);
  const status = store.getDaemonStatus();
  assert.match(status?.lastError ?? "", /internal: ECONNRESET during disconnect/);
  assert.equal(status?.consecutiveFailures, 1);

  const delay = computeDaemonDelayMs({
    intervalMs: 1_000,
    elapsedMs: 0,
    errors: [error!],
    previousBackoffMs: 0,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
  });
  assert.equal(delay.reason, "backoff");
  assert.equal(delay.delayMs, 5_000);
});

test("final Telegram destroy is bounded and reports a normalized timeout", async () => {
  const started = Date.now();
  const error = await destroyTelegramBestEffort(
    {
      destroy: () => new Promise<void>(() => undefined),
    },
    10,
  );

  assert.equal(error?.category, "internal");
  assert.equal(error?.retryable, true);
  assert.match(error?.message ?? "", /destroy timed out after 10ms/u);
  assert.equal(Date.now() - started < 500, true);
});

test("successful Telegram destroy clears its shutdown timeout", async () => {
  const error = await destroyTelegramBestEffort(
    {
      destroy: async () => undefined,
    },
    100,
  );

  assert.equal(error, undefined);
});

const idleEmbeddings = {
  snapshot: () => ({ active: false, nextRunAtMs: 0, report: null }),
  offer: () => ({ active: false, nextRunAtMs: 0, report: null }),
  healthFailure: () => undefined,
};

function config(sync?: Partial<AppConfig["sync"]>): AppConfig {
  const cfg = appConfigWithSync(sync);
  cfg.telegram.connectionRetries = 3;
  return cfg;
}

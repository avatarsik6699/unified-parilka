import assert from "node:assert/strict";
import { test } from "node:test";
import { runSyncDaemonLoop } from "../src/sync/daemon-runner.js";
import { MessageStore } from "../src/store.js";

const idleEmbeddings = {
  snapshot: () => ({ active: false, nextRunAtMs: 0, report: null }),
  offer: () => ({ active: false, nextRunAtMs: 0, report: null }),
  healthFailure: () => undefined,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a successful sync tick runs the human-persona trigger", async () => {
  const shutdown = new AbortController();
  const store = new MessageStore(":memory:");
  let runs = 0;

  const exitPromise = runSyncDaemonLoop({
    signal: shutdown.signal,
    store,
    intervalMs: 60_000,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
    retryAfterMaxMs: 60_000,
    tick: async () => ({ chat: "c1" }),
    embeddings: idleEmbeddings,
    humanPersonaTrigger: {
      run: async () => {
        runs += 1;
        return { status: "no_message" };
      },
    },
  });

  await sleep(50);
  assert.equal(runs, 1);

  shutdown.abort();
  await exitPromise;
});

test("a failed sync tick does not run the human-persona trigger", async () => {
  const shutdown = new AbortController();
  const store = new MessageStore(":memory:");
  let runs = 0;

  const exitPromise = runSyncDaemonLoop({
    signal: shutdown.signal,
    store,
    intervalMs: 60_000,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
    retryAfterMaxMs: 60_000,
    tick: async () => {
      throw new Error("boom");
    },
    embeddings: idleEmbeddings,
    humanPersonaTrigger: {
      run: async () => {
        runs += 1;
        return { status: "no_message" };
      },
    },
  });

  await sleep(50);
  assert.equal(runs, 0);

  shutdown.abort();
  await exitPromise;
});

test("a throwing trigger run never crashes the sync daemon loop", async () => {
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
      return { chat: "c1" };
    },
    embeddings: idleEmbeddings,
    humanPersonaTrigger: {
      run: async () => {
        throw new Error("trigger exploded");
      },
    },
  });

  await sleep(200);
  assert.ok(ticks >= 1);

  shutdown.abort();
  const exit = await exitPromise;
  assert.equal(exit.reason, "shutdown");
});

test("the send-tick runs even after a failed sync tick, unlike the trigger", async () => {
  const shutdown = new AbortController();
  const store = new MessageStore(":memory:");
  let sendRuns = 0;

  const exitPromise = runSyncDaemonLoop({
    signal: shutdown.signal,
    store,
    intervalMs: 60_000,
    backoffInitialMs: 5_000,
    backoffMaxMs: 60_000,
    retryAfterMaxMs: 60_000,
    tick: async () => {
      throw new Error("sync boom");
    },
    embeddings: idleEmbeddings,
    humanPersonaSend: {
      run: async () => {
        sendRuns += 1;
        return { status: "idle" };
      },
    },
  });

  await sleep(50);
  assert.equal(sendRuns, 1);

  shutdown.abort();
  await exitPromise;
});

test("a throwing send-tick never crashes the sync daemon loop", async () => {
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
      return { chat: "c1" };
    },
    embeddings: idleEmbeddings,
    humanPersonaSend: {
      run: async () => {
        throw new Error("send exploded");
      },
    },
  });

  await sleep(200);
  assert.ok(ticks >= 1);

  shutdown.abort();
  const exit = await exitPromise;
  assert.equal(exit.reason, "shutdown");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ToolError } from "../src/errors.js";
import { MessageStore } from "../src/store.js";
import {
  FakeTelegram,
  callTool,
  makeTools,
  seedSend,
  tempDbPath,
  waitForSendOutbox,
} from "./send-safety-fixtures.js";

test("sent dedupe keys survive a fresh tools instance", async (t) => {
  const dbPath = tempDbPath(t);
  const firstTelegram = new FakeTelegram();
  const { tools: firstTools } = makeTools(firstTelegram, {
    dbPath,
    throttle: { userCooldownMs: 0 },
  });
  const firstPreview = await callTool(firstTools, "preview_message", {
    chat: "-1001",
    text: "dedupe me",
  });
  const firstSend = await callTool(firstTools, "send_message", {
    chat: "-1001",
    text: "dedupe me",
    dry_run: false,
    approval_id: firstPreview.approval_id,
    dedupe_key: "dedupe/restart",
  });

  assert.equal(firstSend.ok, true);
  assert.equal(firstTelegram.sends.length, 1);

  const secondTelegram = new FakeTelegram();
  const { tools: secondTools } = makeTools(secondTelegram, {
    dbPath,
    throttle: { userCooldownMs: 0 },
  });
  const secondPreview = await callTool(secondTools, "preview_message", {
    chat: "-1001",
    text: "dedupe me",
  });
  const duplicate = await callTool(secondTools, "send_message", {
    chat: "-1001",
    text: "dedupe me",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    dedupe_key: "dedupe/restart",
  });

  assert.equal(duplicate.ok, true);
  assert.equal((duplicate.sent as { id?: number }).id, (firstSend.sent as { id?: number }).id);
  assert.equal(
    ((duplicate.sent as { chat: { chatId: string } }).chat).chatId,
    ((firstSend.sent as { chat: { chatId: string } }).chat).chatId,
  );
  assert.equal(secondTelegram.sends.length, 0);
});

test("sent dedupe keys are permanent audit ids before and after the old ttl window", () => {
  const store = new MessageStore(":memory:");
  const original = store.reserveSend({
    outboxId: "send/permanent-dedupe",
    dedupeKey: "dedupe/permanent",
    payloadHash: "payload/hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 1_000,
    maxAgeMs: 120_000,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 10,
    maxQueuePerChat: 10,
  });

  assert.equal(original.kind, "queued");
  assert.equal(store.markSendSending(original.outboxId, 1_001), true);
  assert.equal(store.markSendSent(original.outboxId, 9001, 1_002), true);

  for (const nowMs of [5 * 60_000, 31 * 24 * 60 * 60_000]) {
    const duplicate = store.reserveSend({
      outboxId: `send/duplicate-${nowMs}`,
      dedupeKey: "dedupe/permanent",
      payloadHash: "payload/hash",
      chatId: "-1001",
      userKey: "mcp-server",
      nowMs,
      maxAgeMs: 120_000,
      userCooldownMs: 0,
      maxPendingPerUserPerChat: 10,
      maxQueuePerChat: 10,
    });
    assert.equal(duplicate.kind, "duplicate_sent");
    assert.equal(duplicate.telegramMessageId, 9001);
  }

  assert.throws(
    () =>
      store.reserveSend({
        outboxId: "send/permanent-dedupe-conflict",
        dedupeKey: "dedupe/permanent",
        payloadHash: "payload/other",
        chatId: "-1001",
        userKey: "mcp-server",
        nowMs: 31 * 24 * 60 * 60_000,
        maxAgeMs: 120_000,
        userCooldownMs: 0,
        maxPendingPerUserPerChat: 10,
        maxQueuePerChat: 10,
      }),
    /dedupe_key has already been used/,
  );
});

test("a rejected dispatch becomes unknown and cannot retry the same dedupe key", async () => {
  const telegram = new FakeTelegram();
  telegram.failNextSend = new Error("temporary send failure");
  const { tools, store } = makeTools(telegram, {
    throttle: { userCooldownMs: 0 },
  });
  const preview = await callTool(tools, "preview_message", {
    text: "retry me",
  });
  const failed = await callTool(tools, "send_message", {
    text: "retry me",
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "dedupe/retry",
  });

  assert.equal(failed.ok, false);
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/retry")?.status, "failed");
  assert.match(store.getSendOutboxByDedupeKey("dedupe/retry")?.error ?? "", /delivery state is unknown/);

  const retryPreview = await callTool(tools, "preview_message", {
    text: "retry me",
  });
  const retried = await callTool(tools, "send_message", {
    text: "retry me",
    dry_run: false,
    approval_id: retryPreview.approval_id,
    dedupe_key: "dedupe/retry",
  });

  assert.equal(retried.ok, false);
  assert.match((retried.error as { message: string }).message, /unknown Telegram delivery state/);
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/retry")?.status, "failed");
  assert.equal(telegram.sends.length, 1);
});

test("an explicitly definitive failed row can be retried with the same dedupe key", () => {
  const store = new MessageStore(":memory:");
  const original = store.reserveSend({
    outboxId: "send/definitive-failure",
    dedupeKey: "dedupe/definitive-failure",
    payloadHash: "payload/hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 1_000,
    maxAgeMs: 120_000,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 10,
    maxQueuePerChat: 10,
  });
  assert.equal(original.kind, "queued");
  assert.equal(store.markSendSending(original.outboxId, 1_001), true);
  assert.equal(store.markSendFailed(original.outboxId, "definitive Telegram rejection", 1_002), true);

  const retry = store.reserveSend({
    outboxId: "send/definitive-failure-retry",
    dedupeKey: "dedupe/definitive-failure",
    payloadHash: "payload/hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 2_000,
    maxAgeMs: 120_000,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 10,
    maxQueuePerChat: 10,
  });

  assert.equal(retry.kind, "queued");
});

test("queued sends expire before execution", async () => {
  const telegram = new FakeTelegram();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  telegram.onSend = async (callNumber) => {
    if (callNumber === 1) {
      markFirstStarted();
      await firstGate;
    }
  };
  const { tools, store } = makeTools(telegram, {
    throttle: {
      userCooldownMs: 0,
      maxAgeMs: 50,
      globalConcurrency: 1,
      maxRunningPerChat: 1,
    },
  });

  const firstPreview = await callTool(tools, "preview_message", {
    text: "first",
  });
  const secondPreview = await callTool(tools, "preview_message", {
    text: "second",
  });
  const firstSend = callTool(tools, "send_message", {
    text: "first",
    dry_run: false,
    approval_id: firstPreview.approval_id,
    dedupe_key: "dedupe/first",
  });
  await firstStarted;
  const secondSend = callTool(tools, "send_message", {
    text: "second",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    dedupe_key: "dedupe/second",
  });

  await sleep(80);
  releaseFirst();

  assert.equal((await firstSend).ok, true);
  const expired = await secondSend;
  assert.equal(expired.ok, false);
  assert.equal((expired.error as { category: string }).category, "rate_limit");
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/second")?.status, "expired");
  assert.equal(telegram.sends.length, 1);
});

test("stale queued transition aborts before Telegram dispatch", async () => {
  const telegram = new FakeTelegram();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  telegram.onSend = async (callNumber) => {
    if (callNumber === 1) {
      markFirstStarted();
      await firstGate;
    }
  };
  const { tools, store } = makeTools(telegram, {
    throttle: {
      userCooldownMs: 0,
      maxAgeMs: 60_000,
      globalConcurrency: 1,
      maxRunningPerChat: 1,
    },
  });

  const firstPreview = await callTool(tools, "preview_message", {
    text: "first stale guard",
  });
  const secondPreview = await callTool(tools, "preview_message", {
    text: "second stale guard",
  });
  const firstSend = callTool(tools, "send_message", {
    text: "first stale guard",
    dry_run: false,
    approval_id: firstPreview.approval_id,
    dedupe_key: "dedupe/stale-first",
  });
  await firstStarted;

  const secondSend = callTool(tools, "send_message", {
    text: "second stale guard",
    dry_run: false,
    approval_id: secondPreview.approval_id,
    dedupe_key: "dedupe/stale-second",
  });
  const queued = await waitForSendOutbox(store, "dedupe/stale-second");
  assert.equal(store.markSendExpired(queued.id, "manually expired before dispatch"), true);

  releaseFirst();

  assert.equal((await firstSend).ok, true);
  const stale = await secondSend;
  assert.equal(stale.ok, false);
  assert.equal((stale.error as { category: string }).category, "rate_limit");
  assert.match((stale.error as { message: string }).message, /no longer queued/);
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/stale-second")?.status, "expired");
  assert.equal(telegram.sends.length, 1);
});

test("persisted cooldown uses server-owned caller identity", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, {
    throttle: { userCooldownMs: 60_000 },
  });
  const firstPreview = await callTool(tools, "preview_message", {
    text: "cooldown one",
  });
  const firstSend = await callTool(tools, "send_message", {
    text: "cooldown one",
    dry_run: false,
    approval_id: firstPreview.approval_id,
  });

  assert.equal(firstSend.ok, true);

  const secondPreview = await callTool(tools, "preview_message", {
    text: "cooldown two",
  });
  const secondSend = await callTool(tools, "send_message", {
    text: "cooldown two",
    dry_run: false,
    approval_id: secondPreview.approval_id,
  });

  assert.equal(secondSend.ok, false);
  assert.equal((secondSend.error as { category: string }).category, "rate_limit");
  assert.equal(telegram.sends.length, 1);
});

test("a second tools instance does not rewrite another process's active outbox rows", (t) => {
  const dbPath = tempDbPath(t);
  const seedStore = new MessageStore(dbPath);
  seedSend(seedStore, "queued", "queued/restart");
  seedSend(seedStore, "sending", "sending/restart");
  seedSend(seedStore, "failed", "failed/restart", "original failure");
  seedSend(seedStore, "expired", "expired/restart", "already expired");
  seedSend(seedStore, "sent", "sent/restart");

  const { store } = makeTools(new FakeTelegram(), { dbPath });

  const queued = store.getSendOutboxByDedupeKey("queued/restart");
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.error, undefined);

  const sending = store.getSendOutboxByDedupeKey("sending/restart");
  assert.equal(sending?.status, "sending");
  assert.equal(sending?.error, undefined);

  assert.equal(store.getSendOutboxByDedupeKey("failed/restart")?.status, "failed");
  assert.equal(store.getSendOutboxByDedupeKey("failed/restart")?.error, "original failure");
  assert.equal(store.getSendOutboxByDedupeKey("expired/restart")?.status, "expired");
  assert.equal(store.getSendOutboxByDedupeKey("expired/restart")?.error, "already expired");
  assert.equal(store.getSendOutboxByDedupeKey("sent/restart")?.status, "sent");
});

test("ambiguous in-flight send is not retried after restart", async (t) => {
  const dbPath = tempDbPath(t);
  const seedStore = new MessageStore(dbPath);
  seedSend(seedStore, "sending", "ambiguous/restart");
  const telegram = new FakeTelegram();
  const { tools, store } = makeTools(telegram, {
    dbPath,
    throttle: { userCooldownMs: 0 },
  });

  const reconciled = store.getSendOutboxByDedupeKey("ambiguous/restart");
  assert.equal(reconciled?.status, "sending");

  const preview = await callTool(tools, "preview_message", {
    text: "ambiguous send",
  });
  const retried = await callTool(tools, "send_message", {
    text: "ambiguous send",
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "ambiguous/restart",
  });

  assert.equal(retried.ok, false);
  assert.equal((retried.error as { category: string }).category, "internal");
  assert.match((retried.error as { message: string }).message, /Telegram delivery state is unknown/);
  assert.equal(telegram.sends.length, 0);
});

test("an expired in-flight row never becomes a reusable dedupe reservation", () => {
  const store = new MessageStore(":memory:");
  const original = store.reserveSend({
    outboxId: "send/in-flight",
    dedupeKey: "dedupe/in-flight",
    payloadHash: "payload/hash",
    chatId: "-1001",
    userKey: "mcp-server",
    nowMs: 1_000,
    maxAgeMs: 50,
    userCooldownMs: 0,
    maxPendingPerUserPerChat: 10,
    maxQueuePerChat: 10,
  });
  assert.equal(original.kind, "queued");
  assert.equal(store.markSendSending(original.outboxId, 1_001), true);

  assert.throws(
    () =>
      store.reserveSend({
        outboxId: "send/in-flight-retry",
        dedupeKey: "dedupe/in-flight",
        payloadHash: "payload/hash",
        chatId: "-1001",
        userKey: "mcp-server",
        nowMs: 2_000,
        maxAgeMs: 50,
        userCooldownMs: 0,
        maxPendingPerUserPerChat: 10,
        maxQueuePerChat: 10,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.normalized.retryable, false);
      assert.match(error.message, /in-flight/);
      return true;
    },
  );
  assert.equal(store.getSendOutboxByDedupeKey("dedupe/in-flight")?.status, "sending");
});

test("startup reconciliation expires only stale queued rows and never touches sending", () => {
  const store = new MessageStore(":memory:");
  seedSend(store, "queued", "queued/stale");
  seedSend(store, "sending", "sending/live");

  const result = store.reconcileActiveSendsOnStartup(70_000);

  assert.equal(result.expiredQueued, 1);
  assert.equal(result.markedUnknownDelivery, 0);
  assert.equal(store.getSendOutboxByDedupeKey("queued/stale")?.status, "expired");
  assert.equal(store.getSendOutboxByDedupeKey("sending/live")?.status, "sending");
});

test("terminal send outbox states are not overwritten by later transitions", () => {
  const store = new MessageStore(":memory:");
  const sentId = seedSend(store, "sent", "terminal/sent");
  const failedId = seedSend(store, "failed", "terminal/failed", "original failure");
  const expiredId = seedSend(store, "expired", "terminal/expired", "original expiry");

  assert.equal(store.markSendFailed(sentId, "late failure", 2000), false);
  assert.equal(store.markSendExpired(sentId, "late expiry", 2001), false);
  assert.equal(store.getSendOutboxByDedupeKey("terminal/sent")?.status, "sent");
  assert.equal(store.getSendOutboxByDedupeKey("terminal/sent")?.error, undefined);

  assert.equal(store.markSendSent(failedId, 9002, 2002), false);
  assert.equal(store.markSendExpired(failedId, "late expiry", 2003), false);
  assert.equal(store.markSendFailed(failedId, "late failure", 2004), false);
  const failed = store.getSendOutboxByDedupeKey("terminal/failed");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "original failure");

  assert.equal(store.markSendSending(expiredId, 2005), false);
  assert.equal(store.markSendSent(expiredId, 9003, 2006), false);
  assert.equal(store.markSendFailed(expiredId, "late failure", 2007), false);
  assert.equal(store.markSendExpired(expiredId, "late expiry", 2008), false);
  const expired = store.getSendOutboxByDedupeKey("terminal/expired");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.error, "original expiry");
});


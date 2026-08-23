import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import {
  CHAT,
  OTHER_CHAT,
  assertAddressedAckHasReservation,
  ingest,
  makeStore,
  message,
} from "./support/bot-durability.js";

test("duplicate Bot API update is idempotent and cannot reserve a second turn", (t) => {
  const store = makeStore(t);

  const first = ingest(store, 100, 500);
  const duplicate = ingest(store, 100, 500);
  const duplicateTrigger = ingest(store, 101, 500);

  assert.equal(first.disposition, "ingested");
  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(duplicate.turn?.id, first.turn?.id);
  assert.equal(duplicateTrigger.update.status, "skipped");
  assert.equal(duplicateTrigger.turn?.id, first.turn?.id);
  assert.equal(store.queryBotUpdates().length, 2);
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(store.countMessages(CHAT.chatId), 1);
});

test("durable writer uses WAL with FULL synchronous commits", (t) => {
  const store = makeStore(t);
  const db = (
    store as unknown as {
      db: {
        prepare(sql: string): {
          get(): Record<string, unknown> | undefined;
        };
      };
    }
  ).db;

  assert.equal(Number(db.prepare("PRAGMA synchronous").get()?.synchronous), 2);
  assert.equal(
    String(db.prepare("PRAGMA journal_mode").get()?.journal_mode),
    "wal",
  );
});

test("a process crash after ingest leaves an addressed turn claimable after reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-durable-crash-"));
  const dbPath = join(directory, "cache.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const firstProcess = new MessageStore(dbPath);
  const ingested = ingest(firstProcess, 200, 600);
  firstProcess.close();

  const restarted = new MessageStore(dbPath);
  t.after(() => restarted.close());
  const claimed = restarted.claimNextBotTurn({
    workerId: "worker-after-restart",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 10_000,
  });

  assert.equal(claimed?.id, ingested.turn?.id);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempts, 1);
  assert.equal(restarted.getBotUpdate(200)?.status, "running");
});

test("claiming a turn for one chat never quarantines another concurrently valid chat's backlog (Фаза 7)", (t) => {
  const store = makeStore(t);
  const otherChatTurn = ingest(store, 250, 650).turn!;
  const thisChatTurn = store.ingestBotUpdate({
    updateId: 251,
    rawJson: '{"update_id":251}',
    chat: OTHER_CHAT,
    message: message(651, { chatId: OTHER_CHAT.chatId }),
    addressed: true,
    nowMs: 1_000,
  }).turn!;

  const claimed = store.claimNextBotTurn({
    workerId: "other-chat-worker",
    chatId: OTHER_CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 2_000,
  });

  assert.equal(claimed?.id, thisChatTurn.id);
  assert.equal(claimed?.chatId, OTHER_CHAT.chatId);
  // Two chats can be concurrently valid (multi-chat, Фаза 7): claiming for
  // OTHER_CHAT must not touch CHAT's still-legitimate queued turn.
  assert.equal(store.getBotTurn(otherChatTurn.id)?.status, "queued");
});

test("quarantineBotTurnsOutsideAllowlist dead-letters backlog outside the given chats, called once, not per-claim", (t) => {
  const store = makeStore(t);
  const keptTurn = ingest(store, 260, 660).turn!;
  const droppedTurn = store.ingestBotUpdate({
    updateId: 261,
    rawJson: '{"update_id":261}',
    chat: OTHER_CHAT,
    message: message(661, { chatId: OTHER_CHAT.chatId }),
    addressed: true,
    nowMs: 1_000,
  }).turn!;

  store.quarantineBotTurnsOutsideAllowlist([CHAT.chatId], 2_000);

  assert.equal(store.getBotTurn(keptTurn.id)?.status, "queued");
  assert.equal(store.getBotTurn(droppedTurn.id)?.status, "dead_letter");
  assert.match(
    store.getBotTurn(droppedTurn.id)?.error ?? "",
    /outside the current allowlist/u,
  );

  assert.throws(
    () => store.quarantineBotTurnsOutsideAllowlist([]),
    /must not be empty/u,
  );
});

test("expired running and drafted leases recover, but attempts stay bounded", (t) => {
  const store = makeStore(t);
  const ingested = ingest(store, 300, 700, { maxAttempts: 2, nowMs: 1_000 });
  const first = store.claimNextBotTurn({
    workerId: "worker-a",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 1_000,
  });
  assert.equal(first?.id, ingested.turn?.id);
  assert.equal(
    store.saveBotTurnDraft(first!.id, "worker-a", "durable draft", 1_050),
    true,
  );

  assert.equal(
    store.claimNextBotTurn({
      workerId: "worker-b",
      chatId: CHAT.chatId,
      leaseMs: 100,
      nowMs: 1_099,
    }),
    undefined,
  );
  const recovered = store.claimNextBotTurn({
    workerId: "worker-b",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 1_100,
  });
  assert.equal(recovered, undefined);
  assert.equal(store.getBotTurn(first!.id)?.retryNotBeforeMs, 6_100);
  const due = store.claimNextBotTurn({
    workerId: "worker-b",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 6_100,
  });
  assert.equal(due?.id, first?.id);
  assert.equal(due?.attempts, 2);
  assert.equal(due?.draftText, "durable draft");
  assert.equal(
    store.saveBotTurnDraft(first!.id, "worker-a", "stale owner", 1_101),
    false,
  );

  const exhausted = store.claimNextBotTurn({
    workerId: "worker-c",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 6_200,
  });
  assert.equal(exhausted, undefined);
  assert.equal(store.getBotTurn(first!.id)?.status, "dead_letter");
  assert.equal(store.getBotTurn(first!.id)?.attempts, 2);
  assert.equal(store.getBotUpdate(300)?.status, "dead_letter");
});

test("the active owner can renew a live lease but cannot revive or steal one", (t) => {
  const store = makeStore(t);
  const turn = ingest(store, 350, 750, { nowMs: 1_000 }).turn!;
  const claimed = store.claimNextBotTurn({
    workerId: "worker-a",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 1_010,
  });
  assert.equal(claimed?.id, turn.id);

  assert.equal(store.renewBotTurnLease(turn.id, "worker-b", 200, 1_050), false);
  assert.equal(store.renewBotTurnLease(turn.id, "worker-a", 200, 1_050), true);
  assert.equal(store.getBotTurn(turn.id)?.leaseExpiresAtMs, 1_250);
  assert.equal(store.renewBotTurnLease(turn.id, "worker-a", 200, 1_251), false);
});

test("sent terminal state is immutable and never automatically claimed", (t) => {
  const store = makeStore(t);
  const turn = ingest(store, 400, 800).turn!;
  const claimed = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 2_000,
  })!;

  assert.equal(
    store.saveBotTurnDraft(claimed.id, "sender", "guarded final text", 2_100),
    true,
  );
  assert.equal(store.markBotTurnSending(claimed.id, "sender", 2_200), true);
  assert.equal(store.markBotTurnSent(claimed.id, 9_001, 2_300), true);

  assert.equal(store.markBotTurnSent(claimed.id, 9_002, 2_301), false);
  assert.equal(store.markBotTurnLostAck(claimed.id, "too late", 2_302), false);
  assert.equal(
    store.markBotTurnFailed(claimed.id, "sender", "too late", 2_303),
    false,
  );
  assert.equal(
    store.markBotTurnSkipped(claimed.id, "sender", "too late", 2_304),
    false,
  );
  assert.equal(
    store.claimNextBotTurn({
      workerId: "other",
      chatId: CHAT.chatId,
      leaseMs: 100,
      nowMs: 9_000,
    }),
    undefined,
  );
  assert.equal(store.getBotTurn(turn.id)?.status, "sent");
  assert.equal(store.getBotTurn(turn.id)?.telegramMessageId, 9_001);
  assert.equal(store.getBotTurn(turn.id)?.draftText, "guarded final text");
  assert.equal(store.getBotUpdate(400)?.status, "sent");
});

test("ACK token for an addressed update exists only after its turn reservation commits", (t) => {
  const store = makeStore(t);

  const result = ingest(store, 500, 900);
  assertAddressedAckHasReservation(store, result);
  assert.equal(result.ackUpdateId, 500);
  assert.equal(
    store.getHistory({ chatId: CHAT.chatId, limit: 10 })[0]?.messageId,
    900,
  );

  assert.throws(
    () =>
      store.ingestBotUpdate({
        updateId: 501,
        rawJson: '{"update_id":501}',
        chat: CHAT,
        message: message(900, { chatId: "-100-different" }),
        addressed: true,
      }),
    /chatId must match/,
  );
  assert.equal(store.getBotUpdate(501), undefined);
  assert.equal(store.queryBotTurns().length, 1);
});

test("three addressed triggers are durably queued and claimed once in FIFO order", (t) => {
  const store = makeStore(t);
  const results = [
    ingest(store, 600, 1_000, { nowMs: 10 }),
    ingest(store, 601, 1_001, { nowMs: 20 }),
    ingest(store, 602, 1_002, { nowMs: 30 }),
  ];

  assert.deepEqual(
    store
      .queryBotTurns({ statuses: ["queued"] })
      .map((turn) => turn.triggerMessageId),
    [1_000, 1_001, 1_002],
  );
  const claimed = results.map((_, index) =>
    store.claimNextBotTurn({
      workerId: `worker-${index}`,
      chatId: CHAT.chatId,
      leaseMs: 1_000,
      nowMs: 100 + index,
    }),
  );
  assert.deepEqual(
    claimed.map((turn) => turn?.triggerMessageId),
    [1_000, 1_001, 1_002],
  );
  assert.equal(new Set(claimed.map((turn) => turn?.id)).size, 3);
  assert.equal(store.queryBotTurns({ statuses: ["queued"] }).length, 0);
});

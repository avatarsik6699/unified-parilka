import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT, ingest, makeStore } from "./support/bot-durability.js";

test("sending and lost_ack are never auto-retried", (t) => {
  const store = makeStore(t);
  ingest(store, 700, 1_100);
  const sending = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 100,
    nowMs: 20_000,
  })!;
  assert.equal(
    store.saveBotTurnDraft(sending.id, "sender", "possibly delivered", 20_010),
    true,
  );
  assert.equal(store.markBotTurnSending(sending.id, "sender", 20_020), true);

  assert.equal(
    store.claimNextBotTurn({
      workerId: "retry-worker",
      chatId: CHAT.chatId,
      leaseMs: 100,
      nowMs: 30_000,
    }),
    undefined,
  );
  assert.equal(
    store.markBotTurnLostAck(
      sending.id,
      "network timeout after dispatch",
      30_001,
    ),
    true,
  );
  assert.equal(
    store.claimNextBotTurn({
      workerId: "retry-worker",
      chatId: CHAT.chatId,
      leaseMs: 100,
      nowMs: 40_000,
    }),
    undefined,
  );
  assert.equal(store.getBotTurn(sending.id)?.status, "lost_ack");
});

test("only a definitive dispatch rejection may leave sending for a retry lane", (t) => {
  const store = makeStore(t);
  const retryTurn = ingest(store, 725, 1_125, {
    maxAttempts: 2,
    nowMs: 30_000,
  }).turn!;
  const retryClaim = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 30_010,
  });
  assert.equal(retryClaim?.id, retryTurn.id);
  assert.equal(
    store.saveBotTurnDraft(retryTurn.id, "sender", "retry me", 30_020),
    true,
  );
  assert.equal(store.markBotTurnSending(retryTurn.id, "sender", 30_030), true);
  assert.equal(
    store.markBotTurnDispatchRejected(
      retryTurn.id,
      "429 response",
      true,
      30_040,
    ),
    true,
  );
  assert.equal(store.getBotTurn(retryTurn.id)?.status, "failed");
  assert.equal(store.getBotTurn(retryTurn.id)?.retryNotBeforeMs, 35_040);
  assert.equal(
    store.claimNextBotTurn({
      workerId: "retry",
      chatId: CHAT.chatId,
      leaseMs: 100,
      nowMs: 30_050,
    })?.id,
    undefined,
  );
  assert.equal(
    store.claimNextBotTurn({
      workerId: "retry",
      chatId: CHAT.chatId,
      leaseMs: 100,
      nowMs: 35_040,
    })?.id,
    retryTurn.id,
  );

  const permanentTurn = ingest(store, 726, 1_126, { nowMs: 31_000 }).turn!;
  const permanentClaim = store.claimNextBotTurn({
    workerId: "sender",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 31_010,
  });
  assert.equal(permanentClaim?.id, permanentTurn.id);
  assert.equal(
    store.saveBotTurnDraft(permanentTurn.id, "sender", "invalid", 31_020),
    true,
  );
  assert.equal(
    store.markBotTurnSending(permanentTurn.id, "sender", 31_030),
    true,
  );
  assert.equal(
    store.markBotTurnDispatchRejected(
      permanentTurn.id,
      "400 response",
      false,
      31_040,
    ),
    true,
  );
  assert.equal(store.getBotTurn(permanentTurn.id)?.status, "dead_letter");
  assert.equal(
    store.markBotTurnDispatchRejected(
      permanentTurn.id,
      "late rewrite",
      true,
      31_050,
    ),
    false,
  );
});

test("known failures retry within budget and an explicit skip is terminal", (t) => {
  const store = makeStore(t);
  ingest(store, 750, 1_150, { maxAttempts: 2, nowMs: 50_000 });
  const first = store.claimNextBotTurn({
    workerId: "worker-a",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 50_000,
  })!;

  assert.equal(
    store.markBotTurnFailed(
      first.id,
      "worker-a",
      "provider unavailable",
      50_100,
    ),
    true,
  );
  assert.equal(store.getBotTurn(first.id)?.status, "failed");
  const retry = store.claimNextBotTurn({
    workerId: "worker-b",
    chatId: CHAT.chatId,
    leaseMs: 1_000,
    nowMs: 55_100,
  })!;
  assert.equal(retry.id, first.id);
  assert.equal(retry.attempts, 2);
  assert.equal(
    store.markBotTurnSkipped(retry.id, "worker-b", "moderation policy", 50_300),
    true,
  );
  assert.equal(store.getBotTurn(retry.id)?.status, "skipped");
  assert.equal(
    store.claimNextBotTurn({
      workerId: "worker-c",
      chatId: CHAT.chatId,
      leaseMs: 100,
      nowMs: 60_000,
    }),
    undefined,
  );
});

test("poison updates retry durably, recover before the limit, and dead-letter at the limit", (t) => {
  const store = makeStore(t);

  const firstFailure = store.recordBotUpdateFailure({
    updateId: 800,
    rawJson: '{"broken":',
    error: "invalid JSON",
    maxAttempts: 3,
    nowMs: 1,
  });
  assert.equal(firstFailure.update.status, "failed");
  assert.equal(firstFailure.update.attempts, 1);
  assert.equal(firstFailure.ackUpdateId, undefined);

  const recovered = ingest(store, 800, 1_200, { maxAttempts: 3, nowMs: 2 });
  assert.equal(recovered.disposition, "recovered");
  assert.equal(recovered.update.status, "queued");
  assert.equal(recovered.turn?.triggerMessageId, 1_200);

  const deadOne = store.recordBotUpdateFailure({
    updateId: 801,
    rawJson: '{"still":"bad"}',
    error: "unsupported update shape",
    maxAttempts: 2,
    nowMs: 3,
  });
  const deadTwo = store.recordBotUpdateFailure({
    updateId: 801,
    rawJson: '{"still":"bad"}',
    error: "unsupported update shape",
    maxAttempts: 20,
    nowMs: 4,
  });
  assert.equal(deadOne.update.status, "failed");
  assert.equal(deadTwo.update.status, "dead_letter");
  assert.equal(deadTwo.update.attempts, 2);
  assert.equal(deadTwo.update.maxAttempts, 2);
  assert.equal(deadTwo.ackUpdateId, 801);
  assert.equal(ingest(store, 801, 1_201).disposition, "duplicate");
  assert.equal(store.getBotTurnByTrigger(CHAT.chatId, 1_201), undefined);
});

test("a changed decoder still ACKs a previously committed valid redelivery", (t) => {
  const store = makeStore(t);
  const committed = ingest(store, 850, 1_250);

  const reclassified = store.recordBotUpdateFailure({
    updateId: 850,
    rawJson: '{"update_id":850,"new_shape":true}',
    error: "new decoder rejects old shape",
    maxAttempts: 3,
    nowMs: 2_000,
  });

  assert.equal(reclassified.ackUpdateId, 850);
  assert.equal(reclassified.update.status, "queued");
  assert.equal(reclassified.update.attempts, 0);
  assert.equal(
    store.getBotTurnByTrigger(CHAT.chatId, committed.turn!.triggerMessageId)
      ?.id,
    committed.turn?.id,
  );
});

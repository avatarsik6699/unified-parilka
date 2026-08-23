import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runHumanPersonaSendTick,
  type HumanPersonaSendRegeneratePort,
  type HumanPersonaSendStore,
  type HumanPersonaSendTelegramPort,
} from "../src/human-persona-send.js";
import type {
  HumanPersonaProposalStatus,
  StoredHumanPersonaProposal,
} from "../src/store.js";

function proposal(
  overrides: Partial<StoredHumanPersonaProposal> = {},
): StoredHumanPersonaProposal {
  return {
    id: "prop-1",
    personaId: "p1",
    chatId: "-1002",
    proposedText: "го покерасим",
    finalText: null,
    status: "approved",
    autonomyMode: "approval",
    approvalChatId: null,
    approvalMessageId: null,
    claimedBy: null,
    claimedAtMs: null,
    decidedAtMs: 1_000,
    error: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

class FakeStore implements HumanPersonaSendStore {
  autoQueue: StoredHumanPersonaProposal[];
  decidedQueue: StoredHumanPersonaProposal[];
  decisions: { id: string; status: string }[] = [];
  sent: string[] = [];
  expired: string[] = [];

  constructor(
    autoQueue: StoredHumanPersonaProposal[] = [],
    decidedQueue: StoredHumanPersonaProposal[] = [],
  ) {
    this.autoQueue = autoQueue;
    this.decidedQueue = decidedQueue;
  }

  claimNextPendingAutoHumanPersonaProposal():
    StoredHumanPersonaProposal | undefined {
    return this.autoQueue.shift();
  }

  getNextDecidedHumanPersonaProposal(): StoredHumanPersonaProposal | undefined {
    return this.decidedQueue.shift();
  }

  recordHumanPersonaProposalDecision(
    id: string,
    status: HumanPersonaProposalStatus,
  ): boolean {
    this.decisions.push({ id, status });
    return true;
  }

  markHumanPersonaProposalSent(id: string): boolean {
    this.sent.push(id);
    return true;
  }

  markHumanPersonaProposalExpired(id: string): boolean {
    this.expired.push(id);
    return true;
  }
}

class FakeTelegram implements HumanPersonaSendTelegramPort {
  calls: { chat: string; text: string }[] = [];
  shouldFail = false;

  async sendMessage(params: {
    chat: string;
    text: string;
  }): Promise<{ id?: number }> {
    if (this.shouldFail) {
      throw new Error("network down");
    }
    this.calls.push(params);
    return { id: 42 };
  }
}

class FakeRegenerate implements HumanPersonaSendRegeneratePort {
  calls: StoredHumanPersonaProposal[] = [];
  result: { status: string; proposalId?: string } = {
    status: "proposed",
    proposalId: "prop-2",
  };
  shouldFail = false;

  async regenerate(
    proposal: StoredHumanPersonaProposal,
  ): Promise<{ status: string; proposalId?: string }> {
    this.calls.push(proposal);
    if (this.shouldFail) {
      throw new Error("model unavailable");
    }
    return this.result;
  }
}

test("an idle queue on both paths reports idle without any side effects", async () => {
  const store = new FakeStore([], []);
  const telegram = new FakeTelegram();
  const regenerate = new FakeRegenerate();

  const report = await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "bot-agi-sync",
  });

  assert.equal(report.status, "idle");
  assert.equal(telegram.calls.length, 0);
});

test("an auto-mode proposal self-approves through the normal decision path, then sends", async () => {
  const store = new FakeStore([
    proposal({ id: "auto-1", autonomyMode: "auto", status: "pending" }),
  ]);
  const telegram = new FakeTelegram();
  const regenerate = new FakeRegenerate();

  const report = await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "bot-agi-sync",
  });

  assert.equal(report.status, "sent_auto");
  assert.deepEqual(store.decisions, [{ id: "auto-1", status: "approved" }]);
  assert.deepEqual(store.sent, ["auto-1"]);
  assert.equal(telegram.calls[0]?.text, "го покерасим");
});

test("an approved proposal sends its proposed text and is marked sent", async () => {
  const store = new FakeStore([], [proposal({ status: "approved" })]);
  const telegram = new FakeTelegram();
  const regenerate = new FakeRegenerate();

  const report = await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "bot-agi-sync",
  });

  assert.equal(report.status, "sent_approved");
  assert.equal(telegram.calls[0]?.text, "го покерасим");
  assert.deepEqual(store.sent, ["prop-1"]);
});

test("an edited proposal sends the final (corrected) text, not the original", async () => {
  const store = new FakeStore(
    [],
    [proposal({ status: "edited", finalText: "го, но повежливее" })],
  );
  const telegram = new FakeTelegram();
  const regenerate = new FakeRegenerate();

  await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "x",
  });

  assert.equal(telegram.calls[0]?.text, "го, но повежливее");
});

test("a regenerate_requested proposal is handed to the regenerate port and marked expired", async () => {
  const store = new FakeStore(
    [],
    [proposal({ status: "regenerate_requested" })],
  );
  const telegram = new FakeTelegram();
  const regenerate = new FakeRegenerate();

  const report = await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "bot-agi-sync",
  });

  assert.equal(report.status, "regenerated");
  assert.equal(report.proposalId, "prop-2");
  assert.equal(regenerate.calls.length, 1);
  assert.deepEqual(store.expired, ["prop-1"]);
  assert.equal(telegram.calls.length, 0);
});

test("a send failure is reported without marking the proposal sent", async () => {
  const store = new FakeStore([], [proposal({ status: "approved" })]);
  const telegram = new FakeTelegram();
  telegram.shouldFail = true;
  const regenerate = new FakeRegenerate();

  const report = await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "bot-agi-sync",
  });

  assert.equal(report.status, "send_failed");
  assert.equal(store.sent.length, 0);
});

test("a regenerate failure is reported and the original proposal is left un-expired", async () => {
  const store = new FakeStore(
    [],
    [proposal({ status: "regenerate_requested" })],
  );
  const telegram = new FakeTelegram();
  const regenerate = new FakeRegenerate();
  regenerate.shouldFail = true;

  const report = await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "bot-agi-sync",
  });

  assert.equal(report.status, "regenerate_failed");
  assert.equal(store.expired.length, 0);
});

test("an auto-mode proposal takes priority over an unrelated decided approval proposal", async () => {
  const store = new FakeStore(
    [proposal({ id: "auto-1", autonomyMode: "auto", status: "pending" })],
    [proposal({ id: "approved-1", status: "approved" })],
  );
  const telegram = new FakeTelegram();
  const regenerate = new FakeRegenerate();

  const report = await runHumanPersonaSendTick({
    store,
    telegram,
    regenerate,
    personaId: "p1",
    claimedBy: "bot-agi-sync",
  });

  assert.equal(report.proposalId, "auto-1");
  assert.equal(store.decidedQueue.length, 1);
});

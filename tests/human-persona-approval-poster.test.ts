import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApprovalPosterLoop,
  runApprovalPosterTick,
  type ApprovalPosterApiPort,
  type ApprovalPosterStore,
} from "../src/human-persona-approval-poster.js";
import type { StoredHumanPersonaProposal } from "../src/store.js";

function proposal(
  overrides: Partial<StoredHumanPersonaProposal> = {},
): StoredHumanPersonaProposal {
  return {
    id: "prop-1",
    personaId: "p1",
    chatId: "-1002",
    proposedText: "го покерасим",
    finalText: null,
    status: "claimed",
    autonomyMode: "approval",
    approvalChatId: null,
    approvalMessageId: null,
    claimedBy: null,
    claimedAtMs: null,
    decidedAtMs: null,
    error: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

class FakeStore implements ApprovalPosterStore {
  queue: StoredHumanPersonaProposal[];
  posted: { id: string; approvalChatId: string; approvalMessageId: number }[] =
    [];

  constructor(queue: StoredHumanPersonaProposal[] = []) {
    this.queue = queue;
  }

  claimNextPendingHumanPersonaProposal():
    StoredHumanPersonaProposal | undefined {
    return this.queue.shift();
  }

  recordHumanPersonaApprovalPosted(
    id: string,
    approvalChatId: string,
    approvalMessageId: number,
  ): boolean {
    this.posted.push({ id, approvalChatId, approvalMessageId });
    return true;
  }
}

class FakeApi implements ApprovalPosterApiPort {
  calls: { chatId: string; text: string }[] = [];
  nextMessageId = 500;
  shouldFail = false;

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<{ message_id: number }> {
    if (this.shouldFail) {
      throw new Error("network down");
    }
    this.calls.push({ chatId, text });
    return { message_id: this.nextMessageId++ };
  }
}

test("an empty queue is reported without calling the API", async () => {
  const store = new FakeStore([]);
  const api = new FakeApi();

  const report = await runApprovalPosterTick({
    store,
    api,
    personaId: "p1",
    approvalChatId: "-999",
    claimedBy: "bot-agi-bot",
    now: () => 1_000,
  });

  assert.equal(report.status, "empty");
  assert.equal(api.calls.length, 0);
});

test("a claimed proposal is posted with its buttons and recorded", async () => {
  const store = new FakeStore([proposal()]);
  const api = new FakeApi();

  const report = await runApprovalPosterTick({
    store,
    api,
    personaId: "p1",
    approvalChatId: "-999",
    claimedBy: "bot-agi-bot",
    now: () => 1_000,
  });

  assert.equal(report.status, "posted");
  assert.equal(report.proposalId, "prop-1");
  assert.equal(api.calls.length, 1);
  assert.match(api.calls[0]!.text, /го покерасим/);
  assert.deepEqual(store.posted, [
    { id: "prop-1", approvalChatId: "-999", approvalMessageId: 500 },
  ]);
});

test("an API failure is reported as failed without throwing", async () => {
  const store = new FakeStore([proposal()]);
  const api = new FakeApi();
  api.shouldFail = true;

  const report = await runApprovalPosterTick({
    store,
    api,
    personaId: "p1",
    approvalChatId: "-999",
    claimedBy: "bot-agi-bot",
    now: () => 1_000,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.proposalId, "prop-1");
  assert.equal(store.posted.length, 0);
});

test("the loop drains a queue of proposals, then idles until the signal aborts", async () => {
  const store = new FakeStore([proposal({ id: "a" }), proposal({ id: "b" })]);
  const api = new FakeApi();
  const reports: string[] = [];
  const loop = new ApprovalPosterLoop({
    store,
    api,
    personaId: "p1",
    approvalChatId: "-999",
    claimedBy: "bot-agi-bot",
    idleIntervalMs: 20,
    onTick: (report) => reports.push(report.status),
  });

  const controller = new AbortController();
  const runPromise = loop.run(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort();
  await runPromise;

  assert.deepEqual(reports.slice(0, 2), ["posted", "posted"]);
  assert.equal(api.calls.length, 2);
  assert.ok(reports.includes("empty"));
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BotUpdateProcessor } from "../src/bot/runtime.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import type { MessageStore } from "../src/store.js";
import { makeStore, TELEGRAM_OPTIONS } from "./support/bot-runtime.js";

const APPROVAL_CHAT_ID = "-1009998887776";

const TELEGRAM_WITH_APPROVAL = {
  ...TELEGRAM_OPTIONS,
  humanPersonaApprovalChatId: APPROVAL_CHAT_ID,
} as const;

function processor(store: MessageStore): BotUpdateProcessor {
  return new BotUpdateProcessor({
    store,
    coordinator: new TurnCoordinator({ maxActiveTurns: 3 }),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_WITH_APPROVAL,
    now: () => 1_000,
  });
}

function callbackUpdate(updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: { id: 555, is_bot: false, username: "owner" },
      message: { message_id: 42, chat: { id: Number(APPROVAL_CHAT_ID) } },
    },
  };
}

function approvalReply(
  updateId: number,
  replyToMessageId: number,
  text: string,
) {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      date: 1_700_000_000,
      chat: { id: Number(APPROVAL_CHAT_ID), type: "private" },
      from: { id: 555, is_bot: false, username: "owner" },
      reply_to_message: { message_id: replyToMessageId },
      text,
    },
  };
}

function claimedProposal(
  store: MessageStore,
  t: TestContext,
  overrides: { id?: string; approvalMessageId?: number } = {},
) {
  const id = overrides.id ?? "prop-1";
  store.createHumanPersonaProposal({
    id,
    personaId: "p1",
    chatId: "-1002",
    proposedText: "го покерасим",
    autonomyMode: "approval",
    nowMs: 1_000,
  });
  const claimed = store.claimNextPendingHumanPersonaProposal(
    "p1",
    "bot-agi-bot",
    1_000,
  );
  assert.ok(claimed);
  store.recordHumanPersonaApprovalPosted(
    id,
    APPROVAL_CHAT_ID,
    overrides.approvalMessageId ?? 42,
    1_000,
  );
  t.after(() => {});
  return id;
}

test("approve callback moves a claimed proposal to approved and acks without routing", (t) => {
  const store = makeStore(t);
  const id = claimedProposal(store, t);

  const result = processor(store).process(
    callbackUpdate(1, `hp:approve:${id}`),
  );

  assert.equal(result.acknowledged, true);
  assert.ok(
    result.acknowledged && result.disposition === "human_persona_decision",
  );
  assert.ok(result.acknowledged && result.routed === false);
  assert.equal(store.getHumanPersonaProposal(id)?.status, "approved");
});

test("reject and regenerate callbacks apply the matching status", (t) => {
  const store = makeStore(t);
  const rejectId = claimedProposal(store, t, { id: "prop-reject" });
  processor(store).process(callbackUpdate(2, `hp:reject:${rejectId}`));
  assert.equal(store.getHumanPersonaProposal(rejectId)?.status, "rejected");

  const regenId = claimedProposal(store, t, { id: "prop-regen" });
  processor(store).process(callbackUpdate(3, `hp:regenerate:${regenId}`));
  assert.equal(
    store.getHumanPersonaProposal(regenId)?.status,
    "regenerate_requested",
  );
});

test("the edit button is a UI hint only -- it never changes proposal status", (t) => {
  const store = makeStore(t);
  const id = claimedProposal(store, t);

  const result = processor(store).process(callbackUpdate(4, `hp:edit:${id}`));

  assert.equal(result.acknowledged, true);
  assert.equal(store.getHumanPersonaProposal(id)?.status, "claimed");
});

test("a malformed callback is acknowledged and never touches any proposal", (t) => {
  const store = makeStore(t);
  const id = claimedProposal(store, t);

  const result = processor(store).process(
    callbackUpdate(5, "not-a-valid-payload"),
  );

  assert.equal(result.acknowledged, true);
  assert.equal(store.getHumanPersonaProposal(id)?.status, "claimed");
});

test("a callback for an already-decided proposal is a harmless no-op (double click)", (t) => {
  const store = makeStore(t);
  const id = claimedProposal(store, t);
  store.recordHumanPersonaProposalDecision(id, "approved", undefined, 1_000);

  const result = processor(store).process(callbackUpdate(6, `hp:reject:${id}`));

  assert.equal(result.acknowledged, true);
  assert.equal(store.getHumanPersonaProposal(id)?.status, "approved");
});

test("a reply to the posted proposal in the approval chat captures the edited text", (t) => {
  const store = makeStore(t);
  const id = claimedProposal(store, t, { approvalMessageId: 77 });

  const result = processor(store).process(
    approvalReply(7, 77, "го, но повежливее"),
  );

  assert.equal(result.acknowledged, true);
  assert.ok(result.acknowledged && result.routed === false);
  const proposal = store.getHumanPersonaProposal(id);
  assert.equal(proposal?.status, "edited");
  assert.equal(proposal?.finalText, "го, но повежливее");
});

test("a reply with a matching message id in a different chat is not mistaken for an edit", (t) => {
  const store = makeStore(t);
  const id = claimedProposal(store, t, { approvalMessageId: 77 });

  // Same reply_to_message_id (77), but posted in the normal allowed chat --
  // TELEGRAM_OPTIONS.allowedChatId, not the approval chat.
  const result = processor(store).process({
    update_id: 8,
    message: {
      message_id: 900,
      date: 1_700_000_000,
      chat: { id: Number("-1003179772905"), type: "supergroup" },
      from: { id: 555, is_bot: false, username: "owner" },
      reply_to_message: { message_id: 77 },
      text: "го, но повежливее",
    },
  });

  assert.equal(result.acknowledged, true);
  assert.equal(store.getHumanPersonaProposal(id)?.status, "claimed");
});

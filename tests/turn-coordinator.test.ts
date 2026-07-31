import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TurnCoordinator,
  type TurnTraceEvent,
} from "../src/bot/turn-coordinator.js";

test("three overlapping turns receive only messages after their start watermark", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });

  assert.equal(
    coordinator.startTurn({ turnId: "turn-1", ownerSenderId: "alice" })
      .status,
    "started",
  );
  assert.deepEqual(
    coordinator.routeMessage(message("message-1", "alice")).deliveredToTurnIds,
    ["turn-1"],
  );

  assert.equal(
    coordinator.startTurn({ turnId: "turn-2", ownerSenderId: "bob" }).status,
    "started",
  );
  assert.deepEqual(
    coordinator.routeMessage(message("message-2", "bob")).deliveredToTurnIds,
    ["turn-1", "turn-2"],
  );

  assert.equal(
    coordinator.startTurn({ turnId: "turn-3", ownerSenderId: "carol" })
      .status,
    "started",
  );
  assert.deepEqual(
    coordinator.routeMessage(message("message-3", "carol"))
      .deliveredToTurnIds,
    ["turn-1", "turn-2", "turn-3"],
  );

  assert.deepEqual(foldIds(coordinator, "turn-1"), [
    "message-1",
    "message-2",
    "message-3",
  ]);
  assert.deepEqual(foldIds(coordinator, "turn-2"), [
    "message-2",
    "message-3",
  ]);
  assert.deepEqual(foldIds(coordinator, "turn-3"), ["message-3"]);
});

test("two active turns from the same sender keep independent owner queues", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  coordinator.startTurn({ turnId: "older", ownerSenderId: "alice" });
  coordinator.routeMessage(message("before-newer", "alice"));
  coordinator.startTurn({ turnId: "newer", ownerSenderId: "alice" });
  coordinator.routeMessage(message("shared-follow-up", "alice"));

  const older = drain(coordinator, "older");
  const newer = drain(coordinator, "newer");

  assert.deepEqual(
    older.ownerFollowUps.map(({ messageId }) => messageId),
    ["before-newer", "shared-follow-up"],
  );
  assert.deepEqual(
    newer.ownerFollowUps.map(({ messageId }) => messageId),
    ["shared-follow-up"],
  );
  assert.equal(older.ambient.length, 0);
  assert.equal(newer.ambient.length, 0);
  assert.equal(coordinator.activeTurnCount, 2);
});

test("owner follow-ups and ambient chat are separated without losing stable order", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 1 });
  coordinator.startTurn({ turnId: "turn", ownerSenderId: "alice" });
  coordinator.routeMessage(message("ambient-1", "bob"));
  coordinator.routeMessage(message("owner-1", "alice"));
  coordinator.routeMessage(message("ambient-2", "carol"));

  const fold = drain(coordinator, "turn", "tool");

  assert.deepEqual(
    fold.messages.map(({ messageId, route }) => [messageId, route]),
    [
      ["ambient-1", "ambient"],
      ["owner-1", "owner_follow_up"],
      ["ambient-2", "ambient"],
    ],
  );
  assert.deepEqual(
    fold.ownerFollowUps.map(({ messageId }) => messageId),
    ["owner-1"],
  );
  assert.deepEqual(
    fold.ambient.map(({ messageId }) => messageId),
    ["ambient-1", "ambient-2"],
  );
  assert.equal(fold.boundary, "tool");
});

test("folds preserve sender names for reply context", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 1 });
  coordinator.startTurn({ turnId: "turn", ownerSenderId: "alice-id" });
  coordinator.routeMessage({
    messageId: "follow-up",
    senderId: "alice-id",
    senderName: "alice_user",
    text: "и ещё вот это",
  });

  assert.equal(drain(coordinator, "turn").ownerFollowUps[0]?.senderName, "alice_user");
});

test("completing one turn cannot clear or stop another turn", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 2 });
  coordinator.startTurn({ turnId: "done", ownerSenderId: "alice" });
  coordinator.startTurn({ turnId: "live", ownerSenderId: "bob" });
  coordinator.routeMessage(message("shared", "carol"));

  assert.deepEqual(coordinator.completeTurn("done"), {
    status: "completed",
    turnId: "done",
    discardedMessages: 1,
  });
  assert.equal(coordinator.activeTurnCount, 1);
  assert.equal(coordinator.getTurn("live")?.queuedMessages, 1);

  coordinator.routeMessage(message("after-completion", "bob"));
  assert.deepEqual(foldIds(coordinator, "live"), [
    "shared",
    "after-completion",
  ]);
  assert.deepEqual(coordinator.drainAtBoundary("done", "model"), {
    status: "not_found",
    turnId: "done",
    boundary: "model",
  });
});

test("message ids are deduplicated globally and folded in watermark order", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 1 });
  coordinator.startTurn({ turnId: "turn", ownerSenderId: "alice" });

  const first = coordinator.routeMessage(message("id-1", "bob"));
  const duplicate = coordinator.routeMessage({
    messageId: "id-1",
    senderId: "alice",
    text: "different retry payload",
  });
  coordinator.routeMessage(message("id-2", "bob"));

  assert.equal(first.status, "routed");
  assert.deepEqual(duplicate, {
    status: "duplicate",
    messageId: "id-1",
    watermark: first.watermark,
    deliveredToTurnIds: [],
  });
  const fold = drain(coordinator, "turn");
  assert.deepEqual(
    fold.messages.map(({ messageId, watermark }) => [messageId, watermark]),
    [
      ["id-1", 1],
      ["id-2", 2],
    ],
  );
});

test("durable replay reaches a later turn even when an older turn already saw it", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 2 });
  coordinator.startTurn({ turnId: "older", ownerSenderId: "alice" });
  coordinator.routeMessage({
    messageId: "durable-after-trigger",
    senderId: "bob",
    senderName: "bob_user",
    text: "сообщение уже прошло через live routing",
  });
  coordinator.startTurn({ turnId: "later", ownerSenderId: "bob" });

  assert.deepEqual(
    coordinator.seedTurnReplay("later", [
      {
        messageId: "durable-after-trigger",
        senderId: "bob",
        senderName: "bob_user",
        text: "сообщение уже прошло через live routing",
      },
      {
        messageId: "durable-after-trigger",
        senderId: "bob",
        senderName: "bob_user",
        text: "duplicate in the same replay",
      },
    ]),
    {
      status: "seeded",
      turnId: "later",
      addedMessageIds: ["durable-after-trigger"],
      duplicateMessageIds: ["durable-after-trigger"],
    },
  );

  assert.deepEqual(
    drain(coordinator, "later").ownerFollowUps.map(
      ({ messageId, text, senderName }) => [messageId, text, senderName],
    ),
    [
      [
        "durable-after-trigger",
        "сообщение уже прошло через live routing",
        "bob_user",
      ],
    ],
  );
  assert.deepEqual(coordinator.seedTurnReplay("missing", []), {
    status: "not_found",
    turnId: "missing",
    addedMessageIds: [],
    duplicateMessageIds: [],
  });
});

test("message dedupe memory is bounded for a long-lived daemon", () => {
  const coordinator = new TurnCoordinator({
    maxActiveTurns: 1,
    maxSeenMessageIds: 2,
  });
  coordinator.startTurn({ turnId: "turn", ownerSenderId: "alice" });

  coordinator.routeMessage(message("id-1", "bob"));
  coordinator.routeMessage(message("id-2", "bob"));
  coordinator.routeMessage(message("id-3", "bob"));

  assert.equal(coordinator.routeMessage(message("id-2", "bob")).status, "duplicate");
  assert.equal(coordinator.routeMessage(message("id-1", "bob")).status, "routed");
});

test("a boundary drains at most 20 messages and leaves the rest on that turn", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 1 });
  coordinator.startTurn({ turnId: "turn", ownerSenderId: "alice" });
  for (let index = 1; index <= 25; index += 1) {
    coordinator.routeMessage(message(`id-${index}`, "bob", "x"));
  }

  const first = drain(coordinator, "turn");
  assert.equal(first.messages.length, 20);
  assert.equal(first.totalChars, 20);
  assert.equal(first.remainingMessages, 5);
  assert.deepEqual(
    first.messages.map(({ messageId }) => messageId),
    Array.from({ length: 20 }, (_, index) => `id-${index + 1}`),
  );

  const second = drain(coordinator, "turn", "tool");
  assert.deepEqual(
    second.messages.map(({ messageId }) => messageId),
    ["id-21", "id-22", "id-23", "id-24", "id-25"],
  );
  assert.equal(second.remainingMessages, 0);
});

test("a boundary caps text at 4000 Unicode characters without splitting an emoji", () => {
  const coordinator = new TurnCoordinator({ maxActiveTurns: 1 });
  coordinator.startTurn({ turnId: "turn", ownerSenderId: "alice" });
  coordinator.routeMessage(message("long", "bob", `${"x".repeat(3_999)}😀z`));
  coordinator.routeMessage(message("later", "bob", "kept for next fold"));

  const first = drain(coordinator, "turn");
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0]?.text, `${"x".repeat(3_999)}😀`);
  assert.equal(first.messages[0]?.truncated, true);
  assert.equal(first.totalChars, 4_000);
  assert.equal(first.remainingMessages, 1);

  assert.deepEqual(foldIds(coordinator, "turn"), ["later"]);
});

test("capacity produces an explicit refusal or caller-queue signal", () => {
  const refused = new TurnCoordinator({
    maxActiveTurns: 1,
    capacityPolicy: "refuse",
  });
  refused.startTurn({ turnId: "active", ownerSenderId: "alice" });
  assert.equal(refused.availableTurnSlots, 0);
  assert.deepEqual(
    refused.startTurn({ turnId: "next", ownerSenderId: "bob" }),
    {
      accepted: false,
      status: "refused",
      reason: "max_active_turns",
      turnId: "next",
      maxActiveTurns: 1,
      activeTurnIds: ["active"],
    },
  );

  const queued = new TurnCoordinator({
    maxActiveTurns: 1,
    capacityPolicy: "queue",
  });
  queued.startTurn({ turnId: "active", ownerSenderId: "alice" });
  assert.equal(
    queued.startTurn({ turnId: "next", ownerSenderId: "bob" }).status,
    "queue",
  );
  assert.equal(queued.getTurn("next"), undefined);
});

test("every emitted trace event is correlated with a turn id", () => {
  const events: TurnTraceEvent[] = [];
  const coordinator = new TurnCoordinator({
    maxActiveTurns: 1,
    onTrace: (event) => events.push(event),
  });

  coordinator.startTurn({ turnId: "turn", ownerSenderId: "alice" });
  coordinator.routeMessage(message("message", "bob"));
  coordinator.drainAtBoundary("turn", "model");
  coordinator.startTurn({ turnId: "overflow", ownerSenderId: "carol" });
  coordinator.completeTurn("turn");

  assert.ok(events.length > 0);
  assert.ok(events.every(({ turnId }) => turnId.length > 0));
  assert.deepEqual(
    events.map(({ event, turnId }) => [event, turnId]),
    [
      ["turn.started", "turn"],
      ["turn.message_routed", "turn"],
      ["turn.fold_drained", "turn"],
      ["turn.admission_rejected", "overflow"],
      ["turn.completed", "turn"],
    ],
  );
});

function message(
  messageId: string,
  senderId: string,
  text = messageId,
) {
  return { messageId, senderId, text };
}

function drain(
  coordinator: TurnCoordinator,
  turnId: string,
  boundary: "model" | "tool" = "model",
) {
  const result = coordinator.drainAtBoundary(turnId, boundary);
  assert.equal(result.status, "drained");
  return result.fold;
}

function foldIds(coordinator: TurnCoordinator, turnId: string): string[] {
  return drain(coordinator, turnId).messages.map(({ messageId }) => messageId);
}

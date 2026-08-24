import assert from "node:assert/strict";
import { test } from "node:test";
import { BotUpdateProcessor } from "../src/bot/runtime.js";
import type { NewsBriefTriggerPort } from "../src/bot/runtime/contracts.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import {
  TELEGRAM_OPTIONS,
  CHAT_ID,
  makeStore,
  messageUpdate,
} from "./support/bot-runtime.js";

function fakeTrigger(handles: boolean): {
  calls: Array<{
    chatId: string;
    messageId: number;
    senderId: string | undefined;
    text: string;
  }>;
  port: NewsBriefTriggerPort;
} {
  const calls: Array<{
    chatId: string;
    messageId: number;
    senderId: string | undefined;
    text: string;
  }> = [];
  return {
    calls,
    port: {
      tryTrigger(message) {
        calls.push(message);
        return handles;
      },
    },
  };
}

test("a matched news-brief trigger consumes the update instead of routing a model turn", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  let routeCalls = 0;
  const originalRoute = coordinator.routeMessage.bind(coordinator);
  coordinator.routeMessage = (params) => {
    routeCalls += 1;
    return originalRoute(params);
  };
  const { calls, port } = fakeTrigger(true);
  const processor = new BotUpdateProcessor({
    store,
    coordinators: new Map([[CHAT_ID, coordinator]]),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
    newsBriefTrigger: port,
  });

  const result = processor.process(
    messageUpdate(100, 500, {
      text: "@ParilkaBot daily news-brief",
      entities: [{ type: "mention", offset: 0, length: "@ParilkaBot".length }],
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.chatId, CHAT_ID);
  assert.equal(calls[0]!.messageId, 500);
  assert.equal(calls[0]!.senderId, "42");
  assert.equal(routeCalls, 0);
  assert.equal(result.acknowledged, true);
  if (result.acknowledged) {
    assert.equal(result.routed, false);
  }
});

test("an unmatched trigger falls through to normal routing", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  let routeCalls = 0;
  const originalRoute = coordinator.routeMessage.bind(coordinator);
  coordinator.routeMessage = (params) => {
    routeCalls += 1;
    return originalRoute(params);
  };
  const { port } = fakeTrigger(false);
  const processor = new BotUpdateProcessor({
    store,
    coordinators: new Map([[CHAT_ID, coordinator]]),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
    newsBriefTrigger: port,
  });

  const result = processor.process(
    messageUpdate(100, 500, {
      text: "@ParilkaBot привет",
      entities: [{ type: "mention", offset: 0, length: "@ParilkaBot".length }],
    }),
  );

  assert.equal(routeCalls, 1);
  assert.equal(result.acknowledged, true);
  if (result.acknowledged) {
    assert.equal(result.routed, true);
  }
});

test("an unaddressed message is never offered to the trigger port at all", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  const { calls, port } = fakeTrigger(true);
  const processor = new BotUpdateProcessor({
    store,
    coordinators: new Map([[CHAT_ID, coordinator]]),
    workNotifier: { notify() {} },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
    newsBriefTrigger: port,
  });

  // No mention/reply-to-bot -> not addressed, so this must never reach the
  // trigger port even if it would otherwise say "daily news-brief".
  processor.process(messageUpdate(100, 500, { text: "daily news-brief" }));

  assert.equal(calls.length, 0);
});

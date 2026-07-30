import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotUpdateProcessor } from "../src/bot/runtime.js";
import { TurnCoordinator } from "../src/bot/turn-coordinator.js";
import { MessageStore } from "../src/store.js";
import {
  TELEGRAM_OPTIONS,
  addressedUpdate,
  makeStore,
  message,
  messageUpdate,
  processorFor,
} from "./support/bot-runtime.js";

test("processor commits/reserves before ACK, routes messages, and keeps edits out of folds", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  let notifications = 0;
  let nowMs = 1_000;
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: {
      notify() {
        notifications += 1;
      },
    },
    telegram: TELEGRAM_OPTIONS,
    now: () => nowMs,
  });

  const addressed = processor.process(
    messageUpdate(100, 500, {
      text: "@ParilkaBot привет",
      entities: [
        {
          type: "mention",
          offset: 0,
          length: "@ParilkaBot".length,
        },
      ],
    }),
  );
  nowMs += 100;
  const ambient = processor.process(
    messageUpdate(101, 501, { text: "обычная реплика" }),
  );
  const watermarkBeforeEdit = coordinator.watermark;
  nowMs += 100;
  const edited = processor.process({
    update_id: 102,
    edited_message: message(501, {
      text: "@ParilkaBot отредактировано",
      entities: [
        {
          type: "mention",
          offset: 0,
          length: "@ParilkaBot".length,
        },
      ],
    }),
  });

  assert.deepEqual(addressed, {
    acknowledged: true,
    ackUpdateId: 100,
    disposition: "ingested",
    turnReserved: true,
    routed: true,
  });
  assert.equal(ambient.acknowledged, true);
  assert.equal(ambient.turnReserved, false);
  assert.equal(edited.acknowledged, true);
  assert.equal(edited.turnReserved, false);
  assert.equal(edited.routed, false);
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(store.getBotUpdate(100)?.status, "queued");
  assert.equal(store.getBotUpdate(102)?.status, "skipped");
  assert.equal(
    store.getMessagesByIds({
      chatId: TELEGRAM_OPTIONS.allowedChatId,
      messageIds: [501],
    })[0]?.text,
    "@ParilkaBot отредактировано",
  );
  assert.equal(coordinator.watermark, watermarkBeforeEdit);
  assert.equal(coordinator.watermark, 2);
  assert.equal(notifications, 1);
});

test("redelivered committed update wakes durable work without routing a duplicate fold", (t) => {
  const store = makeStore(t);
  const coordinator = new TurnCoordinator({ maxActiveTurns: 3 });
  let notifications = 0;
  const processor = new BotUpdateProcessor({
    store,
    coordinator,
    workNotifier: {
      notify() {
        notifications += 1;
      },
    },
    telegram: TELEGRAM_OPTIONS,
    now: () => 1_000,
  });
  const update = addressedUpdate(150, 550);

  const first = processor.process(update);
  const watermarkAfterCommit = coordinator.watermark;
  const redelivery = processor.process(update);

  assert.equal(first.disposition, "ingested");
  assert.equal(first.routed, true);
  assert.equal(redelivery.disposition, "duplicate");
  assert.equal(redelivery.turnReserved, true);
  assert.equal(redelivery.routed, false);
  assert.equal(coordinator.watermark, watermarkAfterCommit);
  assert.equal(coordinator.watermark, 1);
  assert.equal(store.queryBotTurns().length, 1);
  assert.equal(notifications, 2);
});

test("five-second per-sender trigger debounce survives process restart", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-runtime-cooldown-"),
  );
  const dbPath = join(directory, "cache.sqlite");
  try {
    let store = new MessageStore(dbPath);
    let nowMs = 10_000;
    let processor = processorFor(store, () => nowMs);

    const first = processor.process(addressedUpdate(200, 600));
    nowMs = 12_000;
    const throttled = processor.process(
      addressedUpdate(201, 601),
    );

    assert.equal(first.turnReserved, true);
    assert.equal(throttled.turnReserved, false);
    assert.equal(store.getBotUpdate(201)?.addressed, true);
    assert.equal(store.getBotUpdate(201)?.status, "skipped");
    assert.match(store.getBotUpdate(201)?.error ?? "", /cooldown/u);
    assert.equal(store.queryBotTurns().length, 1);
    store.close();

    store = new MessageStore(dbPath);
    nowMs = 15_000;
    processor = processorFor(store, () => nowMs);
    const afterRestart = processor.process(
      addressedUpdate(202, 602),
    );

    assert.equal(afterRestart.turnReserved, true);
    assert.equal(store.queryBotTurns().length, 2);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { runDigestGeneration } from "../src/digests.js";
import {
  CHAT_ID,
  NOW,
  FakeSummaryPort,
  generate,
  makeStore,
  message,
  seedMessages,
} from "./digest-generation-fixtures.js";

test("a changed day source is rechecked after model work and never committed", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "До модели"),
  ]);
  let changed = false;
  const summary = new FakeSummaryPort(
    () => false,
    (request) => {
      if (!changed && request.kind === "day") {
        changed = true;
        seedMessages(store, [
          message(
            1,
            "2026-07-29T08:00:00.000Z",
            "Alice",
            "Изменено во время модели",
          ),
        ]);
      }
    },
  );

  const report = await generate(store, summary);

  assert.equal(report.days.failed, 1);
  assert.equal(
    report.days.items[0]?.error?.code,
    "source_changed_during_generation",
  );
  assert.deepEqual(store.listDayDigests(CHAT_ID), []);
  assert.equal(summary.count("week"), 0);
});

test("a changed weekly source is rechecked and invalidates its stale day", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "До weekly"),
  ]);
  let changed = false;
  const summary = new FakeSummaryPort(
    () => false,
    (request) => {
      if (!changed && request.kind === "week") {
        changed = true;
        seedMessages(store, [
          message(
            1,
            "2026-07-29T08:00:00.000Z",
            "Alice",
            "Изменено во время weekly",
          ),
        ]);
      }
    },
  );

  const report = await generate(store, summary);

  assert.equal(report.days.generated, 1);
  assert.equal(report.days.invalidated, 1);
  assert.equal(report.weeks.failed, 1);
  assert.equal(
    report.weeks.items[0]?.error?.code,
    "source_changed_during_generation",
  );
  assert.deepEqual(store.listDayDigests(CHAT_ID), []);
  assert.deepEqual(
    store.getDigestRollups({
      chatId: CHAT_ID,
      kind: "week",
      dayFrom: "2026-07-27",
      dayTo: "2026-08-02",
    }),
    [],
  );
});

test("one failed day is isolated and later days still commit", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-27T08:00:00.000Z", "Alice", "Сломанный день"),
    message(2, "2026-07-28T08:00:00.000Z", "Bob", "Рабочий день"),
  ]);
  const summary = new FakeSummaryPort((request) =>
    request.kind === "day" && request.period === "2026-07-27",
  );

  const report = await generate(store, summary);

  assert.equal(report.days.failed, 1);
  assert.equal(report.days.generated, 1);
  assert.equal(report.weeks.generated, 0);
  assert.equal(report.weeks.skipped, 1);
  assert.equal(report.weeks.items[0]?.reason, "day_incomplete");
  assert.equal(
    store.getDayDigests({
      chatId: CHAT_ID,
      dayFrom: "2026-07-27",
      dayTo: "2026-07-27",
    }).length,
    0,
  );
  assert.equal(
    store.getDayDigests({
      chatId: CHAT_ID,
      dayFrom: "2026-07-28",
      dayTo: "2026-07-28",
    }).length,
    1,
  );
});

test("a transient day regeneration failure preserves legacy day and week rows", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "Сохранить старую сводку"),
  ]);
  await generate(store, new FakeSummaryPort());

  const dayBefore = store.listDayDigests(CHAT_ID)[0]!;
  store.upsertDayDigest({
    ...dayBefore,
    promptVersion: "legacy-day-prompt",
    createdAtMs: dayBefore.createdAtMs + 1,
  });
  const storedDay = store.listDayDigests(CHAT_ID)[0]!;
  const storedWeek = store.getDigestRollups({
    chatId: CHAT_ID,
    kind: "week",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
  })[0]!;

  const report = await generate(
    store,
    new FakeSummaryPort((request) => request.kind === "day"),
  );

  assert.equal(report.days.failed, 1);
  assert.equal(report.days.invalidated, 0);
  assert.equal(report.weeks.skipped, 1);
  assert.equal(report.weeks.items[0]?.reason, "generation_failed");
  assert.deepEqual(store.listDayDigests(CHAT_ID)[0], storedDay);
  assert.deepEqual(
    store.getDigestRollups({
      chatId: CHAT_ID,
      kind: "week",
      dayFrom: "2026-07-27",
      dayTo: "2026-08-02",
    })[0],
    storedWeek,
  );
});

test("a transient week regeneration failure preserves the legacy rollup", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "Сохранить старый rollup"),
  ]);
  await generate(store, new FakeSummaryPort());

  const weekBefore = store.getDigestRollups({
    chatId: CHAT_ID,
    kind: "week",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
  })[0]!;
  store.upsertDigestRollup({
    ...weekBefore,
    promptVersion: "legacy-week-prompt",
    createdAtMs: weekBefore.createdAtMs + 1,
  });
  const storedWeek = store.getDigestRollups({
    chatId: CHAT_ID,
    kind: "week",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
  })[0]!;

  const report = await generate(
    store,
    new FakeSummaryPort((request) => request.kind === "week"),
  );

  assert.equal(report.days.unchanged, 1);
  assert.equal(report.weeks.failed, 1);
  assert.deepEqual(
    store.getDigestRollups({
      chatId: CHAT_ID,
      kind: "week",
      dayFrom: "2026-07-27",
      dayTo: "2026-08-02",
    })[0],
    storedWeek,
  );
});

test("current Moscow day is skipped by default", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T10:00:00.000Z", "Alice", "Вчера"),
    // 21:00Z is midnight of the next day in Europe/Moscow.
    message(2, "2026-07-29T21:00:00.000Z", "Bob", "Сегодня"),
  ]);
  const summary = new FakeSummaryPort();

  const report = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    now: () => NOW,
  });

  assert.equal(report.days.planned, 1);
  assert.equal(report.days.skipped, 1);
  assert.equal(
    report.days.items.find(
      ({ status }) => status === "skipped_current",
    )?.period,
    "2026-07-30",
  );
  assert.equal(summary.requests.length, 0);

  const manualAll = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    all: true,
    now: () => NOW,
  });
  assert.equal(manualAll.days.planned, 2);
  assert.equal(manualAll.days.skipped, 0);
});

test("day input keeps sender attribution and provider attribution is stored", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    {
      ...message(
        1,
        "2026-07-29T08:00:00.000Z",
        "Alice",
        "Предлагаю оставить TypeScript",
      ),
      senderId: "42",
    },
  ]);
  const summary = new FakeSummaryPort();

  await generate(store, summary);

  const dayRequest = summary.requests.find(({ kind }) => kind === "day");
  assert.match(dayRequest?.sourceText ?? "", /"id":"42"/u);
  assert.match(dayRequest?.sourceText ?? "", /"name":"Alice"/u);
  assert.match(
    dayRequest?.sourceText ?? "",
    /Предлагаю оставить TypeScript/u,
  );
  const stored = store.getDayDigests({
    chatId: CHAT_ID,
    dayFrom: "2026-07-29",
    dayTo: "2026-07-29",
  })[0];
  assert.equal(stored?.model, "secondary:summary-model");
});

test("oversized input fails explicitly without truncation or a model call", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(
      1,
      "2026-07-29T08:00:00.000Z",
      "Alice",
      "x".repeat(2_000),
    ),
  ]);
  const summary = new FakeSummaryPort();

  const report = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort: summary,
    now: () => NOW,
    maxInputChars: 1_000,
  });

  assert.equal(report.days.failed, 1);
  assert.equal(report.days.items[0]?.error?.code, "input_too_large");
  assert.equal(summary.requests.length, 0);
  assert.equal(store.listDayDigests(CHAT_ID).length, 0);
});

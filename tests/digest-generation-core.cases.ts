import assert from "node:assert/strict";
import test from "node:test";
import {
  DAY_DIGEST_PROMPT_VERSION,
  WEEK_DIGEST_PROMPT_VERSION,
  runDigestGeneration,
} from "../src/digests.js";
import {
  CHAT_ID,
  NOW,
  FakeSummaryPort,
  generate,
  makeStore,
  message,
  seedMessages,
} from "./digest-generation-fixtures.js";

test("dry-run plans missing days without model calls or digest writes", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "Первая тема"),
  ]);
  const summary = new FakeSummaryPort();

  const report = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: false,
    summaryPort: summary,
    now: () => NOW,
  });

  assert.equal(report.mode, "dry_run");
  assert.equal(report.days.planned, 1);
  assert.equal(report.days.generated, 0);
  assert.equal(report.weeks.generated, 0);
  assert.equal(summary.requests.length, 0);
  assert.deepEqual(
    store.getDayDigests({
      chatId: CHAT_ID,
      dayFrom: "2026-07-29",
      dayTo: "2026-07-29",
    }),
    [],
  );
});

test("apply is idempotent and current ISO week is built from completed days", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "Решили задачу"),
  ]);
  const summary = new FakeSummaryPort();

  const first = await generate(store, summary);
  assert.equal(first.days.generated, 1);
  assert.equal(first.weeks.generated, 1);
  assert.deepEqual(
    summary.requests.map(({ kind, period }) => [kind, period]),
    [
      ["day", "2026-07-29"],
      ["week", "2026-W31"],
    ],
  );

  const second = await generate(store, summary);
  assert.equal(second.days.unchanged, 1);
  assert.equal(second.weeks.unchanged, 1);
  assert.equal(second.days.generated, 0);
  assert.equal(second.weeks.generated, 0);
  assert.equal(summary.requests.length, 2);
});

test("a stored day regenerates only after 25 messages beyond its stored end", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-28T08:00:00.000Z", "Alice", "Начало"),
  ]);
  const summary = new FakeSummaryPort();
  await generate(store, summary);
  const initialDayCalls = summary.count("day");

  seedMessages(
    store,
    Array.from({ length: 24 }, (_, index) =>
      message(
        index + 2,
        `2026-07-28T08:00:${String(index + 1).padStart(2, "0")}.000Z`,
        "Bob",
        `Дополнение ${index + 1}`,
      ),
    ),
  );
  const belowThreshold = await generate(store, summary);
  assert.equal(belowThreshold.days.generated, 0);
  assert.equal(
    belowThreshold.days.items.find(
      ({ period }) => period === "2026-07-28",
    )?.appendedAfterStoredEnd,
    24,
  );
  assert.equal(summary.count("day"), initialDayCalls);

  seedMessages(store, [
    message(26, "2026-07-28T08:01:00.000Z", "Bob", "Порог"),
  ]);
  const stale = await generate(store, summary);
  assert.equal(stale.days.generated, 1);
  assert.equal(
    stale.days.items.find(
      ({ period }) => period === "2026-07-28",
    )?.appendedAfterStoredEnd,
    25,
  );
  assert.equal(summary.count("day"), initialDayCalls + 1);
  assert.equal(stale.weeks.generated, 1);
});

test("editing a historical message regenerates its day immediately without new IDs", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(
      1,
      "2026-07-28T08:00:00.000Z",
      "Alice",
      "Исходный текст",
    ),
  ]);
  const summary = new FakeSummaryPort();
  await generate(store, summary);
  const initialDayCalls = summary.count("day");
  const initialWeekCalls = summary.count("week");

  seedMessages(store, [
    message(
      1,
      "2026-07-28T08:00:00.000Z",
      "Alice",
      "Исправленный текст",
    ),
  ]);
  const report = await generate(store, summary);

  assert.equal(report.days.generated, 1);
  assert.equal(report.days.items[0]?.reason, "source_changed");
  assert.equal(report.days.items[0]?.appendedAfterStoredEnd, 0);
  assert.equal(report.weeks.generated, 1);
  assert.equal(summary.count("day"), initialDayCalls + 1);
  assert.equal(summary.count("week"), initialWeekCalls + 1);
});

test("partially deleting a historical day regenerates day and week immediately", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-28T08:00:00.000Z", "Alice", "Удалить"),
    message(2, "2026-07-28T08:01:00.000Z", "Bob", "Оставить"),
  ]);
  const summary = new FakeSummaryPort();
  await generate(store, summary);
  const initialDayCalls = summary.count("day");
  const initialWeekCalls = summary.count("week");

  assert.equal(store.markMessagesDeleted(CHAT_ID, [1]), 1);
  const report = await generate(store, summary);

  assert.equal(report.days.generated, 1);
  assert.equal(report.days.items[0]?.reason, "source_changed");
  assert.equal(report.days.items[0]?.appendedAfterStoredEnd, 0);
  assert.equal(report.weeks.generated, 1);
  assert.equal(summary.count("day"), initialDayCalls + 1);
  assert.equal(summary.count("week"), initialWeekCalls + 1);
  assert.equal(store.listDayDigests(CHAT_ID)[0]?.messageCount, 1);
});

test("a stale day blocks and invalidates its dependent weekly rollup", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-28T08:00:00.000Z", "Alice", "Начало"),
  ]);
  const summary = new FakeSummaryPort();
  await generate(store, summary);

  seedMessages(store, [
    message(2, "2026-07-28T08:01:00.000Z", "Bob", "Одно дополнение"),
  ]);
  const report = await generate(store, summary);

  assert.equal(report.days.generated, 0);
  assert.equal(report.weeks.generated, 0);
  assert.equal(report.weeks.invalidated, 1);
  assert.equal(report.weeks.items[0]?.reason, "day_incomplete");
  assert.equal(summary.count("week"), 1);
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

test("deleting the last source message invalidates persisted day and week even with all", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "Последнее сообщение"),
  ]);
  const summary = new FakeSummaryPort();
  await generate(store, summary);
  const requestCount = summary.requests.length;

  assert.equal(store.markMessagesDeleted(CHAT_ID, [1]), 1);
  const report = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    all: true,
    summaryPort: summary,
    now: () => NOW,
  });

  assert.equal(report.days.invalidated, 1);
  assert.equal(report.days.items[0]?.reason, "source_deleted");
  assert.equal(report.weeks.invalidated, 1);
  assert.equal(summary.requests.length, requestCount);
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

test("weekly source hash invalidates when an input day digest changes", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-27T08:00:00.000Z", "Alice", "Понедельник"),
    message(2, "2026-07-28T08:00:00.000Z", "Bob", "Вторник"),
  ]);
  const summary = new FakeSummaryPort();

  const first = await generate(store, summary);
  assert.equal(first.weeks.generated, 1);
  const firstHash = store.getDigestRollups({
    chatId: CHAT_ID,
    kind: "week",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
  })[0]?.sourceHash;

  const tuesday = store.getDayDigests({
    chatId: CHAT_ID,
    dayFrom: "2026-07-28",
    dayTo: "2026-07-28",
  })[0]!;
  store.upsertDayDigest({
    ...tuesday,
    text: "Вторник: уточнённая сводка",
    createdAtMs: 3,
  });
  const second = await generate(store, summary);
  const revised = store.getDigestRollups({
    chatId: CHAT_ID,
    kind: "week",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
  })[0];

  assert.equal(second.weeks.generated, 1);
  assert.notEqual(revised?.sourceHash, firstHash);
  assert.equal(summary.count("week"), 2);
});

test("prompt version mismatches invalidate both day and weekly digests", async (t) => {
  const { store } = makeStore(t);
  seedMessages(store, [
    message(1, "2026-07-29T08:00:00.000Z", "Alice", "Версия промпта"),
  ]);
  const summary = new FakeSummaryPort();
  await generate(store, summary);

  const day = store.listDayDigests(CHAT_ID)[0]!;
  store.upsertDayDigest({
    ...day,
    promptVersion: "obsolete-day-prompt",
    createdAtMs: day.createdAtMs + 1,
  });
  const regeneratedDay = await generate(store, summary);
  assert.equal(regeneratedDay.days.generated, 1);
  assert.equal(regeneratedDay.days.items[0]?.reason, "prompt_changed");
  assert.equal(
    store.listDayDigests(CHAT_ID)[0]?.promptVersion,
    DAY_DIGEST_PROMPT_VERSION,
  );

  const week = store.getDigestRollups({
    chatId: CHAT_ID,
    kind: "week",
    dayFrom: "2026-07-27",
    dayTo: "2026-08-02",
  })[0]!;
  store.upsertDigestRollup({
    ...week,
    promptVersion: "obsolete-week-prompt",
    createdAtMs: week.createdAtMs + 1,
  });
  const regeneratedWeek = await generate(store, summary);
  assert.equal(regeneratedWeek.days.unchanged, 1);
  assert.equal(regeneratedWeek.weeks.generated, 1);
  assert.equal(regeneratedWeek.weeks.items[0]?.reason, "prompt_changed");
  assert.equal(
    store.getDigestRollups({
      chatId: CHAT_ID,
      kind: "week",
      dayFrom: "2026-07-27",
      dayTo: "2026-08-02",
    })[0]?.promptVersion,
    WEEK_DIGEST_PROMPT_VERSION,
  );
});


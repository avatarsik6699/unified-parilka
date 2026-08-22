import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_MAX_DAY_GENERATIONS_PER_RUN,
  DEFAULT_MAX_WEEK_GENERATIONS_PER_RUN,
  MAX_DAY_GENERATIONS_PER_RUN,
  MAX_WEEK_GENERATIONS_PER_RUN,
  runDigestGeneration,
  type DigestSummaryPort,
  type DigestSummaryRequest,
  type DigestSummaryResult,
} from "../src/digests.js";
import {
  CliConfigError,
  parseOptions,
} from "../src/digest-cli/options.js";
import { compactDigestReport } from "../src/digest-cli/run.js";
import {
  MessageStore,
  type StoredMessage,
} from "../src/store.js";

const CHAT_ID = "-1001234567890";
const NOW = new Date("2026-07-30T09:00:00.000Z");

test("dry-run plans the full backlog regardless of apply limits", async (t) => {
  const { store } = makeStore(t);
  seedDays(store, [
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
  ]);
  const summary = new TrackingSummaryPort();

  const report = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    now: () => NOW,
    summaryPort: summary,
    maxDayGenerationsPerRun: 0,
    maxWeekGenerationsPerRun: 0,
  });

  assert.equal(report.mode, "dry_run");
  assert.deepEqual(report.options, {
    all: false,
    maxDayGenerationsPerRun: 0,
    maxWeekGenerationsPerRun: 0,
  });
  assert.equal(report.days.planned, 5);
  assert.equal(report.days.deferred, 0);
  assert.equal(report.days.providerCalls, 0);
  assert.equal(summary.requests.length, 0);
  const compact = compactDigestReport(report);
  assert.equal("items" in compact.days, false);
  assert.deepEqual(compact.days.generatedPeriods, []);
  assert.deepEqual(compact.days.failures, []);
});

test("bounded day apply is newest-first, preserves deferred legacy rows, and progresses", async (t) => {
  const { store } = makeStore(t);
  const days = Array.from(
    { length: 10 },
    (_, index) => `2026-07-${String(index + 20).padStart(2, "0")}`,
  );
  seedDays(store, days);
  await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort: new TrackingSummaryPort(),
    now: () => NOW,
    maxDayGenerationsPerRun: 31,
    maxWeekGenerationsPerRun: 8,
  });

  for (const digest of store.listDayDigests(CHAT_ID)) {
    store.upsertDayDigest({
      ...digest,
      promptVersion: "legacy-day-prompt",
      createdAtMs: digest.createdAtMs + 1,
    });
  }
  const legacyWeeks = listWeeks(store);
  for (const digest of legacyWeeks) {
    store.upsertDigestRollup({
      ...digest,
      promptVersion: "legacy-week-prompt",
      createdAtMs: digest.createdAtMs + 1,
    });
  }
  const legacyDayText = new Map(
    store
      .listDayDigests(CHAT_ID)
      .map((digest) => [digest.day, digest.text] as const),
  );
  const legacyWeekText = new Map(
    listWeeks(store).map(
      (digest) => [digest.period, digest.text] as const,
    ),
  );

  const firstPort = new TrackingSummaryPort();
  const first = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort: firstPort,
    now: () => NOW,
    maxDayGenerationsPerRun: 2,
    maxWeekGenerationsPerRun: 1,
  });

  assert.deepEqual(
    firstPort.requests.map(({ kind, period }) => [kind, period]),
    [
      ["day", "2026-07-29"],
      ["day", "2026-07-28"],
    ],
  );
  assert.equal(first.days.providerCalls, 2);
  assert.equal(first.days.generated, 2);
  assert.equal(first.days.deferred, 8);
  assert.equal(first.weeks.providerCalls, 0);
  assert.equal(first.weeks.deferred, 2);
  assert.equal(firstPort.maxConcurrent, 1);

  for (const item of first.days.items.filter(
    ({ status }) => status === "deferred",
  )) {
    assert.equal(item.reason, "run_limit");
    const stored = store.getDayDigests({
      chatId: CHAT_ID,
      dayFrom: item.period,
      dayTo: item.period,
      limit: 1,
    })[0];
    assert.equal(stored?.promptVersion, "legacy-day-prompt");
    assert.equal(stored?.text, legacyDayText.get(item.period));
  }
  for (const stored of listWeeks(store)) {
    assert.equal(stored.promptVersion, "legacy-week-prompt");
    assert.equal(stored.text, legacyWeekText.get(stored.period));
  }

  const secondPort = new TrackingSummaryPort();
  const second = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort: secondPort,
    now: () => NOW,
    maxDayGenerationsPerRun: 2,
    maxWeekGenerationsPerRun: 1,
  });

  assert.deepEqual(
    secondPort.requests
      .filter(({ kind }) => kind === "day")
      .map(({ period }) => period),
    ["2026-07-27", "2026-07-26"],
  );
  assert.equal(second.days.providerCalls, 2);
  assert.equal(second.days.deferred, 6);
  assert.deepEqual(
    secondPort.requests
      .filter(({ kind }) => kind === "week")
      .map(({ period }) => period),
    ["2026-W31"],
  );
  assert.equal(second.weeks.providerCalls, 1);
  assert.equal(secondPort.maxConcurrent, 1);
});

test("bounded week apply regenerates newest legacy rollups first", async (t) => {
  const { store } = makeStore(t);
  seedDays(store, [
    "2026-07-06",
    "2026-07-13",
    "2026-07-20",
    "2026-07-27",
  ]);
  await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort: new TrackingSummaryPort(),
    now: () => NOW,
    maxDayGenerationsPerRun: 31,
    maxWeekGenerationsPerRun: 8,
  });
  for (const digest of listWeeks(store)) {
    store.upsertDigestRollup({
      ...digest,
      promptVersion: "legacy-week-prompt",
      createdAtMs: digest.createdAtMs + 1,
    });
  }
  const legacyText = new Map(
    listWeeks(store).map(
      (digest) => [digest.period, digest.text] as const,
    ),
  );

  const firstPort = new TrackingSummaryPort();
  const first = await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort: firstPort,
    now: () => NOW,
    maxDayGenerationsPerRun: 0,
    maxWeekGenerationsPerRun: 1,
  });

  assert.deepEqual(
    firstPort.requests.map(({ kind, period }) => [kind, period]),
    [["week", "2026-W31"]],
  );
  assert.equal(first.weeks.providerCalls, 1);
  assert.equal(first.weeks.generated, 1);
  assert.equal(first.weeks.deferred, 3);
  for (const item of first.weeks.items.filter(
    ({ status }) => status === "deferred",
  )) {
    assert.equal(item.reason, "run_limit");
    const stored = listWeeks(store).find(
      ({ period }) => period === item.period,
    );
    assert.equal(stored?.promptVersion, "legacy-week-prompt");
    assert.equal(stored?.text, legacyText.get(item.period));
  }

  const secondPort = new TrackingSummaryPort();
  await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort: secondPort,
    now: () => NOW,
    maxDayGenerationsPerRun: 0,
    maxWeekGenerationsPerRun: 1,
  });
  assert.deepEqual(
    secondPort.requests.map(({ kind, period }) => [kind, period]),
    [["week", "2026-W30"]],
  );
});

test("digest CLI applies explicit overrides, safe defaults, and upper bounds", (t) => {
  const { dbPath } = makeStore(t);
  const required = ["--db", dbPath, "--chat", CHAT_ID];

  const defaults = parseOptions(required, {});
  assert.equal(defaults.summaryOnly, false);
  assert.equal(
    defaults.maxDayGenerationsPerRun,
    DEFAULT_MAX_DAY_GENERATIONS_PER_RUN,
  );
  assert.equal(
    defaults.maxWeekGenerationsPerRun,
    DEFAULT_MAX_WEEK_GENERATIONS_PER_RUN,
  );

  const overridden = parseOptions(
    [
      ...required,
      "--summary-only",
      "--max-day-generations-per-run",
      "2",
    ],
    {
      BOT_DIGEST_MAX_DAY_GENERATIONS_PER_RUN: "7",
      BOT_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN: "4",
    },
  );
  assert.equal(overridden.maxDayGenerationsPerRun, 2);
  assert.equal(overridden.maxWeekGenerationsPerRun, 4);
  assert.equal(overridden.summaryOnly, true);

  assert.throws(
    () =>
      parseOptions(required, {
        BOT_DIGEST_MAX_DAY_GENERATIONS_PER_RUN: String(
          MAX_DAY_GENERATIONS_PER_RUN + 1,
        ),
      }),
    (error: unknown) =>
      error instanceof CliConfigError &&
      error.code === "integer_out_of_range",
  );
  assert.throws(
    () =>
      parseOptions(required, {
        BOT_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN: String(
          MAX_WEEK_GENERATIONS_PER_RUN + 1,
        ),
      }),
    (error: unknown) =>
      error instanceof CliConfigError &&
      error.code === "integer_out_of_range",
  );
});

class TrackingSummaryPort implements DigestSummaryPort {
  readonly requests: DigestSummaryRequest[] = [];
  maxConcurrent = 0;
  #active = 0;

  async summarize(
    request: DigestSummaryRequest,
  ): Promise<DigestSummaryResult> {
    this.requests.push(request);
    this.#active += 1;
    this.maxConcurrent = Math.max(
      this.maxConcurrent,
      this.#active,
    );
    try {
      await Promise.resolve();
      return {
        text: `${request.kind}:${request.period}:generated`,
        model: "test:summary",
        providerId: "test",
        fallbackCount: 0,
      };
    } finally {
      this.#active -= 1;
    }
  }
}

function makeStore(t: TestContext): {
  store: MessageStore;
  dbPath: string;
} {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-digest-limits-"),
  );
  const dbPath = join(directory, "messages.sqlite");
  const store = new MessageStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, dbPath };
}

function seedDays(
  store: MessageStore,
  days: readonly string[],
): void {
  const messages: StoredMessage[] = days.map(
    (day, index) => ({
      chatId: CHAT_ID,
      messageId: index + 1,
      date: `${day}T08:00:00.000Z`,
      senderId: String(index + 1_000),
      senderName: "Alice",
      text: `Сообщение ${day}`,
    }),
  );
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Test",
      kind: "supergroup",
    },
    messages,
  );
}

function listWeeks(store: MessageStore) {
  return store.getDigestRollups({
    chatId: CHAT_ID,
    kind: "week",
    dayFrom: "2026-07-01",
    dayTo: "2026-08-02",
    limit: 100,
  });
}

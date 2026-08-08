import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { MessageStore, type StoredMessage } from "../src/store.js";
import {
  CanonicalBotReadCache,
  type BotVectorSearchPort,
} from "../src/bot/read-cache.js";
import { hashWeekSource } from "../src/digest/source.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "supergroup",
};

test("hybrid search applies the exclusive beforeId to BM25 and vector channels", async (t) => {
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "ключевое слово"),
    message(2, "семантический сосед"),
    message(3, "ещё один сосед"),
    message(4, "будущее сообщение"),
  ]);
  let capturedSearch: { chatId: string; beforeId?: number } | undefined;
  const vector: BotVectorSearchPort = {
    async search(params) {
      capturedSearch = { chatId: params.chatId, beforeId: params.beforeId };
      return { available: true, hits: [] };
    },
    hybrid() {
      return [];
    },
  };
  const cache = new CanonicalBotReadCache({ store, vector });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "ключевое",
    limit: 3,
    signal: new AbortController().signal,
    beforeId: 4,
  });

  assert.equal(result.mode, "hybrid");
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [1],
    "BM25 must never return rows at or above the beforeId",
  );
  assert.equal(capturedSearch?.beforeId, 4);
});

test("thread window never reaches the application-owned beforeId", (t) => {
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(10, "старое"),
    message(20, "центр"),
    message(30, "позже центра"),
    message(40, "будущее"),
  ]);
  const cache = new CanonicalBotReadCache({ store });

  const window = cache.getThreadContext({
    chatId: CHAT.chatId,
    messageId: 20,
    before: 15,
    after: 25,
    beforeId: 40,
  });

  assert.deepEqual(
    window.map(({ messageId }) => messageId),
    [10, 20, 30],
  );
});

test("day digests touching the trigger id are hidden, older ones survive", (t) => {
  const store = fixtureStore(t);
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-24",
    startMessageId: 1,
    endMessageId: 50,
    messageCount: 3,
    text: "Вчера",
    promptVersion: "v1",
  });
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-25",
    startMessageId: 51,
    endMessageId: 80,
    messageCount: 3,
    text: "Сегодня",
    promptVersion: "v1",
  });
  const cache = new CanonicalBotReadCache({ store });
  const query = {
    chatId: CHAT.chatId,
    dayFrom: "2026-07-24",
    dayTo: "2026-07-25",
    dayCount: 2,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-07-23T21:00:00.000Z",
    endExclusive: "2026-07-25T21:00:00.000Z",
    reversedInput: false,
    preferWeekly: false,
    sourceMessageId: 75,
  } as const;

  assert.deepEqual(cache.getDigests(query).digests, [
    {
      kind: "day",
      period: "2026-07-24",
      dayFrom: "2026-07-24",
      dayTo: "2026-07-24",
      text: "Вчера",
      startMessageId: 1,
      endMessageId: 50,
    },
  ]);
});

test("weekly rollups survive when their day-digest source is proven below the trigger", (t) => {
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    { ...message(10, "начало недели"), date: "2026-07-21T10:00:00.000Z" },
    { ...message(12, "конец недели"), date: "2026-07-22T10:00:00.000Z" },
  ]);
  const monday = store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-21",
    startMessageId: 10,
    endMessageId: 10,
    messageCount: 1,
    text: "Дневная сводка",
    promptVersion: "v1",
  });
  const tuesday = store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-22",
    startMessageId: 12,
    endMessageId: 12,
    messageCount: 1,
    text: "Дневная сводка 2",
    promptVersion: "v1",
  });
  store.upsertDigestRollup({
    chatId: CHAT.chatId,
    kind: "week",
    period: "2026-W30",
    dayFrom: "2026-07-20",
    dayTo: "2026-07-26",
    dayCount: 2,
    text: "Недельная сводка",
    promptVersion: "v1",
    sourceHash: hashWeekSource(CHAT.chatId, {
      period: "2026-W30",
      dayFrom: "2026-07-20",
      dayTo: "2026-07-26",
      digests: [monday, tuesday],
    }),
  });
  const cache = new CanonicalBotReadCache({ store });

  assert.deepEqual(cache.getDigests(weekQuery(90)).digests, [
    {
      kind: "week",
      period: "2026-W30",
      dayFrom: "2026-07-20",
      dayTo: "2026-07-26",
      text: "Недельная сводка",
    },
  ]);
});

test("weekly rollups without a sourceHash are hidden", (t) => {
  const store = fixtureStore(t);
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-20",
    startMessageId: 1,
    endMessageId: 50,
    messageCount: 3,
    text: "Воскресенье",
    promptVersion: "v1",
  });
  store.upsertDigestRollup({
    chatId: CHAT.chatId,
    kind: "week",
    period: "2026-W30",
    dayFrom: "2026-07-20",
    dayTo: "2026-07-26",
    dayCount: 7,
    text: "Недельная сводка",
    promptVersion: "v1",
  });
  const cache = new CanonicalBotReadCache({ store });

  assert.deepEqual(
    cache.getDigests(weekQuery(90)).digests,
    [
      {
        kind: "day",
        period: "2026-07-20",
        dayFrom: "2026-07-20",
        dayTo: "2026-07-20",
        text: "Воскресенье",
        startMessageId: 1,
        endMessageId: 50,
      },
    ],
    "a rollup without a provable source must fall back to day digests",
  );
});

test("weekly rollups with a stale sourceHash are hidden", (t) => {
  const store = fixtureStore(t);
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-20",
    startMessageId: 1,
    endMessageId: 50,
    messageCount: 3,
    text: "Воскресенье",
    promptVersion: "v1",
  });
  store.upsertDigestRollup({
    chatId: CHAT.chatId,
    kind: "week",
    period: "2026-W30",
    dayFrom: "2026-07-20",
    dayTo: "2026-07-26",
    dayCount: 7,
    text: "Недельная сводка",
    promptVersion: "v1",
    sourceHash: "0".repeat(64),
  });
  const cache = new CanonicalBotReadCache({ store });

  assert.deepEqual(
    cache.getDigests(weekQuery(90)).digests,
    [
      {
        kind: "day",
        period: "2026-07-20",
        dayFrom: "2026-07-20",
        dayTo: "2026-07-20",
        text: "Воскресенье",
        startMessageId: 1,
        endMessageId: 50,
      },
    ],
    "a rollup whose source hash no longer matches must fall back to day digests",
  );
});

test("weekly rollups are hidden when a day digest reaches the trigger", (t) => {
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    { ...message(10, "начало недели"), date: "2026-07-21T10:00:00.000Z" },
    { ...message(12, "конец недели"), date: "2026-07-22T10:00:00.000Z" },
  ]);
  const sunday = store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-20",
    startMessageId: 1,
    endMessageId: 50,
    messageCount: 3,
    text: "Воскресенье",
    promptVersion: "v1",
  });
  const monday = store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-21",
    startMessageId: 10,
    endMessageId: 95,
    messageCount: 3,
    text: "Понедельник",
    promptVersion: "v1",
  });
  store.upsertDigestRollup({
    chatId: CHAT.chatId,
    kind: "week",
    period: "2026-W30",
    dayFrom: "2026-07-20",
    dayTo: "2026-07-26",
    dayCount: 2,
    text: "Недельная сводка",
    promptVersion: "v1",
    sourceHash: hashWeekSource(CHAT.chatId, {
      period: "2026-W30",
      dayFrom: "2026-07-20",
      dayTo: "2026-07-26",
      digests: [sunday, monday],
    }),
  });
  const cache = new CanonicalBotReadCache({ store });

  assert.deepEqual(
    cache.getDigests(weekQuery(90)).digests,
    [
      {
        kind: "day",
        period: "2026-07-20",
        dayFrom: "2026-07-20",
        dayTo: "2026-07-20",
        text: "Воскресенье",
        startMessageId: 1,
        endMessageId: 50,
      },
    ],
    "a rollup with a future-attributed day digest must fall back even without a raw future message",
  );
});

test("mixed weekly safety keeps safe weeks plus uncovered safe days", (t) => {
  const store = fixtureStore(t);
  const monday = store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-13",
    startMessageId: 10,
    endMessageId: 10,
    messageCount: 1,
    text: "День 1",
    promptVersion: "v1",
  });
  const tuesday = store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-14",
    startMessageId: 12,
    endMessageId: 12,
    messageCount: 1,
    text: "День 2",
    promptVersion: "v1",
  });
  store.upsertDigestRollup({
    chatId: CHAT.chatId,
    kind: "week",
    period: "2026-W29",
    dayFrom: "2026-07-13",
    dayTo: "2026-07-19",
    dayCount: 2,
    text: "Безопасная неделя",
    promptVersion: "v1",
    sourceHash: hashWeekSource(CHAT.chatId, {
      period: "2026-W29",
      dayFrom: "2026-07-13",
      dayTo: "2026-07-19",
      digests: [monday, tuesday],
    }),
  });
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-20",
    startMessageId: 40,
    endMessageId: 50,
    messageCount: 2,
    text: "День в небезопасной неделе",
    promptVersion: "v1",
  });
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-21",
    startMessageId: 51,
    endMessageId: 900,
    messageCount: 2,
    text: "День, дотянувшийся до триггера",
    promptVersion: "v1",
  });
  store.upsertDigestRollup({
    chatId: CHAT.chatId,
    kind: "week",
    period: "2026-W30",
    dayFrom: "2026-07-20",
    dayTo: "2026-07-26",
    dayCount: 2,
    text: "Небезопасная неделя",
    promptVersion: "v1",
    sourceHash: "0".repeat(64),
  });
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-28",
    startMessageId: 60,
    endMessageId: 70,
    messageCount: 2,
    text: "День вне недель",
    promptVersion: "v1",
  });
  const cache = new CanonicalBotReadCache({ store });
  const query = {
    chatId: CHAT.chatId,
    dayFrom: "2026-07-13",
    dayTo: "2026-07-28",
    dayCount: 16,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-07-12T21:00:00.000Z",
    endExclusive: "2026-07-28T21:00:00.000Z",
    reversedInput: false,
    preferWeekly: true,
    sourceMessageId: 800,
  } as const;

  assert.deepEqual(cache.getDigests(query).digests, [
    {
      kind: "week",
      period: "2026-W29",
      dayFrom: "2026-07-13",
      dayTo: "2026-07-19",
      text: "Безопасная неделя",
    },
    {
      kind: "day",
      period: "2026-07-20",
      dayFrom: "2026-07-20",
      dayTo: "2026-07-20",
      text: "День в небезопасной неделе",
      startMessageId: 40,
      endMessageId: 50,
    },
    {
      kind: "day",
      period: "2026-07-28",
      dayFrom: "2026-07-28",
      dayTo: "2026-07-28",
      text: "День вне недель",
      startMessageId: 60,
      endMessageId: 70,
    },
  ]);
});

function weekQuery(sourceMessageId: number) {
  return {
    chatId: CHAT.chatId,
    dayFrom: "2026-07-20",
    dayTo: "2026-07-26",
    dayCount: 7,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-07-19T21:00:00.000Z",
    endExclusive: "2026-07-26T21:00:00.000Z",
    reversedInput: false,
    preferWeekly: true,
    sourceMessageId,
  } as const;
}

function fixtureStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-read-cache-cutoff-"));
  const store = new MessageStore(join(directory, "cache.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function message(messageId: number, text: string): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: `2026-07-${String(20 + messageId).padStart(2, "0")}T12:00:00.000Z`,
    senderId: `user-${messageId}`,
    senderName: `user_${messageId}`,
    text,
  };
}

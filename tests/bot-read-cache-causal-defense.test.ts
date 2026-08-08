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
import type { VectorSearchHit } from "../src/vector-rag.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "supergroup",
};

const BEFORE_ID = 5;

test("malicious vector port ignoring beforeId cannot leak future rows into hybrid results or rerank candidates", async (t) => {
  const store = fixtureStore(t);
  const messages = [1, 2, 3, 4, 5, 6, 7, 8].map((id) =>
    message(id, `тема ${id}`),
  );
  store.upsertMessages(CHAT, messages);
  const futureTexts = new Set(
    messages.slice(4).map(({ text }) => text),
  );
  let forwardedBeforeId: number | undefined;
  let rerankCandidates: string[] | undefined;
  const vector: BotVectorSearchPort = {
    supportsSparse: true,
    async search(params) {
      // The port receives the bound but deliberately ignores it.
      forwardedBeforeId = params.beforeId;
      return {
        available: true,
        hits: [makeVectorHit(messages)],
        sparseAvailable: true,
        sparseHits: [makeVectorHit(messages.slice(4))],
      };
    },
    fuseChannels() {
      // Future ids ranked on top; safe ids follow in fused order.
      return [8, 7, 6, 5, 4, 3, 2, 1].map((messageId, index) => ({
        rank: index + 1,
        source: "hybrid" as const,
        sources: ["dense" as const, "bm25" as const],
        score: 1 / (60 + index + 1),
        messageId,
        text: messages[messageId - 1]!.text,
      }));
    },
    async rerank({ candidates }) {
      rerankCandidates = [...candidates];
      return {
        available: true,
        scores: candidates.map((_, index) => candidates.length - index),
      };
    },
  };
  const cache = new CanonicalBotReadCache({
    store,
    vector,
    rerankMaxCandidates: 5,
  });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "тема",
    limit: 4,
    signal: new AbortController().signal,
    beforeId: BEFORE_ID,
  });

  assert.equal(forwardedBeforeId, BEFORE_ID);
  assert.equal(result.mode, "hybrid");
  assert.equal(result.channels?.rerank, "ok");
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [4, 3, 2, 1],
    "safe rows keep their fused order and future rows are never returned",
  );
  assert.ok(
    rerankCandidates !== undefined && rerankCandidates.length === 4,
    "rerank must run over the safe pool",
  );
  for (const text of rerankCandidates!) {
    assert.ok(
      !futureTexts.has(text),
      `rerank candidate must not be future text: ${text}`,
    );
  }
});

test("legacy hybrid port ignoring beforeId cannot leak future rows", async (t) => {
  const store = fixtureStore(t);
  const messages = [1, 2, 3, 4, 5, 6].map((id) =>
    message(id, `тема ${id}`),
  );
  store.upsertMessages(CHAT, messages);
  const vector: BotVectorSearchPort = {
    async search() {
      return {
        available: true,
        hits: [makeVectorHit(messages)],
      };
    },
    hybrid() {
      // A future row ranked ahead of the safe rows.
      return [
        {
          rank: 1,
          source: "vector",
          sources: ["vector"],
          score: 1,
          messageId: 6,
          text: messages[5]!.text,
        },
        {
          rank: 2,
          source: "keyword",
          sources: ["keyword"],
          score: 0.5,
          messageId: 1,
          text: messages[0]!.text,
        },
      ];
    },
  };
  const cache = new CanonicalBotReadCache({ store, vector });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "тема",
    limit: 3,
    signal: new AbortController().signal,
    beforeId: BEFORE_ID,
  });

  assert.equal(result.mode, "hybrid");
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    // The port-ranked future row is dropped; its top safe row leads, and the
    // window fills with remaining keyword hits in BM25 order (tie-break:
    // newest message id first), so the 4th safe row is cut by the limit.
    [1, 4, 3],
    "future rows ranked first are dropped, safe rows fill the window",
  );
});

test("semantic-only results drop future rows from a beforeId-ignoring port", async (t) => {
  const brokenStore = {
    searchWithRank() {
      throw new Error("fts temporarily unavailable");
    },
  } as unknown as MessageStore;
  const future = [5, 6, 7, 8].map((id) => message(id, `тема ${id}`));
  const vector: BotVectorSearchPort = {
    async search() {
      return { available: true, hits: [makeVectorHit(future)] };
    },
  };
  const cache = new CanonicalBotReadCache({ store: brokenStore, vector });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "тема",
    limit: 3,
    signal: new AbortController().signal,
    beforeId: BEFORE_ID,
  });

  assert.equal(result.mode, "semantic");
  assert.deepEqual(result.messages, []);
});

test("merged causal digests never exceed the digest row limit", (t) => {
  const store = fixtureStore(t);
  for (let index = 0; index < 50; index += 1) {
    const day = addDays("2026-01-01", index);
    const digest = store.upsertDayDigest({
      chatId: CHAT.chatId,
      day,
      startMessageId: 500 + index,
      endMessageId: 500 + index,
      messageCount: 1,
      text: `Недельная сводка ${day}`,
      promptVersion: "parilka-week-v1",
    });
    store.upsertDigestRollup({
      chatId: CHAT.chatId,
      kind: "week",
      period: day,
      dayFrom: day,
      dayTo: day,
      dayCount: 1,
      text: `Недельная сводка ${day}`,
      promptVersion: "parilka-week-v1",
      sourceHash: hashWeekSource(CHAT.chatId, {
        period: day,
        dayFrom: day,
        dayTo: day,
        digests: [digest],
      }),
    });
  }
  for (let index = 0; index < 100; index += 1) {
    const day = addDays("2026-02-20", index);
    store.upsertDayDigest({
      chatId: CHAT.chatId,
      day,
      startMessageId: 1000 + index,
      endMessageId: 1000 + index,
      messageCount: 1,
      text: `Дневная сводка ${day}`,
      promptVersion: "parilka-day-v1",
    });
  }
  const cache = new CanonicalBotReadCache({ store });

  const result = cache.getDigests({
    chatId: CHAT.chatId,
    dayFrom: "2026-01-01",
    dayTo: "2026-05-30",
    dayCount: 150,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-01-01T00:00:00.000Z",
    endExclusive: "2026-05-31T00:00:00.000Z",
    reversedInput: false,
    preferWeekly: true,
    sourceMessageId: 10_000,
  });

  assert.ok(
    result.digests.length <= 100,
    "merged week+day digests must never exceed 100 rows",
  );
  assert.equal(
    result.digests.length,
    100,
    "50 proven weeks + 100 uncovered safe days must be truncated to the limit",
  );
  for (let index = 1; index < result.digests.length; index += 1) {
    assert.ok(
      result.digests[index - 1]!.dayFrom <= result.digests[index]!.dayFrom,
      "digests must stay in deterministic chronological order",
    );
  }
  assert.equal(result.digests[0]!.kind, "week");
  assert.equal(result.digests[0]!.dayFrom, "2026-01-01");
  assert.equal(result.digests[50]!.kind, "day");
  // Proven weeks keep all 50 slots; the remaining 50 slots take the NEWEST
  // uncovered safe days (2026-02-20 + 50 … + 99), not the oldest ones.
  assert.equal(result.digests[50]!.dayFrom, "2026-04-11");
  assert.equal(result.digests[99]!.dayFrom, "2026-05-30");
  assert.ok(
    result.digests.every(
      (digest) =>
        digest.startMessageId === undefined ||
        digest.endMessageId === undefined ||
        digest.endMessageId < 10_000,
    ),
    "no returned digest may reach the trigger id",
  );
});

test("same-boundary proven weeks keep deterministic period ordering", (t) => {
  const store = fixtureStore(t);
  const day = "2026-03-10";
  const digest = store.upsertDayDigest({
    chatId: CHAT.chatId,
    day,
    startMessageId: 10,
    endMessageId: 10,
    messageCount: 1,
    text: `Недельная сводка ${day}`,
    promptVersion: "parilka-week-v1",
  });
  const week = (period: string) => ({
    chatId: CHAT.chatId,
    kind: "week" as const,
    period,
    dayFrom: day,
    dayTo: day,
    dayCount: 1,
    text: `Недельная сводка ${period}`,
    promptVersion: "parilka-week-v1",
    sourceHash: hashWeekSource(CHAT.chatId, {
      period,
      dayFrom: day,
      dayTo: day,
      digests: [digest],
    }),
  });
  // The store surfaces same-boundary weeks in period DESC order; the merged
  // result must override it with the deterministic period ASC tie-break.
  store.upsertDigestRollup(week("2026-03-15"));
  store.upsertDigestRollup(week("2026-03-08"));
  const cache = new CanonicalBotReadCache({ store });

  const result = cache.getDigests({
    chatId: CHAT.chatId,
    dayFrom: "2026-03-08",
    dayTo: "2026-03-15",
    dayCount: 8,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-03-08T00:00:00.000Z",
    endExclusive: "2026-03-16T00:00:00.000Z",
    reversedInput: false,
    preferWeekly: true,
    sourceMessageId: 100,
  });

  assert.deepEqual(
    result.digests.map(({ period }) => period),
    ["2026-03-08", "2026-03-15"],
    "weeks sharing dayFrom/dayTo must be ordered by period ascending",
  );
});

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fixtureStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-read-cache-defense-"));
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
    date: `2026-07-${String(1 + messageId).padStart(2, "0")}T12:00:00.000Z`,
    senderId: `user-${messageId}`,
    senderName: `user_${messageId}`,
    text,
  };
}

function makeVectorHit(messages: StoredMessage[]): VectorSearchHit {
  return {
    rank: 1,
    score: 0.9,
    chunk: {
      id: 10,
      startMessageId: messages[0]!.messageId,
      endMessageId: messages.at(-1)!.messageId,
      messageCount: messages.length,
      messageIds: messages.map(({ messageId }) => messageId),
      text: "chunk",
      namespace: "test",
      model: "test",
      dimensions: 2,
    },
    messages,
  };
}

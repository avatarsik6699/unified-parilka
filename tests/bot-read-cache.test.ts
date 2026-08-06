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
import type {
  RetrievalChannelInput,
  VectorSearchHit,
} from "../src/vector-rag.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "supergroup",
};

test("keyword search remains useful and reports semantic degradation", async (t) => {
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "typescript архитектура"),
    message(2, "совсем другой текст"),
  ]);
  const cache = new CanonicalBotReadCache({ store });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "typescript",
    limit: 5,
    signal: new AbortController().signal,
  });

  assert.equal(result.mode, "keyword");
  assert.deepEqual(result.messages.map(({ messageId }) => messageId), [1]);
  assert.deepEqual(result.degradedChannels, ["semantic_disabled"]);
});

test("hybrid projection returns exact stored messages in ranked order", async (t) => {
  const store = fixtureStore(t);
  const messages = [
    message(1, "ключевое слово"),
    message(2, "семантический сосед"),
    message(3, "ещё один сосед"),
  ];
  store.upsertMessages(CHAT, messages);
  const vectorHit = makeVectorHit(messages.slice(1));
  const vector: BotVectorSearchPort = {
    async search() {
      return { available: true, hits: [vectorHit] };
    },
    hybrid() {
      return [
        {
          rank: 1,
          source: "vector",
          sources: ["vector"],
          score: 1,
          startMessageId: 2,
          endMessageId: 3,
          text: "chunk",
        },
        {
          rank: 2,
          source: "keyword",
          sources: ["keyword"],
          score: 0.5,
          messageId: 1,
          text: "ключевое слово",
        },
      ];
    },
  };
  const cache = new CanonicalBotReadCache({ store, vector });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "ключевое",
    limit: 3,
    signal: new AbortController().signal,
  });

  assert.equal(result.mode, "hybrid");
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [2, 3, 1],
  );
  assert.deepEqual(result.degradedChannels, []);
});

test("vector failures degrade to keyword without exposing provider errors", async (t) => {
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [message(1, "надёжный локальный поиск")]);
  const vector: BotVectorSearchPort = {
    async search() {
      throw new Error("SECRET upstream credential and response");
    },
    hybrid() {
      assert.fail("hybrid must not run after vector failure");
    },
  };
  const cache = new CanonicalBotReadCache({ store, vector });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "надёжный",
    limit: 3,
    signal: new AbortController().signal,
  });

  assert.equal(result.mode, "keyword");
  assert.deepEqual(result.degradedChannels, [
    "semantic_failed",
    "dense_failed",
  ]);
  assert.equal(result.channels?.dense, "failed");
  assert.equal(result.channels?.bm25, "ok");
  assert.doesNotMatch(JSON.stringify(result), /SECRET|credential/);
});

test("an aborted search does not begin local or provider work", async (t) => {
  const store = fixtureStore(t);
  let vectorCalls = 0;
  const vector: BotVectorSearchPort = {
    async search() {
      vectorCalls += 1;
      return { available: true, hits: [] };
    },
    hybrid() {
      return [];
    },
  };
  const cache = new CanonicalBotReadCache({ store, vector });
  const controller = new AbortController();
  controller.abort(new DOMException("stop", "AbortError"));

  await assert.rejects(
    cache.search({
      chatId: CHAT.chatId,
      query: "anything",
      limit: 3,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(vectorCalls, 0);
});

test("find and slice paths never call the vector port and exclude the bot", (t) => {
  const store = fixtureStore(t);
  store.upsertMessages(CHAT, [
    message(1, "релиз обсуждение"),
    {
      ...message(2, "релиз подтверждён"),
      senderId: "bot-1",
      senderName: "Parilka Bot",
    },
    message(3, "релиз перенесли"),
  ]);
  let vectorCalls = 0;
  const vector: BotVectorSearchPort = {
    async search() {
      vectorCalls += 1;
      return { available: true, hits: [] };
    },
    hybrid() {
      vectorCalls += 1;
      return [];
    },
  };
  const cache = new CanonicalBotReadCache({
    store,
    vector,
    botSenderId: "bot-1",
  });

  const found = cache.findMessages({
    chatId: CHAT.chatId,
    query: "релиз",
    match: "all",
    includeBot: false,
    order: "oldest",
    limit: 20,
  });
  assert.deepEqual(
    found.map(({ messageId }) => messageId),
    [1, 3],
  );

  const withBot = cache.findMessages({
    chatId: CHAT.chatId,
    query: "релиз",
    match: "all",
    includeBot: true,
    order: "oldest",
    limit: 20,
  });
  assert.deepEqual(
    withBot.map(({ messageId }) => messageId),
    [1, 2, 3],
  );

  const slice = cache.readSlice({
    chatId: CHAT.chatId,
    form: "recent",
    count: 10,
    upperMessageId: 2,
  });
  assert.deepEqual(
    slice.messages.map(({ messageId }) => messageId),
    [1, 2],
  );
  assert.equal(slice.coverage.upperMessageId, 2);
  assert.equal(vectorCalls, 0);
});

test("weekly digest preference falls back to daily cache", (t) => {
  const store = fixtureStore(t);
  store.upsertDayDigest({
    chatId: CHAT.chatId,
    day: "2026-07-25",
    startMessageId: 1,
    endMessageId: 3,
    messageCount: 3,
    text: "Дневная сводка",
    promptVersion: "v1",
  });
  const cache = new CanonicalBotReadCache({ store });
  const query = {
    chatId: CHAT.chatId,
    dayFrom: "2026-07-20",
    dayTo: "2026-07-30",
    dayCount: 11,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-07-19T21:00:00.000Z",
    endExclusive: "2026-07-30T21:00:00.000Z",
    reversedInput: false,
    preferWeekly: true,
  } as const;

  assert.deepEqual(cache.getDigests(query).digests, [
    {
      kind: "day",
      period: "2026-07-25",
      dayFrom: "2026-07-25",
      dayTo: "2026-07-25",
      text: "Дневная сводка",
      startMessageId: 1,
      endMessageId: 3,
    },
  ]);

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
  assert.deepEqual(cache.getDigests(query).digests, [
    {
      kind: "week",
      period: "2026-W30",
      dayFrom: "2026-07-20",
      dayTo: "2026-07-26",
      text: "Недельная сводка",
    },
  ]);
});

test("external dense-only backend reports sparse as unsupported, not failed", async (t) => {
  const store = fixtureStore(t);
  const messages = [message(1, "внешний dense провайдер")];
  store.upsertMessages(CHAT, messages);
  const vector: BotVectorSearchPort = {
    supportsSparse: false,
    async search() {
      return {
        available: true,
        hits: [makeVectorHit(messages)],
        sparseHits: [],
      };
    },
    hybrid() {
      return [
        {
          rank: 1,
          source: "vector",
          sources: ["vector"],
          score: 1,
          startMessageId: 1,
          endMessageId: 1,
          text: "chunk",
        },
      ];
    },
  };
  const cache = new CanonicalBotReadCache({ store, vector });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "внешний",
    limit: 3,
    signal: new AbortController().signal,
  });

  assert.equal(result.channels?.sparse, "unsupported");
  assert.ok(
    !(result.degradedChannels ?? []).some((token) =>
      token.startsWith("sparse_"),
    ),
    "unsupported sparse must not degrade",
  );
});

test("late rerank can promote a candidate from outside the output window", async (t) => {
  const store = fixtureStore(t);
  const messages = [1, 2, 3, 4, 5].map((id) =>
    message(id, `сообщение ${id}`),
  );
  store.upsertMessages(CHAT, messages);
  const denseHits = messages.map((msg, index) =>
    makeVectorHitWithId([msg], index + 1),
  );
  const vector: BotVectorSearchPort = {
    supportsSparse: true,
    async search() {
      return {
        available: true,
        hits: denseHits,
        sparseAvailable: true,
        sparseHits: [],
      };
    },
    fuseChannels(channels) {
      type VectorChannel = Extract<RetrievalChannelInput, { channel: "dense" | "sparse" }>;
      const dense = channels.find(
        (entry): entry is VectorChannel => entry.channel === "dense",
      );
      return (dense?.hits ?? []).map((hit, index) => ({
        rank: index + 1,
        source: "dense" as const,
        sources: ["dense" as const],
        score: 1 / (60 + index + 1),
        messageId: hit.messages[0]!.messageId,
        text: hit.messages[0]!.text,
      }));
    },
    async rerank({ candidates }) {
      // Message 5 sits at first-stage rank 5; the rerank lifts it.
      return {
        available: true,
        scores: candidates.map((text) =>
          text === "сообщение 5" ? 9.9 : 0.1,
        ),
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
    query: "сообщение",
    limit: 2,
    signal: new AbortController().signal,
  });

  assert.equal(result.channels?.rerank, "ok");
  assert.equal(result.messages.length, 2);
  assert.equal(
    result.messages[0]?.messageId,
    5,
    "rerank must promote a candidate that was outside the output limit",
  );
});

test("dense+sparse still fuse through RRF when BM25 is down", async (t) => {
  const brokenStore = {
    searchWithRank() {
      throw new Error("fts temporarily unavailable");
    },
  } as unknown as MessageStore;
  const denseMessages = [message(1, "dense кандидат")];
  const sparseMessages = [message(3, "sparse кандидат")];
  const seenChannels: string[] = [];
  const vector: BotVectorSearchPort = {
    supportsSparse: true,
    async search() {
      return {
        available: true,
        hits: [makeVectorHitWithId(denseMessages, 1)],
        sparseAvailable: true,
        sparseHits: [makeVectorHitWithId(sparseMessages, 2)],
      };
    },
    fuseChannels(channels) {
      seenChannels.push(...channels.map((entry) => entry.channel));
      // RRF ordering controlled here: sparse-only message outranks dense.
      return [
        {
          rank: 1,
          source: "sparse" as const,
          sources: ["sparse" as const],
          score: 1 / 61,
          messageId: 3,
          text: "sparse кандидат",
        },
        {
          rank: 2,
          source: "dense" as const,
          sources: ["dense" as const],
          score: 1 / 62,
          messageId: 1,
          text: "dense кандидат",
        },
      ];
    },
  };
  const cache = new CanonicalBotReadCache({
    store: brokenStore,
    vector,
  });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "кандидат",
    limit: 5,
    signal: new AbortController().signal,
  });

  assert.equal(result.mode, "semantic");
  assert.equal(result.channels?.bm25, "failed");
  assert.ok(seenChannels.includes("dense"));
  assert.ok(seenChannels.includes("sparse"));
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [3, 1],
    "sparse candidate must outrank dense via RRF, not dense-first concat",
  );
});

function fixtureStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-read-cache-"));
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

function makeVectorHit(messages: StoredMessage[]): VectorSearchHit {
  return makeVectorHitWithId(messages, 10);
}

function makeVectorHitWithId(
  messages: StoredMessage[],
  chunkId: number,
): VectorSearchHit {
  return {
    rank: 1,
    score: 0.9,
    chunk: {
      id: chunkId,
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

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
import type { VectorSearchHit } from "../src/vector-rag.js";
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
  assert.deepEqual(result.degradedChannels, ["semantic_failed"]);
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

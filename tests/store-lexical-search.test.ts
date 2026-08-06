import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MessageStore, type StoredMessage } from "../src/store.js";
import type { ChatInfo } from "../src/telegram-client.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "supergroup",
};
const BOT_SENDER_ID = "99";

function fixtureStore(t: TestContext): MessageStore {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  const rows: StoredMessage[] = [
    message(1, "10", "alice", "Привет, мир! Обсуждаем релиз", "2026-07-01"),
    message(2, "11", "bob", "ПРИВЕТ всем, deploy завтра", "2026-07-02"),
    message(3, "10", "alice", "релиз отложили", "2026-07-03"),
    message(
      4,
      BOT_SENDER_ID,
      "ParilkaBot",
      "Привет! Я бот, релиз подтверждён",
      "2026-07-04",
    ),
    message(5, "10", "alice", "Привет удалённое релиз", "2026-07-05"),
    message(6, "12", "carol", "release(v2) готов", "2026-07-06"),
    message(7, "11", "bob", "итог: релиз и deploy вместе", "2026-07-07"),
    message(8, "13", "dave", "релиз", "2026-07-08"),
  ];
  store.upsertMessages(CHAT, rows);
  store.markMessagesDeleted(CHAT.chatId, [5]);
  return store;
}

function message(
  messageId: number,
  senderId: string,
  senderName: string,
  text: string,
  day: string,
): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: `${day}T10:00:00.000Z`,
    senderId,
    senderName,
    text,
  };
}

function ids(hits: { message: StoredMessage }[]): number[] {
  return hits.map((hit) => hit.message.messageId);
}

test("lexical search folds Russian Unicode case and never matches deleted rows", (t) => {
  const store = fixtureStore(t);
  const hits = store.searchLexical({ chatId: CHAT.chatId, query: "прИВЕТ" });
  assert.deepEqual(new Set(ids(hits)), new Set([1, 2, 4]));
});

test("all, any, phrase and prefix match modes stay deterministic", (t) => {
  const store = fixtureStore(t);
  const all = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз deploy",
    match: "all",
  });
  assert.deepEqual(ids(all), [7]);

  const any = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз deploy",
    match: "any",
    order: "oldest",
  });
  assert.deepEqual(ids(any), [1, 2, 3, 4, 7, 8]);

  const phrase = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз и deploy",
    match: "phrase",
  });
  assert.deepEqual(ids(phrase), [7]);
  const reversedPhrase = store.searchLexical({
    chatId: CHAT.chatId,
    query: "deploy и релиз",
    match: "phrase",
  });
  assert.deepEqual(ids(reversedPhrase), []);

  const prefix = store.searchLexical({
    chatId: CHAT.chatId,
    query: "рели",
    match: "prefix",
    order: "oldest",
  });
  assert.deepEqual(ids(prefix), [1, 3, 4, 7, 8]);
  // No stemming: a non-prefix inflection does not match in prefix mode.
  const nonPrefix = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиза",
    match: "prefix",
  });
  assert.deepEqual(ids(nonPrefix), []);
});

test("FTS punctuation and quote injection stay literal tokens", (t) => {
  const store = fixtureStore(t);
  const punct = store.searchLexical({
    chatId: CHAT.chatId,
    query: "release(v2)",
    match: "all",
  });
  assert.deepEqual(ids(punct), [6]);

  const injectedAll = store.searchLexical({
    chatId: CHAT.chatId,
    query: '"релиз" OR "Привет"',
    match: "all",
  });
  assert.deepEqual(ids(injectedAll), []);

  const injectedAny = store.searchLexical({
    chatId: CHAT.chatId,
    query: '"релиз" OR "Привет"',
    match: "any",
    order: "oldest",
  });
  // The injected OR stays a literal token and matches nothing; only the real
  // quoted words resolve.
  assert.deepEqual(ids(injectedAny), [1, 2, 3, 4, 7, 8]);

  const operators = store.searchLexical({
    chatId: CHAT.chatId,
    query: "* NEAR {текст}",
    match: "all",
  });
  assert.deepEqual(ids(operators), []);
});

test("sender filter matches id or name exactly, exclude list removes senders", (t) => {
  const store = fixtureStore(t);
  const byName = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз",
    sender: "alice",
    order: "oldest",
  });
  assert.deepEqual(ids(byName), [1, 3]);

  const byId = store.searchLexical({
    chatId: CHAT.chatId,
    query: "deploy",
    sender: "11",
    order: "oldest",
  });
  assert.deepEqual(ids(byId), [2, 7]);

  const withoutBot = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз",
    excludeSenderIds: [BOT_SENDER_ID],
    order: "oldest",
  });
  assert.deepEqual(ids(withoutBot), [1, 3, 7, 8]);
});

test("date bounds are UTC half-open and id bounds stay exclusive", (t) => {
  const store = fixtureStore(t);
  const from = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз",
    dateFromInclusive: "2026-07-03T00:00:00.000Z",
    order: "oldest",
  });
  assert.deepEqual(ids(from), [3, 4, 7, 8]);

  const to = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз",
    dateToExclusive: "2026-07-03T00:00:00.000Z",
    order: "oldest",
  });
  assert.deepEqual(ids(to), [1]);

  const window = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз",
    beforeId: 8,
    afterId: 1,
    order: "oldest",
  });
  assert.deepEqual(ids(window), [3, 4, 7]);
});

test("newest/oldest orders ignore BM25 ranking of short junk rows", (t) => {
  const store = fixtureStore(t);
  const newest = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз",
    order: "newest",
  });
  assert.deepEqual(ids(newest), [8, 7, 4, 3, 1]);
  assert.ok(newest.every((hit) => hit.rank === 0));

  const oldest = store.searchLexical({
    chatId: CHAT.chatId,
    query: "релиз",
    order: "oldest",
  });
  assert.deepEqual(ids(oldest), [1, 3, 4, 7, 8]);
});

test("getHistory and getThreadContext hide soft-deleted rows by default", (t) => {
  const store = fixtureStore(t);

  const history = store.getHistory({ chatId: CHAT.chatId, limit: 50 });
  assert.ok(!history.some((row) => row.messageId === 5));
  assert.equal(history.length, 7);

  const withDeleted = store.getHistory({
    chatId: CHAT.chatId,
    limit: 50,
    includeDeleted: true,
  });
  assert.equal(withDeleted.length, 8);
  assert.ok(withDeleted.some((row) => row.messageId === 5));

  const thread = store.getThreadContext({
    chatId: CHAT.chatId,
    messageId: 5,
    before: 2,
    after: 2,
  });
  assert.deepEqual(
    thread.map((row) => row.messageId),
    [3, 4, 6, 7],
  );

  const threadWithDeleted = store.getThreadContext({
    chatId: CHAT.chatId,
    messageId: 5,
    before: 2,
    after: 2,
    includeDeleted: true,
  });
  assert.deepEqual(
    threadWithDeleted.map((row) => row.messageId),
    [3, 4, 5, 6, 7],
  );
});

test("lexical search validates inputs before touching SQLite", (t) => {
  const store = fixtureStore(t);
  assert.throws(
    () => store.searchLexical({ chatId: CHAT.chatId, query: "x", limit: 0 }),
    /limit/,
  );
  assert.throws(
    () => store.searchLexical({ chatId: CHAT.chatId, query: "x", limit: 201 }),
    /limit/,
  );
  assert.throws(
    () =>
      store.searchLexical({
        chatId: CHAT.chatId,
        query: "x",
        match: "regex" as never,
      }),
    /match/,
  );
  assert.throws(
    () =>
      store.searchLexical({
        chatId: CHAT.chatId,
        query: "x",
        order: "random" as never,
      }),
    /order/,
  );
  assert.throws(
    () =>
      store.searchLexical({
        chatId: CHAT.chatId,
        query: "x",
        dateFromInclusive: "not-a-date",
      }),
    /dateFromInclusive/,
  );
  assert.throws(
    () =>
      store.searchLexical({
        chatId: CHAT.chatId,
        query: "x",
        dateFromInclusive: "2026-07-03T00:00:00+03:00",
      }),
    /canonical UTC ISO/,
  );
  assert.throws(
    () =>
      store.searchLexical({
        chatId: CHAT.chatId,
        query: "x",
        excludeSenderIds: Array.from({ length: 33 }, (_, i) => `s${i}`),
      }),
    /excludeSenderIds/,
  );
});

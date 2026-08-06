import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_READ_TOOL_DEFINITIONS,
  BotReadTools,
  calendarDayRange,
  type DigestCacheQuery,
} from "../src/bot/read-tools.js";
import { MessageStore } from "../src/store.js";
import {
  CHAT,
  durationHours,
  emptyCache,
  message,
  storeCache,
} from "./support/bot-read-tools.js";

test("the direct registry preserves the nine useful read-tool contracts", () => {
  const names: readonly string[] = BOT_READ_TOOL_DEFINITIONS.map(
    ({ name }) => name,
  );
  assert.deepEqual(
    names,
    [
      "rag_bm25_search",
      "keyword_search",
      "read_chat_slice",
      "day_digest",
      "thread_context",
      "web_search",
      "static_page_fetch",
      "paper_search",
      "research_lookup",
    ],
  );
  assert.ok(names.includes("static_page_fetch"));
  assert.ok(!names.includes("web_fetch"));
  for (const definition of BOT_READ_TOOL_DEFINITIONS) {
    assert.equal(definition.inputSchema.additionalProperties, false);
  }
});

test("rag_bm25_search reads MessageStore locally and emits attributable evidence", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 10,
      date: "2026-07-30T08:15:00.000Z",
      senderId: "42",
      senderName: "alice",
      text: "needle про архитектуру",
    },
    {
      chatId: CHAT.chatId,
      messageId: 11,
      date: "2026-07-30T08:16:00.000Z",
      senderId: "43",
      senderName: "bob",
      text: "другое сообщение",
    },
  ]);
  let webCalls = 0;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
    webSearch: {
      async search() {
        webCalls += 1;
        throw new Error("must not be called by SQLite tools");
      },
    },
  });

  const result = await tools.callTool("rag_bm25_search", {
    query: "needle",
    limit: 3,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  assert.deepEqual(result.result, {
    query: "needle",
    limit: 3,
    returnedCount: 1,
    mode: "keyword",
    degradedChannels: [],
  });
  assert.deepEqual(result.evidence, [
    {
      source: "chat_message",
      sourceId: "chat:10",
      chat: { id: CHAT.chatId },
      message: { id: 10 },
      speaker: { id: "42", name: "alice" },
      authorRole: "user",
      isOwnTurn: false,
      date: "2026-07-30T08:15:00.000Z",
      text: "needle про архитектуру",
    },
  ]);
  assert.equal(webCalls, 0);
});

test("rag_bm25_search accepts an async hybrid adapter and reports degraded channels", async () => {
  let signal: AbortSignal | undefined;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      async search(params) {
        signal = params.signal;
        return {
          messages: [message(12, "hybrid hit", "alice")],
          mode: "hybrid",
          degradedChannels: ["vector"],
        };
      },
    }),
  });

  const result = await tools.callTool("rag_bm25_search", { query: "hybrid" });
  assert.equal(signal?.aborted, false);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.mode, "hybrid");
    assert.deepEqual(result.result.degradedChannels, ["vector"]);
    assert.equal(result.evidence[0]?.message?.id, 12);
  }
});

test("thread_context keeps explicit zero windows and evidence order", async () => {
  const calls: Array<{
    chatId: string;
    messageId: number;
    before: number;
    after: number;
  }> = [];
  const cache = emptyCache({
    getThreadContext(params) {
      calls.push(params);
      return [
        message(20, "до", "alice"),
        message(21, "центр", "bob"),
        message(22, "после", "carol"),
      ];
    },
  });
  const tools = new BotReadTools({ chatId: CHAT.chatId, cache });

  const exact = await tools.callTool("thread_context", {
    message_id: 21,
    before: 0,
    after: 0,
  });

  assert.deepEqual(calls, [
    {
      chatId: CHAT.chatId,
      messageId: 21,
      before: 0,
      after: 0,
    },
  ]);
  assert.equal(exact.ok, true);
  if (!exact.ok) {
    return;
  }
  assert.deepEqual(
    exact.evidence.map((item) => [item.message?.id, item.speaker.name, item.text]),
    [
      [20, "alice", "до"],
      [21, "bob", "центр"],
      [22, "carol", "после"],
    ],
  );
  assert.equal(exact.result.centerFound, true);
});

test("empty cache is a successful empty result for all SQLite tools", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webSearch: {
      async search() {
        throw new Error("SQLite tools must not make network calls");
      },
    },
  });

  const results = await Promise.all([
    tools.callTool("rag_bm25_search", { query: "ничего" }),
    tools.callTool("thread_context", { message_id: 100 }),
    tools.callTool("day_digest", { day_from: "2026-07-30" }),
  ]);

  for (const result of results) {
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.status, "empty");
      assert.deepEqual(result.evidence, []);
    }
  }
});

test("day_digest passes inclusive Moscow days as an exact UTC half-open range", async () => {
  let query: DigestCacheQuery | undefined;
  const source = message(
    301,
    "дословное сообщение для проверки кэша",
    "alice",
    "2026-07-29T21:00:00.000Z",
  );
  const cache = emptyCache({
    getDigests(params) {
      query = params;
      return {
        digests: [
          {
            kind: "day",
            period: "2026-07-30",
            dayFrom: "2026-07-30",
            dayTo: "2026-07-30",
            startMessageId: 301,
            endMessageId: 399,
            text: "Обсуждали архитектуру.",
          },
        ],
        sourceMessages: [source],
      };
    },
  });
  const tools = new BotReadTools({ chatId: CHAT.chatId, cache });

  const result = await tools.callTool("day_digest", {
    day_from: "2026-07-30",
  });

  assert.equal(query?.startInclusive, "2026-07-29T21:00:00.000Z");
  assert.equal(query?.endExclusive, "2026-07-30T21:00:00.000Z");
  assert.equal(query?.dayFrom, "2026-07-30");
  assert.equal(query?.dayTo, "2026-07-30");
  assert.equal(query?.dayCount, 1);
  assert.equal(query?.preferWeekly, false);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  assert.deepEqual(result.evidence, [
    {
      source: "digest",
      chat: { id: CHAT.chatId },
      message: { id: 301, endId: 399 },
      speaker: { id: null, name: null },
      date: "2026-07-30",
      text: "Обсуждали архитектуру.",
      range: { dayFrom: "2026-07-30", dayTo: "2026-07-30" },
    },
    {
      source: "chat_message",
      sourceId: "chat:301",
      chat: { id: CHAT.chatId },
      message: { id: 301 },
      speaker: { id: "speaker-301", name: "alice" },
      authorRole: "user",
      isOwnTurn: false,
      date: "2026-07-29T21:00:00.000Z",
      text: "дословное сообщение для проверки кэша",
    },
  ]);
});

test("calendar day conversion is reversed-range tolerant and DST-safe", () => {
  const reversed = calendarDayRange(
    "2026-07-30",
    "2026-07-25",
    "Europe/Moscow",
  );
  assert.deepEqual(reversed, {
    dayFrom: "2026-07-25",
    dayTo: "2026-07-30",
    dayCount: 6,
    timeZone: "Europe/Moscow",
    startInclusive: "2026-07-24T21:00:00.000Z",
    endExclusive: "2026-07-30T21:00:00.000Z",
    reversedInput: true,
  });

  // Moscow observed DST in 2010. Converting each local midnight independently
  // produces a 23-hour spring day and a 25-hour autumn day.
  const spring = calendarDayRange("2010-03-28");
  const autumn = calendarDayRange("2010-10-31");
  assert.equal(durationHours(spring), 23);
  assert.equal(durationHours(autumn), 25);
  assert.equal(spring.startInclusive, "2010-03-27T21:00:00.000Z");
  assert.equal(spring.endExclusive, "2010-03-28T20:00:00.000Z");
});

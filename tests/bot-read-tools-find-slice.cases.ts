import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_BOT_READ_TOOL_OUTPUT_CHARS,
  MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS,
  MAX_READ_CHAT_SLICE_OUTPUT_CHARS,
  BotReadTools,
  type BotFindMessagesQuery,
  type BotReadSliceRequest,
} from "../src/bot/read-tools.js";
import { MessageStore, type StoredMessage } from "../src/store.js";
import {
  asFailure,
  CHAT,
  emptyCache,
  emptyTranscript,
  storeCache,
} from "./support/bot-read-tools.js";

const BOT_SENDER_ID = "bot-1";

function seed(store: MessageStore, rows: StoredMessage[]): void {
  store.upsertMessages(CHAT, rows);
}

function row(
  messageId: number,
  text: string,
  senderId = `user-${messageId}`,
  date = `2026-07-30T08:${String(messageId % 60).padStart(2, "0")}:00.000Z`,
): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date,
    senderId,
    senderName: senderId === BOT_SENDER_ID ? "Parilka Bot" : `name_${senderId}`,
    text,
  };
}

test("keyword_search includes bot answers by default and excludes them on explicit false", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  seed(store, [
    row(1, "релиз обсуждение", "alice"),
    row(2, "релиз подтверждён", BOT_SENDER_ID),
    row(3, "релиз перенесли", "bob"),
  ]);
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store, BOT_SENDER_ID),
  });

  const withBot = await tools.callTool("keyword_search", {
    query: "релиз",
    order: "oldest",
  });
  assert.equal(withBot.ok, true);
  if (withBot.ok) {
    assert.deepEqual(
      withBot.evidence.map((item) => item.message?.id),
      [1, 2, 3],
    );
  }

  const withoutBot = await tools.callTool("keyword_search", {
    query: "релиз",
    include_bot: false,
    order: "oldest",
  });
  assert.equal(withoutBot.ok, true);
  if (withoutBot.ok) {
    assert.deepEqual(
      withoutBot.evidence.map((item) => item.message?.id),
      [1, 3],
    );
  }
});

test("keyword_search converts Moscow days and clamps beforeId to the trigger", async () => {
  let captured: BotFindMessagesQuery | undefined;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      findMessages(params) {
        captured = params;
        return [];
      },
    }),
  });

  const result = await tools.callTool(
    "keyword_search",
    {
      query: "релиз",
      day_from: "2026-07-30",
      day_to: "2026-07-31",
      before_id: 9_000,
    },
    { sourceMessageId: 1_000 },
  );

  assert.equal(result.ok, true);
  assert.equal(captured?.startInclusive, "2026-07-29T21:00:00.000Z");
  assert.equal(captured?.endExclusive, "2026-07-31T21:00:00.000Z");
  assert.equal(captured?.beforeId, 1_000);
  assert.equal(captured?.match, "all");
  assert.equal(captured?.includeBot, true);
});

test("keyword_search rejects invalid combinations as typed errors", async () => {
  const tools = new BotReadTools({ chatId: CHAT.chatId, cache: emptyCache() });
  const invalid = await tools.callTool("keyword_search", {
    query: "x",
    day_to: "2026-07-31",
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "invalid_arguments");
    assert.ok(invalid.error.fields?.some(({ path }) => path === "day_to"));
  }
  const tooLarge = await tools.callTool("keyword_search", {
    query: "x",
    limit: 51,
  });
  assert.equal(tooLarge.ok, false);
});

test("keyword_search projection stays inside its moderate cap", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  seed(
    store,
    Array.from({ length: 50 }, (_, index) =>
      row(index + 1, `релиз ${"подробности ".repeat(40)}${index}`),
    ),
  );
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const result = await tools.callTool("keyword_search", {
    query: "релиз",
    limit: 50,
  });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length <= MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS);
  if (result.ok) {
    assert.deepEqual(result.result.projection, {
      truncated: true,
      omittedEvidence: 0,
      maxCharacters: MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS,
    });
  }
  assert.ok(MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS > MAX_BOT_READ_TOOL_OUTPUT_CHARS);
});

test("read_chat_slice recent 800 delivers the whole transcript in one call", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  seed(
    store,
    Array.from({ length: 800 }, (_, index) =>
      row(index + 1, `m ${index + 1}`),
    ),
  );
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const result = await tools.callTool(
    "read_chat_slice",
    { mode: "recent", count: 800 },
    { sourceMessageId: 900 },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  const messages = result.result.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 800);
  assert.deepEqual(messages[0]?.sourceId, "chat:1");
  assert.deepEqual(messages.at(-1)?.sourceId, "chat:800");
  assert.ok(
    messages.every(
      (item, index) =>
        index === 0 ||
        (messages[index - 1]?.messageId as number) <
          (item.messageId as number),
    ),
  );
  assert.ok(messages.every((item) => !("rawJson" in item)));

  const coverage = result.result.coverage as Record<string, unknown>;
  // The authoritative upper is min(trigger - 1, chat max id); here the store
  // ends at 700, so the snapshot freezes 700, never the trigger itself.
  assert.equal(coverage.upperMessageId, 800);
  assert.equal(coverage.returnedCount, 800);
  assert.equal(coverage.coveredCount, 800);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.hasMore, false);

  const serialized = JSON.stringify(result);
  // The real transcript must blow through the legacy 4k/4.5k caps and still
  // stay inside the slice hard cap without any projection truncation.
  assert.ok(serialized.length > MAX_BOT_READ_TOOL_OUTPUT_CHARS);
  assert.ok(serialized.length <= MAX_READ_CHAT_SLICE_OUTPUT_CHARS);
  assert.equal(result.result.projection, undefined);
});

test("read_chat_slice never reaches the trigger or messages above it", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  seed(
    store,
    Array.from({ length: 300 }, (_, index) => row(index + 1, "x")),
  );
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const result = await tools.callTool(
    "read_chat_slice",
    { mode: "recent", count: 1_000 },
    { sourceMessageId: 200 },
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const messages = result.result.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 199);
  assert.deepEqual(messages.at(-1)?.messageId, 199);
  assert.equal(
    (result.result.coverage as Record<string, unknown>).upperMessageId,
    199,
  );
});

test("read_chat_slice converts period days and forwards cursors", async () => {
  const captured: BotReadSliceRequest[] = [];
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      readSlice(params) {
        captured.push(params);
        return emptyTranscript("period");
      },
    }),
  });

  const first = await tools.callTool(
    "read_chat_slice",
    { mode: "period", day_from: "2026-07-30" },
    { sourceMessageId: 500 },
  );
  assert.equal(first.ok, true);
  assert.deepEqual(captured[0], {
    chatId: CHAT.chatId,
    form: "period",
    startInclusive: "2026-07-29T21:00:00.000Z",
    endExclusive: "2026-07-30T21:00:00.000Z",
    upperMessageId: 499,
  });

  const continuation = await tools.callTool("read_chat_slice", {
    mode: "period",
    cursor: "b3BhcXVl",
  });
  assert.equal(continuation.ok, true);
  assert.deepEqual(captured[1], {
    chatId: CHAT.chatId,
    form: "period",
    cursor: "b3BhcXVl",
  });
});

test("read_chat_slice rejects a forged cursor that exceeds the trigger upper bound", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  seed(
    store,
    Array.from({ length: 1_500 }, (_, index) =>
      row(index + 1, `сообщение ${index + 1}`),
    ),
  );
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const forged = Buffer.from(
    JSON.stringify({
      v: 1,
      form: "recent",
      chatId: CHAT.chatId,
      upper: 1_500,
      anchor: 1,
      budget: 100,
      covered: 0,
      total: 1_500,
      omitted: 0,
    }),
    "utf8",
  ).toString("base64url");

  const result = asFailure(
    await tools.callTool(
      "read_chat_slice",
      { mode: "recent", cursor: forged },
      { sourceMessageId: 900 },
    ),
  );
  assert.equal(result.error.code, "invalid_arguments");
  assert.equal(result.error.retryable, false);
});

test("read_chat_slice reports corrupted cursors as invalid arguments", async (t) => {
  const store = new MessageStore(":memory:");
  t.after(() => store.close());
  seed(store, [row(1, "сообщение")]);
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: storeCache(store),
  });

  const result = asFailure(
    await tools.callTool("read_chat_slice", {
      mode: "recent",
      cursor: "definitely-not-a-cursor",
    }),
  );
  assert.equal(result.error.code, "invalid_arguments");
  assert.equal(result.error.retryable, false);

  const schemaConflict = asFailure(
    await tools.callTool("read_chat_slice", {
      mode: "recent",
      count: 10,
      cursor: "b3BhcXVl",
    }),
  );
  assert.equal(schemaConflict.error.code, "invalid_arguments");
});

test("ordinary tools keep the short cap while slice and find carry more", async () => {
  assert.equal(MAX_BOT_READ_TOOL_OUTPUT_CHARS, 4_000);
  assert.ok(
    MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS >= 16_000 &&
      MAX_FIND_CHAT_MESSAGES_OUTPUT_CHARS <= 24_000,
  );
  assert.equal(MAX_READ_CHAT_SLICE_OUTPUT_CHARS, 192_000);
});

test("carried tool results keep the slice intact but truncate ordinary output", async () => {
  const {
    boundedSerialize,
    maxCarriedToolResultChars,
  } = await import("../src/bot/agent/evidence.js");

  assert.equal(maxCarriedToolResultChars("rag_bm25_search"), 4_500);
  assert.equal(maxCarriedToolResultChars("keyword_search"), 20_000);
  assert.equal(maxCarriedToolResultChars("read_chat_slice"), 192_000);

  const large = { payload: "x".repeat(90_000) };
  const ordinary = boundedSerialize(large, maxCarriedToolResultChars("rag_bm25_search"));
  assert.ok(ordinary.length <= 4_500);
  assert.doesNotThrow(() => JSON.parse(ordinary));
  assert.ok(ordinary.includes("output_too_large"));

  const carriedSlice = boundedSerialize(
    large,
    maxCarriedToolResultChars("read_chat_slice"),
  );
  assert.equal(carriedSlice, JSON.stringify(large));
});

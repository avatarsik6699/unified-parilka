import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotReadToolResult } from "../src/bot/read-tools.js";
import { listToolDefinitions } from "../src/mcp-tools/definitions.js";
import type { TelegramToolContext } from "../src/mcp-tools/contracts.js";
import { callTelegramTool } from "../src/mcp-tools/registry.js";
import { MessageStore } from "../src/store.js";
import { CHAT, fakeContext } from "./support/mcp-cache-read-tools.js";

const CACHE_ONLY_TOOLS = new Set([
  "rag_bm25_search",
  "keyword_search",
  "read_chat_slice",
  "day_digest",
  "thread_context",
]);

// ── Definitions ────────────────────────────────────────────────────────────

test("five cache-only definitions have source_message_id required and no chat", () => {
  const defs = listToolDefinitions();
  for (const def of defs) {
    if (!CACHE_ONLY_TOOLS.has(def.name)) continue;
    const schema = def.inputSchema as Record<string, unknown>;
    const required = schema.required as string[];
    const props = schema.properties as Record<string, unknown>;

    assert.ok(
      required.includes("source_message_id"),
      `${def.name} must require source_message_id`,
    );
    assert.equal(
      props.chat,
      undefined,
      `${def.name} must not expose a model-controlled chat argument`,
    );
    const sid = props.source_message_id as Record<string, unknown>;
    assert.equal(sid.type, "integer");
    assert.equal(sid.minimum, 1);
    assert.equal(
      sid.maximum,
      Number.MAX_SAFE_INTEGER,
      `${def.name} must cap source_message_id at MAX_SAFE_INTEGER`,
    );
  }
});

// ── source_message_id validation ───────────────────────────────────────────

test("missing source_message_id is rejected", async () => {
  const ctx = fakeContext();
  const result = await callTelegramTool(ctx, "rag_bm25_search", {
    query: "тест",
  });
  assert.equal(result.isError, true);
  const payload = parsePayload(result);
  assert.equal(payload.ok, false);
});

test("invalid source_message_id (zero, negative, float, string) is rejected", async () => {
  const ctx = fakeContext();
  const cases: Array<Record<string, unknown>> = [
    { source_message_id: 0 },
    { source_message_id: -1 },
    { source_message_id: 1.5 },
    { source_message_id: "1" },
    { source_message_id: null },
    { source_message_id: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const extra of cases) {
    const result = await callTelegramTool(ctx, "rag_bm25_search", {
      query: "тест",
      ...extra,
    });
    assert.equal(
      result.isError,
      true,
      `must reject source_message_id=${JSON.stringify(extra.source_message_id)}`,
    );
  }
});

// ── Boundary vs operational failures ───────────────────────────────────────

test("invalid tool arguments stay an MCP isError", async () => {
  const ctx = fakeContext();
  const result = await callTelegramTool(ctx, "rag_bm25_search", {
    source_message_id: 10,
  });
  assert.equal(result.isError, true);
  const payload = parsePayload(result);
  assert.equal(payload.ok, false);
  const error = payload.error as { code: string };
  assert.equal(error.code, "invalid_arguments");
});

test("operational cache failures stay typed JSON without MCP isError", async () => {
  const ctx = {
    ...fakeContext(),
    botReadTools: {
      callTool: async (): Promise<BotReadToolResult> => ({
        ok: false,
        tool: "day_digest",
        error: {
          code: "cache_error",
          retryable: false,
          message: "Local cache read failed.",
        },
        evidence: [],
      }),
    },
  } as unknown as TelegramToolContext;
  const result = await callTelegramTool(ctx, "day_digest", {
    day_from: "2026-07-30",
    source_message_id: 500,
  });
  assert.equal(result.isError, undefined);
  const payload = parsePayload(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.tool, "day_digest");
  const error = payload.error as { code: string; retryable: boolean };
  assert.equal(error.code, "cache_error");
  assert.equal(error.retryable, false);
  assert.deepEqual(payload.evidence, []);
});

// ── Causal bound: trigger/future messages are never returned ────────────────

test("keyword_search never returns trigger or future messages", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    message(10, "прошлое"),
    message(20, "триггер"),
    message(30, "будущее"),
  ]);
  const ctx = fakeContext(store);

  const result = await callTelegramTool(ctx, "keyword_search", {
    query: "прошлое",
    match: "all",
    include_bot: true,
    order: "oldest",
    limit: 10,
    source_message_id: 20,
  });
  assert.equal(result.isError, undefined);
  const payload = payloadOk(result);
  assert.equal(payload.status, "done");
  assert.equal(payload.result.returnedCount, 1);
  const evidence = payload.evidence as Array<{ message: { id: number } }>;
  assert.deepEqual(
    evidence.map((e) => e.message.id),
    [10],
    "must not return trigger or future",
  );
});

test("read_chat_slice snapshot ends before trigger", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    message(5, "давно"),
    message(10, "прошлое"),
    message(20, "триггер"),
    message(30, "будущее"),
  ]);
  const ctx = fakeContext(store);

  const result = await callTelegramTool(ctx, "read_chat_slice", {
    mode: "recent",
    count: 10,
    source_message_id: 20,
  });
  const payload = payloadOk(result);
  assert.equal(payload.status, "done");
  const messages = payload.result.messages as Array<{ messageId: number }>;
  const ids = messages.map((m) => m.messageId);
  assert.ok(ids.every((id) => id < 20), "all must be below trigger");
  assert.ok(!ids.includes(20), "trigger must not appear");
  assert.ok(!ids.includes(30), "future must not appear");
});

test("thread_context never reaches beforeId", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    message(10, "старое"),
    message(20, "центр"),
    message(30, "будущее"),
  ]);
  const ctx = fakeContext(store);

  const result = await callTelegramTool(ctx, "thread_context", {
    message_id: 20,
    before: 15,
    after: 15,
    source_message_id: 30,
  });
  const payload = payloadOk(result);
  const evidence = payload.evidence as Array<{ message: { id: number } }>;
  assert.deepEqual(
    evidence.map((e) => e.message.id),
    [10, 20],
    "must exclude message at or above beforeId",
  );
});

test("rag_bm25_search respects beforeId causal bound", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    message(10, "раннее ключевое слово"),
    message(20, "триггер ключевое слово"),
    message(30, "будущее ключевое слово"),
  ]);
  const ctx = fakeContext(store);

  const result = await callTelegramTool(ctx, "rag_bm25_search", {
    query: "ключевое слово",
    limit: 5,
    source_message_id: 20,
  });
  const payload = payloadOk(result);
  const evidence = payload.evidence as Array<{ message: { id: number } }>;
  assert.deepEqual(
    evidence.map((e) => e.message.id),
    [10],
    "must not return trigger or future",
  );
});

// ── Bot sender marking ─────────────────────────────────────────────────────

test("bot sender messages are marked authorRole=assistant and isOwnTurn=true", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { ...message(10, "от бота"), senderId: "123456789" },
    { ...message(11, "от юзера"), senderId: "user-1" },
  ]);
  const ctx = fakeContext(store, "123456789");

  const result = await callTelegramTool(ctx, "keyword_search", {
    query: "от",
    match: "any",
    include_bot: true,
    order: "oldest",
    limit: 10,
    source_message_id: 99,
  });
  const payload = payloadOk(result);
  assert.equal(payload.result.returnedCount, 2);
  const evidence = payload.evidence as Array<{
    message: { id: number };
    authorRole: string;
    isOwnTurn: boolean;
  }>;
  const botEvidence = evidence.find((e) => e.message.id === 10)!;
  assert.equal(botEvidence.authorRole, "assistant");
  assert.equal(botEvidence.isOwnTurn, true);

  const userEvidence = evidence.find((e) => e.message.id === 11)!;
  assert.equal(userEvidence.authorRole, "user");
  assert.equal(userEvidence.isOwnTurn, false);
});

test("read_chat_slice marks bot messages with authorRole=assistant", async () => {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    { ...message(10, "бот"), senderId: "bot42" },
    { ...message(11, "юзер"), senderId: "user-1" },
  ]);
  const ctx = fakeContext(store, "bot42");

  const result = await callTelegramTool(ctx, "read_chat_slice", {
    mode: "recent",
    count: 5,
    source_message_id: 99,
  });
  const payload = payloadOk(result);
  const messages = payload.result.messages as Array<{
    messageId: number;
    authorRole: string;
    isOwnTurn: boolean;
  }>;
  const botMsg = messages.find((m) => m.messageId === 10)!;
  assert.equal(botMsg.authorRole, "assistant");
  assert.equal(botMsg.isOwnTurn, true);
  const userMsg = messages.find((m) => m.messageId === 11)!;
  assert.equal(userMsg.authorRole, "user");
  assert.equal(userMsg.isOwnTurn, false);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function message(
  messageId: number,
  text: string,
): {
  chatId: string;
  messageId: number;
  date: string;
  senderId: string;
  senderName: string;
  text: string;
} {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: `2026-08-0${String(messageId).slice(0, 1)}T12:00:00.000Z`,
    senderId: `user-${messageId}`,
    senderName: `user_${messageId}`,
    text,
  };
}

function parsePayload(
  result: { content: Array<{ type: string; text: string }> },
): Record<string, unknown> & { ok: boolean } {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown> & {
    ok: boolean;
  };
}

function payloadOk(
  result: { content: Array<{ type: string; text: string }> },
): Record<string, unknown> & {
  ok: true;
  status: string;
  result: Record<string, unknown>;
  evidence: unknown[];
} {
  const payload = parsePayload(result);
  assert.equal(payload.ok, true);
  return payload as unknown as Record<string, unknown> & {
    ok: true;
    status: string;
    result: Record<string, unknown>;
    evidence: unknown[];
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
  type BotReadSliceRequest,
  type DigestCacheQuery,
} from "../src/bot/read-tools.js";
import {
  CHAT,
  emptyCache,
  emptyTranscript,
  message,
} from "./support/bot-read-tools.js";

test("day_digest forwards the trigger id into the digest query", async () => {
  let captured: DigestCacheQuery | undefined;
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache({
      getDigests(params) {
        captured = params;
        return { digests: [] };
      },
    }),
  });

  const result = await tools.callTool(
    "day_digest",
    { day_from: "2026-07-30" },
    { sourceMessageId: 500 },
  );

  assert.equal(result.ok, true);
  assert.equal(captured?.sourceMessageId, 500);
  assert.equal(captured?.preferWeekly, false);
});

test("day_digest probes the causal period when no digest exists and reports not_ready", async () => {
  let probe: BotReadSliceRequest | undefined;
  const base = emptyTranscript("period");
  const cache = emptyCache({
    getDigests() {
      return { digests: [] };
    },
    readSlice(params) {
      probe = params;
      return {
        ...base,
        coverage: { ...base.coverage, upperMessageId: 499, totalAvailable: 5 },
      };
    },
  });
  const tools = new BotReadTools({ chatId: CHAT.chatId, cache });

  const result = await tools.callTool(
    "day_digest",
    { day_from: "2026-07-30" },
    { sourceMessageId: 500 },
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  // The probe reuses the read_chat_slice snapshot bound: trigger minus one.
  assert.deepEqual(probe, {
    chatId: CHAT.chatId,
    form: "period",
    startInclusive: "2026-07-29T21:00:00.000Z",
    endExclusive: "2026-07-30T21:00:00.000Z",
    upperMessageId: 499,
  });
  assert.equal(result.result.digestState, "not_ready");
  assert.equal(result.result.sourceMessageCount, 5);
  assert.equal(result.result.returnedCount, 0);
  assert.deepEqual(result.result.digests, []);
  assert.deepEqual(result.result.suggestedRead, {
    tool: "read_chat_slice",
    mode: "period",
    day_from: "2026-07-30",
    day_to: "2026-07-30",
  });
  assert.deepEqual(result.evidence, []);
});

test("day_digest reports honest no_messages when the range has no source rows", async () => {
  const tools = new BotReadTools({ chatId: CHAT.chatId, cache: emptyCache() });

  const result = await tools.callTool("day_digest", {
    day_from: "2026-07-30",
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "empty");
  assert.equal(result.result.digestState, "no_messages");
  assert.equal(result.result.sourceMessageCount, 0);
  assert.equal(result.result.returnedCount, 0);
  assert.deepEqual(result.result.digests, []);
  assert.equal(result.result.suggestedRead, undefined);
  assert.deepEqual(result.evidence, []);
});

test("day_digest skips the probe when a digest is available", async () => {
  let probeCalls = 0;
  const cache = emptyCache({
    readSlice() {
      probeCalls += 1;
      return emptyTranscript("period");
    },
    getDigests() {
      return {
        digests: [
          {
            kind: "day",
            period: "2026-07-30",
            dayFrom: "2026-07-30",
            dayTo: "2026-07-30",
            text: "Итог дня.",
          },
        ],
      };
    },
  });
  const tools = new BotReadTools({ chatId: CHAT.chatId, cache });

  const result = await tools.callTool("day_digest", {
    day_from: "2026-07-30",
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "done");
  assert.equal(result.result.digestState, "available");
  assert.equal(result.result.returnedCount, 1);
  assert.equal(probeCalls, 0);
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

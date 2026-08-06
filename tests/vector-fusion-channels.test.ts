import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeywordSearchHit, StoredMessage } from "../src/store.js";
import {
  fuseHybridSearch,
  fuseRankedChannels,
} from "../src/vector/fusion.js";
import type { VectorSearchHit } from "../src/vector-rag.js";

function storedMessage(messageId: number, text: string): StoredMessage {
  return {
    chatId: "-1001",
    messageId,
    date: "2026-08-01T12:00:00.000Z",
    senderId: `user-${messageId}`,
    senderName: `user_${messageId}`,
    text,
  };
}

function keywordHit(messageId: number, text: string): KeywordSearchHit {
  return { message: storedMessage(messageId, text), rank: -1 };
}

function vectorHit(
  chunkId: number,
  messages: StoredMessage[],
): VectorSearchHit {
  return {
    rank: 0,
    score: 0.9,
    chunk: {
      id: chunkId,
      startMessageId: messages[0]!.messageId,
      endMessageId: messages.at(-1)!.messageId,
      messageCount: messages.length,
      messageIds: messages.map(({ messageId }) => messageId),
      text: `chunk-${chunkId}`,
      namespace: "test",
      model: "bge-m3",
      dimensions: 1024,
    },
    messages,
  };
}

test("three-channel fusion ranks and tags bm25/dense/sparse sources", () => {
  const denseOnly = vectorHit(1, [storedMessage(1, "релиз")]);
  const sparseOnly = vectorHit(2, [storedMessage(2, "релиз план")]);
  const keywordOnly = keywordHit(3, "релиз перенесли");

  const fused = fuseRankedChannels(
    [
      { channel: "dense", hits: [denseOnly] },
      { channel: "sparse", hits: [sparseOnly] },
      { channel: "bm25", hits: [keywordOnly] },
    ],
    10,
  );

  assert.equal(fused.length, 3);
  assert.deepEqual(fused[0]?.sources.length, 1);
  const allSources = fused.flatMap((hit) => hit.sources);
  assert.ok(allSources.includes("dense"));
  assert.ok(allSources.includes("sparse"));
  assert.ok(allSources.includes("bm25"));
});

test("one chunk found by dense and sparse collapses into a hybrid entry", () => {
  const shared = vectorHit(7, [storedMessage(5, "общий чанк")]);
  const fused = fuseRankedChannels(
    [
      { channel: "dense", hits: [shared] },
      { channel: "sparse", hits: [shared] },
      { channel: "bm25", hits: [] },
    ],
    10,
  );
  assert.equal(fused.length, 1);
  assert.equal(fused[0]?.source, "hybrid");
  assert.deepEqual(fused[0]?.sources, ["dense", "sparse"]);
});

test("bm25 message inside a dense chunk merges into the chunk entry", () => {
  const messages = [storedMessage(1, "а"), storedMessage(2, "б")];
  const fused = fuseRankedChannels(
    [
      { channel: "dense", hits: [vectorHit(9, messages)] },
      { channel: "sparse", hits: [] },
      { channel: "bm25", hits: [keywordHit(2, "б")] },
    ],
    10,
  );
  assert.equal(fused.length, 1, "keyword message merges into the chunk");
  assert.deepEqual(fused[0]?.sources.sort(), ["bm25", "dense"]);
  assert.equal(fused[0]?.messageId, 2, "keyword id survives the merge");
  assert.equal(fused[0]?.startMessageId, 1);
});

test("fusion is deterministic for equal scores", () => {
  const a = vectorHit(1, [storedMessage(1, "x")]);
  const b = vectorHit(2, [storedMessage(2, "y")]);
  const first = fuseRankedChannels(
    [
      { channel: "dense", hits: [a, b] },
      { channel: "sparse", hits: [] },
      { channel: "bm25", hits: [] },
    ],
    10,
  );
  const second = fuseRankedChannels(
    [
      { channel: "dense", hits: [a, b] },
      { channel: "sparse", hits: [] },
      { channel: "bm25", hits: [] },
    ],
    10,
  );
  assert.deepEqual(first, second);
});

test("legacy two-channel fusion output shape is preserved", () => {
  const keyword = keywordHit(1, "ключ");
  const vector = vectorHit(3, [storedMessage(2, "вектор")]);
  const fused = fuseHybridSearch([keyword], [vector], 10);
  assert.equal(fused.length, 2);
  assert.deepEqual(fused.map((hit) => hit.source).sort(), [
    "keyword",
    "vector",
  ]);
});

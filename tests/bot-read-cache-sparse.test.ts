import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  CanonicalBotReadCache,
  type BotVectorSearchPort,
} from "../src/bot/read-cache.js";
import type { RetrievalChannelInput, VectorSearchHit } from "../src/vector-rag.js";
import type { ChatInfo } from "../src/telegram-client.js";
import { MessageStore } from "../src/store.js";
import type { StoredMessage } from "../src/store.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "supergroup",
};

test("dense unavailable + sparse available + BM25 ok => hybrid with dense_unavailable token only", async (t) => {
  const store = fixtureStore(t);
  const messages = [message(1, "bm25 хит"), message(2, "sparse хит")];
  store.upsertMessages(CHAT, messages);
  const vector: BotVectorSearchPort = {
    supportsSparse: true,
    async search() {
      return {
        available: false,
        error: "Vector search candidate limit 1 exceeded for model bge-m3 and dimensions 1024.",
        hits: [],
        sparseAvailable: true,
        sparseHits: [makeVectorHitWithId([messages[1]!], 2)],
      };
    },
    fuseChannels(channels) {
      return [
        {
          rank: 1,
          source: "bm25" as const,
          sources: ["bm25" as const],
          score: 1 / 61,
          messageId: 1,
          text: "bm25 хит",
        },
        {
          rank: 2,
          source: "sparse" as const,
          sources: ["sparse" as const],
          score: 1 / 62,
          startMessageId: 2,
          endMessageId: 2,
          text: "chunk",
        },
      ];
    },
  };
  const cache = new CanonicalBotReadCache({ store, vector });

  const result = await cache.search({
    chatId: CHAT.chatId,
    query: "хит",
    limit: 5,
    signal: new AbortController().signal,
  });

  assert.equal(result.mode, "hybrid");
  assert.equal(result.channels?.dense, "unavailable");
  assert.equal(result.channels?.sparse, "ok");
  assert.equal(result.channels?.bm25, "ok");
  assert.ok(
    (result.degradedChannels ?? []).includes("dense_unavailable"),
    "dense_unavailable token present",
  );
  assert.ok(
    !(result.degradedChannels ?? []).includes("semantic_unavailable"),
    "semantic_unavailable must NOT appear when sparse is ok",
  );
  assert.ok(
    (result.messages ?? []).some((m) => m.messageId === 2),
    "sparse evidence included in results",
  );
  assert.ok(
    (result.messages ?? []).some((m) => m.messageId === 1),
    "BM25 evidence included in results",
  );
});

test("dense unavailable + sparse available + BM25 failed => semantic sparse evidence", async (t) => {
  const store = fixtureStore(t);
  const sparseMessages = [message(2, "sparse кандидат")];
  store.upsertMessages(CHAT, sparseMessages);
  const seenChannels: string[] = [];
  const vector: BotVectorSearchPort = {
    supportsSparse: true,
    async search() {
      return {
        available: false,
        error: "Vector search candidate limit 1 exceeded for model bge-m3 and dimensions 1024.",
        hits: [],
        sparseAvailable: true,
        sparseHits: [makeVectorHitWithId(sparseMessages, 2)],
      };
    },
    fuseChannels(channels) {
      seenChannels.push(...channels.map((entry) => entry.channel));
      return [
        {
          rank: 1,
          source: "sparse" as const,
          sources: ["sparse" as const],
          score: 1 / 61,
          startMessageId: 2,
          endMessageId: 2,
          text: "chunk",
        },
      ];
    },
  };
  const ftsUnavailableStore = {
    searchWithRank() {
      throw new Error("fts temporarily unavailable");
    },
  } as unknown as MessageStore;
  const cache = new CanonicalBotReadCache({
    store: ftsUnavailableStore,
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
  assert.equal(result.channels?.dense, "unavailable");
  assert.equal(result.channels?.sparse, "ok");
  assert.ok(
    (result.degradedChannels ?? []).includes("dense_unavailable"),
    "dense_unavailable present",
  );
  assert.ok(
    !(result.degradedChannels ?? []).includes("semantic_unavailable"),
    "semantic_unavailable must NOT appear when sparse is ok",
  );
  assert.ok(seenChannels.includes("sparse"));
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [2],
    "sparse evidence in semantic mode",
  );
});

function fixtureStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-read-cache-sparse-"));
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

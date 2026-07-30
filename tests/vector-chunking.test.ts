import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import { VectorRag } from "../src/vector-rag.js";
import {
  CHAT,
  config,
  mockEmbeddingFetch,
  namespace,
} from "./support/vector-rag.js";

test("chunk overlap repeats trailing message membership", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ chunkMessages: 2, chunkOverlapMessages: 1 }), store);
  store.upsertMessages(
    CHAT,
    [1, 2, 3].map((messageId) => ({
      chatId: CHAT.chatId,
      messageId,
      senderName: "alice",
      text: `overlap message ${messageId}`,
    })),
  );

  await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 3, confirmFirstRun: true });

  const chunks = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: namespace({ chunkMessages: 2, chunkOverlapMessages: 1 }),
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });
  assert.deepEqual(
    chunks.map((chunk) => chunk.messageIds),
    [
      [1, 2],
      [2, 3],
    ],
  );
});

test("long messages are truncated to the configured chunk max", async (t) => {
  mockEmbeddingFetch(t);
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ chunkMessages: 1, chunkMaxChars: 80 }), store);
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "x".repeat(500),
    },
  ]);

  await vectorRag.indexCachedMessages({ chatId: CHAT.chatId, limitChunks: 1, confirmFirstRun: true });
  const [chunk] = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: namespace({ chunkMessages: 1, chunkMaxChars: 80 }),
    model: config().embeddings.model,
    dimensions: config().embeddings.dimensions,
  });

  assert.equal((chunk?.text.length ?? 0) <= 80, true);
  assert.match(chunk?.text ?? "", /truncated/);
});

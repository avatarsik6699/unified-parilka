import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  fingerprintEmbeddingSource,
  renderEmbeddingChunkSource,
} from "../src/embedding-source.js";
import type { EmbeddingChunkVector } from "../src/embeddings.js";
import {
  MessageStore,
  type StoredMessage,
} from "../src/store.js";
import type { ChatInfo } from "../src/telegram/types.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};
const CHUNK_MAX_CHARS = 1_600;

test("atomic embedding commit persists a byte-current source and membership", () => {
  const store = new MessageStore(":memory:");
  const messages = [
    message(1, "alpha"),
    message(2, "beta"),
  ];
  store.upsertMessages(CHAT, messages);

  const result = store.commitEmbeddingChunksIfCurrent(
    [chunk(messages)],
    CHUNK_MAX_CHARS,
  );

  assert.deepEqual(result, {
    committedChunks: 1,
    committedMessages: 2,
    staleRanges: [],
    nextAfterMessageId: 2,
  });
  const [stored] = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: "test",
    model: "test-model",
    dimensions: 2,
  });
  assert.deepEqual(stored?.messageIds, [1, 2]);
  assert.equal(stored?.text, renderEmbeddingChunkSource(messages, CHUNK_MAX_CHARS));
  store.close();
});

test("edit between provider input and commit is stale and creates no membership", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-embedding-commit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "messages.sqlite");
  const planner = new MessageStore(dbPath);
  const writer = new MessageStore(dbPath);
  t.after(() => {
    writer.close();
    planner.close();
  });
  const original = [message(1, "before"), message(2, "stable")];
  planner.upsertMessages(CHAT, original);
  const providerResult = chunk(original);

  writer.upsertMessages(CHAT, [message(1, "after")]);
  const result = planner.commitEmbeddingChunksIfCurrent(
    [providerResult],
    CHUNK_MAX_CHARS,
  );

  assert.deepEqual(result, {
    committedChunks: 0,
    committedMessages: 0,
    staleRanges: [
      {
        chatId: CHAT.chatId,
        startMessageId: 1,
        endMessageId: 2,
        reason: "source_changed",
      },
    ],
  });
  assert.deepEqual(
    planner.getEmbeddingChunks({
      chatId: CHAT.chatId,
      namespace: "test",
      model: "test-model",
      dimensions: 2,
    }),
    [],
  );
  const inspection = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => inspection.close());
  assert.equal(
    Number(
      (
        inspection
          .prepare(
            "SELECT COUNT(*) AS count FROM message_embedding_chunk_messages",
          )
          .get() as Record<string, unknown>
      ).count,
    ),
    0,
  );
});

test("batch cursor stops before first stale range while later current chunks commit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-embedding-cursor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "messages.sqlite");
  const planner = new MessageStore(dbPath);
  const writer = new MessageStore(dbPath);
  t.after(() => {
    writer.close();
    planner.close();
  });
  const messages = [
    message(1, "one"),
    message(2, "two"),
    message(3, "three"),
  ];
  planner.upsertMessages(CHAT, messages);
  const providerResults = messages.map((item) => chunk([item]));
  writer.markMessagesDeleted(CHAT.chatId, [2]);

  const result = planner.commitEmbeddingChunksIfCurrent(
    providerResults,
    CHUNK_MAX_CHARS,
  );

  assert.deepEqual(result, {
    committedChunks: 2,
    committedMessages: 2,
    staleRanges: [
      {
        chatId: CHAT.chatId,
        startMessageId: 2,
        endMessageId: 2,
        reason: "deleted_message",
      },
    ],
    nextAfterMessageId: 1,
  });
  assert.deepEqual(
    planner
      .getEmbeddingChunks({
        chatId: CHAT.chatId,
        namespace: "test",
        model: "test-model",
        dimensions: 2,
      })
      .map((item) => item.startMessageId),
    [1, 3],
  );
});

test("stale retry never clears an existing dirty chunk or rewrites membership", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-embedding-dirty-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "messages.sqlite");
  const planner = new MessageStore(dbPath);
  const writer = new MessageStore(dbPath);
  t.after(() => {
    writer.close();
    planner.close();
  });
  const original = [message(1, "old text")];
  planner.upsertMessages(CHAT, original);
  const providerResult = chunk(original);
  planner.commitEmbeddingChunksIfCurrent(
    [providerResult],
    CHUNK_MAX_CHARS,
  );
  writer.upsertMessages(CHAT, [message(1, "new text")]);

  const before = embeddingAudit(dbPath);
  assert.notEqual(before.dirtyAt, null);
  assert.deepEqual(before.membership, [1]);
  const result = planner.commitEmbeddingChunksIfCurrent(
    [providerResult],
    CHUNK_MAX_CHARS,
  );
  const after = embeddingAudit(dbPath);

  assert.equal(result.committedChunks, 0);
  assert.equal(result.staleRanges[0]?.reason, "source_changed");
  assert.deepEqual(after, before);
});

test("sender/date source changes dirty a previously committed chunk", () => {
  const store = new MessageStore(":memory:");
  const original = [message(1, "same text")];
  store.upsertMessages(CHAT, original);
  store.commitEmbeddingChunksIfCurrent(
    [chunk(original)],
    CHUNK_MAX_CHARS,
  );

  store.upsertMessages(CHAT, [
    {
      ...original[0]!,
      senderName: "Bob",
    },
  ]);

  const [stored] = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: "test",
    model: "test-model",
    dimensions: 2,
    includeDirty: true,
  });
  assert.notEqual(stored?.dirtyAt, undefined);
  store.close();
});

test("atomic embedding commit rejects malformed chunk identity before writes", () => {
  const store = new MessageStore(":memory:");
  const messages = [message(1, "one"), message(2, "two")];
  store.upsertMessages(CHAT, messages);
  const malformed = {
    ...chunk(messages),
    messageIds: [1, 1],
  };

  assert.throws(
    () =>
      store.commitEmbeddingChunksIfCurrent(
        [malformed],
        CHUNK_MAX_CHARS,
      ),
    /unique and strictly ascending/u,
  );
  assert.deepEqual(
    store.getEmbeddingChunks({
      chatId: CHAT.chatId,
      namespace: "test",
      model: "test-model",
      dimensions: 2,
    }),
    [],
  );
  store.close();
});

function message(messageId: number, text: string): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: "2026-07-30T12:00:00.000Z",
    senderName: "Alice",
    text,
  };
}

function chunk(messages: StoredMessage[]): EmbeddingChunkVector {
  const text = renderEmbeddingChunkSource(messages, CHUNK_MAX_CHARS);
  return {
    chatId: CHAT.chatId,
    startMessageId: messages[0]!.messageId,
    endMessageId: messages.at(-1)!.messageId,
    messageIds: messages.map((item) => item.messageId),
    messageCount: messages.length,
    text,
    namespace: "test",
    model: "test-model",
    dimensions: 2,
    embedding: Buffer.alloc(8),
    contentHash: fingerprintEmbeddingSource(text),
  };
}

function embeddingAudit(dbPath: string): {
  dirtyAt: unknown;
  membership: number[];
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT id, dirty_at
         FROM message_embedding_chunks
         WHERE chat_id = ? AND start_message_id = 1 AND end_message_id = 1`,
      )
      .get(CHAT.chatId) as Record<string, unknown>;
    const membership = db
      .prepare(
        `SELECT message_id
         FROM message_embedding_chunk_messages
         WHERE chunk_id = ?
         ORDER BY position`,
      )
      .all(Number(row.id)) as Record<string, unknown>[];
    return {
      dirtyAt: row.dirty_at,
      membership: membership.map((item) => Number(item.message_id)),
    };
  } finally {
    db.close();
  }
}

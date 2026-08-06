/**
 * Offline retrieval evaluation seam.
 *
 * Validates the BM25 + dense + learned sparse pipeline end-to-end on a
 * synthetic fixture corpus using a deterministic hash encoder instead of a
 * real model: no network, no model artifacts, no production database. It
 * measures whether each channel and the RRF fusion surface the expected
 * evidence for the four operational query classes (exact names/quotes,
 * Russian morphology/slang, paraphrase with an anchor token, mixed RU/EN).
 *
 * Absolute recall here reflects fixture design with a hash encoder, not
 * model quality; run the same query classes against an approved snapshot
 * copy with the real local BGE-M3 backend before cutover decisions.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  renderEmbeddingChunkSource,
  fingerprintEmbeddingSource,
} from "../src/embedding-source.js";
import type { ChatInfo } from "../src/telegram-client.js";
import {
  MessageStore,
  type SparseTerm,
  type StoredMessage,
} from "../src/store.js";
import { fuseRankedChannels } from "../src/vector-rag.js";

const DENSE_DIMENSIONS = 64;
const CHUNK_MESSAGES = 2;
const RECALL_AT = 5;
const AGGREGATE_RECALL_TARGET = 0.75;

const CHAT: ChatInfo = {
  chatId: "-100eval",
  requested: "-100eval",
  kind: "supergroup",
};

type QueryClass =
  | "exact_name_quote"
  | "morphology_slang"
  | "paraphrase_anchor"
  | "mixed_ru_en";

type FixtureQuery = {
  class: QueryClass;
  query: string;
  expectedMessageIds: number[];
};

// Synthetic corpus. Any resemblance to private chat content is coincidental:
// every line is written for this fixture and contains no personal data.
const CORPUS: Array<{ id: number; text: string }> = [
  { id: 1, text: "Алексей предложил собрать релиз в пятницу" },
  { id: 2, text: "цитата: релиз без тестов не катит" },
  { id: 3, text: "договорились что деплой переносим на понедельник" },
  { id: 4, text: "деплой перенесли потому что упал стейджинг" },
  { id: 5, text: "Марина сказала что бюджет утвердили" },
  { id: 6, text: "бюджет на инфраструктуру согласован финотделом" },
  { id: 7, text: "обсуждали мониторинг алерты и дашборды" },
  { id: 8, text: "алертов слишком много надо группировать" },
  { id: 9, text: "фичу с авторизацией выкатили на прод" },
  { id: 10, text: "авторизация теперь через единый шлюз" },
  { id: 11, text: "созвон по архитектуре назначили на среду" },
  { id: 12, text: "архитектуру сервиса пересобрали на очереди" },
  { id: 13, text: "кранч перед релизом отменили" },
  { id: 14, text: "ревью кода обязательно для всех веток" },
  { id: 15, text: "incident review провели по горячим следам" },
  { id: 16, text: "hotfix выкатили за двадцать минут" },
];

const QUERIES: FixtureQuery[] = [
  {
    class: "exact_name_quote",
    query: "Алексей релиз",
    expectedMessageIds: [1],
  },
  {
    class: "exact_name_quote",
    query: "Марина бюджет",
    expectedMessageIds: [5],
  },
  {
    class: "exact_name_quote",
    query: "релиз без тестов не катит",
    expectedMessageIds: [2],
  },
  {
    class: "morphology_slang",
    query: "деплой переносим",
    expectedMessageIds: [3, 4],
  },
  {
    class: "morphology_slang",
    query: "кранч релиз",
    expectedMessageIds: [13],
  },
  {
    class: "paraphrase_anchor",
    query: "согласование денег на инфраструктуру бюджет",
    expectedMessageIds: [5, 6],
  },
  {
    class: "paraphrase_anchor",
    query: "жалобы на шумные алерты мониторинг",
    expectedMessageIds: [7, 8],
  },
  {
    class: "mixed_ru_en",
    query: "incident review разбор",
    expectedMessageIds: [15],
  },
  {
    class: "mixed_ru_en",
    query: "hotfix выкатили прод",
    expectedMessageIds: [16, 9],
  },
];

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(token, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/u)
    .filter(Boolean);
}

function denseOf(text: string): number[] {
  const vector = new Array<number>(DENSE_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    vector[hashToken(token) % DENSE_DIMENSIONS] = 1;
  }
  const norm = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function sparseOf(text: string): SparseTerm[] {
  const weights = new Map<number, number>();
  for (const [index, token] of tokenize(text).entries()) {
    const tokenId = hashToken(token) % 50_000;
    const weight = 1 + 1 / (index + 2);
    weights.set(tokenId, Math.max(weights.get(tokenId) ?? 0, weight));
  }
  return [...weights.entries()].map(([tokenId, weight]) => ({
    tokenId,
    weight: Number(weight.toFixed(6)),
  }));
}

function toMessage(entry: { id: number; text: string }): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId: entry.id,
    date: `2026-07-${String(entry.id % 28 + 1).padStart(2, "0")}T12:00:00.000Z`,
    senderId: `user-${entry.id}`,
    senderName: `user_${entry.id}`,
    text: entry.text,
  };
}

function cosine(left: number[], right: number[]): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index]! * right[index]!;
  }
  return score;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "parilka-retrieval-eval-"));
  const dbPath = join(dir, "eval.sqlite");
  const store = new MessageStore(dbPath);
  try {
    const messages = CORPUS.map(toMessage);
    store.upsertMessages(CHAT, messages);
    indexFixtureChunks(store, messages);
    const report = evaluate(store);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function indexFixtureChunks(
  store: MessageStore,
  messages: StoredMessage[],
): void {
  const namespace = "eval-hash-v1";
  for (let start = 0; start < messages.length; start += CHUNK_MESSAGES) {
    const group = messages.slice(start, start + CHUNK_MESSAGES);
    const text = renderEmbeddingChunkSource(group, 1_600);
    const committed = store.commitEmbeddingChunksIfCurrent(
      [
        {
          chatId: CHAT.chatId,
          startMessageId: group[0]!.messageId,
          endMessageId: group.at(-1)!.messageId,
          messageIds: group.map((message) => message.messageId),
          messageCount: group.length,
          text,
          namespace,
          model: "hash-eval",
          dimensions: DENSE_DIMENSIONS,
          embedding: float32Blob(denseOf(text)),
          contentHash: fingerprintEmbeddingSource(text),
          sparseTerms: sparseOf(text),
        },
      ],
      1_600,
    );
    if (committed.committedChunks !== 1) {
      throw new Error("fixture indexing must commit every chunk");
    }
  }
}

function float32Blob(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (const [index, value] of vector.entries()) {
    buffer.writeFloatLE(value, index * 4);
  }
  return buffer;
}

function evaluate(store: MessageStore): Record<string, unknown> {
  const started = performance.now();
  const perClass = new Map<
    QueryClass,
    { recallSum: number; count: number }
  >();
  const details: Array<Record<string, unknown>> = [];

  for (const fixture of QUERIES) {
    const candidateLimit = 24;
    const keywordHits = store.searchWithRank({
      chatId: CHAT.chatId,
      query: fixture.query,
      limit: candidateLimit,
    });
    const denseHits = denseChannel(store, fixture.query, candidateLimit);
    const sparseHits = sparseChannel(store, fixture.query, candidateLimit);
    const fused = fuseRankedChannels(
      [
        { channel: "dense", hits: denseHits },
        { channel: "sparse", hits: sparseHits },
        { channel: "bm25", hits: keywordHits },
      ],
      candidateLimit,
    );
    const retrieved = fusedMessages(fused, keywordHits, [
      ...denseHits,
      ...sparseHits,
    ]).slice(0, RECALL_AT);
    const expected = new Set(fixture.expectedMessageIds);
    const found = retrieved.filter((message) =>
      expected.has(message.messageId),
    ).length;
    const recall = expected.size === 0 ? 0 : found / expected.size;
    const bucket = perClass.get(fixture.class) ?? {
      recallSum: 0,
      count: 0,
    };
    bucket.recallSum += recall;
    bucket.count += 1;
    perClass.set(fixture.class, bucket);
    details.push({
      class: fixture.class,
      query: fixture.query,
      recallAtK: Number(recall.toFixed(3)),
      topSources: fused.slice(0, RECALL_AT).map((hit) => hit.source),
    });
  }

  const classes: Record<string, Record<string, unknown>> = {};
  let aggregateSum = 0;
  let aggregateCount = 0;
  for (const [name, bucket] of perClass) {
    const recall = bucket.recallSum / bucket.count;
    classes[name] = {
      queries: bucket.count,
      recallAtK: Number(recall.toFixed(3)),
    };
    aggregateSum += bucket.recallSum;
    aggregateCount += bucket.count;
  }
  const aggregate = aggregateSum / Math.max(1, aggregateCount);

  return {
    ok: aggregate >= AGGREGATE_RECALL_TARGET,
    k: RECALL_AT,
    aggregateRecallAtK: Number(aggregate.toFixed(3)),
    aggregateRecallTarget: AGGREGATE_RECALL_TARGET,
    classes,
    details,
    durationMs: Number((performance.now() - started).toFixed(2)),
    note: "Hash-encoder fixture seam; validates pipeline wiring, not model quality.",
  };
}

function denseChannel(
  store: MessageStore,
  query: string,
  limit: number,
) {
  const queryVector = denseOf(query);
  const chunks = store.getEmbeddingChunks({
    chatId: CHAT.chatId,
    namespace: "eval-hash-v1",
    model: "hash-eval",
    dimensions: DENSE_DIMENSIONS,
    limit: 1_000,
  });
  const scored = chunks
    .map((chunk) => ({
      chunk,
      score: cosine(
        queryVector,
        Array.from(
          new Float32Array(
            chunk.embedding.buffer,
            chunk.embedding.byteOffset,
            chunk.embedding.byteLength / 4,
          ),
        ),
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return scored.map((hit, index) =>
    chunkToHit(store, hit.chunk, hit.score, index),
  );
}

function sparseChannel(
  store: MessageStore,
  query: string,
  limit: number,
) {
  const chunkHits = store.searchSparseChunks({
    chatId: CHAT.chatId,
    namespace: "eval-hash-v1",
    model: "hash-eval",
    dimensions: DENSE_DIMENSIONS,
    terms: sparseOf(query),
    limit,
  });
  return chunkHits.map((hit, index) =>
    chunkToHit(store, hit.chunk, hit.score, index),
  );
}

function chunkToHit(
  store: MessageStore,
  chunk: {
    id: number;
    startMessageId: number;
    endMessageId: number;
    messageIds: number[];
    messageCount: number;
    text: string;
    namespace: string;
    model: string;
    dimensions: number;
  },
  score: number,
  index: number,
) {
  // Hydrate exactly like the production read path: channel hits carry the
  // real stored messages of their chunk, not an empty projection.
  const messages = store.getMessagesByIds({
    chatId: CHAT.chatId,
    messageIds: chunk.messageIds,
  });
  return {
    rank: index + 1,
    score,
    chunk,
    messages,
  };
}

function fusedMessages(
  fused: Array<{
    messageId?: number;
    startMessageId?: number;
    endMessageId?: number;
  }>,
  keywordHits: Array<{ message: StoredMessage }>,
  chunkHits: Array<{
    chunk: { startMessageId: number; endMessageId: number };
    messages: readonly StoredMessage[];
  }>,
): StoredMessage[] {
  const exact = new Map<number, StoredMessage>();
  for (const hit of keywordHits) {
    exact.set(hit.message.messageId, hit.message);
  }
  const chunksByRange = new Map<string, readonly StoredMessage[]>();
  for (const hit of chunkHits) {
    chunksByRange.set(
      rangeKey(hit.chunk.startMessageId, hit.chunk.endMessageId),
      hit.messages,
    );
    for (const message of hit.messages) {
      exact.set(message.messageId, message);
    }
  }
  const output: StoredMessage[] = [];
  const seen = new Set<number>();
  const append = (message: StoredMessage | undefined): void => {
    if (message && !seen.has(message.messageId)) {
      seen.add(message.messageId);
      output.push(message);
    }
  };
  for (const hit of fused) {
    if (hit.messageId !== undefined) {
      append(exact.get(hit.messageId));
      continue;
    }
    if (
      hit.startMessageId !== undefined &&
      hit.endMessageId !== undefined
    ) {
      for (const message of chunksByRange.get(
        rangeKey(hit.startMessageId, hit.endMessageId),
      ) ?? []) {
        append(message);
      }
    }
  }
  // Fill only from the real channel candidates; nothing is synthesized from
  // a global corpus, so broken hydration surfaces as missing evidence.
  for (const hit of keywordHits) {
    append(hit.message);
  }
  for (const hit of chunkHits) {
    for (const message of hit.messages) {
      append(message);
    }
  }
  return output;
}

function rangeKey(startMessageId: number, endMessageId: number): string {
  return `${startMessageId}:${endMessageId}`;
}

main();

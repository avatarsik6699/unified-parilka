import { z } from "zod";
import { ok, ToolError } from "../errors.js";
import type {
  KeywordSearchHit,
  StoredMessage,
} from "../store.js";
import { embeddingEstimateRequiresConfirmation } from "../vector-rag.js";
import type {
  HybridSearchHit,
  VectorSearchHit,
  VectorSearchResult,
} from "../vector/types.js";
import {
  contextCacheMetadata,
  historyCacheMetadata,
  publicEmbeddingStats,
} from "./cache-metadata.js";
import {
  chatSchema,
  limitSchema,
  type TelegramToolContext,
} from "./contracts.js";
import { throwIfToolAborted } from "./response.js";

const VECTOR_PROVIDER_FAILURE_MESSAGE =
  "Vector search is temporarily unavailable. Try again later.";
const MAX_PUBLIC_VECTOR_CANDIDATE_LIMIT = 1_000_000;

export async function readHistory(
  context: TelegramToolContext,
  rawArgs: unknown,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      limit: limitSchema.max(500).default(50),
      before_id: z.number().int().positive().optional(),
      after_id: z.number().int().positive().optional(),
      order: z.enum(["asc", "desc"]).default("desc"),
    })
    .strict()
    .parse(rawArgs ?? {});
  const chat = context.cacheChat(args.chat);
  const messages = context.store.getHistory({
    chatId: chat.chatId,
    limit: args.limit,
    beforeId: args.before_id,
    afterId: args.after_id,
    order: args.order,
  });
  const cacheStatus = context.store.getChatStatus(chat.chatId);
  return ok({
    chat,
    applied_filters: {
      limit: args.limit,
      before_id: args.before_id,
      after_id: args.after_id,
      order: args.order,
    },
    returned_count: messages.length,
    cache: historyCacheMetadata({
      status: cacheStatus,
      beforeId: args.before_id,
      afterId: args.after_id,
      returnedCount: messages.length,
    }),
    messages: messages.map(publicStoredMessage),
  });
}

export async function searchMessages(
  context: TelegramToolContext,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      query: z.string().min(1),
      limit: limitSchema.max(200).default(30),
      keyword_limit: limitSchema.max(200).optional(),
      vector_limit: limitSchema.max(50).optional(),
      hybrid_limit: limitSchema.max(100).optional(),
      before_id: z.number().int().positive().optional(),
      after_id: z.number().int().positive().optional(),
    })
    .strict()
    .parse(rawArgs ?? {});
  const chat = context.cacheChat(args.chat);
  const keywordLimit = args.keyword_limit ?? args.limit;
  const vectorLimit =
    args.vector_limit ??
    Math.min(
      args.limit,
      context.config.embeddings.searchLimit,
    );
  const hybridLimit = args.hybrid_limit ?? args.limit;
  const keywordHits = context.store.searchWithRank({
    chatId: chat.chatId,
    query: args.query,
    limit: keywordLimit,
    beforeId: args.before_id,
    afterId: args.after_id,
  });
  let vectorResult: VectorSearchResult;
  let vector: VectorSearchResult;
  try {
    vectorResult = await context.vectorRag.search({
      chatId: chat.chatId,
      query: args.query,
      limit: vectorLimit,
      beforeId: args.before_id,
      afterId: args.after_id,
      includeMessages: true,
      signal,
    });
    vector = publicVectorSearchResult(context, vectorResult);
  } catch (error) {
    throwIfToolAborted(signal);
    vector = publicVectorFailure(context, error, chat.chatId);
    vectorResult = vector;
  }
  const hybridHits = context.vectorRag.hybrid(
    keywordHits,
    vectorResult.hits,
    hybridLimit,
  );
  const publicKeywordHits = keywordHits.map(publicKeywordSearchHit);
  const publicHybridHits = hybridHits.map(publicHybridSearchHit);
  const vectorReason =
    vector.error ?? VECTOR_PROVIDER_FAILURE_MESSAGE;
  const degradedChannels = vector.available
    ? []
    : [
        {
          channel: "vector",
          reason: vectorReason,
        },
      ];
  return ok({
    status: degradedChannels.length > 0 ? "partial" : "done",
    chat,
    query: args.query,
    result_count: publicHybridHits.length,
    results: publicHybridHits,
    degraded_channels: degradedChannels,
    partial_failure:
      degradedChannels.length > 0
        ? { degraded_channels: degradedChannels }
        : null,
    messages: publicKeywordHits.map((hit) => hit.message),
    keyword: {
      count: keywordHits.length,
      hits: publicKeywordHits,
    },
    vector,
    hybrid: {
      count: hybridHits.length,
      raw_candidate_count:
        keywordHits.length + vectorResult.hits.length,
      hits: publicHybridHits,
    },
  });
}

export async function semanticSearchMessages(
  context: TelegramToolContext,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      query: z.string().min(1),
      limit: limitSchema
        .max(50)
        .default(context.config.embeddings.searchLimit),
      before_id: z.number().int().positive().optional(),
      after_id: z.number().int().positive().optional(),
      include_messages: z.boolean().default(true),
    })
    .strict()
    .parse(rawArgs ?? {});
  const chat = context.cacheChat(args.chat);
  const vector = publicVectorSearchResult(
    context,
    await context.vectorRag.search({
      chatId: chat.chatId,
      query: args.query,
      limit: args.limit,
      beforeId: args.before_id,
      afterId: args.after_id,
      includeMessages: args.include_messages,
      signal,
    }),
  );
  return ok({
    chat,
    query: args.query,
    vector,
  });
}

export async function indexEmbeddings(
  context: TelegramToolContext,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      limit_chunks: limitSchema
        .max(5000)
        .default(context.config.embeddings.tickChunkLimit),
      after_message_id: z
        .number()
        .int()
        .nonnegative()
        .optional(),
      rebuild: z.boolean().default(false),
      estimate_only: z.boolean().default(false),
      confirm_estimate: z.boolean().default(false),
    })
    .strict()
    .parse(rawArgs ?? {});
  const chat = context.cacheChat(args.chat);
  const estimate =
    context.vectorRag.estimateIndexCachedMessages({
      chatId: chat.chatId,
      limitChunks: args.limit_chunks,
      afterMessageId: args.after_message_id,
      rebuild: args.rebuild,
    });
  const requiresConfirmation =
    embeddingEstimateRequiresConfirmation(
      estimate,
      args.confirm_estimate,
    );
  if (args.estimate_only || requiresConfirmation) {
    return ok({
      chat,
      estimate,
      requires_confirmation: requiresConfirmation,
      result: null,
    });
  }
  return ok({
    chat,
    estimate,
    result: await context.vectorRag.indexCachedMessages({
      chatId: chat.chatId,
      limitChunks: args.limit_chunks,
      afterMessageId: args.after_message_id,
      rebuild: args.rebuild,
      confirmFirstRun: args.confirm_estimate,
      signal,
    }),
  });
}

export async function getThreadContext(
  context: TelegramToolContext,
  rawArgs: unknown,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      message_id: z.number().int().positive(),
      before: z
        .number()
        .int()
        .nonnegative()
        .max(500)
        .default(25),
      after: z
        .number()
        .int()
        .nonnegative()
        .max(500)
        .default(25),
    })
    .strict()
    .parse(rawArgs ?? {});
  const chat = context.cacheChat(args.chat);
  const messages = context.store.getThreadContext({
    chatId: chat.chatId,
    messageId: args.message_id,
    before: args.before,
    after: args.after,
  });
  const cacheStatus = context.store.getChatStatus(chat.chatId);
  const centerFound = messages.some(
    (message) => message.messageId === args.message_id,
  );
  return ok({
    chat,
    center_message_id: args.message_id,
    center_found: centerFound,
    requested_range: {
      start_message_id: Math.max(
        1,
        args.message_id - args.before,
      ),
      end_message_id: args.message_id + args.after,
      before: args.before,
      after: args.after,
    },
    returned_count: messages.length,
    cache: contextCacheMetadata({
      status: cacheStatus,
      messageId: args.message_id,
      before: args.before,
      after: args.after,
      returnedCount: messages.length,
    }),
    messages: messages.map(publicStoredMessage),
  });
}

function publicStoredMessage(message: StoredMessage): StoredMessage {
  const publicMessage: StoredMessage = {
    chatId: message.chatId,
    messageId: message.messageId,
    text: message.text,
  };
  if (message.date != null) {
    publicMessage.date = message.date;
  }
  if (message.senderId != null) {
    publicMessage.senderId = message.senderId;
  }
  if (message.senderName != null) {
    publicMessage.senderName = message.senderName;
  }
  if (message.replyToMessageId != null) {
    publicMessage.replyToMessageId = message.replyToMessageId;
  }
  if (message.topicId != null) {
    publicMessage.topicId = message.topicId;
  }
  if (message.deletedAt != null) {
    publicMessage.deletedAt = message.deletedAt;
  }
  return publicMessage;
}

function publicKeywordSearchHit(
  hit: KeywordSearchHit,
): KeywordSearchHit {
  return {
    rank: hit.rank,
    message: publicStoredMessage(hit.message),
  };
}

function publicVectorSearchHit(hit: VectorSearchHit): VectorSearchHit {
  return {
    rank: hit.rank,
    score: hit.score,
    chunk: {
      id: hit.chunk.id,
      startMessageId: hit.chunk.startMessageId,
      endMessageId: hit.chunk.endMessageId,
      messageCount: hit.chunk.messageCount,
      messageIds: [...hit.chunk.messageIds],
      text: hit.chunk.text,
      namespace: hit.chunk.namespace,
      model: hit.chunk.model,
      dimensions: hit.chunk.dimensions,
    },
    messages: hit.messages.map(publicStoredMessage),
  };
}

function publicHybridSearchHit(hit: HybridSearchHit): HybridSearchHit {
  const publicHit: HybridSearchHit = {
    rank: hit.rank,
    source: hit.source,
    sources: [...hit.sources],
    score: hit.score,
    text: hit.text,
  };
  if (hit.messageId != null) {
    publicHit.messageId = hit.messageId;
  }
  if (hit.startMessageId != null) {
    publicHit.startMessageId = hit.startMessageId;
  }
  if (hit.endMessageId != null) {
    publicHit.endMessageId = hit.endMessageId;
  }
  return publicHit;
}

function publicVectorSearchResult(
  context: TelegramToolContext,
  result: VectorSearchResult,
): VectorSearchResult {
  const stats = publicEmbeddingStats(result.stats);
  const available = result.available === true;
  const publicResult: VectorSearchResult = {
    available,
    stats,
    hits: result.hits.map(publicVectorSearchHit),
  };
  if (available) {
    const candidateLimit = publicVectorCandidateLimit(
      result.candidateLimit,
      context.config.embeddings.vectorCandidateLimit,
    );
    if (candidateLimit != null) {
      publicResult.candidateLimit = candidateLimit;
      const candidateCount = publicVectorCandidateCount(
        result.candidateCount,
        candidateLimit,
      );
      if (candidateCount != null) {
        publicResult.candidateCount = candidateCount;
      }
    }
    return publicResult;
  }
  publicResult.error = localVectorUnavailableReason(context, stats);
  return publicResult;
}

function publicVectorFailure(
  context: TelegramToolContext,
  error: unknown,
  chatId: string,
): VectorSearchResult {
  return {
    available: false,
    error: vectorFailureReason(context, error),
    stats: publicEmbeddingStats(context.store.getEmbeddingStats(chatId)),
    hits: [],
  };
}

function publicVectorCandidateLimit(
  value: unknown,
  expected: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_PUBLIC_VECTOR_CANDIDATE_LIMIT &&
    value === expected
    ? value
    : undefined;
}

function publicVectorCandidateCount(
  value: unknown,
  candidateLimit: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= candidateLimit
    ? value
    : undefined;
}

function vectorFailureReason(
  context: TelegramToolContext,
  error: unknown,
): string {
  if (isCandidateLimitFailure(error, context)) {
    return `Vector search candidate limit ${context.config.embeddings.vectorCandidateLimit} exceeded. Narrow the search with before_id/after_id or raise TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT after benchmarking.`;
  }
  return VECTOR_PROVIDER_FAILURE_MESSAGE;
}

function isCandidateLimitFailure(
  error: unknown,
  context: TelegramToolContext,
): boolean {
  return error instanceof ToolError &&
    error.normalized.message.startsWith(
      `Vector search candidate limit ${context.config.embeddings.vectorCandidateLimit} exceeded`,
    );
}

function localVectorUnavailableReason(
  context: TelegramToolContext,
  stats: Array<Record<string, unknown>>,
): string {
  if (
    context.store.isMaintenanceJobPending(
      "embedding_chunk_membership_backfill",
    )
  ) {
    return "Vector search is temporarily unavailable while chunk membership backfill is pending. Run state maintenance with --apply.";
  }
  if (!context.config.embeddings.enabled) {
    return "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.";
  }
  if (!context.config.embeddings.apiKey) {
    return "Embedding API key is missing. Set OPENAI_API_KEY or TELEGRAM_EMBEDDINGS_API_KEY.";
  }
  if (stats.length === 0) {
    return "No vector chunks indexed yet. Run index_embeddings first.";
  }
  return "Vector search is unavailable.";
}

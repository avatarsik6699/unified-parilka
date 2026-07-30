import { z } from "zod";
import { ok } from "../errors.js";
import { embeddingEstimateRequiresConfirmation } from "../vector-rag.js";
import {
  contextCacheMetadata,
  historyCacheMetadata,
} from "./cache-metadata.js";
import {
  chatSchema,
  limitSchema,
  type TelegramToolContext,
} from "./contracts.js";
import { throwIfToolAborted } from "./response.js";

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
    messages,
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
  const vector = await context.vectorRag
    .search({
      chatId: chat.chatId,
      query: args.query,
      limit: vectorLimit,
      beforeId: args.before_id,
      afterId: args.after_id,
      includeMessages: true,
      signal,
    })
    .catch((error) => {
      throwIfToolAborted(signal);
      return {
        available: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
        stats: context.store.getEmbeddingStats(chat.chatId),
        hits: [],
      };
    });
  const hybridHits = context.vectorRag.hybrid(
    keywordHits,
    vector.hits,
    hybridLimit,
  );
  const degradedChannels = vector.available
    ? []
    : [
        {
          channel: "vector",
          reason:
            vector.error ?? "Vector search is unavailable.",
        },
      ];
  return ok({
    status: degradedChannels.length > 0 ? "partial" : "done",
    chat,
    query: args.query,
    result_count: hybridHits.length,
    results: hybridHits,
    degraded_channels: degradedChannels,
    partial_failure:
      degradedChannels.length > 0
        ? { degraded_channels: degradedChannels }
        : null,
    messages: keywordHits.map((hit) => hit.message),
    keyword: {
      count: keywordHits.length,
      hits: keywordHits,
    },
    vector,
    hybrid: {
      count: hybridHits.length,
      raw_candidate_count:
        keywordHits.length + vector.hits.length,
      hits: hybridHits,
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
  return ok({
    chat,
    query: args.query,
    vector: await context.vectorRag.search({
      chatId: chat.chatId,
      query: args.query,
      limit: args.limit,
      beforeId: args.before_id,
      afterId: args.after_id,
      includeMessages: args.include_messages,
      signal,
    }),
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
    messages,
  });
}

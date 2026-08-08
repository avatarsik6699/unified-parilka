import { TranscriptCursorError, type StoredMessage } from "../../store.js";
import { calendarDayRange } from "./calendar.js";
import type {
  BotReadToolCache,
  BotReadToolSuccess,
  CachedChatSearchResult,
} from "./contracts.js";
import {
  chatEvidence,
  deduplicateEvidence,
  projectDigest,
  ReadToolExecutionError,
  success,
} from "./payload.js";
import type {
  DayDigestArgs,
  KeywordSearchArgs,
  ReadChatSliceArgs,
  RagBm25SearchArgs,
  ThreadContextArgs,
} from "./schemas.js";
import { callCacheSearch } from "./timeouts.js";

export interface CacheExecutorContext {
  chatId: string;
  cache: BotReadToolCache;
  timeZone: string;
  chatSearchTimeoutMs: number;
  /** Durable sender id of this bot's own published messages. */
  botSenderId?: string;
}

export async function executeRagBm25Search(
  context: CacheExecutorContext,
  args: RagBm25SearchArgs,
  sourceMessageId: number | undefined,
  externalSignal: AbortSignal | undefined,
): Promise<BotReadToolSuccess> {
  const cached = await callCacheSearch({
    operation: (signal) =>
      context.cache.search({
        chatId: context.chatId,
        query: args.query,
        limit: args.limit,
        signal,
        ...(sourceMessageId === undefined
          ? {}
          : { beforeId: sourceMessageId }),
      }),
    timeoutMs: context.chatSearchTimeoutMs,
    externalSignal,
  });
  const normalized: CachedChatSearchResult = Array.isArray(cached)
    ? {
        messages: cached as readonly StoredMessage[],
        mode: "keyword",
        degradedChannels: [],
      }
    : (cached as CachedChatSearchResult);
  if (
    !normalized ||
    !Array.isArray(normalized.messages) ||
    !["hybrid", "keyword", "semantic"].includes(normalized.mode)
  ) {
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Chat search returned an invalid result.",
    );
  }
  const evidence = chatEvidence(
    normalized.messages,
    context.chatId,
    context.botSenderId,
  );
  return success(
    "rag_bm25_search",
    evidence.length === 0 ? "empty" : "done",
    {
      query: args.query,
      limit: args.limit,
      returnedCount: evidence.length,
      mode: normalized.mode,
      degradedChannels: [
        ...(normalized.degradedChannels ?? []),
      ],
      ...(normalized.channels === undefined
        ? {}
        : { channels: normalized.channels }),
    },
    evidence,
  );
}

/**
 * Cache-only lexical search. The authoritative upper bound is derived from
 * the application-owned trigger id, never from model-provided ids: the tool
 * cannot see the trigger message or anything above it.
 */
export function executeKeywordSearch(
  context: CacheExecutorContext,
  args: KeywordSearchArgs,
  sourceMessageId: number | undefined,
): BotReadToolSuccess {
  const range =
    args.day_from === undefined
      ? undefined
      : calendarDayRange(args.day_from, args.day_to, context.timeZone);
  const beforeId = clampUpperBeforeId(args.before_id, sourceMessageId);
  const messages = fromCache(() =>
    context.cache.findMessages({
      chatId: context.chatId,
      query: args.query,
      match: args.match,
      ...(args.sender === undefined ? {} : { sender: args.sender }),
      includeBot: args.include_bot,
      ...(range === undefined
        ? {}
        : {
            startInclusive: range.startInclusive,
            endExclusive: range.endExclusive,
          }),
      ...(beforeId === undefined ? {} : { beforeId }),
      ...(args.after_id === undefined ? {} : { afterId: args.after_id }),
      order: args.order,
      limit: args.limit,
    }),
  );
  const evidence = chatEvidence(messages, context.chatId, context.botSenderId);
  return success(
    "keyword_search",
    evidence.length === 0 ? "empty" : "done",
    {
      query: args.query,
      match: args.match,
      order: args.order,
      limit: args.limit,
      returnedCount: evidence.length,
      filters: {
        ...(args.sender === undefined ? {} : { sender: args.sender }),
        includeBot: args.include_bot,
        ...(range === undefined
          ? {}
          : { dayFrom: range.dayFrom, dayTo: range.dayTo }),
        ...(beforeId === undefined ? {} : { beforeId }),
        ...(args.after_id === undefined ? {} : { afterId: args.after_id }),
      },
    },
    evidence,
  );
}

/**
 * Cache-only continuous transcript slice. The snapshot upper bound is always
 * `sourceMessageId - 1` from the application-owned call options, so the slice
 * ends right before the current trigger and is stable against messages
 * inserted after the turn started.
 */
export function executeReadChatSlice(
  context: CacheExecutorContext,
  args: ReadChatSliceArgs,
  sourceMessageId: number | undefined,
): BotReadToolSuccess {
  const upperMessageId =
    sourceMessageId === undefined ? undefined : sourceMessageId - 1;
  const range =
    args.mode === "period" && args.cursor === undefined && args.day_from !== undefined
      ? calendarDayRange(args.day_from, args.day_to, context.timeZone)
      : undefined;
  const transcript = fromCache(() => {
    if (args.cursor !== undefined) {
      return context.cache.readSlice({
        chatId: context.chatId,
        form: args.mode,
        cursor: args.cursor,
        ...(upperMessageId === undefined
          ? {}
          : { upperMessageId }),
      });
    }
    if (args.mode === "recent") {
      if (args.count === undefined) {
        throw new ReadToolExecutionError(
          "invalid_arguments",
          false,
          "recent requires count.",
        );
      }
      return context.cache.readSlice({
        chatId: context.chatId,
        form: "recent",
        count: args.count,
        ...(upperMessageId === undefined ? {} : { upperMessageId }),
      });
    }
    if (range === undefined) {
      throw new ReadToolExecutionError(
        "invalid_arguments",
        false,
        "period requires day_from.",
      );
    }
    return context.cache.readSlice({
      chatId: context.chatId,
      form: "period",
      startInclusive: range.startInclusive,
      endExclusive: range.endExclusive,
      ...(upperMessageId === undefined ? {} : { upperMessageId }),
    });
  });

  const { coverage } = transcript;
  const projected = transcript.messages.map((message) => {
    const isOwnTurn =
      context.botSenderId !== undefined &&
      message.senderId === context.botSenderId;
    return {
      sourceId: `chat:${message.messageId}`,
      messageId: message.messageId,
      senderId: message.senderId ?? null,
      senderName: message.senderName ?? null,
      date: message.date ?? null,
      replyToMessageId: message.replyToMessageId ?? null,
      authorRole: isOwnTurn ? "assistant" : "user",
      isOwnTurn,
      text: message.text,
    };
  });
  return success(
    "read_chat_slice",
    projected.length === 0 ? "empty" : "done",
    {
      mode: transcript.form,
      requested:
        args.cursor !== undefined
          ? { continuation: true }
          : args.mode === "recent"
            ? { count: args.count }
            : {
                dayFrom: range?.dayFrom,
                dayTo: range?.dayTo,
                startInclusive: range?.startInclusive,
                endExclusive: range?.endExclusive,
              },
      coverage: {
        upperMessageId: coverage.upperMessageId,
        totalAvailable: coverage.totalAvailable,
        returnedCount: coverage.returnedCount,
        coveredCount: coverage.coveredCount,
        ...(coverage.firstMessageId === undefined
          ? {}
          : {
              firstMessageId: coverage.firstMessageId,
              lastMessageId: coverage.lastMessageId,
              firstDate: coverage.firstDate ?? null,
              lastDate: coverage.lastDate ?? null,
            }),
        emptyTextCount: coverage.emptyTextCount,
        truncated: coverage.truncated,
        omittedCount: coverage.omittedCount,
        hasMore: coverage.hasMore,
        ...(coverage.nextCursor === undefined
          ? {}
          : { nextCursor: coverage.nextCursor }),
      },
      messages: projected,
    },
    [],
  );
}

/**
 * Thread window around a cached message. The exclusive application-owned
 * `beforeId` is part of the owning query itself, so rows at or above the
 * trigger are never fetched; a future center simply reports centerFound
 * false.
 */
export function executeThreadContext(
  context: CacheExecutorContext,
  args: ThreadContextArgs,
  sourceMessageId: number | undefined,
): BotReadToolSuccess {
  const messages = fromCache(() =>
    context.cache.getThreadContext({
      chatId: context.chatId,
      messageId: args.message_id,
      before: args.before,
      after: args.after,
      ...(sourceMessageId === undefined
        ? {}
        : { beforeId: sourceMessageId }),
    }),
  );
  const evidence = chatEvidence(messages, context.chatId, context.botSenderId);
  return success(
    "thread_context",
    evidence.length === 0 ? "empty" : "done",
    {
      centerMessageId: args.message_id,
      centerFound: evidence.some(
        (item) => item.message?.id === args.message_id,
      ),
      before: args.before,
      after: args.after,
      returnedCount: evidence.length,
    },
    evidence,
  );
}

/**
 * A missing digest is ambiguous: the day may have no messages at all, or the
 * digest may simply not be built yet. When no digest is cached, a cache-only
 * period probe of the same causal range distinguishes the two so the model
 * can decide to read the raw slice instead of reporting an empty day.
 */
export function executeDayDigest(
  context: CacheExecutorContext,
  args: DayDigestArgs,
  sourceMessageId: number | undefined,
): BotReadToolSuccess {
  const range = calendarDayRange(
    args.day_from,
    args.day_to,
    context.timeZone,
  );
  const cached = fromCache(() =>
    context.cache.getDigests({
      chatId: context.chatId,
      ...range,
      preferWeekly: range.dayCount > 5,
      ...(sourceMessageId === undefined
        ? {}
        : { sourceMessageId }),
    }),
  );
  if (!cached || !Array.isArray(cached.digests)) {
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Digest cache returned an invalid result.",
    );
  }

  if (cached.digests.length > 0) {
    const projected = cached.digests.map((digest) =>
      projectDigest(digest, context.chatId),
    );
    const sourceEvidence = chatEvidence(
      cached.sourceMessages ?? [],
      context.chatId,
      context.botSenderId,
    );
    const evidence = deduplicateEvidence([
      ...projected.map(({ evidence: item }) => item),
      ...sourceEvidence,
    ]);
    return success(
      "day_digest",
      "done",
      {
        range,
        preferWeekly: range.dayCount > 5,
        digestState: "available",
        returnedCount: projected.length,
        digests: projected.map(({ result }) => result),
      },
      evidence,
    );
  }

  // The probe is causal: the same sourceMessageId - 1 snapshot bound as
  // read_chat_slice, so it never sees the trigger or anything above it.
  const upperMessageId =
    sourceMessageId === undefined ? undefined : sourceMessageId - 1;
  const probe = fromCache(() =>
    context.cache.readSlice({
      chatId: context.chatId,
      form: "period",
      startInclusive: range.startInclusive,
      endExclusive: range.endExclusive,
      ...(upperMessageId === undefined ? {} : { upperMessageId }),
    }),
  );
  const sourceMessageCount = probe.coverage.totalAvailable;
  if (sourceMessageCount > 0) {
    return success(
      "day_digest",
      "done",
      {
        range,
        preferWeekly: range.dayCount > 5,
        digestState: "not_ready",
        sourceMessageCount,
        returnedCount: 0,
        digests: [],
        suggestedRead: {
          tool: "read_chat_slice",
          mode: "period",
          day_from: range.dayFrom,
          day_to: range.dayTo,
        },
      },
      [],
    );
  }
  return success(
    "day_digest",
    "empty",
    {
      range,
      preferWeekly: range.dayCount > 5,
      digestState: "no_messages",
      sourceMessageCount: 0,
      returnedCount: 0,
      digests: [],
    },
    [],
  );
}

function fromCache<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ReadToolExecutionError) {
      throw error;
    }
    if (error instanceof TranscriptCursorError) {
      throw new ReadToolExecutionError(
        "invalid_arguments",
        false,
        "Slice cursor failed validation.",
      );
    }
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Local cache read failed.",
    );
  }
}

/**
 * `beforeId` is exclusive, so the trigger id itself is the correct clamp to
 * hide the trigger and everything above it.
 */
function clampUpperBeforeId(
  beforeId: number | undefined,
  sourceMessageId: number | undefined,
): number | undefined {
  if (sourceMessageId === undefined) {
    return beforeId;
  }
  if (beforeId === undefined) {
    return sourceMessageId;
  }
  return Math.min(beforeId, sourceMessageId);
}

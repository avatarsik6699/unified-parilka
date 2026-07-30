import type { StoredMessage } from "../../store.js";
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
  SearchChatArgs,
  ThreadContextArgs,
} from "./schemas.js";
import { callCacheSearch } from "./timeouts.js";

export interface CacheExecutorContext {
  chatId: string;
  cache: BotReadToolCache;
  timeZone: string;
  chatSearchTimeoutMs: number;
}

export async function executeSearchChat(
  context: CacheExecutorContext,
  args: SearchChatArgs,
  externalSignal: AbortSignal | undefined,
): Promise<BotReadToolSuccess> {
  const cached = await callCacheSearch({
    operation: (signal) =>
      context.cache.search({
        chatId: context.chatId,
        query: args.query,
        limit: args.limit,
        signal,
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
  );
  return success(
    "search_chat",
    evidence.length === 0 ? "empty" : "done",
    {
      query: args.query,
      limit: args.limit,
      returnedCount: evidence.length,
      mode: normalized.mode,
      degradedChannels: [
        ...(normalized.degradedChannels ?? []),
      ],
    },
    evidence,
  );
}

export function executeThreadContext(
  context: CacheExecutorContext,
  args: ThreadContextArgs,
): BotReadToolSuccess {
  const messages = fromCache(() =>
    context.cache.getThreadContext({
      chatId: context.chatId,
      messageId: args.message_id,
      before: args.before,
      after: args.after,
    }),
  );
  const evidence = chatEvidence(messages, context.chatId);
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

export function executeDayDigest(
  context: CacheExecutorContext,
  args: DayDigestArgs,
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
    }),
  );
  if (!cached || !Array.isArray(cached.digests)) {
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Digest cache returned an invalid result.",
    );
  }

  const projected = cached.digests.map((digest) =>
    projectDigest(digest, context.chatId),
  );
  const sourceEvidence = chatEvidence(
    cached.sourceMessages ?? [],
    context.chatId,
  );
  const evidence = deduplicateEvidence([
    ...projected.map(({ evidence: item }) => item),
    ...sourceEvidence,
  ]);
  return success(
    "day_digest",
    projected.length === 0 ? "empty" : "done",
    {
      range,
      preferWeekly: range.dayCount > 5,
      returnedCount: projected.length,
      digests: projected.map(({ result }) => result),
    },
    evidence,
  );
}

function fromCache<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ReadToolExecutionError) {
      throw error;
    }
    throw new ReadToolExecutionError(
      "cache_error",
      false,
      "Local cache read failed.",
    );
  }
}

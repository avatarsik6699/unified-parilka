import type {
  KeywordSearchHit,
  MessageStore,
  StoredMessage,
} from "../store.js";
import type {
  HybridSearchHit,
  VectorSearchHit,
} from "../vector-rag.js";
import type { JsonEventLogger } from "./worker.js";
import type {
  BotReadToolCache,
  CachedChatSearchResult,
  CachedDigestResult,
  DigestCacheQuery,
} from "./read-tools.js";

const SEARCH_CANDIDATE_MULTIPLIER = 3;
const MAX_SEARCH_CANDIDATES = 24;
const MAX_DIGEST_ROWS = 100;

export interface BotVectorSearchPort {
  search(params: {
    chatId: string;
    query: string;
    limit?: number;
    includeMessages?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    available: boolean;
    hits: VectorSearchHit[];
  }>;
  hybrid(
    keywordHits: KeywordSearchHit[],
    vectorHits: VectorSearchHit[],
    limit: number,
  ): HybridSearchHit[];
}

/**
 * Direct adapter over the canonical SQLite/FTS/vector cache.
 *
 * The bot deliberately does not call its own MCP server. This keeps one set of
 * storage/search semantics while avoiding a loopback protocol hop and another
 * place to configure credentials.
 */
export class CanonicalBotReadCache implements BotReadToolCache {
  readonly #store: MessageStore;
  readonly #vector: BotVectorSearchPort | undefined;
  readonly #logger: JsonEventLogger | undefined;

  constructor(options: {
    store: MessageStore;
    vector?: BotVectorSearchPort;
    logger?: JsonEventLogger;
  }) {
    this.#store = options.store;
    this.#vector = options.vector;
    this.#logger = options.logger;
  }

  async search(params: {
    chatId: string;
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<CachedChatSearchResult> {
    throwIfAborted(params.signal);
    const candidateLimit = Math.min(
      MAX_SEARCH_CANDIDATES,
      Math.max(params.limit, params.limit * SEARCH_CANDIDATE_MULTIPLIER),
    );
    const degradedChannels: string[] = [];
    let keywordHits: KeywordSearchHit[] = [];
    let keywordAvailable = true;
    try {
      keywordHits = this.#store.searchWithRank({
        chatId: params.chatId,
        query: params.query,
        limit: candidateLimit,
      });
    } catch (error) {
      keywordAvailable = false;
      degradedChannels.push("keyword_failed");
      this.#log("warn", "bot.read_cache.keyword_failed", {
        code: error instanceof Error ? (error as Error & { code?: string }).code ?? error.name : "unknown",
      });
    }
    throwIfAborted(params.signal);

    if (!this.#vector) {
      degradedChannels.push("semantic_disabled");
      if (!keywordAvailable) {
        throw new Error("No chat search channel is available.");
      }
      return {
        messages: keywordHits
          .slice(0, params.limit)
          .map((hit) => hit.message),
        mode: "keyword",
        degradedChannels,
      };
    }

    let vectorHits: VectorSearchHit[] = [];
    let vectorAvailable = false;
    try {
      const vector = await this.#vector.search({
        chatId: params.chatId,
        query: params.query,
        limit: candidateLimit,
        includeMessages: true,
        signal: params.signal,
      });
      throwIfAborted(params.signal);
      vectorAvailable = vector.available;
      vectorHits = vector.available ? vector.hits : [];
      if (!vector.available) {
        degradedChannels.push("semantic_unavailable");
      }
    } catch (error) {
      throwIfAborted(params.signal);
      degradedChannels.push("semantic_failed");
    }

    if (!keywordAvailable && !vectorAvailable) {
      throw new Error("No chat search channel is available.");
    }
    if (!vectorAvailable) {
      return {
        messages: keywordHits
          .slice(0, params.limit)
          .map((hit) => hit.message),
        mode: "keyword",
        degradedChannels,
      };
    }
    if (!keywordAvailable) {
      return {
        messages: uniqueVectorMessages(vectorHits, params.limit),
        mode: "semantic",
        degradedChannels,
      };
    }

    const ranked = this.#vector.hybrid(
      keywordHits,
      vectorHits,
      candidateLimit,
    );
    return {
      messages: hydrateHybridMessages({
        ranked,
        keywordHits,
        vectorHits,
        limit: params.limit,
      }),
      mode: "hybrid",
      degradedChannels,
    };
  }

  getThreadContext(params: {
    chatId: string;
    messageId: number;
    before: number;
    after: number;
  }): readonly StoredMessage[] {
    return this.#store.getThreadContext(params);
  }

  getDigests(params: DigestCacheQuery): CachedDigestResult {
    if (params.preferWeekly) {
      const weeks = this.#store.getDigestRollups({
        chatId: params.chatId,
        kind: "week",
        dayFrom: params.dayFrom,
        dayTo: params.dayTo,
        limit: MAX_DIGEST_ROWS,
      });
      if (weeks.length > 0) {
        return {
          digests: weeks.map((digest) => ({
            kind: "week",
            period: digest.period,
            dayFrom: digest.dayFrom,
            dayTo: digest.dayTo,
            text: digest.text,
          })),
        };
      }
    }

    return {
      digests: this.#store
        .getDayDigests({
          chatId: params.chatId,
          dayFrom: params.dayFrom,
          dayTo: params.dayTo,
          limit: MAX_DIGEST_ROWS,
        })
        .map((digest) => ({
          kind: "day",
          period: digest.day,
          dayFrom: digest.day,
          dayTo: digest.day,
          text: digest.text,
          startMessageId: digest.startMessageId,
          endMessageId: digest.endMessageId,
        })),
    };
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Observability must never break read-cache fallback behavior.
    }
  }
}

function hydrateHybridMessages(params: {
  ranked: readonly HybridSearchHit[];
  keywordHits: readonly KeywordSearchHit[];
  vectorHits: readonly VectorSearchHit[];
  limit: number;
}): StoredMessage[] {
  const exact = new Map<number, StoredMessage>();
  for (const hit of params.keywordHits) {
    exact.set(hit.message.messageId, hit.message);
  }
  const vectorsByRange = new Map<string, readonly StoredMessage[]>();
  for (const hit of params.vectorHits) {
    vectorsByRange.set(
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
    if (
      message &&
      output.length < params.limit &&
      !seen.has(message.messageId)
    ) {
      seen.add(message.messageId);
      output.push(message);
    }
  };

  for (const hit of params.ranked) {
    if (output.length >= params.limit) {
      break;
    }
    if (hit.messageId !== undefined) {
      append(exact.get(hit.messageId));
      continue;
    }
    if (
      hit.startMessageId !== undefined &&
      hit.endMessageId !== undefined
    ) {
      for (const message of vectorsByRange.get(
        rangeKey(hit.startMessageId, hit.endMessageId),
      ) ?? []) {
        append(message);
      }
    }
  }

  // A custom vector implementation can return a partial hybrid projection.
  // Fill from exact candidates without inventing synthetic evidence.
  for (const hit of params.keywordHits) {
    append(hit.message);
  }
  for (const hit of params.vectorHits) {
    for (const message of hit.messages) {
      append(message);
    }
  }
  return output;
}

function uniqueVectorMessages(
  hits: readonly VectorSearchHit[],
  limit: number,
): StoredMessage[] {
  const output: StoredMessage[] = [];
  const seen = new Set<number>();
  for (const hit of hits) {
    for (const message of hit.messages) {
      if (!seen.has(message.messageId)) {
        seen.add(message.messageId);
        output.push(message);
        if (output.length >= limit) {
          return output;
        }
      }
    }
  }
  return output;
}

function rangeKey(startMessageId: number, endMessageId: number): string {
  return `${startMessageId}:${endMessageId}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Chat search was aborted.", "AbortError");
  }
}

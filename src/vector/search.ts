import type { AppConfig } from "../config.js";
import {
  blobToVector,
  cosineSimilarity,
  type EmbeddingClient,
} from "../embeddings.js";
import { ToolError } from "../errors.js";
import {
  MessageStore,
  type StoredEmbeddingChunk,
} from "../store.js";
import { formatMessage } from "./source-formatter.js";
import type {
  VectorSearchHit,
  VectorSearchParams,
  VectorSearchResult,
} from "./types.js";

export class VectorSearcher {
  constructor(
    private readonly config: AppConfig,
    private readonly store: MessageStore,
    private readonly embeddings: EmbeddingClient,
    private readonly namespace: string,
  ) {}

  async search(
    params: VectorSearchParams,
  ): Promise<VectorSearchResult> {
    const stats = this.store.getEmbeddingStats(params.chatId, {
      namespace: this.namespace,
    });
    if (
      this.store.isMaintenanceJobPending(
        "embedding_chunk_membership_backfill",
      )
    ) {
      return {
        available: false,
        error:
          "Vector search is temporarily unavailable while chunk membership backfill is pending. Run state maintenance with --apply.",
        stats,
        hits: [],
      };
    }
    if (!this.embeddings.isConfigured) {
      return {
        available: false,
        error: this.config.embeddings.enabled
          ? "Embedding API key is missing. Set OPENAI_API_KEY or TELEGRAM_EMBEDDINGS_API_KEY."
          : "Embeddings are disabled. Set TELEGRAM_EMBEDDINGS_ENABLED=true.",
        stats,
        hits: [],
      };
    }
    if (stats.length === 0) {
      return {
        available: false,
        error:
          "No vector chunks indexed yet. Run index_embeddings first.",
        stats,
        hits: [],
      };
    }

    const limit = Math.max(
      1,
      Math.min(
        params.limit ?? this.config.embeddings.searchLimit,
        50,
      ),
    );
    const queryVector = await this.embeddings.embedQuery(
      params.query,
      params.signal,
    );
    const searchDimensions =
      this.config.embeddings.dimensions ?? queryVector.length;
    const chunks = this.store.getEmbeddingChunks({
      chatId: params.chatId,
      namespace: this.namespace,
      model: this.config.embeddings.model,
      dimensions: searchDimensions,
      beforeId: params.beforeId,
      afterId: params.afterId,
      limit: this.config.embeddings.vectorCandidateLimit + 1,
    });
    if (
      chunks.length >
      this.config.embeddings.vectorCandidateLimit
    ) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: `Vector search candidate limit ${this.config.embeddings.vectorCandidateLimit} exceeded for model ${this.config.embeddings.model} and dimensions ${searchDimensions}. Narrow the search with before_id/after_id or raise TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT after benchmarking.`,
      });
    }
    const mismatchedChunk = chunks.find(
      (chunk) => chunk.dimensions !== queryVector.length,
    );
    if (mismatchedChunk) {
      throw new ToolError({
        category: "internal",
        retryable: false,
        message: `Refusing mixed-dimension vector comparison: query has ${queryVector.length} dimensions but chunk ${mismatchedChunk.id} has ${mismatchedChunk.dimensions}.`,
      });
    }

    const hits = chunks
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(
          queryVector,
          blobToVector(chunk.embedding),
        ),
      }))
      .sort((left, right) => right.score - left.score)
      .map((hit) =>
        this.toVectorHit(
          hit.chunk,
          hit.score,
          params.includeMessages ?? true,
          {
            beforeId: params.beforeId,
            afterId: params.afterId,
          },
        ),
      )
      .filter((hit): hit is VectorSearchHit => hit != null)
      .slice(0, limit)
      .map((hit, index) => ({ ...hit, rank: index + 1 }));

    return {
      available: true,
      stats,
      candidateLimit:
        this.config.embeddings.vectorCandidateLimit,
      candidateCount: chunks.length,
      hits,
    };
  }

  private toVectorHit(
    chunk: StoredEmbeddingChunk,
    score: number,
    includeMessages: boolean,
    window: { beforeId?: number; afterId?: number },
  ): VectorSearchHit | undefined {
    const messageIds = chunk.messageIds.filter((messageId) =>
      messageIdInWindow(messageId, window),
    );
    if (messageIds.length === 0) {
      return undefined;
    }
    const trimmed = messageIds.length !== chunk.messageIds.length;
    const visibleMessages =
      includeMessages || trimmed
        ? this.store.getMessagesByIds({
            chatId: chunk.chatId,
            messageIds,
          })
        : [];
    const visibleText = trimmed
      ? visibleMessages
          .map((message) => formatMessage(message))
          .join("\n")
      : chunk.text;
    return {
      rank: 0,
      score,
      chunk: {
        id: chunk.id,
        startMessageId: Math.min(...messageIds),
        endMessageId: Math.max(...messageIds),
        messageIds,
        messageCount: messageIds.length,
        text: visibleText,
        namespace: chunk.namespace,
        model: chunk.model,
        dimensions: chunk.dimensions,
      },
      messages: includeMessages ? visibleMessages : [],
    };
  }
}

function messageIdInWindow(
  messageId: number,
  window: { beforeId?: number; afterId?: number },
): boolean {
  if (window.beforeId != null && messageId >= window.beforeId) {
    return false;
  }
  if (window.afterId != null && messageId <= window.afterId) {
    return false;
  }
  return true;
}

export function assertVectorSearchReady(result: {
  available: boolean;
  error?: string;
}): void {
  if (!result.available) {
    throw new ToolError({
      category: "internal",
      retryable: false,
      message: result.error ?? "Vector search is unavailable.",
    });
  }
}

import type { StoredMessage } from "../store.js";

export type EmbeddingIndexResult = {
  ok: true;
  chatId: string;
  model: string;
  dimensions?: number;
  namespace: string;
  normalizationVersion: string;
  chunksCreated: number;
  messagesCovered: number;
  nextAfterMessageId?: number;
  deletedChunks?: number;
  dirtyChunksDeleted?: number;
  staleChunks?: number;
  budget: EmbeddingRunBudget;
  coverage: Record<string, number>;
  stats: Array<Record<string, unknown>>;
};

export type EmbeddingRunBudget = {
  requestedLimitChunks: number;
  effectiveLimitChunks: number;
  maxChunksPerRun: number;
  maxCharsPerRun: number;
  truncatedByChunkBudget: boolean;
  truncatedByCharBudget: boolean;
};

export type EmbeddingIndexEstimate = {
  provider: string;
  baseUrl: string;
  model: string;
  dimensions?: number;
  namespace: string;
  normalizationVersion: string;
  chatId: string;
  limitChunks: number;
  requestedLimitChunks: number;
  estimatedChunks: number;
  estimatedMessages: number;
  estimatedChars: number;
  existingChunks: number;
  budget: EmbeddingRunBudget;
  coverage: Record<string, number>;
  firstRun: boolean;
  requiresConfirmation: boolean;
  privacy: string;
};

export type VectorSearchHit = {
  rank: number;
  score: number;
  chunk: {
    id: number;
    startMessageId: number;
    endMessageId: number;
    messageCount: number;
    messageIds: number[];
    text: string;
    namespace: string;
    model: string;
    dimensions: number;
  };
  messages: StoredMessage[];
};

export type HybridSearchHit = {
  rank: number;
  source: "keyword" | "vector" | "hybrid";
  sources: Array<"keyword" | "vector">;
  score: number;
  messageId?: number;
  startMessageId?: number;
  endMessageId?: number;
  text: string;
};

export interface VectorSearchResult {
  /**
   * Dense channel state only. Kept as the backward-compatible "vector
   * availability" for the public operator projection. Dense-only failures
   * (candidate cap, corrupt blobs, dimension mismatch) set it to false while
   * the learned sparse channel below stays independent and may still return
   * hits. Common failures (query encode, service outage, maintenance,
   * missing index) take down both channels.
   */
  available: boolean;
  error?: string;
  /** Backend that produced (or would produce) the dense channel. */
  backend?: "external_openai" | "local_bge_m3";
  stats: Array<Record<string, unknown>>;
  candidateLimit?: number;
  candidateCount?: number;
  hits: VectorSearchHit[];
  /**
   * Learned sparse channel of the local BGE-M3 backend. Independent of
   * `available`: it may be true/non-empty while the dense channel is
   * degraded. Always an empty list for the external dense-only backend;
   * `sparseAvailable` distinguishes "channel not supported" from
   * "supported but degraded".
   */
  sparseHits: VectorSearchHit[];
  sparseAvailable?: boolean;
  sparseError?: string;
  sparseCandidateCount?: number;
}

export interface VectorIndexParams {
  chatId: string;
  limitChunks?: number;
  afterMessageId?: number;
  rebuild?: boolean;
  confirmFirstRun?: boolean;
  signal?: AbortSignal;
}

export interface VectorSearchParams {
  chatId: string;
  query: string;
  limit?: number;
  beforeId?: number;
  afterId?: number;
  includeMessages?: boolean;
  signal?: AbortSignal;
}

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
  available: boolean;
  error?: string;
  stats: Array<Record<string, unknown>>;
  candidateLimit?: number;
  candidateCount?: number;
  hits: VectorSearchHit[];
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

export { VectorRag } from "./vector/facade.js";
export type { VectorRerankResult } from "./vector/facade.js";
export {
  createVectorBackend,
  type EncodedQuery,
  type VectorBackend,
} from "./vector/backend.js";
export {
  fuseRankedChannels,
  type ChannelFusedHit,
  type RetrievalChannelInput,
  type RetrievalChannelName,
} from "./vector/fusion.js";
export {
  embeddingEstimateRequiresConfirmation,
} from "./vector/indexer.js";
export {
  assertVectorSearchReady,
} from "./vector/search.js";
export {
  formatMessage,
} from "./vector/source-formatter.js";
export type {
  EmbeddingIndexEstimate,
  EmbeddingIndexResult,
  EmbeddingRunBudget,
  HybridSearchHit,
  VectorSearchHit,
} from "./vector/types.js";

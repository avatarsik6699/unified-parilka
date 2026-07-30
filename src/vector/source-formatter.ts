import {
  formatEmbeddingMessage,
  formatEmbeddingMessageForChunk,
  renderEmbeddingChunkSource,
} from "../embedding-source.js";

// Vector-facing names preserve the old public API while all provider input
// and transactional source validation share one canonical implementation.
export const formatMessage = formatEmbeddingMessage;
export const formatMessageForChunk =
  formatEmbeddingMessageForChunk;
export const formatChunkSource = renderEmbeddingChunkSource;

import type { StoredMessage } from "../../store.js";
import type { VectorSearchHit } from "../../vector-rag.js";

/**
 * Local causal cutoff over dense/sparse hits: an injected
 * BotVectorSearchPort may ignore `beforeId` and return rows at or above it.
 * Such rows are dropped before fusion so they cannot consume rerank slots,
 * and a hit left without safe messages is removed entirely.
 */
export function causalSafeHits(
  hits: readonly VectorSearchHit[],
  beforeId: number | undefined,
): VectorSearchHit[] {
  if (beforeId === undefined) {
    return [...hits];
  }
  return hits
    .map((hit) => ({
      ...hit,
      messages: causalSafeMessages(hit.messages, beforeId),
    }))
    .filter((hit) => hit.messages.length > 0);
}

/**
 * Exclusive cutoff applied at the output boundary: rows at or above
 * `beforeId` are never returned, regardless of what the port or store
 * reported.
 */
export function causalSafeMessages(
  messages: readonly StoredMessage[],
  beforeId: number | undefined,
): StoredMessage[] {
  if (beforeId === undefined) {
    return [...messages];
  }
  return messages.filter((message) => message.messageId < beforeId);
}

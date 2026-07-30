import type { KeywordSearchHit } from "../store.js";
import { formatMessage } from "./source-formatter.js";
import type {
  HybridSearchHit,
  VectorSearchHit,
} from "./types.js";

type DraftHit = Omit<HybridSearchHit, "rank" | "source"> & {
  bestRank: number;
};

export function fuseHybridSearch(
  keywordHits: KeywordSearchHit[],
  vectorHits: VectorSearchHit[],
  limit: number,
): HybridSearchHit[] {
  const results = new Map<string, DraftHit>();
  const vectorKeyByMessageId = new Map<number, string>();

  for (const [index, hit] of vectorHits.entries()) {
    const key = `chunk:${hit.chunk.id}`;
    for (const message of hit.messages) {
      vectorKeyByMessageId.set(message.messageId, key);
    }
    results.set(
      key,
      mergeHybridHit(results.get(key), {
        sources: ["vector"],
        score: reciprocalRank(index),
        bestRank: index + 1,
        startMessageId: hit.chunk.startMessageId,
        endMessageId: hit.chunk.endMessageId,
        text: hit.chunk.text,
      }),
    );
  }

  for (const [index, hit] of keywordHits.entries()) {
    const vectorKey = vectorKeyByMessageId.get(
      hit.message.messageId,
    );
    const key =
      vectorKey ??
      `message:${hit.message.chatId}:${hit.message.messageId}`;
    results.set(
      key,
      mergeHybridHit(results.get(key), {
        sources: ["keyword"],
        score: reciprocalRank(index),
        bestRank: index + 1,
        messageId: hit.message.messageId,
        text: vectorKey
          ? (results.get(vectorKey)?.text ??
            formatMessage(hit.message))
          : formatMessage(hit.message),
      }),
    );
  }

  return [...results.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.bestRank - right.bestRank,
    )
    .slice(0, limit)
    .map((hit, index) => ({
      rank: index + 1,
      source:
        hit.sources.length > 1 ? "hybrid" : hit.sources[0]!,
      sources: hit.sources,
      score: hit.score,
      messageId: hit.messageId,
      startMessageId: hit.startMessageId,
      endMessageId: hit.endMessageId,
      text: hit.text,
    }));
}

function reciprocalRank(index: number): number {
  return 1 / (60 + index + 1);
}

function mergeHybridHit(
  existing: DraftHit | undefined,
  incoming: DraftHit,
): DraftHit {
  if (!existing) {
    return incoming;
  }
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(
        ([, value]) => value != null,
      ),
    ),
    sources: [
      ...new Set([...existing.sources, ...incoming.sources]),
    ],
    score: existing.score + incoming.score,
    bestRank: Math.min(existing.bestRank, incoming.bestRank),
    text: existing.text || incoming.text,
  } as DraftHit;
}

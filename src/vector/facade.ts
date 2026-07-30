import type { AppConfig } from "../config.js";
import {
  EmbeddingClient,
  embeddingNamespace,
} from "../embeddings.js";
import type {
  KeywordSearchHit,
  MessageStore,
} from "../store.js";
import { fuseHybridSearch } from "./fusion.js";
import { VectorIndexer } from "./indexer.js";
import { VectorSearcher } from "./search.js";
import type {
  EmbeddingIndexEstimate,
  EmbeddingIndexResult,
  HybridSearchHit,
  VectorIndexParams,
  VectorSearchHit,
  VectorSearchParams,
  VectorSearchResult,
} from "./types.js";

export class VectorRag {
  readonly #embeddings: EmbeddingClient;
  readonly #indexer: VectorIndexer;
  readonly #searcher: VectorSearcher;

  constructor(
    config: AppConfig,
    store: MessageStore,
  ) {
    this.#embeddings = new EmbeddingClient(config);
    const namespace = embeddingNamespace(config);
    this.#indexer = new VectorIndexer(
      config,
      store,
      this.#embeddings,
      namespace,
    );
    this.#searcher = new VectorSearcher(
      config,
      store,
      this.#embeddings,
      namespace,
    );
  }

  get isConfigured(): boolean {
    return this.#embeddings.isConfigured;
  }

  indexCachedMessages(
    params: VectorIndexParams,
  ): Promise<EmbeddingIndexResult> {
    return this.#indexer.indexCachedMessages(params);
  }

  estimateIndexCachedMessages(params: {
    chatId: string;
    limitChunks?: number;
    afterMessageId?: number;
    rebuild?: boolean;
  }): EmbeddingIndexEstimate {
    return this.#indexer.estimateIndexCachedMessages(params);
  }

  search(params: VectorSearchParams): Promise<VectorSearchResult> {
    return this.#searcher.search(params);
  }

  hybrid(
    keywordHits: KeywordSearchHit[],
    vectorHits: VectorSearchHit[],
    limit: number,
  ): HybridSearchHit[] {
    return fuseHybridSearch(keywordHits, vectorHits, limit);
  }
}

# Vector slice

`facade.ts` preserves the public `VectorRag` API. Backend selection lives in
`backend.ts` (`external_openai` dense-only, or `local_bge_m3` dense + learned
sparse + bounded ColBERT rerank). Index planning/provider orchestration lives
in `indexer.ts`, bounded exact search in `search.ts`, channel rank fusion in
`fusion.ts`, the loopback BGE-M3 HTTP client in `bge-client.ts`, and public
shapes in `types.ts`. `source-formatter.ts` only exposes the shared canonical
formatter from `src/embedding-source.ts`.

Retrieval fuses up to three independent ranked channels — BM25 (FTS5), dense
cosine, and learned sparse postings — through deterministic reciprocal-rank
fusion (`fuseRankedChannels`). The legacy two-channel `hybrid` path is kept
for the MCP `search_messages` contract. An optional bounded ColBERT rerank
reorders only the first-stage top-K and never persists token vectors.

Storage: dense vectors live in `message_embedding_chunks`; learned sparse
postings live in `message_embedding_sparse_terms(chunk_id, token_id, weight)`,
owned by their parent chunk namespace. The delete trigger cascades postings;
dirty/stale parent chunks are excluded from sparse lookup.

Invariants:

- provider output is committed only through
  `commitEmbeddingChunksIfCurrent`; a single local BGE-M3 encode pass supplies
  both the dense vector and the sparse terms for a chunk;
- source rows are re-rendered inside the same `BEGIN IMMEDIATE` transaction;
- stale chunks are never counted, never made searchable, and block the
  reported cursor at the first stale range;
- dirty chunks remain excluded until a current vector replaces them;
- candidate scans, run chunks, characters, response bytes, retry delay,
  provider time, query terms, sparse terms per chunk, and rerank candidates
  are bounded;
- the local backend endpoint is loopback-only and carries no credential;
- keyword `searchLexical` and transcript reads never touch the vector port.

Focused gate:

```bash
node --test --import tsx tests/vector-*.test.ts
node --test --import tsx tests/store-sparse-postings.test.ts
```

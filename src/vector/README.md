# Vector slice

`facade.ts` preserves the public `VectorRag` API. Index planning/provider
orchestration lives in `indexer.ts`, bounded exact search in `search.ts`,
keyword/vector rank fusion in `fusion.ts`, and public shapes in `types.ts`.
`source-formatter.ts` only exposes the shared canonical formatter from
`src/embedding-source.ts`.

Invariants:

- provider output is committed only through
  `commitEmbeddingChunksIfCurrent`;
- source rows are re-rendered inside the same `BEGIN IMMEDIATE` transaction;
- stale chunks are never counted, never made searchable, and block the
  reported cursor at the first stale range;
- dirty chunks remain excluded until a current vector replaces them;
- candidate scans, run chunks, characters, response bytes, retry delay, and
  provider time are bounded.

Focused gate:

```bash
node --test --import tsx tests/vector-*.test.ts
```

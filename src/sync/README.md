# Sync slice

`history-syncer.ts` owns cursor/state transitions and delegates transport
traversal to `recent.ts` and `backfill.ts`. Public contracts are in
`contracts.ts`, cancellation/watchdogs in `abort.ts`, and the bounded writer
lane in `serialized.ts`. `daemon-runner.ts` composes the process while
`daemon-policy.ts` contains health/backoff decisions.

Invariants:

- one serialized history writer owns recent/backfill cursors;
- cancellation never stamps a successful sync;
- partial recent progress checkpoints only durable flushed rows;
- Telegram errors alone control core stop/backoff;
- optional embedding work runs out-of-band through
  `EmbeddingCadenceRunner`, has a hard budget/cadence, and may degrade health
  without delaying or stopping history sync;
- provider and daemon `Retry-After` delays are clamped;
- final Telegram destruction is best-effort and bounded to 30 seconds.
- shutdown emits timings for embeddings, MCP, Telegram and storage; the daemon
  process boundary is forced only after `sync.shutdown_completed`.

Focused gates:

```bash
node --test --import tsx tests/sync-*.test.ts
node --test --import tsx tests/flood-handling.test.ts tests/embeddings-opt-in.test.ts
```

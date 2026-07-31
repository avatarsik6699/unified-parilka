# Storage layout

`MessageStore` remains the stable flat API used by the bot, MCP tools, sync
daemon, scripts, and tests. Its implementation is split into focused method
modules under this directory.

## Invariants

- One `MessageStore` owns exactly one `StoreCore` and one `DatabaseSync`.
- Only `core.ts` opens/closes SQLite and implements busy retry plus
  `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`.
- Method modules are prototype contributors, not separately instantiated
  repositories. Their methods always receive the owning `MessageStore` as
  `this`.
- Public methods keep the compatibility surface exported by `src/store.ts`.
- `upsertMessages` replaces cached text only when the transport has a text
  projection. A native-rich MTProto placeholder therefore cannot erase the
  canonical plain text recorded by the Bot API publisher; genuine empty-text
  edits still replace it.
- A public method may start a transaction only at its orchestration boundary.
  Helpers with a `Locked` suffix assume the caller already owns that boundary
  and must never start another transaction.
- Embedding provider output is committed through
  `commitEmbeddingChunksIfCurrent`: source rows are re-read and canonically
  rendered under the same write transaction that stores chunk membership.
  `upsertEmbeddingChunks` remains only as the compatibility primitive for
  trusted migration/test data.
- Schema changes belong in `schema/`; domain files must not perform ad-hoc
  migrations.

## Module map

- `core.ts`: connection ownership, file permissions, busy retry, transactions.
- `schema/definitions.ts`: current table and index definitions.
- `schema/migrations.ts`: version-to-version reconciliation.
- `schema/objects.ts`: managed FTS/trigger definitions and schema helpers.
- `schema/lifecycle.ts`: migration ordering and final schema validation.
- `messages.ts`: chats, messages, keyword search, and message hydration.
- `bot-updates.ts`: durable Bot API inbox and update ingestion.
- `bot-turns.ts`: turn leases and durable turn state machine.
- `chat-knowledge.ts`: bounded chat-scoped fast notes, durable lessons and
  progressive skills; source-attributed upserts, credential rejection and
  capacity pruning under the shared transaction kernel.
- `digests.ts`: day and rollup cache persistence.
- `embeddings.ts`: embedding chunks, membership, and coverage.
- `send-outbox.ts`: durable sends, throttle state, and startup reconciliation.
- `sync-ops.ts`: sync cursors, history jobs, and daemon ticks.
- `status.ts`: maintenance and aggregate status reads.
- `types.ts`, `mappers.ts`, `validation.ts`, `sqlite-utils.ts`: shared,
  side-effect-free support code.

## Adding storage behavior

Add a method to the narrowest domain module and include only public methods in
that module's `*Api` type. Then install a new module in `src/store.ts` only if
none of the existing domains is a coherent home. Keep SQL and row mapping near
their owning domain, reuse the core transaction helpers, and add a regression
test at the public `MessageStore` boundary.

The architecture test keeps the compatibility barrel below 150 lines, every
TypeScript storage implementation below 700 lines, and transaction/connection
ownership in `core.ts`.

# Telegram transport

`types.ts` is the provider-neutral boundary used by bot, MCP, and sync
consumers. `gateway-factory.ts` selects the configured transport and completes
any one-shot session import before returning the long-lived gateway.

The mtcute implementation keeps its compatibility exports in
`mtcute-client.ts`; runtime responsibilities live in [`mtcute/`](./mtcute/):

- `service.ts` composes the gateway facade;
- `process-owner.ts` owns the one client lifecycle for each process factory;
- `client.ts` constructs the bounded mtcute client and private auth store;
- `peer-resolver.ts` applies allowlisting and maintains the peer cache;
- `history-adapter.ts` validates and paginates reads;
- `send-adapter.ts` validates replies and formats outbound text;
- `message-normalizer.ts` prevents transport objects crossing the boundary;
- `config.ts`, `errors.ts`, `timeout.ts`, and `request-utils.ts` contain the
  shared contracts and guards.

## Runtime invariants

- One mtcute factory maps to one process owner. Do not add pools or create a
  second long-lived MTProto client.
- A bootstrap client may exist only before gateway construction for session
  import and must be destroyed before the process owner starts.
- The mtcute auth SQLite file is distinct from the application database and is
  forced to mode `0600`.
- Connection attempts, reconnect delay, request retries, request timeout, and
  flood waits remain bounded by validated configuration.
- Peer cache hits never replace the pre-resolution and post-resolution
  allowlist checks.
- Updates stay disabled; bot updates are owned by the Bot API runtime.
- The daemon owns `SIGINT`/`SIGTERM`; mtcute receives only a natural
  `beforeExit` hook. Its storage/caches are flushed before transport destroy,
  avoiding the default synchronous signal hook racing SQLite shutdown.
- mtcute 0.31 may retain completed RPC timeout handles after successful
  destroy. The daemon process exits explicitly only after every owned stage
  has completed and logs have been flushed.

Run `tests/mtcute-client.test.ts`, `tests/telegram-gateway.test.ts`, and
`tests/flood-handling.test.ts` plus `npm run smoke:mtcute-storage` after
changing the transport. Sync consumers and a measured service restart must
also pass before changing history or lifecycle behavior.

# MCP tools

`src/tools.ts` is the compatibility import. `facade.ts` owns the
`TelegramTools` lifecycle and an explicit runtime context; `registry.ts`
dispatches the fixed 13-tool surface without a generic plugin framework.

- `definitions.ts`: public names, descriptions, and JSON Schemas.
- `sync-health-handlers.ts`: config, status, chat resolution, and manual sync.
- `read-handlers.ts`: cache reads, search, embeddings, and thread context.
- `send-handlers.ts`: preview, reply preflight, dry-run, and live send flow.
- `send-approval.ts`: short-lived one-shot payload capabilities and hashes.
- `cache-metadata.ts`: health and cache-completeness response metadata.
- `response.ts`: MCP JSON envelope, error flag, and cancellation guard.

To add or change a tool, update both the definition and the explicit registry
branch, then test the public `TelegramTools.callTool` boundary. Keep
live-write policy in the send domain and storage durability in
`SendThrottler`/`MessageStore`.

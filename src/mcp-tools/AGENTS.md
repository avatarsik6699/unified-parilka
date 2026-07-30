# MCP tools agent contract

Область действия: `src/mcp-tools/**` и фасад `src/tools.ts`.

- Публичная поверхность фиксирована: definition и explicit `registry.ts`
  branch меняются вместе. Не добавляйте generic plugin loader/framework.
- Cache-only handlers не должны внезапно обращаться к Telegram или provider.
  Сетевые операции разрешены только явно сетевым resolve/sync/vector/send
  путям и обязаны сохранять cancellation/timeout/bounds.
- Live send сохраняет порядок fences: allowlist/resolve, validation и bounded
  reply preflight, hard dry-run, one-shot exact-payload capability, durable
  throttle/outbox, Telegram dispatch. Нельзя ослаблять bypass/dry-run или
  повторно использовать capability/dedupe key.
- Ошибки проходят через единый JSON envelope и выставляют MCP `isError`;
  секреты и credential-bearing URL не попадают в ответы.
- Тесты не выполняют live Telegram/provider I/O. Минимальный gate:
  `tools-response`, `send-safety`, `chat-aliases`, `embeddings-opt-in`,
  `sync-engine`, `flood-handling`, затем `npm run check` и `npm run build`.

Карта модулей: `README.md`.

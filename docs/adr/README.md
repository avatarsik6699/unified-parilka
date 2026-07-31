# Architecture Decision Records

ADR — durable record решения, а не active proposal, checklist или completion
evidence. Принятое решение сохраняется; существенная замена оформляется новым
ADR, небольшое уточнение — датированным addendum. Mutable implementation status
живёт в architecture/operations/goal record.

Следующий ADR использует следующий свободный четырёхзначный номер.

## Index

- [ADR 0001](0001-unified-typescript.md): единый TypeScript codebase, два
  process owners, один versioned SQLite и loopback MCP.
- [ADR 0002](0002-native-telegram-rich-messages.md): нативные Telegram Rich
  Messages (`sendRichMessage` + `markdown`) как primary path финального
  ответа бота, bounded AST preflight и classic plain fallback.
- [ADR 0003](0003-layered-chat-memory.md): bounded per-chat fast/long memory
  и progressive skills с явным user-gated обновлением.

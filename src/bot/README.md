# Bot module shape

The public entry points remain thin compatibility files:

- `runtime.ts` — durable Bot API ingestion, polling, worker admission, lifecycle,
  and grammY adapters.
- `read-tools.ts` — the five read-only model tools.
- `worker.ts` — one durable turn from claim through the send fence.
- `grammy-publisher.ts` — the narrow Bot API port and publisher: primary native
  `sendRichMessage({ markdown, skip_entity_detection: true })`; classic
  `sendMessage` only for whole-message plain publications and the single
  parser-related 400 fallback before ACK. Timeout/network/malformed ACK/
  partial/post-ACK failures never resend.
- `ai-agent.ts` — the bounded, non-streaming model/tool loop.
- `output-guards.ts` — final-output validation and the rich/plain publication
  boundary.
- `rich-markdown.ts` — bounded Rich Markdown AST preflight (unified +
  remark-parse + remark-gfm + remark-math): admits safe original Markdown
  for native `sendRichMessage` (only short GFM table separators are widened
  to Telegram's minimum of three dashes), builds the canonical visible plain
  text, and proves whole-message plain mode for raw HTML/media/unsafe
  links/Telegram-only syntax without an exact projection/malformed input/limit
  overflow (including the 500-block API limit).
- `telemetry.ts` — per-turn usage accumulation and footer rendering.
- `typing.ts` — best-effort typing heartbeat.
- `tool-progress.ts` — persisted single-message tool-progress presentation.
- `runtime-config.ts` — fail-closed bot environment configuration.
- `turn-coordinator.ts` — isolated overlapping-turn state and fold contracts.
- `../bot-daemon.ts` — process composition and lifecycle entry point.
- `prompt.ts` injects a bounded, untrusted per-chat memory section
  (`memoryBlock`/`memoryMaxChars`) on every provider attempt.

Their implementation is split by ownership:

- `runtime/`: shared contracts and validation helpers, update processor,
  long-poller, worker pump, API lifecycle, and grammY adapters.
- `read-tools/`: model-facing contracts and schemas, calendar conversion,
  bounded payload projection, cache/web/paper executors, and abortable timeouts.
- `../../dream/`: offline memory consolidation triggered by the digest timer.
- `worker/`: turn contracts, validated worker settings, context/replay/fold
  preparation, lease/deadline timers, durable dispatch, and orchestration.
- `turn-coordinator/`: public state contracts, admission/routing state,
  bounded folding, and option validation.
- `agent/`: untrusted chat-context serialization, carried tool evidence, and
  abort/deadline helpers.
- `output-guards/`: artifact cleanup, exact plain-text quote/mention
  verification (including backtick spans), and UTF-16-safe length handling.
- `rich-markdown.ts`: the bounded AST preflight described above. It never
  renders or serializes arbitrary Markdown; Telegram renders the rich payload
  natively. The only local classic splitter is the lossless 4096-char plain
  fallback (`output-guards/length.ts`).
- `runtime-config/`: public contracts, environment rules, cross-field
  validation, optional web-search loading, and redacted inspection.
- `../bot-daemon/`: dependency composition, production adapters, trace wiring,
  signal lifecycle, and the executable main routine.

## Extension points

Add a model/provider through `TurnModelRouter`; add external search through
`WebSearchProvider`; add scientific paper search through the built-in keyless
arXiv/Europe PMC executor or a `PaperSearchProvider`; add local history behavior
behind `BotReadToolCache`; and keep Telegram transport adaptation in
`runtime/grammy-adapters.ts` or `grammy-publisher.ts`. New model tools must stay
read-only and update the contract, executor, prompt budget, and focused tests
together.

Durable state transitions belong to the update processor or turn worker, not
transport adapters. Keep `turnId` and `updateId` in agent/worker log records,
and never retry a send after entering an ambiguous delivery state.

## Focused tests

- Runtime/ACK/polling/pump: `tests/bot-runtime.test.ts`,
  `tests/bot-durability.test.ts`
- Read tools/cache: `tests/bot-read-tools.test.ts`,
  `tests/bot-read-cache.test.ts`
- Worker/send fence: `tests/bot-worker.test.ts`,
  `tests/grammy-publisher.test.ts`
- Agent/prompt: `tests/ai-agent-core.test.ts`,
  `tests/ai-agent-fallback.test.ts`, `tests/ai-agent-context.test.ts`,
  `tests/bot-prompt.test.ts`, `tests/bot-memory.test.ts`
- Memory/dream: `tests/dream.test.ts`
- Process/config/output: `tests/bot-daemon.test.ts`,
  `tests/bot-runtime-config.test.ts`, `tests/output-guards.test.ts`
- Rich Markdown preflight: `tests/rich-markdown.test.ts`

Run all bot tests with:

```sh
node --test --import tsx tests/bot-*.test.ts tests/ai-agent-*.test.ts \
  tests/grammy-publisher.test.ts tests/output-guards.test.ts \
  tests/telegram-update.test.ts tests/turn-coordinator.test.ts
```

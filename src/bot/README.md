# Bot module shape

The public entry points remain thin compatibility files:

- `runtime.ts` — durable Bot API ingestion, polling, worker admission, lifecycle,
  and grammY adapters.
- `read-tools.ts` — seven bounded evidence/read tools, including a native
  public-page fetcher and an optional Unix-socket client for the private HH
  research gateway. The client holds only a runtime socket path and accepts a
  strict anonymized disclosure envelope; it never knows a research root,
  manifest, database, credential or raw record.
- `worker.ts` — one durable turn from claim through the send fence.
- `grammy-publisher.ts` — the narrow Bot API port and publisher: primary native
  `sendRichMessage({ markdown, skip_entity_detection: true })`; classic
  `sendMessage` only for whole-message plain publications and the single
  parser-related 400 fallback before ACK. Timeout/network/malformed ACK/
  partial/post-ACK failures never resend.
- `ai-agent.ts` — the bounded, non-streaming model/tool loop. One complete
  turn has a 600-second deadline; it has no separate arbitrary model-step
  ceiling, while every tool call remains bounded. Ordinary turns receive a
  six-call ceiling; explicit research requests receive a 12-call ceiling, a
  minimum of four real evidence calls, and up to two bounded continuation
  rounds if the model tries to finalise too early. The prompt separates external
  evidence (`web_search`/`web_fetch`/`paper_search`) from facts in this chat
  (`search_chat`/digest/thread) and never treats chat search as an automatic
  supplement to an external lookup. `research_lookup` is private evidence and
  the sole tool-specific data-disclosure boundary: its model-facing description
  forbids personal extraction, and the executor rejects such queries before the
  Unix socket; results are always paraphrased and generalized, never quoted or
  used to identify a person.
- `media-tools.ts` — the narrow per-turn Telegram media boundary. It may read
  only an addressed photo/audio attachment or its one direct reply; Telegram
  `file_id`, download path and authenticated URL never enter a model prompt,
  progress message, durable answer or log. A Vision-capable selected candidate
  receives an in-memory image part; a text-only fallback receives no bytes and
  is told that it cannot see the image. An explicit `расшифруй` command runs
  Flov locally and publishes the full transcript as chunked plain text without
  sending speech text to an LLM. Broader audio questions expose the bounded
  local `audio_transcribe` tool, whose model projection is deliberately short.
- `memory-tools.ts` — chat-scoped fast notes, durable lessons and progressive
  skill loading. Read tools are always bounded; write tools exist only when
  the addressed trigger both explicitly asks to remember/update something and
  comes from an operator-authorized numeric Telegram account. The private
  `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS` allowlist is never exposed to the
  model; writes remain source-attributed to that trigger.
- `telegram-publication.ts` — narrow transport contract for the final text:
  normal model replies keep their original Markdown for native
  `sendRichMessage`; local audio and replies over Telegram's UTF-16 limit use
  lossless classic plain-message chunks. It applies no content policy and does
  not rewrite model text.
- `telemetry.ts` — per-turn usage accumulation and footer rendering.
- `typing.ts` — best-effort typing heartbeat.
- `tool-progress.ts` — persisted single-message model/tool timeline: safe
  `thinking` status markers (never reasoning text) and an allowlisted
  tool-request/selector preview capped at three lines.
- `runtime-config.ts` — fail-closed bot environment configuration.
- `turn-coordinator.ts` — isolated overlapping-turn state and fold contracts.
- `../bot-daemon.ts` — process composition and lifecycle entry point.
- `prompt.ts` injects bounded, untrusted per-chat Dream memory, fast notes,
  lesson/skill indexes and the memory-write gate on every provider attempt.

Their implementation is split by ownership:

- `runtime/`: shared contracts and validation helpers, update processor,
  long-poller, worker pump, API lifecycle, and grammY adapters.
- `read-tools/`: model-facing contracts and schemas, calendar conversion,
  bounded payload projection, cache/web/paper/research executors, DNS-pinned
  public-page fetch, owner-only Unix-socket research-gateway client and
  abortable timeouts.
- `../../dream/`: offline memory consolidation triggered by the digest timer.
- `worker/`: turn contracts, validated worker settings, context/replay/fold
  preparation, lease/deadline timers, durable dispatch, and orchestration.
- `turn-coordinator/`: public state contracts, admission/routing state,
  bounded folding, and option validation.
- `agent/`: untrusted chat-context serialization, carried tool evidence, and
  abort/deadline helpers.
- `media/`: strict Bot API media-reference parsing (including the one embedded
  direct reply delivered in privacy mode), bounded redirect-free download,
  ffmpeg conversion through a bounded private seekable temporary input (removed
  before return) with an in-memory normalized output, and a single-flight
  loopback-only Flov client.
  The worker rehydrates the exact durable Bot API update before a media turn,
  so the generic MTProto sync representation cannot erase its current file
  reference.
- `telegram-publication.ts`: the transport contract described above. Telegram
  renders the rich payload natively; the only local fallback is a lossless
  4096-char plain splitter.
- `runtime-config/`: public contracts, environment rules, cross-field
  validation, optional web-search loading, and redacted inspection.
- `../bot-daemon/`: dependency composition, production adapters, trace wiring,
  signal lifecycle, and the executable main routine.

## Extension points

Add a model/provider through `TurnModelRouter`; add external search through
`WebSearchProvider`; the built-in `PublicWebFetchProvider` accepts only public
HTTPS pages and never shares browser state; add scientific paper search through
the built-in keyless arXiv/Europe PMC executor or a `PaperSearchProvider`; the
private `ResearchGatewayProvider` must retain the strict anonymized envelope
and never add source structure to this repository; add local history behavior
behind `BotReadToolCache`; and keep Telegram transport adaptation in
`runtime/grammy-adapters.ts` or `grammy-publisher.ts`. General model tools stay
read-only. The only stateful exception is the narrow `memory-tools.ts` contract:
it requires an authoritative direct-write gate from the private operator
authorizer allowlist, chat scope, bounded fields, source attribution and focused
tests together.

Vision is a candidate capability, not a prompt guess: the resolved
`provider:model` manifest is fail-closed and carries `vision: false` unless
explicitly declared. The agent resolves it separately on every fallback, so a
future text-only subagent/model neither downloads image bytes nor invents a
vision tool. Do not infer capability from a model name or probe a user's image
to discover it.

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
  `tests/ai-agent-media.test.ts`,
  `tests/bot-prompt.test.ts`, `tests/bot-memory.test.ts`
- Media/Flov: `tests/media-telegram.test.ts`, `tests/media-tools.test.ts`,
  `tests/media-flov.test.ts`
- Memory/dream: `tests/bot-memory.test.ts`, `tests/bot-memory-tools.test.ts`,
  `tests/chat-knowledge.test.ts`, `tests/dream.test.ts`
- Process/config: `tests/bot-daemon.test.ts`, `tests/bot-runtime-config.test.ts`

Run all bot tests with:

```sh
node --test --import tsx tests/bot-*.test.ts tests/ai-agent-*.test.ts \
  tests/grammy-publisher.test.ts \
  tests/telegram-update.test.ts tests/turn-coordinator.test.ts
```

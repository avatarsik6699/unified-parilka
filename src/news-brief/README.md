# News-brief slice

`src/news-brief.ts` — stable public barrel. Unrelated to `src/digest/`: that
domain summarizes this chat's own message history; this one searches, reads
and summarizes **external** medicine/biohacking news and posts it into the
chat once a day. Split by phase:

- `collect.ts` — SearXNG (`category: "news"`) discovery across a fixed topic
  list, dedupe by normalized URL, filters out previously seen articles.
- `enrich.ts` — best-effort Firecrawl full-article fetch for the top few
  candidates; a failed crawl keeps the search snippet, never fails the run.
- `summarize.ts` — `AiSdkNewsBriefSummaryPort`, a bounded provider call (router
  role `"summary"`) that turns the candidates into one ready-to-send Russian
  bullet-list digest.
- `seen-store.ts` — bounded local JSON file tracking recently posted article
  URLs (~30 days), deliberately outside the shared SQLite transaction kernel:
  this data never needs to be atomic with bot/outbox/embedding transitions.
- `send.ts` — sends exactly one message per calendar day, reusing the shared
  send-outbox's dedupe/audit primitives (`reserveSend`/`markSendSending`/
  `markSendSent`) directly rather than the full in-memory `SendThrottler`,
  since a oneshot CLI sends synchronously and never needs its queue/backoff.
- `types.ts`, `run.ts` — public contracts and orchestration.

Invariants:

- collection and enrichment never mutate state and never require a model
  router or bot token -- only `--apply` with both configured summarizes and
  sends;
- a same-day re-run with byte-identical generated text is a no-op duplicate
  (the outbox dedupe key is scoped to the calendar day); a same-day re-run
  whose regenerated text differs fails closed with an error instead of
  double-posting -- this is expected, not a bug, given the summary is model-
  generated and therefore not naturally idempotent across runs;
- a Firecrawl failure for one article never fails the run, only that article
  falls back to its search snippet;
- entirely off by default -- `systemd/bot-agi-news-brief.timer` is not
  installed/enabled by the codebase itself, an operator opts in explicitly.

## Live-bot privileged trigger

`src/bot/news-brief-trigger.ts` lets the *live* `bot-agi-bot` daemon (not the
CLI) run this pipeline early, on demand, when one specific Telegram user id
messages the bot the exact phrase `daily news-brief`. It reuses this same
`runNewsBrief` orchestration and the same on-disk seen-store as the scheduled
CLI/timer, so a manual test run and the next scheduled run never repeat the
same articles.

Authorization is a plain host-code identity check
(`message.senderId === options.privilegedUserId`) performed in
`src/bot/runtime/update-processor.ts` **before** the message ever reaches the
model/agent loop -- it is not a model tool and not a prompt instruction, so
it cannot be granted, spoofed, or bypassed through chat text or prompt
injection from any other sender. Configured via
`BOT_NEWS_BRIEF_TRIGGER_USER_ID` (`src/bot/runtime-config/news-brief-
trigger.ts`); absent means nobody can trigger it early. A manual trigger uses
a dedupe key namespaced `manual:...:<timestamp>`, deliberately distinct from
the scheduled day-key, so it cannot collide with (or be blocked by) that
day's scheduled send.

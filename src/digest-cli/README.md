# Digest CLI

The production command is compiled to `dist/digest-cli.js`.
`scripts/generate-digests.ts` is a thin development and spawn-test wrapper.

- `options.ts` owns strict CLI/env parsing, chat allowlist checks, canonical
  SQLite identity, and bounded model/input settings.
- `run.ts` owns read-only preflight, apply lock lifecycle, store/model
  composition, report output, and safe top-level errors.

The CLI loads no dotenv file. Apply requires an explicit model-router config
and provider variables in the process environment. Dry-run opens the unified
database read-only, never calls a model, and always reports the complete
backlog.

Scheduled apply defaults to three day generations and one week generation per
run. Environment owners are
`PARILKA_DIGEST_MAX_DAY_GENERATIONS_PER_RUN` and
`PARILKA_DIGEST_MAX_WEEK_GENERATIONS_PER_RUN`; the explicit CLI overrides are
`--max-day-generations-per-run` and `--max-week-generations-per-run`.
Accepted ranges are 0–31 and 0–8. Apply processes due candidates newest-first;
deferred legacy rows remain intact for a later run. The JSON report exposes
the selected limits in `options` and per-phase `providerCalls`/`deferred`
counters.

`--summary-only` keeps the same exit status and counters but emits one compact
JSON line without the full `items` backlog. It retains bounded failed-period
codes and generated period IDs. The systemd timer uses this mode so daily
backlog does not flood journald; manual dry-run keeps the detailed report.

Dream consolidation uses the same `PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS` and
`PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS` bounds as day/week summaries. A
`dream.status = "failed"` makes apply exit nonzero even when day/week phases
have no failures; the old memory block and watermark remain unchanged. Its
default generation cap is deliberately 1024 output tokens, independently of
the larger day/week cap: a memory block is compact and this keeps the
background budget conservative for reasoning-first models. A candidate timeout
gets one bounded retry of that same configured candidate before the existing
fail-closed result; it does not introduce another provider.

The apply lock SQLite lives beside the canonical application DB, inside its
already private state directory. The filename derives from DB device/inode, so
manual CLI and systemd share one lock namespace regardless of
`XDG_RUNTIME_DIR`. The CLI fails closed before even a read-only preflight when
the application DB has more than one hardlink, preventing aliases in different
directories from splitting that namespace or observing a different WAL name.

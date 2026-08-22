# Maintenance

Production entrypoint: `src/maintenance-cli.ts`, compiled to
`dist/maintenance-cli.js`. `bin/bot-agi-maintain`, the npm `maintain` script
and the systemd oneshot run that built file; `scripts/maintain-state.ts` is
only a thin development/test adapter.

The apply order is intentionally explicit:

1. open the database and require a successful `PRAGMA quick_check`;
2. validate the supported schema and inspect all candidates;
3. commit retention in one `BEGIN IMMEDIATE` transaction;
4. rebuild a pending FTS index in its own atomic transaction;
5. process embedding membership in bounded, resumable transactions, one per
   batch;
6. run `PRAGMA optimize` and a passive WAL checkpoint.

An error in a membership batch rolls back that batch only. Earlier batches,
FTS work and retention may already be durable. Failure JSON therefore exposes
`phase`, `completedPhases`, `retentionMayBeCommitted` and
`deferredMaintenanceMayBeCommitted`. These flags are conservative around a
write/commit boundary. Failure output contains a stable error code, not an
exception message, database path or record contents.

## Retention and send deduplication

Defaults:

- history jobs: 30 days, always keep the newest 1,000 rows;
- terminal bot turns/updates: 60 days;
- terminal MCP send outbox: 30 days, always keep the newest 1,000 terminal
  rows.

The outbox limits are configurable with `--send-outbox-days` and
`--keep-send-outbox-rows`. A row is eligible only when:

- its status is `sent`, `failed` or `expired`;
- `updated_at_ms` is older than the age cutoff;
- it is not among the newest keep-last terminal rows.

`queued` and `sending` rows are never removed by retention. The retained rows
are also the durable deduplication history: with defaults, dedupe keys are
protected for at least 30 days and at least the newest 1,000 terminal sends.
After an eligible row is deleted, reuse of that old key can no longer be
detected. Increase either option when callers can retry keys across a longer
window.

## WAL report

Apply reports normalized numeric `busy`, `log` and `checkpointed` frame
counts, plus `remainingFrames`, `pageSizeBytes` and
`approximateRemainingBytes`. A passive checkpoint never blocks active
readers; if frames remain, the successful report includes a warning so the
next run or an operator can retry.

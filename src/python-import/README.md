# Python state importer

The importer is an offline, one-chat migration tool. The production entrypoint
is `dist/python-import-cli.js`; `scripts/import-python-state.ts` exists only as
a thin development and test wrapper.

The implementation is split into:

- `contracts.ts` — CLI/report/phase contracts.
- `source.ts` — read-only source inspection and digest-row validation.
- `normalization.ts` — strict legacy message and digest normalization.
- `hashes.ts` — deterministic source and digest hashes.
- `message-merge.ts` — conservative overlap preflight, missing-field fills,
  and content-free conflict counters.
- `sqlite-guards.ts` — file identity, schema, column, and `quick_check`
  validation.
- `target.ts` — idempotent target message/digest application.
- `cli.ts` — argument parsing, phase orchestration, and safe failure reports.

Dry-run never creates the target. Apply validates the target before entering
the write phase. On message overlap, canonical non-empty target fields win:
Python can fill only missing fields, while differing non-empty values fail
closed before message writes. Target `rawJson`, `topicId`, and `deletedAt`
always survive the merge. Reports contain counters, never field contents.
If a failure report says
`targetMayBePartiallyModified: true`, rerun the idempotent import after
investigation; message batches and digest rows are committed independently.
Legacy outbox, drafts, and events are reported but never inserted into the
live retry queue.

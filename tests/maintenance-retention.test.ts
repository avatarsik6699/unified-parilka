import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  checkpointWarning,
  normalizeWalCheckpoint,
} from "../src/maintenance/checkpoint.js";
import { MessageStore } from "../src/store.js";
import {
  MAINTAIN_SCRIPT,
  assertSeedRowsIntact,
  assertWalCheckpointReport,
  insertSendOutbox,
  parseReport,
  plainRows,
  quickCheck,
  runScript,
  seedMaintenanceRows,
  withTempDirectory,
} from "./support/state-scripts.js";

test("state maintenance is dry-run by default, prunes only allowlisted terminal rows, and is idempotent", () => {
  withTempDirectory((directory) => {
    const dbPath = join(directory, "state.sqlite");
    const store = new MessageStore(dbPath);
    store.close();
    seedMaintenanceRows(dbPath);

    const dryRun = runScript(MAINTAIN_SCRIPT, [
      "--db",
      dbPath,
      "--history-days",
      "1",
      "--bot-days",
      "1",
      "--stale-history-hours",
      "1",
      "--keep-history-jobs",
      "1",
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryReport = parseReport(dryRun.stdout);
    assert.equal(dryReport.mode, "dry_run");
    assert.deepEqual(dryReport.candidates, {
      staleRunningHistoryJobs: 1,
      terminalHistoryJobs: 1,
      terminalBotTurns: 3,
      orphanTerminalBotUpdates: 1,
      terminalSendOutbox: 0,
      throttleState: 0,
    });
    assert.deepEqual(dryReport.changed, {
      staleRunningHistoryJobs: 0,
      terminalHistoryJobs: 0,
      terminalBotTurns: 0,
      terminalBotUpdates: 0,
      terminalSendOutbox: 0,
      throttleState: 0,
    });
    assert.deepEqual(dryReport.warnings, []);
    assertSeedRowsIntact(dbPath);

    const applied = runScript(MAINTAIN_SCRIPT, [
      "--db",
      dbPath,
      "--history-days",
      "1",
      "--bot-days",
      "1",
      "--stale-history-hours",
      "1",
      "--keep-history-jobs",
      "1",
      "--apply",
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedReport = parseReport(applied.stdout);
    assert.equal(appliedReport.mode, "applied");
    assert.deepEqual(appliedReport.changed, {
      staleRunningHistoryJobs: 1,
      terminalHistoryJobs: 1,
      terminalBotTurns: 3,
      terminalBotUpdates: 4,
      terminalSendOutbox: 0,
      throttleState: 0,
    });
    assert.deepEqual(appliedReport.warnings, []);
    assertWalCheckpointReport(appliedReport.walCheckpoint);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        plainRows(
          db
            .prepare(
              "SELECT job_id, status FROM history_jobs ORDER BY job_id",
            )
            .all(),
        ),
        [
          { job_id: "history-latest", status: "done" },
          { job_id: "history-stale", status: "failed" },
          { job_id: "history-unknown", status: "future_active" },
        ],
      );
      assert.deepEqual(
        plainRows(
          db
            .prepare(
              "SELECT update_id, status FROM bot_turns ORDER BY update_id",
            )
            .all(),
        ),
        [
          { update_id: 4, status: "lost_ack" },
          { update_id: 5, status: "sending" },
          { update_id: 6, status: "failed" },
          { update_id: 7, status: "sent" },
        ],
      );
      assert.deepEqual(
        plainRows(
          db
            .prepare(
              "SELECT update_id, status FROM bot_updates ORDER BY update_id",
            )
            .all(),
        ),
        [
          { update_id: 4, status: "lost_ack" },
          { update_id: 5, status: "sending" },
          { update_id: 6, status: "failed" },
          { update_id: 7, status: "sent" },
        ],
      );
      assert.deepEqual(
        plainRows(
          db
            .prepare("SELECT id, status FROM send_outbox ORDER BY id")
            .all(),
        ),
        [
          { id: "outbox-failed", status: "failed" },
          { id: "outbox-sending", status: "sending" },
          { id: "outbox-sent", status: "sent" },
        ],
      );
      assert.deepEqual(quickCheck(db), ["ok"]);
    } finally {
      db.close();
    }

    const secondApply = runScript(MAINTAIN_SCRIPT, [
      "--db",
      dbPath,
      "--history-days",
      "1",
      "--bot-days",
      "1",
      "--stale-history-hours",
      "1",
      "--keep-history-jobs",
      "1",
      "--apply",
    ]);
    assert.equal(secondApply.status, 0, secondApply.stderr);
    assert.deepEqual(parseReport(secondApply.stdout).changed, {
      staleRunningHistoryJobs: 0,
      terminalHistoryJobs: 0,
      terminalBotTurns: 0,
      terminalBotUpdates: 0,
      terminalSendOutbox: 0,
      throttleState: 0,
    });
  });
});

test("state maintenance bounds terminal send outbox dedupe rows by age and keep-last without touching active sends", () => {
  withTempDirectory((directory) => {
    const dbPath = join(directory, "state.sqlite");
    const store = new MessageStore(dbPath);
    store.close();
    const db = new DatabaseSync(dbPath);
    const nowMs = Date.now();
    const oldMs = nowMs - 90 * 24 * 60 * 60_000;
    try {
      insertSendOutbox(db, "outbox-queued", "queued", oldMs);
      insertSendOutbox(db, "outbox-sending", "sending", oldMs);
      insertSendOutbox(db, "outbox-old-sent", "sent", oldMs);
      insertSendOutbox(
        db,
        "outbox-old-expired",
        "expired",
        oldMs + 500,
      );
      insertSendOutbox(
        db,
        "outbox-old-failed",
        "failed",
        oldMs + 1_000,
      );
      insertSendOutbox(
        db,
        "outbox-kept-expired",
        "expired",
        oldMs + 2_000,
      );
      insertSendOutbox(
        db,
        "outbox-recent-sent",
        "sent",
        nowMs - 60_000,
      );
    } finally {
      db.close();
    }

    const args = [
      "--db",
      dbPath,
      "--send-outbox-days",
      "1",
      "--keep-send-outbox-rows",
      "2",
    ];
    const dryRun = runScript(MAINTAIN_SCRIPT, args);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryReport = parseReport(dryRun.stdout);
    assert.equal(dryReport.candidates.terminalSendOutbox, 3);
    assert.equal(dryReport.changed.terminalSendOutbox, 0);

    const applied = runScript(MAINTAIN_SCRIPT, [...args, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(
      parseReport(applied.stdout).changed.terminalSendOutbox,
      3,
    );
    const inspect = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        plainRows(
          inspect
            .prepare(
              "SELECT id, status FROM send_outbox ORDER BY id",
            )
            .all(),
        ),
        [
          { id: "outbox-kept-expired", status: "expired" },
          { id: "outbox-queued", status: "queued" },
          { id: "outbox-recent-sent", status: "sent" },
          { id: "outbox-sending", status: "sending" },
        ],
      );
    } finally {
      inspect.close();
    }
  });
});

test("passive WAL checkpoint fields and remaining-byte warning are normalized", () => {
  const report = normalizeWalCheckpoint(
    { busy: "1", log: "12", checkpointed: "7" },
    { page_size: "4096" },
  );
  assert.deepEqual(report, {
    busy: 1,
    log: 12,
    checkpointed: 7,
    remainingFrames: 5,
    pageSizeBytes: 4_096,
    approximateRemainingBytes: 20_480,
  });
  assert.match(
    checkpointWarning(report) ?? "",
    /5 frame\(s\).*20480 byte\(s\)/u,
  );
  assert.equal(
    checkpointWarning({
      ...report,
      remainingFrames: 0,
      approximateRemainingBytes: 0,
    }),
    undefined,
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
export const IMPORT_SCRIPT = join(
  PROJECT_ROOT,
  "scripts",
  "import-python-state.ts",
);
export const MAINTAIN_SCRIPT = join(
  PROJECT_ROOT,
  "scripts",
  "maintain-state.ts",
);
export const CHAT_ID = "-1003179772905";

export function createLegacySource(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE live_msg (
        message_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        date_unix INTEGER NOT NULL,
        sender_id INTEGER,
        sender_name TEXT,
        text TEXT NOT NULL,
        reply_to INTEGER,
        edited_at INTEGER,
        is_bot INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE digest_day (
        day TEXT PRIMARY KEY,
        start_msg_id INTEGER NOT NULL,
        end_msg_id INTEGER NOT NULL,
        n_msgs INTEGER NOT NULL,
        in_tokens INTEGER,
        out_tokens INTEGER,
        model TEXT,
        prompt_version TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE digest_roll (
        kind TEXT NOT NULL,
        period TEXT NOT NULL,
        day_from TEXT NOT NULL,
        day_to TEXT NOT NULL,
        n_days INTEGER NOT NULL,
        prompt_version TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, period)
      );
      CREATE TABLE digest_month (
        month TEXT PRIMARY KEY,
        n_days INTEGER NOT NULL,
        prompt_version TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE bot_outbox (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE bot_draft (id INTEGER PRIMARY KEY);
      CREATE TABLE event (id INTEGER PRIMARY KEY);
    `);
    db.prepare(
      `INSERT INTO live_msg (
         message_id, chat_id, date_unix, sender_id, sender_name,
         text, reply_to, edited_at, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      101,
      Number(CHAT_ID),
      1_769_644_800,
      42,
      "Alice",
      "legacy hello",
      null,
      null,
      '{"update_id":1}',
    );
    db.prepare(
      `INSERT INTO digest_day (
         day, start_msg_id, end_msg_id, n_msgs, in_tokens, out_tokens,
         model, prompt_version, text, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "2026-01-31",
      101,
      101,
      1,
      10,
      4,
      "summary-model",
      "v1",
      "day digest",
      1_769_644_900,
    );
    db.prepare(
      `INSERT INTO digest_roll (
         kind, period, day_from, day_to, n_days, prompt_version,
         text, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "month",
      "2026-01",
      "2026-01-01",
      "2026-01-31",
      31,
      "v2",
      "authoritative month rollup",
      1_769_644_910,
    );
    db.prepare(
      `INSERT INTO digest_month (
         month, n_days, prompt_version, text, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "2026-01",
      31,
      "legacy",
      "must not overwrite authoritative rollup",
      1_769_644_920,
    );
    db.prepare(
      "INSERT INTO bot_outbox (id, status) VALUES (1, 'lost_ack'), (2, 'reserved')",
    ).run();
    db.prepare("INSERT INTO bot_draft (id) VALUES (1)").run();
    db.prepare("INSERT INTO event (id) VALUES (1)").run();
  } finally {
    db.close();
  }
}

export function seedMaintenanceRows(path: string): void {
  const db = new DatabaseSync(path);
  const oldMs = Date.now() - 90 * 24 * 60 * 60_000;
  const recentMs = Date.now() - 60_000;
  try {
    const history = db.prepare(
      `INSERT INTO history_jobs (
         job_id, chat_id, direction, status, target_count, started_at,
         finished_at
       ) VALUES (?, ?, 'recent', ?, 0, ?, ?)`,
    );
    history.run(
      "history-delete",
      CHAT_ID,
      "done",
      "2019-01-01 00:00:00",
      "2019-01-01 00:01:00",
    );
    history.run(
      "history-stale",
      CHAT_ID,
      "running",
      "2020-01-01 00:00:00",
      null,
    );
    history.run(
      "history-unknown",
      CHAT_ID,
      "future_active",
      "2018-01-01 00:00:00",
      "2018-01-01 00:01:00",
    );
    history.run(
      "history-latest",
      CHAT_ID,
      "done",
      "2099-01-01 00:00:00",
      "2099-01-01 00:01:00",
    );

    insertBotState(db, 1, "sent", oldMs);
    insertBotState(db, 2, "skipped", oldMs);
    insertBotState(db, 3, "dead_letter", oldMs);
    insertBotState(db, 4, "lost_ack", oldMs);
    insertBotState(db, 5, "sending", null);
    insertBotState(db, 6, "failed", oldMs);
    insertBotState(db, 7, "sent", recentMs);
    insertBotUpdate(db, 8, "sent", oldMs, false);

    insertSendOutbox(db, "outbox-sending", "sending");
    insertSendOutbox(db, "outbox-sent", "sent");
    insertSendOutbox(db, "outbox-failed", "failed");
  } finally {
    db.close();
  }
}

function insertBotState(
  db: DatabaseSync,
  updateId: number,
  status:
    | "sent"
    | "skipped"
    | "dead_letter"
    | "lost_ack"
    | "sending"
    | "failed",
  completedAtMs: number | null,
): void {
  insertBotUpdate(db, updateId, status, completedAtMs, true);
  const timestamp = completedAtMs ?? Date.now() - 90 * 24 * 60 * 60_000;
  db.prepare(
    `INSERT INTO bot_turns (
       update_id, chat_id, trigger_message_id, status, attempts,
       max_attempts, created_at_ms, updated_at_ms, completed_at_ms
     ) VALUES (?, ?, ?, ?, 1, 3, ?, ?, ?)`,
  ).run(
    updateId,
    CHAT_ID,
    1_000 + updateId,
    status,
    timestamp,
    timestamp,
    completedAtMs,
  );
}

function insertBotUpdate(
  db: DatabaseSync,
  updateId: number,
  status: string,
  completedAtMs: number | null,
  addressed: boolean,
): void {
  const timestamp = completedAtMs ?? Date.now() - 90 * 24 * 60 * 60_000;
  db.prepare(
    `INSERT INTO bot_updates (
       update_id, raw_json, status, addressed, chat_id,
       trigger_message_id, attempts, max_attempts, received_at_ms,
       updated_at_ms, completed_at_ms
     ) VALUES (?, '{}', ?, ?, ?, ?, 1, 3, ?, ?, ?)`,
  ).run(
    updateId,
    status,
    addressed ? 1 : 0,
    addressed ? CHAT_ID : null,
    addressed ? 1_000 + updateId : null,
    timestamp,
    timestamp,
    completedAtMs,
  );
}

export function insertSendOutbox(
  db: DatabaseSync,
  id: string,
  status:
    | "queued"
    | "sending"
    | "sent"
    | "failed"
    | "expired",
  timestamp = Date.now() - 90 * 24 * 60 * 60_000,
): void {
  db.prepare(
    `INSERT INTO send_outbox (
       id, dedupe_key, payload_hash, chat_id, user_key, status,
       created_at_ms, updated_at_ms, expires_at_ms
     ) VALUES (?, ?, 'hash', ?, 'user', ?, ?, ?, ?)`,
  ).run(
    id,
    `dedupe-${id}`,
    CHAT_ID,
    status,
    timestamp,
    timestamp,
    timestamp,
  );
}

export function assertSeedRowsIntact(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(scalar(db, "SELECT count(*) FROM history_jobs"), 4);
    assert.equal(scalar(db, "SELECT count(*) FROM bot_turns"), 7);
    assert.equal(scalar(db, "SELECT count(*) FROM bot_updates"), 8);
    assert.equal(scalar(db, "SELECT count(*) FROM send_outbox"), 3);
    assert.equal(
      String(
        db
          .prepare(
            "SELECT status FROM history_jobs WHERE job_id = 'history-stale'",
          )
          .get()?.status,
      ),
      "running",
    );
  } finally {
    db.close();
  }
}

export function runScript(script: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        TELEGRAM_DB_PATH: "",
      },
      timeout: 30_000,
    },
  );
}

export function parseReport(stdout: string): any {
  return JSON.parse(stdout) as any;
}

export function importFailureState(stderr: string): {
  phase: string;
  targetMayBePartiallyModified: boolean;
} {
  const report = JSON.parse(stderr) as {
    phase?: unknown;
    targetMayBePartiallyModified?: unknown;
  };
  return {
    phase: String(report.phase),
    targetMayBePartiallyModified:
      report.targetMayBePartiallyModified === true,
  };
}

export function assertMaintenanceFailure(
  stderr: string,
  expected: {
    phase: string;
    code: string;
    stateMayBePartiallyModified: boolean;
  },
): void {
  const report = parseReport(stderr);
  assert.equal(report.phase, expected.phase);
  assert.equal(report.error.code, expected.code);
  assert.equal(
    report.stateMayBePartiallyModified,
    expected.stateMayBePartiallyModified,
  );
  assert.equal(Array.isArray(report.completedPhases), true);
  assert.equal("message" in report.error, false);
}

export function assertWalCheckpointReport(report: any): void {
  assert.equal(Number.isSafeInteger(report.busy), true);
  assert.equal(Number.isSafeInteger(report.log), true);
  assert.equal(Number.isSafeInteger(report.checkpointed), true);
  assert.equal(Number.isSafeInteger(report.remainingFrames), true);
  assert.equal(Number.isSafeInteger(report.pageSizeBytes), true);
  assert.equal(
    report.approximateRemainingBytes,
    report.remainingFrames * report.pageSizeBytes,
  );
}

export function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as
    | Record<string, unknown>
    | undefined;
  return Number(Object.values(row ?? {})[0] ?? 0);
}

export function plainRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

export function quickCheck(db: DatabaseSync): string[] {
  return (
    db.prepare("PRAGMA quick_check").all() as Array<
      Record<string, unknown>
    >
  ).map((row) => String(Object.values(row)[0]));
}

export function fileHash(path: string): string {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex");
}

export function withTempDirectory(
  run: (directory: string) => void,
): void {
  const directory = mkdtempSync(
    join(tmpdir(), "parilka-state-scripts-"),
  );
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

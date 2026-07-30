import type { DatabaseSync } from "node:sqlite";
import type {
  MaintenanceOptions,
  MaintenanceReport,
  RetentionCounts,
} from "./contracts.js";
import { scalarCount } from "./schema.js";
import { immediateTransaction } from "./transactions.js";

const TERMINAL_HISTORY_STATUSES_SQL =
  "'done', 'failed', 'skipped', 'catching_up'";
const TERMINAL_SEND_OUTBOX_STATUSES_SQL =
  "'sent', 'failed', 'expired'";
const DAY_MS = 24 * 60 * 60_000;

export function inspectRetentionCandidates(
  db: DatabaseSync,
  options: MaintenanceOptions,
  nowMs: number,
): MaintenanceReport["candidates"] {
  const historyCutoff = `-${options.historyRetentionDays} days`;
  const staleCutoff = `-${options.staleHistoryHours} hours`;
  const nowUnixSeconds = Math.floor(nowMs / 1_000);
  const botCutoffMs = nowMs - options.botRetentionDays * DAY_MS;
  const sendOutboxCutoffMs =
    nowMs - options.sendOutboxRetentionDays * DAY_MS;

  return {
    staleRunningHistoryJobs: scalarCount(
      db,
      `SELECT count(*) AS count
       FROM history_jobs
       WHERE status = 'running'
         AND started_at < datetime(?, 'unixepoch', ?)`,
      nowUnixSeconds,
      staleCutoff,
    ),
    terminalHistoryJobs: scalarCount(
      db,
      `SELECT count(*) AS count
       FROM history_jobs
       WHERE status IN (${TERMINAL_HISTORY_STATUSES_SQL})
         AND COALESCE(finished_at, started_at)
             < datetime(?, 'unixepoch', ?)
         AND job_id NOT IN (
           SELECT job_id
           FROM history_jobs
           ORDER BY started_at DESC, job_id DESC
           LIMIT ?
         )`,
      nowUnixSeconds,
      historyCutoff,
      options.keepHistoryJobs,
    ),
    terminalBotTurns: scalarCount(
      db,
      `SELECT count(*) AS count
       FROM bot_turns
       WHERE status IN ('sent', 'skipped', 'dead_letter')
         AND completed_at_ms IS NOT NULL
         AND completed_at_ms < ?`,
      botCutoffMs,
    ),
    orphanTerminalBotUpdates: scalarCount(
      db,
      `SELECT count(*) AS count
       FROM bot_updates u
       WHERE u.status IN ('sent', 'skipped', 'dead_letter')
         AND u.completed_at_ms IS NOT NULL
         AND u.completed_at_ms < ?
         AND NOT EXISTS (
           SELECT 1 FROM bot_turns t WHERE t.update_id = u.update_id
         )`,
      botCutoffMs,
    ),
    terminalSendOutbox: scalarCount(
      db,
      terminalSendOutboxSql("SELECT count(*) AS count"),
      sendOutboxCutoffMs,
      options.keepSendOutboxRows,
    ),
  };
}

export function applyRetention(
  db: DatabaseSync,
  options: MaintenanceOptions,
  nowMs: number,
): RetentionCounts {
  const historyCutoff = `-${options.historyRetentionDays} days`;
  const staleCutoff = `-${options.staleHistoryHours} hours`;
  const nowUnixSeconds = Math.floor(nowMs / 1_000);
  const botCutoffMs = nowMs - options.botRetentionDays * DAY_MS;
  const sendOutboxCutoffMs =
    nowMs - options.sendOutboxRetentionDays * DAY_MS;

  return immediateTransaction(db, () => {
    const changed = emptyRetentionCounts();
    changed.staleRunningHistoryJobs = Number(
      db
        .prepare(
          `UPDATE history_jobs
           SET status = 'failed',
               finished_at = datetime(?, 'unixepoch'),
               error = COALESCE(error, 'abandoned by retention after stale running state')
           WHERE status = 'running'
             AND started_at < datetime(?, 'unixepoch', ?)`,
        )
        .run(nowUnixSeconds, nowUnixSeconds, staleCutoff).changes,
    );
    changed.terminalHistoryJobs = Number(
      db
        .prepare(
          `DELETE FROM history_jobs
           WHERE status IN (${TERMINAL_HISTORY_STATUSES_SQL})
             AND COALESCE(finished_at, started_at)
                 < datetime(?, 'unixepoch', ?)
             AND job_id NOT IN (
               SELECT job_id
               FROM history_jobs
               ORDER BY started_at DESC, job_id DESC
               LIMIT ?
             )`,
        )
        .run(
          nowUnixSeconds,
          historyCutoff,
          options.keepHistoryJobs,
        ).changes,
    );

    const expiredUpdateIds = db
      .prepare(
        `SELECT update_id
         FROM bot_turns
         WHERE status IN ('sent', 'skipped', 'dead_letter')
           AND completed_at_ms IS NOT NULL
           AND completed_at_ms < ?`,
      )
      .all(botCutoffMs) as Array<{ update_id: number }>;
    changed.terminalBotTurns = Number(
      db
        .prepare(
          `DELETE FROM bot_turns
           WHERE status IN ('sent', 'skipped', 'dead_letter')
             AND completed_at_ms IS NOT NULL
             AND completed_at_ms < ?`,
        )
        .run(botCutoffMs).changes,
    );
    const deleteUpdate = db.prepare(
      `DELETE FROM bot_updates
       WHERE update_id = ?
         AND status IN ('sent', 'skipped', 'dead_letter')
         AND completed_at_ms IS NOT NULL
         AND completed_at_ms < ?`,
    );
    for (const { update_id: updateId } of expiredUpdateIds) {
      changed.terminalBotUpdates += Number(
        deleteUpdate.run(updateId, botCutoffMs).changes,
      );
    }
    changed.terminalBotUpdates += Number(
      db
        .prepare(
          `DELETE FROM bot_updates
           WHERE status IN ('sent', 'skipped', 'dead_letter')
             AND completed_at_ms IS NOT NULL
             AND completed_at_ms < ?
             AND NOT EXISTS (
               SELECT 1 FROM bot_turns
               WHERE bot_turns.update_id = bot_updates.update_id
             )`,
        )
        .run(botCutoffMs).changes,
    );
    changed.terminalSendOutbox = Number(
      db
        .prepare(terminalSendOutboxSql("DELETE"))
        .run(
          sendOutboxCutoffMs,
          options.keepSendOutboxRows,
        ).changes,
    );
    return changed;
  });
}

export function emptyRetentionCounts(): RetentionCounts {
  return {
    staleRunningHistoryJobs: 0,
    terminalHistoryJobs: 0,
    terminalBotTurns: 0,
    terminalBotUpdates: 0,
    terminalSendOutbox: 0,
  };
}

function terminalSendOutboxSql(prefix: string): string {
  return `${prefix}
    FROM send_outbox
    WHERE status IN (${TERMINAL_SEND_OUTBOX_STATUSES_SQL})
      AND updated_at_ms < ?
      AND id NOT IN (
        SELECT id
        FROM send_outbox
        WHERE status IN (${TERMINAL_SEND_OUTBOX_STATUSES_SQL})
        ORDER BY updated_at_ms DESC, created_at_ms DESC, id DESC
        LIMIT ?
      )`;
}

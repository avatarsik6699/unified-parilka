import type { DatabaseSync } from "node:sqlite";
import {
  FTS_REBUILD_JOB,
  type DeferredMaintenanceJobReport,
} from "./contracts.js";
import {
  completeMaintenanceJob,
  getMaintenanceJob,
  reportStatus,
} from "./jobs.js";
import { scalarCount } from "./schema.js";
import { immediateTransaction } from "./transactions.js";

export function inspectMessagesFtsRebuild(
  db: DatabaseSync,
): DeferredMaintenanceJobReport {
  const job = getMaintenanceJob(db, FTS_REBUILD_JOB);
  return {
    name: FTS_REBUILD_JOB,
    status: reportStatus(job),
    batches: 0,
    processedRows: 0,
    remainingRows:
      job?.status === "pending"
        ? scalarCount(db, "SELECT count(*) AS count FROM messages")
        : 0,
  };
}

export function processMessagesFtsRebuild(
  db: DatabaseSync,
): DeferredMaintenanceJobReport {
  const initial = getMaintenanceJob(db, FTS_REBUILD_JOB);
  if (initial?.status !== "pending") {
    return inspectMessagesFtsRebuild(db);
  }
  return immediateTransaction(db, () => {
    const job = getMaintenanceJob(db, FTS_REBUILD_JOB);
    if (job?.status !== "pending") {
      return inspectMessagesFtsRebuild(db);
    }
    const messageCount = scalarCount(
      db,
      "SELECT count(*) AS count FROM messages",
    );
    // FTS5 rebuild must observe one snapshot while live triggers are blocked.
    // A failed rebuild rolls back with the job still pending.
    db.exec(
      "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')",
    );
    db.exec(
      "INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)",
    );
    completeMaintenanceJob(db, job, {
      ...job.details,
      messageCount,
      rebuiltMessages: messageCount,
      rebuildMode: "atomic_fts5",
    });
    return {
      name: FTS_REBUILD_JOB,
      status: "completed",
      batches: 1,
      processedRows: messageCount,
      remainingRows: 0,
    };
  });
}

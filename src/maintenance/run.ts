import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  MaintenanceError,
  type DeferredMaintenanceJobReport,
  type MaintenanceExecutionState,
  type MaintenanceOptions,
  type MaintenanceReport,
} from "./contracts.js";
import {
  checkpointWarning,
  passiveWalCheckpoint,
} from "./checkpoint.js";
import {
  inspectMessagesFtsRebuild,
  processMessagesFtsRebuild,
} from "./deferred-fts.js";
import {
  inspectEmbeddingMembershipBackfill,
  processEmbeddingMembershipBackfill,
} from "./embedding-membership.js";
import { parseMaintenanceOptions } from "./options.js";
import {
  completePhase,
  createExecutionState,
  enterPhase,
  failureReport,
} from "./report.js";
import {
  applyRetention,
  emptyRetentionCounts,
  inspectRetentionCandidates,
} from "./retention.js";
import {
  assertMaintenanceSchema,
  assertQuickCheckPassed,
  quickCheck,
} from "./schema.js";

export function runMaintenanceCliMain(
  args: string[] = process.argv.slice(2),
): void {
  const state = createExecutionState();
  try {
    const options = parseMaintenanceOptions(args);
    completePhase(state);
    const report = runMaintenance(options, state);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(failureReport(state, error))}\n`,
    );
    process.exitCode = 1;
  }
}

export function runMaintenance(
  options: MaintenanceOptions,
  state: MaintenanceExecutionState = createExecutionState(),
): MaintenanceReport {
  enterPhase(state, "open");
  if (!existsSync(options.dbPath)) {
    throw new MaintenanceError(
      "database_missing",
      "The maintenance database does not exist.",
    );
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.dbPath, {
      readOnly: !options.apply,
    });
  } catch (error) {
    throw new MaintenanceError(
      "database_open_failed",
      "The maintenance database could not be opened.",
      { cause: error },
    );
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (!options.apply) {
      db.exec("PRAGMA query_only = ON");
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the setup failure.
    }
    throw new MaintenanceError(
      "database_open_failed",
      "The maintenance database could not be configured.",
      { cause: error },
    );
  }
  completePhase(state);

  try {
    enterPhase(state, "inspect");
    const integrity = quickCheck(db);
    assertQuickCheckPassed(integrity);
    assertMaintenanceSchema(db);
    const nowMs = Date.now();
    const candidates = inspectRetentionCandidates(
      db,
      options,
      nowMs,
    );
    const inspectedDeferred = inspectDeferredMaintenance(db);
    completePhase(state);

    if (!options.apply) {
      enterPhase(state, "report");
      const report: MaintenanceReport = {
        mode: "dry_run",
        dbPath: options.dbPath,
        integrity,
        candidates,
        changed: emptyRetentionCounts(),
        deferredMaintenance: inspectedDeferred,
        warnings: [],
      };
      completePhase(state);
      return report;
    }

    enterPhase(state, "retention");
    // Conservative on purpose: a process failure around COMMIT can make the
    // caller unable to prove whether this phase reached durable storage.
    state.retentionMayBeCommitted = true;
    const changed = applyRetention(db, options, nowMs);
    completePhase(state);

    const deferredMaintenance: DeferredMaintenanceJobReport[] = [];
    enterPhase(state, "deferred_fts");
    // Re-checking inside the job transaction can observe a newly-pending job,
    // so the failure report must not rely on the earlier inspection snapshot.
    state.deferredMaintenanceMayBeCommitted = true;
    deferredMaintenance.push(processMessagesFtsRebuild(db));
    completePhase(state);

    enterPhase(state, "deferred_embedding_membership");
    deferredMaintenance.push(
      processEmbeddingMembershipBackfill(
        db,
        options.deferredBatchSize,
        options.deferredMaxBatches,
      ),
    );
    completePhase(state);

    const warnings: string[] = [];
    enterPhase(state, "optimize");
    try {
      db.exec("PRAGMA optimize");
    } catch {
      warnings.push(
        "Retention/deferred work committed, but PRAGMA optimize failed.",
      );
    }
    completePhase(state);

    enterPhase(state, "checkpoint");
    let walCheckpoint: MaintenanceReport["walCheckpoint"];
    try {
      walCheckpoint = passiveWalCheckpoint(db);
      const warning = checkpointWarning(walCheckpoint);
      if (warning) {
        warnings.push(warning);
      }
    } catch {
      warnings.push(
        "Retention/deferred work committed, but passive WAL checkpoint failed.",
      );
    }
    completePhase(state);

    enterPhase(state, "report");
    const report: MaintenanceReport = {
      mode: "applied",
      dbPath: options.dbPath,
      integrity,
      candidates,
      changed,
      deferredMaintenance,
      ...(walCheckpoint ? { walCheckpoint } : {}),
      warnings,
    };
    completePhase(state);
    return report;
  } finally {
    db.close();
  }
}

function inspectDeferredMaintenance(
  db: DatabaseSync,
): DeferredMaintenanceJobReport[] {
  return [
    inspectMessagesFtsRebuild(db),
    inspectEmbeddingMembershipBackfill(db),
  ];
}

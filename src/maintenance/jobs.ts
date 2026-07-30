import type { DatabaseSync } from "node:sqlite";
import type {
  DeferredMaintenanceStatus,
  MaintenanceJobRow,
} from "./contracts.js";

export function getMaintenanceJob(
  db: DatabaseSync,
  name: string,
): MaintenanceJobRow | undefined {
  const row = db
    .prepare(
      `SELECT name, status, reason, details_json, updated_at
       FROM maintenance_jobs
       WHERE name = ?`,
    )
    .get(name) as Record<string, unknown> | undefined;
  if (!row) {
    return undefined;
  }
  const status = String(row.status);
  if (status !== "pending" && status !== "completed") {
    throw new Error(`Maintenance job ${name} has an invalid status.`);
  }
  return {
    name: String(row.name),
    status,
    ...(row.reason == null
      ? {}
      : { reason: String(row.reason) }),
    details: parseJobDetails(row.details_json),
    updatedAt: String(row.updated_at),
  };
}

export function reportStatus(
  job: MaintenanceJobRow | undefined,
): DeferredMaintenanceStatus {
  return job?.status ?? "not_pending";
}

export function updatePendingMaintenanceJob(
  db: DatabaseSync,
  job: MaintenanceJobRow,
  details: Record<string, unknown>,
): void {
  const result = db
    .prepare(
      `UPDATE maintenance_jobs
       SET details_json = ?,
           updated_at = datetime('now'),
           completed_at = NULL
       WHERE name = ? AND status = 'pending'`,
    )
    .run(JSON.stringify(details), job.name);
  if (Number(result.changes) !== 1) {
    throw new Error(
      `Maintenance job ${job.name} changed state during its batch.`,
    );
  }
}

export function completeMaintenanceJob(
  db: DatabaseSync,
  job: MaintenanceJobRow,
  details: Record<string, unknown>,
): void {
  const result = db
    .prepare(
      `UPDATE maintenance_jobs
       SET status = 'completed',
           details_json = ?,
           updated_at = datetime('now'),
           completed_at = datetime('now')
       WHERE name = ? AND status = 'pending'`,
    )
    .run(JSON.stringify(details), job.name);
  if (Number(result.changes) !== 1) {
    throw new Error(
      `Maintenance job ${job.name} changed state during completion.`,
    );
  }
}

export function progressInteger(
  value: unknown,
): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

export function safePositiveInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > maximum
  ) {
    throw new Error(
      `${label} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return parsed;
}

function parseJobDetails(
  value: unknown,
): Record<string, unknown> {
  if (value == null || value === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

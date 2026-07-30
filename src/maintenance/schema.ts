import type { DatabaseSync } from "node:sqlite";
import {
  MAX_SUPPORTED_SCHEMA_VERSION,
  MaintenanceError,
  MIN_SUPPORTED_SCHEMA_VERSION,
} from "./contracts.js";

const REQUIRED_TABLE_COLUMNS = {
  messages: ["chat_id", "message_id", "text"],
  history_jobs: [
    "job_id",
    "status",
    "started_at",
    "finished_at",
    "error",
  ],
  send_outbox: [
    "id",
    "status",
    "dedupe_key",
    "created_at_ms",
    "updated_at_ms",
  ],
  bot_updates: ["update_id", "status", "completed_at_ms"],
  bot_turns: ["id", "update_id", "status", "completed_at_ms"],
  maintenance_jobs: [
    "name",
    "status",
    "reason",
    "details_json",
    "updated_at",
    "completed_at",
  ],
  message_embedding_chunks: [
    "id",
    "chat_id",
    "start_message_id",
    "end_message_id",
    "message_count",
    "dirty_at",
  ],
  message_embedding_chunk_messages: [
    "chunk_id",
    "chat_id",
    "message_id",
    "position",
  ],
} as const;

export function quickCheck(db: DatabaseSync): string[] {
  try {
    return (
      db.prepare("PRAGMA quick_check").all() as Array<
        Record<string, unknown>
      >
    ).map((row) => String(Object.values(row)[0]));
  } catch (error) {
    throw new MaintenanceError(
      "quick_check_failed",
      "SQLite quick_check could not be completed.",
      { cause: error },
    );
  }
}

export function assertQuickCheckPassed(results: string[]): void {
  if (results.length !== 1 || results[0] !== "ok") {
    throw new MaintenanceError(
      "quick_check_failed",
      "SQLite quick_check failed; maintenance was not attempted.",
    );
  }
}

export function assertMaintenanceSchema(db: DatabaseSync): void {
  const versionRow = db
    .prepare("PRAGMA user_version")
    .get() as Record<string, unknown> | undefined;
  const version = Number(versionRow?.user_version);
  if (
    !Number.isSafeInteger(version) ||
    version < MIN_SUPPORTED_SCHEMA_VERSION ||
    version > MAX_SUPPORTED_SCHEMA_VERSION
  ) {
    throw new MaintenanceError(
      "incompatible_schema",
      `Unsupported schema version ${String(version)}.`,
    );
  }
  for (const [table, requiredColumns] of Object.entries(
    REQUIRED_TABLE_COLUMNS,
  )) {
    if (!tableExists(db, table)) {
      throw new MaintenanceError(
        "incompatible_schema",
        `Required table ${table} is missing.`,
      );
    }
    const rows = db
      .prepare(`PRAGMA table_info("${table}")`)
      .all() as Array<Record<string, unknown>>;
    const present = new Set(rows.map((row) => String(row.name)));
    const missing = requiredColumns.filter(
      (column) => !present.has(column),
    );
    if (missing.length > 0) {
      throw new MaintenanceError(
        "incompatible_schema",
        `Table ${table} is missing required columns.`,
      );
    }
  }
}

export function scalarCount(
  db: DatabaseSync,
  sql: string,
  ...params: Array<string | number>
): number {
  const row = db.prepare(sql).get(...params) as
    | Record<string, unknown>
    | undefined;
  const count = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Maintenance count query returned invalid data.");
  }
  return count;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(table) as Record<string, unknown> | undefined;
  return row?.present === 1;
}

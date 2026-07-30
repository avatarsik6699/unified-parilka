import { ToolError } from "../../errors.js";
import { StoreCore } from "../core.js";
import {
  FTS_REBUILD_INLINE_MESSAGE_LIMIT,
  MANAGED_TRIGGER_DEFINITIONS,
  MESSAGES_FTS_SQL,
  MESSAGES_FTS_VERSION,
} from "../constants.js";
import {
  hashSql,
  normalizeSql,
} from "../sqlite-utils.js";
import type {
  MaintenanceJobName,
  MaintenanceJobStatus,
} from "../types.js";

/**
 * Method module installed on MessageStore.prototype.
 *
 * It is never instantiated, so every method operates on the single StoreCore
 * DatabaseSync owned by MessageStore.
 */
export abstract class SchemaObjectMethods extends StoreCore {
declare isMaintenanceJobPending: (name: MaintenanceJobName) => boolean;

  protected ensureMessagesFtsDefinition(): void {
    const existing = this.sqliteObjectSql("table", "messages_fts");
    const needsRepair = existing == null || normalizeSql(existing) !== normalizeSql(MESSAGES_FTS_SQL);
    if (needsRepair) {
      this.dropMessagesFtsObjects();
      this.db.exec(MESSAGES_FTS_SQL);
      this.maybeRebuildMessagesFts("messages_fts definition was missing or stale.");
    }
    this.recordSchemaObjectVersion("messages_fts", "table", MESSAGES_FTS_VERSION, MESSAGES_FTS_SQL);
  }

  protected ensureManagedTriggerDefinition(definition: (typeof MANAGED_TRIGGER_DEFINITIONS)[number]): void {
    const existing = this.sqliteObjectSql("trigger", definition.name);
    const needsRepair = existing == null || normalizeSql(existing) !== normalizeSql(definition.sql);
    if (needsRepair) {
      this.db.exec(`DROP TRIGGER IF EXISTS ${definition.name}`);
      this.db.exec(definition.sql);
    }
    this.recordSchemaObjectVersion(definition.name, "trigger", definition.version, definition.sql);
  }

  protected dropMessagesFtsObjects(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TABLE IF EXISTS messages_fts;
    `);
  }

  protected maybeRebuildMessagesFts(reason: string): void {
    const messageCount = this.countRows("messages");
    if (messageCount > FTS_REBUILD_INLINE_MESSAGE_LIMIT) {
      this.upsertMaintenanceJob("messages_fts_rebuild", "pending", reason, {
        messageCount,
        inlineLimit: FTS_REBUILD_INLINE_MESSAGE_LIMIT,
        remediation: "Run a bounded maintenance rebuild before relying on keyword search coverage.",
      });
      return;
    }
    this.rebuildMessagesFts();
    this.upsertMaintenanceJob("messages_fts_rebuild", "completed", reason, {
      messageCount,
      inlineLimit: FTS_REBUILD_INLINE_MESSAGE_LIMIT,
    });
  }

  protected recordSchemaObjectVersion(name: string, type: "table" | "trigger", version: number, sql: string): void {
    this.db
      .prepare(
        `INSERT INTO schema_object_versions (object_name, object_type, object_version, object_hash, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(object_name) DO UPDATE SET
           object_type = excluded.object_type,
           object_version = excluded.object_version,
           object_hash = excluded.object_hash,
           updated_at = excluded.updated_at`,
      )
      .run(name, type, version, hashSql(sql));
  }

  protected ensureColumn(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  protected hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    return rows.some((row) => row.name === column);
  }

  protected rebuildMessagesFts(): void {
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  }

  protected assertSqliteObject(type: "table" | "index" | "trigger", name: string): void {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error(`Database schema validation failed: missing ${type} ${name}.`);
    }
  }

  protected assertColumns(table: string, columns: string[]): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    const present = new Set(rows.map((row) => String(row.name)));
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(`Database schema validation failed: ${table} missing required column ${column}.`);
      }
    }
  }

  protected sqliteObjectSql(type: "table" | "trigger", name: string): string | undefined {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as
      | Record<string, unknown>
      | undefined;
    return typeof row?.sql === "string" ? row.sql : undefined;
  }

  protected countRows(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  protected upsertMaintenanceJob(
    name: string,
    status: MaintenanceJobStatus,
    reason: string,
    details: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_jobs (name, status, reason, details_json, updated_at, completed_at)
         VALUES (?, ?, ?, ?, datetime('now'), CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END)
         ON CONFLICT(name) DO UPDATE SET
           status = excluded.status,
           reason = excluded.reason,
           details_json = excluded.details_json,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
      )
      .run(name, status, reason, JSON.stringify(details), status);
  }

  protected assertMaintenanceJobReady(
    name: MaintenanceJobName,
    message: string,
  ): void {
    if (!this.isMaintenanceJobPending(name)) {
      return;
    }
    throw new ToolError({
      category: "internal",
      retryable: true,
      message,
    });
  }
}

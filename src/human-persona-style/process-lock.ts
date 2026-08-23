import { chmodSync, lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface StyleProfileProcessLock {
  path: string;
  mechanism: "sqlite_immediate";
  release(): void;
}

export interface StyleProfileProcessLockOptions {
  lockDirectory?: string;
}

export class StyleProfileLockHeldError extends Error {
  readonly name = "StyleProfileLockHeldError";
  readonly code = "human_persona_style_lock_held";
}

/**
 * One local apply-owner lock for the style-profile pipeline, independent of
 * Digest's lock (`src/digest/process-lock.ts`) so the two pipelines never
 * contend on each other's sidecar file even though they share a DB.
 */
export function acquireStyleProfileProcessLock(
  dbPath: string,
  options: StyleProfileProcessLockOptions = {},
): StyleProfileProcessLock {
  if (!isAbsolute(dbPath)) {
    throw new Error("Style-profile lock database path must be absolute.");
  }
  const dbStat = statSync(dbPath);
  if (!dbStat.isFile()) {
    throw new Error(
      "Style-profile lock database path must name a regular file.",
    );
  }
  if (dbStat.nlink !== 1) {
    throw new Error(
      "Style-profile lock database must not have hardlink aliases.",
    );
  }
  const lockDirectory = options.lockDirectory ?? dirname(dbPath);
  if (!isAbsolute(lockDirectory)) {
    throw new Error("Style-profile lock directory must be absolute.");
  }
  assertPrivateLockDirectory(lockDirectory);
  const lockPath = join(
    lockDirectory,
    `.bot-agi-human-persona-style-${dbStat.dev}-${dbStat.ino}.lock.sqlite`,
  );
  try {
    const lockStat = lstatSync(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
      throw new Error(
        "Style-profile lock path must name a regular non-symbolic file.",
      );
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  let lockDb: DatabaseSync | undefined;
  try {
    lockDb = new DatabaseSync(lockPath);
    chmodSync(lockPath, 0o600);
    lockDb.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS human_persona_style_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      );
    `);
    // Hold the transaction for the complete run. This locks only the tiny
    // sidecar database; process exit releases SQLite's kernel lock.
    lockDb.exec("BEGIN IMMEDIATE;");
  } catch (error) {
    try {
      lockDb?.close();
    } catch {
      // Preserve the original acquisition error.
    }
    if (isSqliteLockContention(error)) {
      throw new StyleProfileLockHeldError(
        "Another style-profile generation process holds the lock.",
      );
    }
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    mechanism: "sqlite_immediate",
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        lockDb!.exec("ROLLBACK;");
      } finally {
        lockDb!.close();
      }
    },
  };
}

function isSqliteLockContention(error: unknown): boolean {
  return (
    hasErrorCode(error, "SQLITE_BUSY") ||
    (error instanceof Error &&
      /(?:database is locked|SQLITE_BUSY)/iu.test(error.message))
  );
}

function assertPrivateLockDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Style-profile lock directory must be a private, non-symbolic directory owned by the current user (mode 0700 or stricter).",
    );
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

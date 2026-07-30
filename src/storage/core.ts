import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import {
  SQLITE_BUSY_RETRY_ATTEMPTS,
  SQLITE_BUSY_RETRY_INITIAL_MS,
  SQLITE_BUSY_TIMEOUT_MS,
} from "./constants.js";
import { isSqliteBusy, sleepSync } from "./sqlite-utils.js";
import type { MessageStoreOptions } from "./types.js";

const logger = createLogger({ service: "store" });

export class StoreCore {
  protected readonly db: DatabaseSync;

  constructor(path: string, options: MessageStoreOptions = {}) {
    this.db = new DatabaseSync(path, {
      readOnly: options.readOnly === true,
    });
    try {
      if (options.readOnly !== true && path !== ":memory:") {
        // The parent state directory is private in production, but keeping the
        // database itself private prevents accidental exposure when operators
        // copy or inspect it outside that directory.
        chmodSync(path, 0o600);
      }
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  getSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    return Number(row?.user_version ?? 0);
  }

  close(): void {
    this.db.close();
  }

  protected immediateTransaction<T>(operation: string, fn: () => T): T {
    return this.writeWithRetry(operation, () => {
      let started = false;
      try {
        this.db.exec("BEGIN IMMEDIATE");
        started = true;
        const result = fn();
        this.db.exec("COMMIT");
        started = false;
        return result;
      } catch (error) {
        if (started) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            logger.error({
              event: "sqlite.rollback_failed",
              operation,
              failure: safeError(rollbackError),
            });
          }
        }
        throw error;
      }
    });
  }

  protected writeWithRetry<T>(operation: string, fn: () => T): T {
    let delayMs = SQLITE_BUSY_RETRY_INITIAL_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return fn();
      } catch (error) {
        if (!isSqliteBusy(error) || attempt >= SQLITE_BUSY_RETRY_ATTEMPTS) {
          throw error;
        }
        const nextAttempt = attempt + 1;
        logger.warn({
          event: "sqlite.busy_retry",
          operation,
          attempt: nextAttempt,
          maxAttempts: SQLITE_BUSY_RETRY_ATTEMPTS,
          delayMs,
        });
        sleepSync(delayMs);
        delayMs *= 2;
      }
    }
  }
}

import type { DatabaseSync } from "node:sqlite";

export function immediateTransaction<T>(
  db: DatabaseSync,
  operation: () => T,
): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original maintenance failure.
    }
    throw error;
  }
}

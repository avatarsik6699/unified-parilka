import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

export function escapeFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "\"\""))
    .filter(Boolean);
  if (terms.length === 0) {
    return "\"\"";
  }
  return terms.map((term) => `"${term}"`).join(" AND ");
}

export function toSqlValues(values: readonly unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      ArrayBuffer.isView(value)
    ) {
      return value as SQLInputValue;
    }
    throw new TypeError("SQLite bind values must be scalar or binary values.");
  });
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/;$/, "").trim().toLowerCase();
}

export function hashSql(sql: string): string {
  return createHash("sha256").update(normalizeSql(sql)).digest("hex");
}

export function normalizeChunkMessageIds(messageIds: number[] | undefined, startMessageId: number, endMessageId: number): number[] {
  const ids = messageIds?.length
    ? messageIds
    : Array.from({ length: Math.max(0, endMessageId - startMessageId + 1) }, (_, index) => startMessageId + index);
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id)))];
}

export function isSqliteBusy(error: unknown): boolean {
  const anyError = error as { code?: string; message?: string };
  const message = String(anyError?.message ?? error ?? "").toUpperCase();
  return anyError?.code === "SQLITE_BUSY" || message.includes("SQLITE_BUSY") || message.includes("DATABASE IS LOCKED");
}

export function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

import type { DatabaseSync } from "node:sqlite";
import type { WalCheckpointReport } from "./contracts.js";

export function passiveWalCheckpoint(
  db: DatabaseSync,
): WalCheckpointReport {
  const row = db
    .prepare("PRAGMA wal_checkpoint(PASSIVE)")
    .get() as Record<string, unknown> | undefined;
  const pageSizeRow = db
    .prepare("PRAGMA page_size")
    .get() as Record<string, unknown> | undefined;
  return normalizeWalCheckpoint(
    row ?? {},
    pageSizeRow ?? {},
  );
}

export function normalizeWalCheckpoint(
  checkpoint: Record<string, unknown>,
  pageSize: Record<string, unknown>,
): WalCheckpointReport {
  const busy = nonnegativeInteger(
    checkpoint.busy ?? Object.values(checkpoint)[0],
  );
  const log = nonnegativeInteger(
    checkpoint.log ?? Object.values(checkpoint)[1],
  );
  const checkpointed = nonnegativeInteger(
    checkpoint.checkpointed ?? Object.values(checkpoint)[2],
  );
  const pageSizeBytes = nonnegativeInteger(
    pageSize.page_size ?? Object.values(pageSize)[0],
  );
  const remainingFrames = Math.max(0, log - checkpointed);
  return {
    busy: busy > 0 ? 1 : 0,
    log,
    checkpointed,
    remainingFrames,
    pageSizeBytes,
    approximateRemainingBytes: safeProduct(
      remainingFrames,
      pageSizeBytes,
    ),
  };
}

export function checkpointWarning(
  checkpoint: WalCheckpointReport,
): string | undefined {
  if (checkpoint.remainingFrames === 0) {
    return undefined;
  }
  return (
    `Passive WAL checkpoint left ${checkpoint.remainingFrames} ` +
    `frame(s), approximately ${checkpoint.approximateRemainingBytes} ` +
    "byte(s), for a later run."
  );
}

function nonnegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeProduct(left: number, right: number): number {
  const product = left * right;
  return Number.isSafeInteger(product)
    ? product
    : Number.MAX_SAFE_INTEGER;
}

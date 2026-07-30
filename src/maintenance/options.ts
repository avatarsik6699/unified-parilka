import { resolve } from "node:path";
import type { MaintenanceOptions } from "./contracts.js";

const DEFAULT_DEFERRED_BATCH_SIZE = 500;
const DEFAULT_DEFERRED_MAX_BATCHES = 50;
const MAX_DEFERRED_BATCH_SIZE = 5_000;
const MAX_DEFERRED_BATCHES = 1_000;

export function parseMaintenanceOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceOptions {
  let dbPath = env.TELEGRAM_DB_PATH?.trim() || undefined;
  let apply = false;
  let historyRetentionDays = 30;
  let botRetentionDays = 60;
  let sendOutboxRetentionDays = 30;
  let staleHistoryHours = 24;
  let keepHistoryJobs = 1_000;
  let keepSendOutboxRows = 1_000;
  let deferredBatchSize = DEFAULT_DEFERRED_BATCH_SIZE;
  let deferredMaxBatches = DEFAULT_DEFERRED_MAX_BATCHES;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;
    switch (arg) {
      case "--db":
        dbPath = value;
        break;
      case "--history-days":
        historyRetentionDays = positiveInteger(
          value,
          arg,
          3_650,
        );
        break;
      case "--bot-days":
        botRetentionDays = positiveInteger(value, arg, 3_650);
        break;
      case "--send-outbox-days":
        sendOutboxRetentionDays = positiveInteger(
          value,
          arg,
          3_650,
        );
        break;
      case "--stale-history-hours":
        staleHistoryHours = positiveInteger(
          value,
          arg,
          24 * 365,
        );
        break;
      case "--keep-history-jobs":
        keepHistoryJobs = positiveInteger(
          value,
          arg,
          1_000_000,
        );
        break;
      case "--keep-send-outbox-rows":
        keepSendOutboxRows = positiveInteger(
          value,
          arg,
          1_000_000,
        );
        break;
      case "--deferred-batch-size":
        deferredBatchSize = positiveInteger(
          value,
          arg,
          MAX_DEFERRED_BATCH_SIZE,
        );
        break;
      case "--deferred-max-batches":
        deferredMaxBatches = positiveInteger(
          value,
          arg,
          MAX_DEFERRED_BATCHES,
        );
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!dbPath) {
    throw new Error(
      "Usage: maintain-state --db messages.sqlite [--apply] [retention options] [--deferred-batch-size N] [--deferred-max-batches N]",
    );
  }
  return {
    dbPath: resolve(dbPath),
    apply,
    historyRetentionDays,
    botRetentionDays,
    sendOutboxRetentionDays,
    staleHistoryHours,
    keepHistoryJobs,
    keepSendOutboxRows,
    deferredBatchSize,
    deferredMaxBatches,
  };
}

function positiveInteger(
  raw: string,
  field: string,
  maximum: number,
): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${field} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be between 1 and ${maximum}.`);
  }
  return value;
}

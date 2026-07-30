import {
  normalizeError,
  ToolError,
  type NormalizedError,
} from "../errors.js";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import type { MessageStore } from "../store.js";
import type { TelegramGateway } from "../telegram/types.js";
import type {
  SyncOnceResult,
  SyncResult,
} from "./contracts.js";

const logger = createLogger({ service: "sync" });
const DEFAULT_TELEGRAM_DESTROY_TIMEOUT_MS = 30_000;

export function syncErrors(
  result: SyncOnceResult,
): NormalizedError[] {
  return [result.recent?.error, result.backfill?.error].filter(
    (error): error is NormalizedError => error != null,
  );
}

export function shouldStopDaemonForErrors(
  errors: NormalizedError[],
): boolean {
  return errors.some(
    (error) => error.category === "auth" && !error.retryable,
  );
}

export function classifyDaemonErrors(
  coreErrors: NormalizedError[],
  embeddingFailure?: NormalizedError,
): {
  healthErrors: NormalizedError[];
  stopErrors: NormalizedError[];
  delayErrors: NormalizedError[];
} {
  return {
    healthErrors: embeddingFailure
      ? [...coreErrors, embeddingFailure]
      : coreErrors,
    // Optional embedding failures remain visible in health but never control
    // the sole MTProto history owner's lifecycle or polling cadence.
    stopErrors: coreErrors,
    delayErrors: coreErrors,
  };
}

export function stopOnPermanentDaemonErrors(
  errors: NormalizedError[],
): void {
  const permanent = errors.find(
    (error) => error.category === "auth" && !error.retryable,
  );
  if (permanent) {
    throw new ToolError(permanent);
  }
}

export function recordDaemonStarted(store: MessageStore): void {
  try {
    store.recordDaemonTickStarted();
  } catch (error) {
    logger.error({
      event: "sync.status_start_write_failed",
      failure: safeError(error),
    });
  }
}

export function recordDaemonOutcome(
  store: MessageStore,
  errors: NormalizedError[],
): void {
  try {
    if (errors.length > 0) {
      store.recordDaemonTickFailure(daemonErrorSummary(errors));
    } else {
      store.recordDaemonTickSuccess();
    }
  } catch (error) {
    logger.error({
      event:
        errors.length > 0
          ? "sync.status_failure_write_failed"
          : "sync.status_success_write_failed",
      failure: safeError(error),
    });
  }
}

export function computeDaemonDelayMs(params: {
  intervalMs: number;
  elapsedMs: number;
  errors: NormalizedError[];
  previousBackoffMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  retryAfterMaxMs?: number;
  minDelayMs?: number;
}): {
  delayMs: number;
  nextBackoffMs: number;
  reason: "interval" | "retry_after" | "backoff";
} {
  const minDelayMs = params.minDelayMs ?? 1_000;
  const intervalDelayMs = Math.max(
    minDelayMs,
    params.intervalMs - params.elapsedMs,
  );
  const retryAfterMaxMs = Math.max(
    0,
    params.retryAfterMaxMs ?? params.backoffMaxMs,
  );
  const requestedRetryAfterMs = Math.max(
    0,
    ...params.errors.map(
      (error) => (error.retryAfterSec ?? 0) * 1000,
    ),
  );
  const retryAfterMs = Math.min(
    requestedRetryAfterMs,
    retryAfterMaxMs,
  );
  if (retryAfterMs > 0) {
    return {
      delayMs: Math.max(intervalDelayMs, retryAfterMs),
      nextBackoffMs: 0,
      reason: "retry_after",
    };
  }

  if (params.errors.some((error) => error.retryable)) {
    const nextBackoffMs =
      params.previousBackoffMs > 0
        ? Math.min(
            params.previousBackoffMs * 2,
            params.backoffMaxMs,
          )
        : Math.min(
            params.backoffInitialMs,
            params.backoffMaxMs,
          );
    return {
      delayMs: Math.max(intervalDelayMs, nextBackoffMs),
      nextBackoffMs,
      reason: "backoff",
    };
  }

  return {
    delayMs: intervalDelayMs,
    nextBackoffMs: 0,
    reason: "interval",
  };
}

export async function disconnectTelegramBestEffort(
  telegram: Pick<TelegramGateway, "disconnect">,
): Promise<NormalizedError | undefined> {
  try {
    await telegram.disconnect();
    return undefined;
  } catch (error) {
    const normalized = normalizeError(error);
    logger.warn({
      event: "telegram.disconnect_failed",
      failure: normalized,
    });
    return normalized;
  }
}

export async function destroyTelegramBestEffort(
  telegram: Pick<TelegramGateway, "destroy">,
  timeoutMs = DEFAULT_TELEGRAM_DESTROY_TIMEOUT_MS,
): Promise<NormalizedError | undefined> {
  try {
    await withDestroyTimeout(telegram.destroy(), timeoutMs);
    return undefined;
  } catch (error) {
    const normalized = normalizeError(error);
    logger.error({
      event: "telegram.destroy_failed",
      failure: normalized,
    });
    return normalized;
  }
}

async function withDestroyTimeout(
  destroy: PromiseLike<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      destroy,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ToolError({
                category: "internal",
                retryable: true,
                message:
                  `Telegram destroy timed out after ${timeoutMs}ms.`,
              }),
            ),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function summarizeSyncResult(
  result: SyncResult | undefined,
): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  return {
    mode: result.mode,
    status: result.status,
    skipped: result.skipped,
    fetched: result.fetched,
    saved: result.saved,
    nextOffsetId: result.nextOffsetId,
    failure: result.error,
  };
}

function daemonErrorSummary(
  errors: NormalizedError[],
): string {
  return errors
    .map((error) => `${error.category}: ${error.message}`)
    .join(" | ");
}

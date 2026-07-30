import { ToolError } from "../errors.js";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import type { HistorySleep } from "./contracts.js";

const logger = createLogger({ service: "sync" });

export async function* iterateWithOperationTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  operation: string,
  pacing?: {
    chunkSize: number;
    delayMs: number;
    sleep: HistorySleep;
  },
  signal?: AbortSignal,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let yielded = 0;
  while (true) {
    let result: IteratorResult<T>;
    try {
      if (
        pacing &&
        pacing.delayMs > 0 &&
        yielded > 0 &&
        yielded % pacing.chunkSize === 0
      ) {
        throwIfSyncAborted(signal);
        await withAbort(
          pacing.sleep(pacing.delayMs, signal),
          signal,
        );
        throwIfSyncAborted(signal);
      }
      result = await withOperationTimeout(
        iterator.next(),
        timeoutMs,
        operation,
        signal,
      );
    } catch (error) {
      closeIteratorQuietly(iterator, operation);
      throw error;
    }
    if (result.done) {
      return;
    }
    yielded += 1;
    yield result.value;
  }
}

export const sleepMs: HistorySleep = async (
  delayMs,
  signal,
): Promise<void> => {
  throwIfSyncAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, Math.max(0, delayMs));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(syncAbortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
};

export async function withAbort<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfSyncAborted(signal);
  if (!signal) {
    return await promise;
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(syncAbortReason(signal));
        signal.addEventListener("abort", onAbort, {
          once: true,
        });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function withOperationTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  operation: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfSyncAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError({
              category: "internal",
              retryable: true,
              message: `${operation} timed out after ${timeoutMs}ms.`,
            }),
          );
        }, Math.max(1, timeoutMs));
      }),
      ...(signal === undefined
        ? []
        : [
            new Promise<T>((_resolve, reject) => {
              onAbort = () =>
                reject(syncAbortReason(signal));
              signal.addEventListener("abort", onAbort, {
                once: true,
              });
            }),
          ]),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function throwIfSyncAborted(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw syncAbortReason(signal);
  }
}

export function syncAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("History sync was aborted."), {
        name: "AbortError",
        code: "ABORT_ERR",
      });
}

export function combineSyncSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (active.length === 0) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}

function closeIteratorQuietly<T>(
  iterator: AsyncIterator<T>,
  operation: string,
): void {
  const close = iterator.return?.bind(iterator);
  if (!close) {
    return;
  }
  void close().catch((error) => {
    logger.warn({
      event: "sync.iterator_cleanup_failed",
      operation,
      failure: safeError(error),
    });
  });
}

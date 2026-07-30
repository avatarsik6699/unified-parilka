import { ToolError } from "../errors.js";
import { syncAbortReason, throwIfSyncAborted } from "./abort.js";
import type {
  HistorySyncPort,
  SyncDirectionParams,
  SyncOnceParams,
  SyncOnceResult,
  SyncResult,
} from "./contracts.js";

/**
 * One bounded history lane for the daemon tick and MCP-triggered syncs. Local
 * cache reads remain concurrent, but two cursor writers can never traverse and
 * commit the same Telegram range at once.
 */
export class SerializedHistorySyncer implements HistorySyncPort {
  readonly #inner: HistorySyncPort;
  readonly #maxQueued: number;
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;

  constructor(inner: HistorySyncPort, maxQueued = 4) {
    if (
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 1 ||
      maxQueued > 100
    ) {
      throw new RangeError("maxQueued must be between 1 and 100.");
    }
    this.#inner = inner;
    this.#maxQueued = maxQueued;
  }

  syncOnce(
    params: SyncOnceParams = {},
  ): Promise<SyncOnceResult> {
    return this.#enqueue(
      () => this.#inner.syncOnce(params),
      params.signal,
    );
  }

  syncDirection(
    params: SyncDirectionParams,
  ): Promise<SyncResult> {
    return this.#enqueue(
      () => this.#inner.syncDirection(params),
      params.signal,
    );
  }

  #enqueue<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(syncAbortReason(signal));
    }
    if (this.#queued >= this.#maxQueued) {
      return Promise.reject(
        new ToolError({
          category: "internal",
          retryable: true,
          message: "Telegram history sync lane is busy.",
        }),
      );
    }
    this.#queued += 1;
    let started = false;
    let counted = true;
    const releaseCapacity = (): void => {
      if (!counted) {
        return;
      }
      counted = false;
      this.#queued -= 1;
    };
    const run = async (): Promise<T> => {
      throwIfSyncAborted(signal);
      started = true;
      return await operation();
    };
    const execution = this.#tail.then(run, run);
    this.#tail = execution.then(
      () => undefined,
      () => undefined,
    );
    void execution.then(releaseCapacity, releaseCapacity);

    if (!signal) {
      return execution;
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!started) {
          releaseCapacity();
        }
        reject(syncAbortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void execution.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }
}

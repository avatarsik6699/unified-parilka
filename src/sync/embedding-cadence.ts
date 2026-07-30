import {
  normalizeError,
  ToolError,
  type NormalizedError,
} from "../errors.js";
import { safeError } from "../observability/redaction.js";
import type { VectorRag } from "../vector-rag.js";

export type EmbeddingIndexReport = Record<string, unknown> & {
  failure?: NormalizedError;
};

export async function indexEmbeddings(
  vectorRag: VectorRag,
  chatId: string | undefined,
  signal?: AbortSignal,
): Promise<EmbeddingIndexReport | null> {
  throwIfDaemonAborted(signal);
  if (!chatId || !vectorRag.isConfigured) {
    return null;
  }
  try {
    const estimate = vectorRag.estimateIndexCachedMessages({
      chatId,
    });
    if (estimate.requiresConfirmation) {
      return {
        skipped:
          "first_embedding_index_requires_manual_confirmation",
        estimate,
      };
    }
    throwIfDaemonAborted(signal);
    const result = await vectorRag.indexCachedMessages({
      chatId,
      confirmFirstRun: true,
      signal,
    });
    return {
      chunksCreated: result.chunksCreated,
      messagesCovered: result.messagesCovered,
      nextAfterMessageId: result.nextAfterMessageId,
      staleChunks: result.staleChunks,
      budget: result.budget,
      coverage: result.coverage,
    };
  } catch (error) {
    throwIfDaemonAborted(signal);
    const failure = normalizeError(error);
    return {
      failure: {
        ...failure,
        message: safeError(error).message,
      },
    };
  }
}

export interface EmbeddingCadenceOptions {
  intervalMs: number;
  budgetMs: number;
  retryMaxMs: number;
  shutdownSignal?: AbortSignal;
  now?: () => number;
  onReport?: (report: EmbeddingIndexReport | null) => void;
}

export interface EmbeddingCadenceSnapshot {
  active: boolean;
  nextRunAtMs: number;
  report: EmbeddingIndexReport | null;
}

/**
 * Optional embedding work is launched out-of-band. `offer` never awaits the
 * provider, so history tick cadence and backoff remain core-Telegram-only.
 */
export class EmbeddingCadenceRunner {
  readonly #now: () => number;
  #active?: Promise<void>;
  #nextRunAtMs = 0;
  #report: EmbeddingIndexReport | null = null;

  constructor(
    private readonly vectorRag: VectorRag,
    private readonly options: EmbeddingCadenceOptions,
  ) {
    assertPositiveInteger(options.intervalMs, "intervalMs");
    assertPositiveInteger(options.budgetMs, "budgetMs");
    assertNonNegativeInteger(options.retryMaxMs, "retryMaxMs");
    this.#now = options.now ?? Date.now;
  }

  offer(chatId: string | undefined): EmbeddingCadenceSnapshot {
    const now = this.#now();
    if (
      chatId &&
      !this.#active &&
      !this.options.shutdownSignal?.aborted &&
      now >= this.#nextRunAtMs
    ) {
      this.#nextRunAtMs = now + this.options.intervalMs;
      const execution = this.#run(chatId);
      this.#active = execution;
      void execution.finally(() => {
        if (this.#active === execution) {
          this.#active = undefined;
        }
      });
    }
    return this.snapshot();
  }

  snapshot(): EmbeddingCadenceSnapshot {
    return {
      active: this.#active !== undefined,
      nextRunAtMs: this.#nextRunAtMs,
      report: this.#report,
    };
  }

  healthFailure(): NormalizedError | undefined {
    return this.#report?.failure;
  }

  async settle(): Promise<void> {
    await this.#active;
  }

  async #run(chatId: string): Promise<void> {
    const budget = new AbortController();
    const timer = setTimeout(() => {
      budget.abort(
        new ToolError({
          category: "internal",
          retryable: true,
          message: `Embedding daemon tick exceeded its ${this.options.budgetMs}ms budget.`,
        }),
      );
    }, this.options.budgetMs);
    timer.unref?.();
    const signal = this.options.shutdownSignal
      ? AbortSignal.any([
          budget.signal,
          this.options.shutdownSignal,
        ])
      : budget.signal;
    try {
      this.#report = await withAbort(
        indexEmbeddings(this.vectorRag, chatId, signal),
        signal,
      );
      const retryAfterMs =
        (this.#report?.failure?.retryAfterSec ?? 0) * 1000;
      if (retryAfterMs > 0) {
        this.#nextRunAtMs = Math.max(
          this.#nextRunAtMs,
          this.#now() +
            Math.min(retryAfterMs, this.options.retryMaxMs),
        );
      }
      this.options.onReport?.(this.#report);
    } catch (error) {
      if (!this.options.shutdownSignal?.aborted) {
        const failure = normalizeError(error);
        this.#report = {
          failure: {
            ...failure,
            message: safeError(error).message,
          },
        };
        this.options.onReport?.(this.#report);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        onAbort = () => reject(abortReason(signal));
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

function throwIfDaemonAborted(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Sync daemon was aborted.", "AbortError");
}

function assertPositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(
  value: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer.`,
    );
  }
}

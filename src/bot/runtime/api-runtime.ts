import type { ApprovalPosterLoop } from "../../human-persona-approval-poster.js";
import type { JsonEventLogger } from "../worker.js";
import type { BotApiLongPoller } from "./long-poller.js";
import type { BotWorkerDrainResult, BotWorkerPump } from "./worker-pump.js";
import { boundedInteger, compact } from "./helpers.js";

export interface BotApiRuntimeOptions {
  poller: BotApiLongPoller;
  workers: BotWorkerPump;
  shutdownTimeoutMs?: number;
  logger?: JsonEventLogger;
  /**
   * Human-persona approval poster (plan Фаза 4d/5 Шаг 5), undefined when no
   * persona/approval chat is configured. Runs concurrently with the poller
   * for the whole lifetime of `run()`; a poster failure is logged and never
   * affects the poller/workers.
   */
  approvalPoster?: ApprovalPosterLoop;
}

export class BotApiRuntime {
  readonly #poller: BotApiLongPoller;
  readonly #workers: BotWorkerPump;
  readonly #shutdownTimeoutMs: number;
  readonly #logger: JsonEventLogger | undefined;
  readonly #approvalPoster: ApprovalPosterLoop | undefined;

  constructor(options: BotApiRuntimeOptions) {
    this.#poller = options.poller;
    this.#workers = options.workers;
    this.#shutdownTimeoutMs = boundedInteger(
      options.shutdownTimeoutMs ?? 180_000,
      1_000,
      15 * 60_000,
      "shutdownTimeoutMs",
    );
    this.#logger = options.logger;
    this.#approvalPoster = options.approvalPoster;
  }

  async run(signal?: AbortSignal): Promise<BotWorkerDrainResult> {
    const posterController = new AbortController();
    const forwardAbort = (): void => posterController.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const posterPromise = this.#approvalPoster
      ?.run(posterController.signal)
      .catch((error: unknown) => {
        this.#log("warn", "human_persona.approval_poster_failed", {
          failure: error instanceof Error ? error.message : String(error),
        });
      });
    let pollError: unknown;
    try {
      await this.#poller.run(signal, () => this.#workers.start());
    } catch (error) {
      pollError = error;
    } finally {
      this.#poller.requestStop();
      posterController.abort();
      signal?.removeEventListener("abort", forwardAbort);
      await posterPromise;
    }
    // Queued turns are already durable. Graceful shutdown stops admission and
    // waits only for in-flight workers; it does not begin fresh model calls
    // while systemd is counting down the termination deadline.
    const drained = await this.#workers.stop(this.#shutdownTimeoutMs);
    this.#log(
      drained.drained ? "info" : "error",
      drained.drained ? "bot.runtime.stopped" : "bot.runtime.drain_timeout",
      { activeWorkers: drained.activeWorkers },
    );
    if (pollError !== undefined) {
      throw pollError;
    }
    return drained;
  }

  requestStop(): void {
    this.#poller.requestStop();
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...compact(fields) });
    } catch {
      // Logging is best-effort during shutdown.
    }
  }
}

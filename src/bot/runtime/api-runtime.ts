import type { CuriosityTriggerLoop } from "../../assistant-curiosity-loop.js";
import type { ApprovalPosterLoop } from "../../human-persona-approval-poster.js";
import type { JsonEventLogger } from "../worker.js";
import type { BotApiLongPoller } from "./long-poller.js";
import type { BotWorkerDrainResult, BotWorkerPump } from "./worker-pump.js";
import { boundedInteger, compact } from "./helpers.js";

/**
 * VK Bots Long Poll loop (`src/vk/long-poll-loop.ts`): a second, optional
 * ingest source alongside the primary grammy poller. It never drives
 * `BotWorkerPump.start()` itself -- `BOT_TOKEN` (and therefore the grammy
 * poller) is unconditionally required, so the pump is always already
 * started by the time a VK update could arrive; VK ingest only needs to
 * `workNotifier.notify()` into the same already-running pump.
 */
export interface VkLongPollLoop {
  run(signal?: AbortSignal): Promise<void>;
  requestStop(): void;
}

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
  /**
   * Assistant-persona curiosity trigger, undefined when no chat enables it.
   * Runs concurrently with the poller for the whole lifetime of `run()`,
   * same isolation contract as `approvalPoster`: a failure is logged and
   * never affects the poller/workers.
   */
  curiosityTrigger?: CuriosityTriggerLoop;
  /**
   * VK second transport (undefined when BOT_VK_GROUP_TOKEN is unset). Same
   * isolation contract as `approvalPoster`/`curiosityTrigger`: runs
   * concurrently with the primary poller, a failure is logged and never
   * affects it.
   */
  vkPoller?: VkLongPollLoop;
}

export class BotApiRuntime {
  readonly #poller: BotApiLongPoller;
  readonly #workers: BotWorkerPump;
  readonly #shutdownTimeoutMs: number;
  readonly #logger: JsonEventLogger | undefined;
  readonly #approvalPoster: ApprovalPosterLoop | undefined;
  readonly #curiosityTrigger: CuriosityTriggerLoop | undefined;
  readonly #vkPoller: VkLongPollLoop | undefined;

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
    this.#curiosityTrigger = options.curiosityTrigger;
    this.#vkPoller = options.vkPoller;
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
    const curiosityPromise = this.#curiosityTrigger
      ?.run(posterController.signal)
      .catch((error: unknown) => {
        this.#log("warn", "assistant_curiosity.trigger_loop_failed", {
          failure: error instanceof Error ? error.message : String(error),
        });
      });
    const vkPromise = this.#vkPoller
      ?.run(posterController.signal)
      .catch((error: unknown) => {
        this.#log("warn", "vk.long_poll_loop_failed", {
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
      this.#vkPoller?.requestStop();
      posterController.abort();
      signal?.removeEventListener("abort", forwardAbort);
      await posterPromise;
      await curiosityPromise;
      await vkPromise;
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
    this.#vkPoller?.requestStop();
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

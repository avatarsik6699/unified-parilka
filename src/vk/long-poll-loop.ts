import type { VK } from "vk-io";
import type { BotUpdateProcessor } from "../bot/runtime/update-processor.js";
import type { JsonEventLogger } from "../bot/worker.js";

export interface VkLongPollLoopOptions {
  vk: VK;
  processor: BotUpdateProcessor;
  logger?: JsonEventLogger;
}

/**
 * VK-specific poller, parallel to `BotApiLongPoller` but structurally
 * simpler: vk-io's `Updates.startPolling()` owns its own background fetch
 * loop (with its own internal retry/backoff) and returns as soon as polling
 * has started, so this class only needs to register handlers, start it, and
 * block until asked to stop.
 *
 * Unlike Telegram's `getUpdates` offset, VK's Long Poll `ts` cursor is
 * advanced entirely inside vk-io -- there is no per-message ack/nack this
 * process controls, so a processing failure for one message cannot be
 * retried the way a Telegram poll batch can; it is logged and skipped. This
 * is an inherent VK Long Poll API limitation, not a gap in this class.
 */
export class VkLongPollLoop {
  readonly #vk: VK;
  readonly #processor: BotUpdateProcessor;
  readonly #logger: JsonEventLogger | undefined;
  readonly #stopController = new AbortController();
  #handlersRegistered = false;

  constructor(options: VkLongPollLoopOptions) {
    this.#vk = options.vk;
    this.#processor = options.processor;
    this.#logger = options.logger;
  }

  requestStop(): void {
    this.#stopController.abort();
  }

  async run(signal?: AbortSignal): Promise<void> {
    const combined =
      signal === undefined
        ? this.#stopController.signal
        : AbortSignal.any([signal, this.#stopController.signal]);

    this.#registerHandlers();
    await this.#vk.updates.startPolling();
    this.#log("info", "vk.long_poll.started");
    try {
      await waitForAbort(combined);
    } finally {
      await this.#vk.updates.stop();
      this.#log("info", "vk.long_poll.stopped");
    }
  }

  #registerHandlers(): void {
    if (this.#handlersRegistered) {
      return;
    }
    this.#handlersRegistered = true;
    this.#vk.updates.on(["message_new", "message_edit"], (context) => {
      try {
        this.#processor.processVk(context);
      } catch (error) {
        this.#log("error", "vk.update.failed", {
          messageId: context.id,
          failure: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  #log(
    level: "info" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Logging is best-effort.
    }
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

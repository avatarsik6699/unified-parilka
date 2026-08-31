import type { VK } from "vk-io";
import type { JsonEventLogger } from "../bot/worker.js";
import { VkSenderNameCache } from "./sender-name-cache.js";

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 200;

export interface VkSenderNameEnrichmentStore {
  listDistinctUnresolvedVkSenderIds(
    chatIds: readonly string[],
    limit: number,
  ): { chatId: string; senderId: string }[];
  backfillSenderName(
    chatId: string,
    senderId: string,
    senderName: string,
  ): number;
}

export interface VkSenderNameEnrichmentTickReport {
  status: "progress" | "idle";
  resolved?: number;
  updated?: number;
}

/**
 * One bounded pass: pulls the still-unresolved (chat, sender) pairs (both
 * live-ingested rows saved before their name was cached, and backfilled
 * rows -- one code path fixes both), resolves them via `VkSenderNameCache`,
 * then writes back every name it got. A sender `users.get` can't resolve
 * (a VK community/group sender, or a transient API failure) simply stays
 * unresolved and is retried on the next tick.
 */
export async function runVkSenderNameEnrichmentTick(options: {
  store: VkSenderNameEnrichmentStore;
  vk: VK;
  cache: VkSenderNameCache;
  chatIds: readonly string[];
  batchSize?: number;
}): Promise<VkSenderNameEnrichmentTickReport> {
  const { store, vk, cache, chatIds } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (chatIds.length === 0) {
    return { status: "idle" };
  }
  const pending = store.listDistinctUnresolvedVkSenderIds(chatIds, batchSize);
  if (pending.length === 0) {
    return { status: "idle" };
  }
  await cache.resolveMany(
    vk,
    pending.map((entry) => entry.senderId),
  );
  let resolved = 0;
  let updated = 0;
  for (const { chatId, senderId } of pending) {
    const name = cache.get(senderId);
    if (name === undefined) {
      continue;
    }
    resolved += 1;
    updated += store.backfillSenderName(chatId, senderId, name);
  }
  return { status: "progress", resolved, updated };
}

export interface VkSenderNameEnrichmentLoopOptions {
  store: VkSenderNameEnrichmentStore;
  vk: VK;
  cache: VkSenderNameCache;
  /** One entry per `transport: "vk"` chat this process serves. */
  chatIds: readonly string[];
  batchSize?: number;
  tickIntervalMs?: number;
  logger?: JsonEventLogger;
  onTick?: (report: VkSenderNameEnrichmentTickReport) => void;
}

/**
 * Same standalone-interval-loop shape as `VkHistoryBackfillLoop`: one pass
 * over the configured chats' unresolved senders, then sleep. Once every
 * sender is resolved, a pass is a cheap no-op query per chat.
 */
export class VkSenderNameEnrichmentLoop {
  readonly #options: VkSenderNameEnrichmentLoopOptions;
  readonly #tickIntervalMs: number;
  #running = false;

  constructor(options: VkSenderNameEnrichmentLoopOptions) {
    this.#options = options;
    this.#tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) {
      throw new Error("VkSenderNameEnrichmentLoop is already running.");
    }
    if (this.#options.chatIds.length === 0) {
      return;
    }
    this.#running = true;
    try {
      while (!signal.aborted) {
        const report = await runVkSenderNameEnrichmentTick({
          store: this.#options.store,
          vk: this.#options.vk,
          cache: this.#options.cache,
          chatIds: this.#options.chatIds,
          ...(this.#options.batchSize === undefined
            ? {}
            : { batchSize: this.#options.batchSize }),
        });
        this.#options.onTick?.(report);
        this.#log(report);
        await abortableSleep(this.#tickIntervalMs, signal);
      }
    } finally {
      this.#running = false;
    }
  }

  #log(report: VkSenderNameEnrichmentTickReport): void {
    try {
      this.#options.logger?.info({
        event: "vk.sender_name_enrichment.tick",
        status: report.status,
        ...(report.resolved === undefined ? {} : { resolved: report.resolved }),
        ...(report.updated === undefined ? {} : { updated: report.updated }),
      });
    } catch {
      // Logging is best-effort.
    }
  }
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

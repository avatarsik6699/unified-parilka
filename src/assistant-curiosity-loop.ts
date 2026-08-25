import { runCuriosityTriggerTick } from "./assistant-curiosity/tick.js";
import type {
  AssistantCuriosityPort,
  AssistantCuriosityRuntimeConfig,
  AssistantCuriositySendPort,
  AssistantCuriosityStore,
  AssistantCuriosityTickReport,
} from "./assistant-curiosity/types.js";

export interface CuriosityTriggerChatRuntime {
  config: AssistantCuriosityRuntimeConfig;
  send: AssistantCuriositySendPort;
}

export interface CuriosityTriggerLoopOptions {
  store: AssistantCuriosityStore;
  port: AssistantCuriosityPort;
  chats: readonly CuriosityTriggerChatRuntime[];
  /** Sleep between full passes over every configured chat. */
  idleIntervalMs?: number;
  itemTimeoutMs?: number;
  now?: () => Date;
  onTick?: (chatId: string, report: AssistantCuriosityTickReport) => void;
}

const DEFAULT_IDLE_INTERVAL_MS = 5 * 60_000;

/**
 * Small standalone interval loop, run concurrently with the live bot's
 * long-poller (see `BotApiRuntime`) -- mirrors `ApprovalPosterLoop`
 * (`src/human-persona-approval-poster.ts`), but polls every configured chat
 * once per pass instead of draining a DB-backed queue: a curiosity decision
 * is not queued anywhere, each pass either asks or doesn't.
 */
export class CuriosityTriggerLoop {
  readonly #options: CuriosityTriggerLoopOptions;
  readonly #idleIntervalMs: number;
  #running = false;

  constructor(options: CuriosityTriggerLoopOptions) {
    this.#options = options;
    this.#idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
  }

  get running(): boolean {
    return this.#running;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#running) {
      throw new Error("CuriosityTriggerLoop is already running.");
    }
    if (this.#options.chats.length === 0) {
      return;
    }
    this.#running = true;
    try {
      while (!signal.aborted) {
        for (const chat of this.#options.chats) {
          if (signal.aborted) {
            break;
          }
          const report = await runCuriosityTriggerTick({
            store: this.#options.store,
            config: chat.config,
            port: this.#options.port,
            send: chat.send,
            ...(this.#options.now === undefined
              ? {}
              : { now: this.#options.now }),
            ...(this.#options.itemTimeoutMs === undefined
              ? {}
              : { itemTimeoutMs: this.#options.itemTimeoutMs }),
          });
          this.#options.onTick?.(chat.config.chatId, report);
        }
        await abortableSleep(this.#idleIntervalMs, signal);
      }
    } finally {
      this.#running = false;
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

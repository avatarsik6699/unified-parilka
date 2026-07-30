/**
 * Bounded, persisted Telegram tool-progress message.
 *
 * The progress message is presentation-only: it is sent once when the first
 * tool starts, edited as tools complete or fail, and deleted before the durable
 * final answer is published. Its lifecycle is tracked by a persisted fence in
 * the shared store so a crashed or retried turn can recover stale messages.
 */

export interface ToolProgressEvent {
  readonly toolName: string;
  readonly callId: string;
}

export interface ToolProgressPort {
  onToolStarted(event: ToolProgressEvent): void | Promise<void>;
  onToolCompleted(event: ToolProgressEvent, ok: boolean): void | Promise<void>;
}

export interface ToolProgressBotApiPort {
  sendMessage(
    chatId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ ok: true; messageId: number } | { ok: false }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false }>;
  deleteMessage(
    chatId: string,
    messageId: number,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false }>;
}

export interface ToolProgressStore {
  saveBotTurnProgress(
    turnId: number,
    workerId: string,
    progress: { messageId?: number; state?: ToolProgressState },
    nowMs?: number,
  ): boolean;
  clearBotTurnProgress(turnId: number, nowMs?: number): boolean;
}

export type ToolProgressState =
  | "none"
  | "dispatching"
  | "active"
  | "unknown";

export interface ToolProgressPublisherOptions {
  turnId: number;
  workerId: string;
  chatId: string;
  signal: AbortSignal;
  botApi: ToolProgressBotApiPort;
  store: ToolProgressStore;
  initialMessageId?: number;
  maxTextLength?: number;
  now?: () => number;
}

interface ToolCallStatus {
  readonly toolName: string;
  readonly state: "running" | "ok" | "error";
}

const DEFAULT_MAX_TEXT_LENGTH = 180;

/**
 * Publishes a single Telegram progress message during read-tool execution.
 *
 * All Bot API calls are best-effort: failures are swallowed so they can never
 * alter durable turn state. The publisher still persists the message ID and
 * state to the store so recovery can clean up stale messages.
 */
export class ToolProgressPublisher implements ToolProgressPort {
  readonly #turnId: number;
  readonly #workerId: string;
  readonly #chatId: string;
  readonly #signal: AbortSignal;
  readonly #botApi: ToolProgressBotApiPort;
  readonly #store: ToolProgressStore;
  readonly #maxTextLength: number;
  readonly #now: () => number;
  #messageId: number | undefined;
  #state: ToolProgressState = "none";
  #pending = new Map<string, ToolCallStatus>();
  #dispatchPromise: Promise<void> = Promise.resolve();

  constructor(options: ToolProgressPublisherOptions) {
    this.#turnId = options.turnId;
    this.#workerId = options.workerId;
    this.#chatId = options.chatId;
    this.#signal = options.signal;
    this.#botApi = options.botApi;
    this.#store = options.store;
    this.#messageId = options.initialMessageId;
    this.#maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.#now = options.now ?? (() => Date.now());
  }

  get messageId(): number | undefined {
    return this.#messageId;
  }

  get state(): ToolProgressState {
    return this.#state;
  }

  /**
   * Removes a stale progress message from a previous attempt of the same turn.
   * Should be called once after claim before any tool calls start.
   */
  async recoverPrevious(signal: AbortSignal): Promise<void> {
    if (this.#messageId !== undefined) {
      await this.#botApi.deleteMessage(this.#chatId, this.#messageId, signal);
      this.#messageId = undefined;
      this.#state = "none";
      this.#store.clearBotTurnProgress(this.#turnId, this.#now());
    }
  }

  onToolStarted(event: ToolProgressEvent): void {
    this.#pending.set(event.callId, {
      toolName: event.toolName,
      state: "running",
    });
    this.#dispatch();
  }

  onToolCompleted(event: ToolProgressEvent, ok: boolean): void {
    this.#pending.set(event.callId, {
      toolName: event.toolName,
      state: ok ? "ok" : "error",
    });
    this.#dispatch();
  }

  /**
   * Finishes the progress presentation: deletes the progress message before
   * the durable final answer is published. Waits for any in-flight edit.
   */
  async finish(signal: AbortSignal): Promise<void> {
    await this.#dispatchPromise;
    if (this.#messageId !== undefined) {
      await this.#botApi.deleteMessage(this.#chatId, this.#messageId, signal);
      this.#messageId = undefined;
    }
    this.#state = "none";
    this.#store.clearBotTurnProgress(this.#turnId, this.#now());
  }

  #dispatch(): void {
    this.#dispatchPromise = this.#dispatchPromise.then(() =>
      this.#renderAndSend(),
    );
  }

  async #renderAndSend(): Promise<void> {
    const text = renderProgressText(this.#pending, this.#maxTextLength);
    if (this.#messageId === undefined) {
      this.#state = "dispatching";
      this.#persist();
      const result = await this.#botApi.sendMessage(
        this.#chatId,
        text,
        this.#signal,
      );
      if (result.ok) {
        this.#messageId = result.messageId;
        this.#state = "active";
      } else {
        this.#state = "unknown";
      }
    } else {
      this.#state = "active";
      await this.#botApi.editMessageText(
        this.#chatId,
        this.#messageId,
        text,
        this.#signal,
      );
    }
    this.#persist();
  }

  #persist(): void {
    this.#store.saveBotTurnProgress(
      this.#turnId,
      this.#workerId,
      {
        messageId: this.#messageId,
        state: this.#state,
      },
      this.#now(),
    );
  }
}

export function renderProgressText(
  pending: ReadonlyMap<string, ToolCallStatus>,
  maxLength: number,
): string {
  const lines: string[] = [];
  for (const [, status] of pending) {
    const icon =
      status.state === "running" ? "⏳" : status.state === "ok" ? "✓" : "✗";
    lines.push(`${icon} ${status.toolName}`);
  }
  const text = lines.join("\n");
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(1, maxLength - 1)) + "…";
}

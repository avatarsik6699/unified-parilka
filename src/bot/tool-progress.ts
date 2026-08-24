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
  /** Raw model input is projected through an allowlist before presentation. */
  readonly input?: Readonly<Record<string, unknown>>;
}

/**
 * A presentation-only model-step marker. It deliberately has no text payload:
 * the UI may show that a model step is in progress, never its private
 * reasoning or draft response.
 */
export interface ThinkingProgressEvent {
  readonly callId: string;
}

export interface ToolProgressPort {
  onThinkingStarted?(event: ThinkingProgressEvent): void | Promise<void>;
  onThinkingCompleted?(
    event: ThinkingProgressEvent,
    ok: boolean,
  ): void | Promise<void>;
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

export type ToolProgressState = "none" | "dispatching" | "active" | "unknown";

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
  readonly kind: "thinking" | "tool";
  readonly label: string;
  readonly state: "running" | "ok" | "error";
}

const DEFAULT_MAX_TEXT_LENGTH = 3_500;

/**
 * The visible progress line never names the real tool or echoes any part of
 * its input -- both can leak the user's query or private context into the
 * chat timeline. Instead each call gets a random, meaningless label, purely
 * as a "the bot is doing something" heartbeat.
 */
export const PROGRESS_LABELS = [
  "шаманю",
  "колдую",
  "мудрю",
  "включаю режим детектива",
  "советуюсь с котом",
  "трясу магический шар",
  "прокручиваю извилины",
  "заряжаю батарейки",
  "ищу вдохновение",
  "листаю умную книгу",
  "разгадываю ребус",
  "щёлкаю тумблерами",
  "завариваю чай мудрости",
  "спрашиваю оракула",
  "рисую в голове схему",
  "надеваю очки мудреца",
  "плету заклинание",
  "настраиваю частоты",
  "чешу репу",
  "втыкаю в монитор",
  "разговариваю с сервером",
  "перебираю варианты",
  "нюхаю провода",
  "подкручиваю антенну",
  "торгуюсь с нейросетью",
  "зову на помощь дух Тьюринга",
  "проверяю карму",
  "гуглю по фэншую",
  "изобретаю велосипед",
  "ищу смысл жизни",
] as const;

function randomProgressLabel(): string {
  const index = Math.floor(Math.random() * PROGRESS_LABELS.length);
  return PROGRESS_LABELS[index] ?? PROGRESS_LABELS[0];
}

/**
 * Publishes a single Telegram progress message during model steps and read-tool
 * execution. Thinking is a status marker, never a model-output channel.
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
  #lastRenderedText: string | undefined;

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
      this.#lastRenderedText = undefined;
      this.#store.clearBotTurnProgress(this.#turnId, this.#now());
    }
  }

  onThinkingStarted(event: ThinkingProgressEvent): void {
    this.#pending.set(event.callId, {
      kind: "thinking",
      label: randomProgressLabel(),
      state: "running",
    });
    this.#dispatch();
  }

  onThinkingCompleted(event: ThinkingProgressEvent, ok: boolean): void {
    const previous = this.#pending.get(event.callId);
    if (!previous) {
      return;
    }
    this.#pending.set(event.callId, {
      ...previous,
      state: ok ? "ok" : "error",
    });
    this.#dispatch();
  }

  onToolStarted(event: ToolProgressEvent): void {
    this.#pending.set(event.callId, {
      kind: "tool",
      label: randomProgressLabel(),
      state: "running",
    });
    this.#dispatch();
  }

  onToolCompleted(event: ToolProgressEvent, ok: boolean): void {
    const previous = this.#pending.get(event.callId);
    this.#pending.set(event.callId, {
      kind: previous?.kind ?? "tool",
      label: previous?.label ?? randomProgressLabel(),
      state: ok ? "ok" : "error",
    });
    this.#dispatch();
  }

  /**
   * Finishes the progress presentation once the agent has a terminal result.
   * Deletes the message before publication or shadow completion, and waits
   * for any in-flight edit.
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
        this.#lastRenderedText = text;
      } else {
        this.#state = "unknown";
      }
    } else {
      if (this.#lastRenderedText === text) {
        return;
      }
      this.#state = "active";
      const result = await this.#botApi.editMessageText(
        this.#chatId,
        this.#messageId,
        text,
        this.#signal,
      );
      if (result.ok) {
        this.#lastRenderedText = text;
      }
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
      status.kind === "thinking" && status.state === "running"
        ? "🧠"
        : status.state === "running"
          ? "⏳"
          : status.state === "ok"
            ? "✓"
            : "✗";
    lines.push(`${icon} ${status.label}`);
  }
  const text = lines.join("\n");
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(1, maxLength - 1)) + "…";
}

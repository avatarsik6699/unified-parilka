import type {
  MessageStore,
  StoredBotTurn,
  StoredChatLesson,
  StoredChatSkill,
  StoredFastChatMemory,
  StoredMessage,
} from "../../store.js";
import type {
  FoldBatch,
  TurnBoundary,
  TurnCoordinator,
} from "../turn-coordinator.js";
import type { TelegramPublication } from "../telegram-publication.js";
import type {
  ToolProgressBotApiPort,
  ToolProgressPort,
} from "../tool-progress.js";
import type { TurnTelemetry } from "../telemetry.js";
import type { TypingPort } from "../typing.js";
import type { BotReactionApiPort } from "../web-tools/reaction-contracts.js";

export const BOT_CONTEXT_MESSAGES = 60;
export const BOT_REPLAY_MESSAGES = 100;

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
export interface BotAgentFinalResult {
  kind: "final";
  text: string;
  telemetry: TurnTelemetry;
  /**
   * An explicit local Flov transcription is sent as bounded plain text rather
   * than being sent through the native rich-message endpoint.
   */
  responseOrigin?: "local_audio";
  /** A generate_image/edit_image tool result to attach as a native Telegram photo. */
  imageAttachment?: { bytes: Buffer };
  /** A speak_text tool result to attach as a native Telegram voice message. */
  voiceAttachment?: { bytes: Buffer };
}

export interface BotAgentRequest {
  turn: Readonly<StoredBotTurn>;
  trigger: Readonly<StoredMessage>;
  /**
   * The exact message explicitly replied to by the trigger, if it is present
   * in the same durable chat. This is deliberately not general history: media
   * handling may inspect only the addressed message.
   */
  replyTarget?: Readonly<StoredMessage>;
  context: readonly Readonly<StoredMessage>[];
  signal: AbortSignal;
  drainFold: (boundary: TurnBoundary) => FoldBatch;
  toolProgressPort?: ToolProgressPort;
  memoryBlock?: string;
  fastMemory?: readonly StoredFastChatMemory[];
  longTermLessons?: readonly StoredChatLesson[];
  chatSkills?: readonly StoredChatSkill[];
  /** Durable sender id of this bot's own published messages. */
  botSenderId?: string;
  /** Live Bot API port for `react_to_message`; absent leaves the tool unregistered. */
  reactionApi?: BotReactionApiPort;
}

export interface BotTurnAgent {
  run(request: BotAgentRequest): Promise<BotAgentFinalResult>;
}

export interface TelegramPublishRequest {
  chatId: string;
  replyToMessageId: number;
  publication: TelegramPublication;
  signal: AbortSignal;
}

export type TelegramPublisherResult =
  | {
      ok: true;
      chunksSent: number;
      telegramMessageId?: number;
    }
  | {
      ok: false;
      chunksSent: number;
      error:
        | {
            kind: "telegram_rejected";
            code: string;
            retryable: boolean;
            retryAfterMs?: number;
            /** Upstream provider's human-readable rejection reason, bounded and sanitized. */
            message?: string;
            /** Which outbound call was rejected, e.g. "upload_photo" | "send_photo" | "send_plain". */
            stage?: string;
          }
        | {
            kind: "network" | "timeout" | "unknown";
            code?: string;
          };
    };

export interface BotTurnPublisher {
  publish(request: TelegramPublishRequest): Promise<TelegramPublisherResult>;
}

export type { JsonEventLogger } from "../../observability/contracts.js";
import type { JsonEventLogger } from "../../observability/contracts.js";

export interface WorkerScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BotTurnWorkerOptions {
  store: MessageStore;
  coordinator: TurnCoordinator;
  agent: BotTurnAgent;
  publisher: BotTurnPublisher;
  workerId: string;
  allowedChatId: string;
  mode: "live" | "shadow";
  leaseMs?: number;
  heartbeatMs?: number;
  publishTimeoutMs?: number;
  typingPort?: TypingPort;
  typingIntervalMs?: number;
  toolProgressBotApiPort?: ToolProgressBotApiPort;
  logger?: JsonEventLogger;
  scheduler?: WorkerScheduler;
  now?: () => number;
  /** Durable sender id of this bot's own published messages. */
  botSenderId?: string;
  /** Live Bot API port for `react_to_message`, forwarded into each turn's request. */
  reactionBotApiPort?: BotReactionApiPort;
  /**
   * Whether the `model 🧠 · tokens · tool calls · duration` diagnostics
   * footer (`buildTelemetryFooter`) is appended to the published answer.
   * Defaults to true (existing Telegram behavior); set false to publish the
   * bare model text with no footer.
   */
  telemetryFooter?: boolean;
}

export type BotTurnWorkerResult =
  | { status: "idle"; retryAfterMs?: number }
  | { status: "capacity" }
  | { status: "sent"; turnId: number; telegramMessageId?: number }
  | {
      status: "skipped";
      turnId: number;
      reason: "shadow" | "chat_scope";
    }
  | {
      status: "failed";
      turnId: number;
      stage: "load" | "agent" | "coordinator";
    }
  | { status: "lease_lost"; turnId: number }
  | {
      status: "dispatch_rejected";
      turnId: number;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | { status: "lost_ack"; turnId: number };

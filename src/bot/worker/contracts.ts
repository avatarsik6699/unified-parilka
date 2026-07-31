import type { MessageStore, StoredBotTurn, StoredMessage } from "../../store.js";
import type { FoldBatch, TurnBoundary, TurnCoordinator } from "../turn-coordinator.js";
import type { GuardedTelegramPublication, OutputGuardPolicy, QuoteEvidence } from "../output-guards.js";
import type {
  ToolProgressBotApiPort,
  ToolProgressPort,
} from "../tool-progress.js";
import type { TurnTelemetry } from "../telemetry.js";
import type { TypingPort } from "../typing.js";

export const BOT_CONTEXT_MESSAGES = 60;
export const BOT_REPLAY_MESSAGES = 100;

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
export const MAX_AGENT_EVIDENCE_ITEMS = 1_000;

export interface BotAgentFinalResult {
  kind: "final";
  text: string;
  evidence: readonly QuoteEvidence[];
  telemetry: TurnTelemetry;
}

export interface BotAgentRequest {
  turn: Readonly<StoredBotTurn>;
  trigger: Readonly<StoredMessage>;
  context: readonly Readonly<StoredMessage>[];
  signal: AbortSignal;
  drainFold: (boundary: TurnBoundary) => FoldBatch;
  toolProgressPort?: ToolProgressPort;
  memoryBlock?: string;
}

export interface BotTurnAgent {
  run(request: BotAgentRequest): Promise<BotAgentFinalResult>;
}

export interface TelegramPublishRequest {
  chatId: string;
  replyToMessageId: number;
  publication: GuardedTelegramPublication;
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
          }
        | {
            kind: "network" | "timeout" | "unknown";
            code?: string;
          };
    };

export interface BotTurnPublisher {
  publish(request: TelegramPublishRequest): Promise<TelegramPublisherResult>;
}

export interface JsonEventLogger {
  info(record: Readonly<Record<string, unknown>>): void;
  warn(record: Readonly<Record<string, unknown>>): void;
  error(record: Readonly<Record<string, unknown>>): void;
}

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
  turnTimeoutMs?: number;
  publishTimeoutMs?: number;
  outputPolicy?: Omit<OutputGuardPolicy, "evidence" | "allowedMentions">;
  additionalAllowedMentions?: readonly string[];
  typingPort?: TypingPort;
  typingIntervalMs?: number;
  toolProgressBotApiPort?: ToolProgressBotApiPort;
  logger?: JsonEventLogger;
  scheduler?: WorkerScheduler;
  now?: () => number;
}

export type BotTurnWorkerResult =
  | { status: "idle"; retryAfterMs?: number }
  | { status: "capacity" }
  | { status: "sent"; turnId: number; telegramMessageId?: number }
  | {
      status: "skipped";
      turnId: number;
      reason: "model_skip" | "guard_rejected" | "shadow" | "chat_scope";
      guardCode?: string;
    }
  | { status: "failed"; turnId: number; stage: "load" | "agent" | "coordinator" }
  | { status: "lease_lost"; turnId: number }
  | {
      status: "dispatch_rejected";
      turnId: number;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | { status: "lost_ack"; turnId: number };

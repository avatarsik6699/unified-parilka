import type { MessageStore, StoredBotTurn, StoredMessage } from "../../store.js";
import type { GuardedTelegramPublication } from "../output-guards.js";
import type {
  BotTurnPublisher,
  BotTurnWorkerResult,
  JsonEventLogger,
  TelegramPublisherResult,
  WorkerScheduler,
} from "./contracts.js";
import {
  publisherFailureKind,
  safeErrorCode,
  safeMachineCode,
  WorkerAbortError,
} from "./helpers.js";

export interface DispatchBotTurnOptions {
  store: MessageStore;
  publisher: BotTurnPublisher;
  allowedChatId: string;
  publishTimeoutMs: number;
  scheduler: WorkerScheduler;
  logger?: JsonEventLogger;
  now: () => number;
}

export async function dispatchBotTurn(
  options: DispatchBotTurnOptions,
  turn: StoredBotTurn,
  trigger: StoredMessage,
  publication: GuardedTelegramPublication,
): Promise<BotTurnWorkerResult> {
  const {
    store,
    publisher,
    allowedChatId,
    publishTimeoutMs,
    scheduler,
    logger,
    now,
  } = options;
  const log = (
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void => logWorkerEvent(logger, level, event, fields);
  const markLostAck = (target: StoredBotTurn, code: string): void =>
    markBotTurnLostAck({ store, logger, now }, target, code);
    if (turn.chatId !== allowedChatId) {
      const transitioned = store.markBotTurnDispatchRejected(
        turn.id,
        "chat_scope_violation_before_dispatch",
        false,
        now(),
      );
      if (!transitioned) {
        markLostAck(
          turn,
          "chat_scope_transition_refused",
        );
        return { status: "lost_ack", turnId: turn.id };
      }
      return {
        status: "dispatch_rejected",
        turnId: turn.id,
        retryable: false,
      };
    }
    let result: TelegramPublisherResult;
    const controller = new AbortController();
    const publishTimedOut = Symbol("publish_timeout");
    let timeoutHandle: unknown;
    try {
      const timeout = new Promise<typeof publishTimedOut>((resolve) => {
        timeoutHandle = scheduler.setTimeout(() => {
          controller.abort(new WorkerAbortError("publish_timeout"));
          resolve(publishTimedOut);
        }, publishTimeoutMs);
      });
      const outcome = await Promise.race([
        publisher.publish({
          chatId: turn.chatId,
          replyToMessageId: trigger.messageId,
          publication: Object.freeze({ ...publication }),
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (outcome === publishTimedOut) {
        markLostAck(turn, "publisher_timeout");
        return { status: "lost_ack", turnId: turn.id };
      }
      result = outcome;
    } catch (error) {
      markLostAck(turn, `publisher_throw:${safeErrorCode(error)}`);
      return { status: "lost_ack", turnId: turn.id };
    } finally {
      if (timeoutHandle !== undefined) {
        scheduler.clearTimeout(timeoutHandle);
      }
    }

    if (result.ok) {
      if (result.chunksSent < 1) {
        markLostAck(turn, "publisher_partial_success");
        return { status: "lost_ack", turnId: turn.id };
      }
      try {
        if (
          !store.markBotTurnSent(
            turn.id,
            result.telegramMessageId,
            now(),
          )
        ) {
          markLostAck(turn, "sent_transition_refused");
          return { status: "lost_ack", turnId: turn.id };
        }
      } catch {
        markLostAck(turn, "sent_transition_failed");
        return { status: "lost_ack", turnId: turn.id };
      }
      log("info", "bot.turn.sent", {
        turnId: turn.id,
        mode: publication.mode,
        messages: result.chunksSent,
        telegramMessageId: result.telegramMessageId,
      });
      return {
        status: "sent",
        turnId: turn.id,
        ...(result.telegramMessageId == null
          ? {}
          : { telegramMessageId: result.telegramMessageId }),
      };
    }

    if (
      result.chunksSent === 0 &&
      result.error.kind === "telegram_rejected"
    ) {
      const rejectionCode = safeMachineCode(
        result.error.code,
        "TELEGRAM_REJECTED",
      );
      if (
        !store.markBotTurnDispatchRejected(
          turn.id,
          `telegram_rejected:${rejectionCode}`,
          result.error.retryable,
          now(),
          result.error.retryAfterMs,
        )
      ) {
        markLostAck(turn, "dispatch_rejection_transition_refused");
        return { status: "lost_ack", turnId: turn.id };
      }
      log("warn", "bot.turn.dispatch_rejected", {
        turnId: turn.id,
        code: rejectionCode,
        retryable: result.error.retryable,
        retryAfterMs: result.error.retryAfterMs,
      });
      return {
        status: "dispatch_rejected",
        turnId: turn.id,
        retryable: result.error.retryable,
        ...(result.error.retryAfterMs == null
          ? {}
          : { retryAfterMs: result.error.retryAfterMs }),
      };
    }

    markLostAck(
      turn,
      result.chunksSent > 0
        ? "publisher_partial_failure"
        : `publisher_ambiguous:${publisherFailureKind(result.error.kind)}`,
    );
    return { status: "lost_ack", turnId: turn.id };
}

export function markBotTurnLostAck(
  options: Pick<DispatchBotTurnOptions, "store" | "logger" | "now">,
  turn: StoredBotTurn,
  code: string,
): void {
  const { store, logger, now } = options;
  const log = (
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void => logWorkerEvent(logger, level, event, fields);
    try {
      const transitioned = store.markBotTurnLostAck(
        turn.id,
        code,
        now(),
      );
      if (!transitioned) {
        log("error", "bot.turn.lost_ack_transition_refused", {
          turnId: turn.id,
          code,
        });
      }
    } catch {
      // A row that could not be moved out of `sending` is still an
      // unknown-delivery fence and must never be made retryable.
      log("error", "bot.turn.lost_ack_transition_failed", {
        turnId: turn.id,
        code,
      });
    } finally {
      log("error", "bot.turn.lost_ack", {
        turnId: turn.id,
        code,
      });
    }
}

function logWorkerEvent(
  logger: JsonEventLogger | undefined,
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger?.[level]({ event, ...fields });
  } catch {
    // Logging must never alter durable turn state.
  }
}

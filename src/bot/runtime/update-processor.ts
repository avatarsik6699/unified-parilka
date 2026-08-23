import { normalizeTelegramUpdate } from "../telegram-update.js";
import {
  asRecord,
  boundedInteger,
  BotRuntimeProtocolError,
  compact,
  durableMessageId,
  safeMachineCode,
  stringifyUpdate,
  updateIdentifier,
} from "./helpers.js";
import type {
  BotRuntimeStore,
  BotUpdateProcessingResult,
  BotUpdateProcessorOptions,
  BotWorkNotifier,
} from "./contracts.js";
import type { TurnCoordinator } from "../turn-coordinator.js";
import type { TelegramUpdateOptions } from "../telegram-update.js";
import type { JsonEventLogger } from "../worker.js";

const MAX_RAW_UPDATE_CHARS = 2_000_000;
const BOT_TRIGGER_COOLDOWN_PREFIX = "telegram-user:";
/**
 * Human-persona approval button callback data (plan 4d/5 Шаг 5):
 * `hp:<action>:<proposalId>`. `edit` never mutates the proposal here -- it
 * is only a UI hint; the actual edit is captured from a reply to the
 * posted proposal (see `#tryCaptureHumanPersonaEdit`).
 */
const HUMAN_PERSONA_CALLBACK_PATTERN =
  /^hp:(approve|reject|regenerate|edit):([A-Za-z0-9_-]{1,120})$/u;

export class BotUpdateProcessor {
  readonly #store: BotRuntimeStore;
  readonly #coordinator: TurnCoordinator;
  readonly #workNotifier: BotWorkNotifier;
  readonly #telegram: TelegramUpdateOptions;
  readonly #triggerCooldownMs: number;
  readonly #updateMaxAttempts: number;
  readonly #logger: JsonEventLogger | undefined;
  readonly #now: () => number;

  constructor(options: BotUpdateProcessorOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#workNotifier = options.workNotifier;
    this.#telegram = options.telegram;
    this.#triggerCooldownMs = boundedInteger(
      options.triggerCooldownMs ?? 5_000,
      0,
      60_000,
      "triggerCooldownMs",
    );
    this.#updateMaxAttempts = boundedInteger(
      options.updateMaxAttempts ?? 3,
      1,
      20,
      "updateMaxAttempts",
    );
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  process(update: unknown): BotUpdateProcessingResult {
    const updateId = updateIdentifier(update);
    if (updateId === undefined) {
      throw new BotRuntimeProtocolError("UPDATE_ID_MISSING");
    }

    const callbackQuery = asRecord(asRecord(update)?.callback_query);
    if (callbackQuery !== undefined) {
      return this.#processHumanPersonaCallback(updateId, callbackQuery);
    }

    const existing = this.#store.getBotUpdate(updateId);
    if (
      existing &&
      (existing.status === "dead_letter" ||
        (existing.chatId != null && existing.triggerMessageId != null))
    ) {
      const turn =
        existing.chatId != null && existing.triggerMessageId != null
          ? this.#store.getBotTurnByTrigger(
              existing.chatId,
              existing.triggerMessageId,
            )
          : undefined;
      if (turn?.status === "queued" || turn?.status === "failed") {
        this.#workNotifier.notify();
      }
      this.#log("info", "bot.update.duplicate_ack", {
        updateId,
        status: existing.status,
        turnId: turn?.id,
      });
      return {
        acknowledged: true,
        ackUpdateId: updateId,
        disposition: "duplicate",
        turnReserved: turn?.updateId === updateId,
        routed: false,
      };
    }

    const rawJson = stringifyUpdate(update);
    if (rawJson === undefined || rawJson.length > MAX_RAW_UPDATE_CHARS) {
      return this.#recordPoison(
        updateId,
        "raw_update_unserializable_or_too_large",
      );
    }

    const normalized = normalizeTelegramUpdate(update, this.#telegram);
    if (
      !normalized.ingest ||
      normalized.updateId !== updateId ||
      !normalized.chat ||
      !normalized.message ||
      !normalized.updateKind
    ) {
      return this.#recordPoison(updateId, normalized.reason);
    }

    const result = this.#store.ingestBotUpdate({
      updateId,
      rawJson,
      chat: normalized.chat,
      message: normalized.message,
      addressed: normalized.addressed,
      ...(normalized.addressed
        ? {
            triggerCooldown: {
              userKey:
                BOT_TRIGGER_COOLDOWN_PREFIX +
                (normalized.message.senderId ?? "unknown"),
              cooldownMs: this.#triggerCooldownMs,
            },
          }
        : {}),
      maxAttempts: this.#updateMaxAttempts,
      nowMs: this.#now(),
    });

    if (normalized.reason === "human_persona_approval_reply") {
      this.#tryCaptureHumanPersonaEdit(
        normalized.chat.chatId,
        normalized.message,
      );
    }

    let routed = false;
    if (
      result.disposition !== "duplicate" &&
      normalized.updateKind === "message" &&
      normalized.reason !== "own_message" &&
      normalized.reason !== "bot_message" &&
      normalized.reason !== "human_persona_approval_reply"
    ) {
      this.#coordinator.routeMessage({
        messageId: durableMessageId(normalized.message),
        senderId:
          normalized.message.senderId ??
          `unknown:${normalized.message.chatId}:${normalized.message.messageId}`,
        ...(normalized.message.senderName === undefined
          ? {}
          : { senderName: normalized.message.senderName }),
        text: normalized.message.text,
        ...(normalized.replyToBot === true
          ? { replyToBot: true as const }
          : {}),
      });
      routed = true;
    }

    if (result.turn?.status === "queued" || result.turn?.status === "failed") {
      this.#workNotifier.notify();
    }
    this.#log(
      result.throttled ? "warn" : "info",
      result.throttled ? "bot.update.cooldown" : "bot.update.committed",
      {
        updateId,
        reason: normalized.reason,
        disposition: result.disposition,
        turnId: result.turn?.id,
        routed,
        retryAfterMs: result.throttled?.retryAfterMs,
      },
    );
    return {
      acknowledged: true,
      ackUpdateId: result.ackUpdateId,
      disposition: result.disposition,
      turnReserved:
        result.turn?.updateId === updateId && result.throttled === undefined,
      routed,
    };
  }

  /**
   * Approve/reject/regenerate/edit button presses (plan 4d/5 Шаг 5). Always
   * acknowledges: a malformed, stale (already-decided), or foreign `hp:`
   * callback must never consume the shared poison-retry budget or block
   * offset advancement -- it is simply a no-op click.
   */
  #processHumanPersonaCallback(
    updateId: number,
    callbackQuery: Record<string, unknown>,
  ): BotUpdateProcessingResult {
    const acked: BotUpdateProcessingResult = {
      acknowledged: true,
      ackUpdateId: updateId,
      disposition: "human_persona_decision",
      turnReserved: false,
      routed: false,
    };
    const data =
      typeof callbackQuery.data === "string" ? callbackQuery.data : undefined;
    const parsed = data ? HUMAN_PERSONA_CALLBACK_PATTERN.exec(data) : null;
    if (!parsed) {
      this.#log("warn", "human_persona.callback_ignored", { updateId });
      return acked;
    }
    const [, action, proposalId] = parsed as unknown as [
      string,
      string,
      string,
    ];
    const proposal = this.#store.getHumanPersonaProposal(proposalId);
    if (!proposal || proposal.status !== "claimed") {
      this.#log("info", "human_persona.callback_stale", {
        updateId,
        proposalId,
        action,
        status: proposal?.status,
      });
      return acked;
    }
    if (action === "edit") {
      // UI hint only; the edit itself comes from a reply to the posted
      // proposal (see #tryCaptureHumanPersonaEdit), not from this click.
      this.#log("info", "human_persona.callback_edit_hint", {
        updateId,
        proposalId,
      });
      return acked;
    }
    const status =
      action === "approve"
        ? "approved"
        : action === "reject"
          ? "rejected"
          : "regenerate_requested";
    const applied = this.#store.recordHumanPersonaProposalDecision(
      proposalId,
      status,
      undefined,
    );
    this.#log("info", "human_persona.callback_decided", {
      updateId,
      proposalId,
      action,
      applied,
    });
    return acked;
  }

  /**
   * A reply in the approval chat to a still-`claimed` proposal's posted
   * message is the manual-edit path -- no explicit button state, see
   * `#processHumanPersonaCallback`'s "edit" case. Best-effort: this never
   * changes the durable ACK outcome for the message itself.
   */
  #tryCaptureHumanPersonaEdit(
    chatId: string,
    message: { text: string; replyToMessageId?: number },
  ): void {
    if (message.replyToMessageId === undefined) {
      return;
    }
    const proposal =
      this.#store.getClaimedHumanPersonaProposalByApprovalMessage(
        chatId,
        message.replyToMessageId,
      );
    if (!proposal) {
      return;
    }
    const applied = this.#store.recordHumanPersonaProposalDecision(
      proposal.id,
      "edited",
      message.text,
    );
    this.#log("info", "human_persona.edit_captured", {
      proposalId: proposal.id,
      applied,
    });
  }

  #recordPoison(updateId: number, reason: string): BotUpdateProcessingResult {
    const result = this.#store.recordBotUpdateFailure({
      updateId,
      rawJson: JSON.stringify({ update_id: updateId, reason }),
      error: `Bot API update rejected: ${safeMachineCode(reason)}.`,
      maxAttempts: this.#updateMaxAttempts,
      nowMs: this.#now(),
    });
    this.#log("warn", "bot.update.rejected", {
      updateId,
      reason: safeMachineCode(reason),
      attempts: result.update.attempts,
      maxAttempts: result.update.maxAttempts,
      deadLetter: result.ackUpdateId !== undefined,
    });
    return result.ackUpdateId === undefined
      ? {
          acknowledged: false,
          updateId,
          disposition: "poison_retry",
        }
      : {
          acknowledged: true,
          ackUpdateId: result.ackUpdateId,
          disposition: "dead_letter",
          turnReserved: false,
          routed: false,
        };
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...compact(fields) });
    } catch {
      // Telemetry is never part of the durable ACK path.
    }
  }
}

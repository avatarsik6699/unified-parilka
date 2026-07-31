import type { MessageStore, StoredBotTurn } from "../../store.js";
import { TurnCoordinator } from "../turn-coordinator.js";
import {
  guardApplicationPlainTelegramOutput,
  guardFinalTelegramOutput,
  type GuardedTelegramPublication,
  type OutputGuardPolicy,
  type OutputRejectionCode,
} from "../output-guards.js";
import { buildTelemetryFooter } from "../telemetry.js";
import {
  ToolProgressPublisher,
  type ToolProgressBotApiPort,
} from "../tool-progress.js";
import {
  startTypingHeartbeat,
  type TypingHeartbeat,
  type TypingPort,
} from "../typing.js";
import {
  type BotAgentFinalResult,
  type BotTurnAgent,
  type BotTurnPublisher,
  type BotTurnWorkerOptions,
  type BotTurnWorkerResult,
  type JsonEventLogger,
  type WorkerScheduler,
} from "./contracts.js";
import { dispatchBotTurn, markBotTurnLostAck } from "./dispatch.js";
import {
  dedupeEvidence,
  isAgentFinal,
  messagesToEvidence,
  safeErrorCode,
} from "./helpers.js";
import { startTurnTimers, type TurnTimers } from "./timers.js";
import {
  createTurnFoldCollector,
  loadBotTurn,
  seedBotTurnReplay,
} from "./turn-context.js";
import { resolveBotTurnWorkerSettings } from "./worker-config.js";

const GUARD_REJECTION_NOTICE =
  "⚠️ Ответ не отправлен: он не прошёл внутреннюю проверку безопасности. Переформулируй запрос — отвечу заново.";

export class BotTurnWorker {
  readonly #store: MessageStore;
  readonly #coordinator: TurnCoordinator;
  readonly #agent: BotTurnAgent;
  readonly #publisher: BotTurnPublisher;
  readonly #workerId: string;
  readonly #allowedChatId: string;
  readonly #mode: "live" | "shadow";
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #turnTimeoutMs: number;
  readonly #publishTimeoutMs: number;
  readonly #outputPolicy: Omit<
    OutputGuardPolicy,
    "evidence" | "allowedMentions"
  >;
  readonly #additionalAllowedMentions: readonly string[];
  readonly #typingPort: TypingPort | undefined;
  readonly #typingIntervalMs: number;
  readonly #toolProgressBotApiPort: ToolProgressBotApiPort | undefined;
  readonly #logger: JsonEventLogger | undefined;
  readonly #scheduler: WorkerScheduler;
  readonly #now: () => number;

  constructor(options: BotTurnWorkerOptions) {
    this.#store = options.store;
    this.#coordinator = options.coordinator;
    this.#agent = options.agent;
    this.#publisher = options.publisher;
    const settings = resolveBotTurnWorkerSettings(options);
    this.#workerId = settings.workerId;
    this.#allowedChatId = settings.allowedChatId;
    this.#mode = settings.mode;
    this.#leaseMs = settings.leaseMs;
    this.#heartbeatMs = settings.heartbeatMs;
    this.#turnTimeoutMs = settings.turnTimeoutMs;
    this.#publishTimeoutMs = settings.publishTimeoutMs;
    this.#outputPolicy = settings.outputPolicy;
    this.#additionalAllowedMentions =
      settings.additionalAllowedMentions;
    this.#typingPort = options.typingPort;
    this.#typingIntervalMs = options.typingIntervalMs ?? 4_000;
    this.#toolProgressBotApiPort = options.toolProgressBotApiPort;
    this.#logger = settings.logger;
    this.#scheduler = settings.scheduler;
    this.#now = settings.now;
  }

  async runOnce(): Promise<BotTurnWorkerResult> {
    if (this.#coordinator.availableTurnSlots <= 0) {
      this.#log("info", "bot.turn.capacity", {
        activeTurns: this.#coordinator.activeTurnCount,
      });
      return { status: "capacity" };
    }

    const turn = this.#store.claimNextBotTurn({
      workerId: this.#workerId,
      chatId: this.#allowedChatId,
      leaseMs: this.#leaseMs,
      nowMs: this.#now(),
    });
    if (!turn) {
      const nowMs = this.#now();
      const retryAt = this.#store.getNextBotTurnRetryAt(
        this.#allowedChatId,
        nowMs,
      );
      return {
        status: "idle",
        ...(retryAt == null
          ? {}
          : { retryAfterMs: Math.max(1, retryAt - nowMs) }),
      };
    }
    if (turn.chatId !== this.#allowedChatId) {
      const skipped = this.#store.markBotTurnSkipped(
        turn.id,
        this.#workerId,
        "chat_scope_violation",
        this.#now(),
      );
      if (!skipped) {
        return { status: "lease_lost", turnId: turn.id };
      }
      this.#log("error", "bot.turn.chat_scope_rejected", {
        turnId: turn.id,
      });
      return {
        status: "skipped",
        turnId: turn.id,
        reason: "chat_scope",
      };
    }

    const coordinatorTurnId = `bot:${turn.chatId}:${turn.id}`;
    let coordinatorStarted = false;
    let timers: TurnTimers | undefined;
    let typing: TypingHeartbeat | undefined;
    let reachedSending = false;
    try {
      const loaded = loadBotTurn(this.#store, turn);
      if (!loaded) {
        if (!this.#failClaimedTurn(turn, "load", "trigger_not_found")) {
          return { status: "lease_lost", turnId: turn.id };
        }
        return { status: "failed", turnId: turn.id, stage: "load" };
      }

      const admission = this.#coordinator.startTurn({
        turnId: coordinatorTurnId,
        ownerSenderId: loaded.trigger.senderId ?? `unknown:${turn.id}`,
      });
      if (!admission.accepted) {
        if (
          !this.#failClaimedTurn(
            turn,
            "coordinator",
            admission.reason,
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        return {
          status: "failed",
          turnId: turn.id,
          stage: "coordinator",
        };
      }
      coordinatorStarted = true;
      seedBotTurnReplay(
        this.#coordinator,
        coordinatorTurnId,
        loaded.replay,
      );

      const controller = new AbortController();
      if (this.#typingPort) {
        typing = startTypingHeartbeat({
          port: this.#typingPort,
          chatId: turn.chatId,
          intervalMs: this.#typingIntervalMs,
          scheduler: this.#scheduler,
          signal: controller.signal,
        });
      }
      const toolProgress = this.#toolProgressBotApiPort
        ? new ToolProgressPublisher({
            turnId: turn.id,
            workerId: this.#workerId,
            chatId: turn.chatId,
            signal: controller.signal,
            botApi: this.#toolProgressBotApiPort,
            store: this.#store,
            initialMessageId: turn.progressMessageId,
            now: this.#now,
          })
        : undefined;
      timers = startTurnTimers({
        store: this.#store,
        turn,
        workerId: this.#workerId,
        leaseMs: this.#leaseMs,
        heartbeatMs: this.#heartbeatMs,
        turnTimeoutMs: this.#turnTimeoutMs,
        scheduler: this.#scheduler,
        now: this.#now,
        controller,
      });
      const {
        drainFold,
        drainedEvidence,
        foldedAllowedMentions,
      } = createTurnFoldCollector(
        this.#coordinator,
        coordinatorTurnId,
      );

      if (toolProgress) {
        await toolProgress.recoverPrevious(controller.signal);
      }

      let final: BotAgentFinalResult;
      try {
        final = await Promise.race([
          this.#agent.run({
            turn: Object.freeze({ ...turn }),
            trigger: Object.freeze({ ...loaded.trigger }),
            ...(loaded.replyTarget === undefined
              ? {}
              : { replyTarget: Object.freeze({ ...loaded.replyTarget }) }),
            context: loaded.context.map((message) =>
              Object.freeze({ ...message }),
            ),
            signal: controller.signal,
            drainFold,
            toolProgressPort: toolProgress,
            memoryBlock: loaded.memory?.memoryText,
            fastMemory: loaded.fastMemory,
            longTermLessons: loaded.longTermLessons,
            chatSkills: loaded.chatSkills,
          }),
          timers.interruption,
        ]);
      } catch (error) {
        timers.stop();
        if (timers.leaseLost) {
          this.#log("warn", "bot.turn.lease_lost", { turnId: turn.id });
          return { status: "lease_lost", turnId: turn.id };
        }
        if (
          !this.#failClaimedTurn(
            turn,
            "agent",
            timers.timedOut ? "turn_timeout" : safeErrorCode(error),
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        return { status: "failed", turnId: turn.id, stage: "agent" };
      }

      if (timers.leaseLost) {
        timers.stop();
        return { status: "lease_lost", turnId: turn.id };
      }
      if (timers.timedOut) {
        timers.stop();
        if (!this.#failClaimedTurn(turn, "agent", "turn_timeout")) {
          return { status: "lease_lost", turnId: turn.id };
        }
        return { status: "failed", turnId: turn.id, stage: "agent" };
      }
      if (!isAgentFinal(final)) {
        timers.stop();
        if (
          !this.#failClaimedTurn(
            turn,
            "agent",
            "invalid_final_protocol",
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        return { status: "failed", turnId: turn.id, stage: "agent" };
      }

      // A final may be rejected by output guards or become SKIP/shadow. The
      // progress message is presentation-only and must not outlive any of
      // those terminal outcomes.
      try {
        await toolProgress?.finish(controller.signal);
      } catch {
        // A persisted fence lets the next attempt recover a failed cleanup.
      }

      const evidence = dedupeEvidence([
        ...messagesToEvidence(loaded.context),
        ...drainedEvidence,
        ...final.evidence,
      ]);
      const allowedMentions = [
        ...this.#additionalAllowedMentions,
        ...foldedAllowedMentions,
      ];
      const isSkip = final.text.trim() === "SKIP";
      const finalText = isSkip
        ? final.text
        : `${final.text}\n\n${buildTelemetryFooter(final.telemetry)}`;
      const guarded = final.responseOrigin === "local_audio"
        ? guardApplicationPlainTelegramOutput(
            { kind: "final", text: finalText },
            this.#outputPolicy,
          )
        : guardFinalTelegramOutput(
            { kind: "final", text: finalText },
            {
              ...this.#outputPolicy,
              evidence,
              allowedMentions,
            },
          );

      let publication: GuardedTelegramPublication;
      let draftText: string;
      let rejectedGuardCode: OutputRejectionCode | undefined;
      if (!guarded.ok) {
        rejectedGuardCode = guarded.rejection.code;
        this.#log("warn", "bot.turn.guard_rejected", {
          turnId: turn.id,
          code: rejectedGuardCode,
        });
        const notice = guardFinalTelegramOutput(
          { kind: "final", text: GUARD_REJECTION_NOTICE },
          { maxMentions: 0 },
        );
        if (!notice.ok || notice.disposition !== "send") {
          timers.stop();
          if (
            !this.#store.markBotTurnSkipped(
              turn.id,
              this.#workerId,
              `guard_rejected:${rejectedGuardCode}`,
              this.#now(),
            )
          ) {
            return { status: "lease_lost", turnId: turn.id };
          }
          this.#log("error", "bot.turn.guard_notice_unavailable", {
            turnId: turn.id,
            code: rejectedGuardCode,
          });
          return {
            status: "skipped",
            turnId: turn.id,
            reason: "guard_rejected",
            guardCode: rejectedGuardCode,
          };
        }
        publication = notice.publication;
        draftText = notice.text;
      } else if (guarded.disposition === "skip") {
        if (
          !this.#store.saveBotTurnDraft(
            turn.id,
            this.#workerId,
            guarded.text,
            this.#now(),
          )
        ) {
          timers.stop();
          return { status: "lease_lost", turnId: turn.id };
        }
        timers.stop();
        if (
          !this.#store.markBotTurnSkipped(
            turn.id,
            this.#workerId,
            "model_skip",
            this.#now(),
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        this.#log("info", "bot.turn.skipped", {
          turnId: turn.id,
          reason: "model_skip",
        });
        return {
          status: "skipped",
          turnId: turn.id,
          reason: "model_skip",
        };
      } else {
        publication = guarded.publication;
        draftText = guarded.text;
      }

      if (
        !this.#store.saveBotTurnDraft(
          turn.id,
          this.#workerId,
          draftText,
          this.#now(),
        )
      ) {
        timers.stop();
        return { status: "lease_lost", turnId: turn.id };
      }

      if (this.#mode === "shadow") {
        timers.stop();
        if (
          !this.#store.markBotTurnSkipped(
            turn.id,
            this.#workerId,
            "shadow_mode",
            this.#now(),
          )
        ) {
          return { status: "lease_lost", turnId: turn.id };
        }
        this.#log("info", "bot.turn.skipped", {
          turnId: turn.id,
          reason: "shadow",
          publication: publication.mode,
          ...(rejectedGuardCode === undefined
            ? {}
            : { guardCode: rejectedGuardCode }),
        });
        return { status: "skipped", turnId: turn.id, reason: "shadow" };
      }

      // From here on no lease timer may mutate or abort the turn. The durable
      // `sending` row is the unknown-delivery fence.
      typing?.stop();
      timers.stop();
      if (
        !this.#store.markBotTurnSending(
          turn.id,
          this.#workerId,
          this.#now(),
        )
      ) {
        return { status: "lease_lost", turnId: turn.id };
      }
      reachedSending = true;
      return await dispatchBotTurn(
        {
          store: this.#store,
          publisher: this.#publisher,
          allowedChatId: this.#allowedChatId,
          publishTimeoutMs: this.#publishTimeoutMs,
          scheduler: this.#scheduler,
          logger: this.#logger,
          now: this.#now,
        },
        turn,
        loaded.trigger,
        publication,
      );
    } catch (error) {
      timers?.stop();
      if (reachedSending) {
        markBotTurnLostAck(
          { store: this.#store, logger: this.#logger, now: this.#now },
          turn,
          `worker_exception:${safeErrorCode(error)}`,
        );
        return { status: "lost_ack", turnId: turn.id };
      }
      if (!this.#failClaimedTurn(turn, "agent", safeErrorCode(error))) {
        return { status: "lease_lost", turnId: turn.id };
      }
      return { status: "failed", turnId: turn.id, stage: "agent" };
    } finally {
      typing?.stop();
      timers?.stop();
      if (coordinatorStarted) {
        this.#coordinator.completeTurn(coordinatorTurnId);
      }
    }
  }

  #failClaimedTurn(
    turn: StoredBotTurn,
    stage: "load" | "agent" | "coordinator",
    code: string,
  ): boolean {
    let transitioned = false;
    try {
      transitioned = this.#store.markBotTurnFailed(
        turn.id,
        this.#workerId,
        `${stage}:${code}`,
        this.#now(),
      );
    } finally {
      this.#log("error", "bot.turn.failed", {
        turnId: turn.id,
        stage,
        code,
      });
    }
    return transitioned;
  }

  #log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Logging must never alter durable turn state.
    }
  }
}

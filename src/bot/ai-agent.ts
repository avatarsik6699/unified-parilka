import { randomBytes } from "node:crypto";
import { generateText } from "ai";
import {
  ModelContentFilterError,
  type ModelExecutionResult,
  type ModelRole,
  type ResolvedModelCandidate,
} from "../providers/model-router.js";
import {
  BOT_AGENT_CONTRACT,
  botResearchMinimumToolCalls,
  botResearchModeForText,
  botToolCallBudget,
  buildBotSystemPrompt,
  renderFoldBatch,
  type BotSystemPromptOptions,
} from "./prompt.js";
import { type BotReadTools } from "./read-tools.js";
import { BotMemoryTools } from "./memory-tools.js";
import { botMemoryWriteAllowedForText } from "./memory-policy.js";
import {
  extractReasoningMode,
  extractReasoningTokens,
  TurnUsageAccumulator,
  type TurnTelemetry,
} from "./telemetry.js";
import type {
  BotAgentFinalResult,
  BotAgentRequest,
  BotTurnAgent,
  JsonEventLogger,
} from "./worker.js";
import {
  buildTurnMessages,
  userMessage,
  withImageAttachment,
} from "./agent/context.js";
import {
  boundedSerialize,
  renderCarriedToolMessages,
  type CarriedToolResult,
} from "./agent/evidence.js";
import { sanitizeFinalText } from "./agent/final-sanitizer.js";
import { ThinkingProgressTracker } from "./agent/thinking-progress.js";
import { createBotToolCompletionObserver } from "./agent/tool-observer.js";
import {
  createBotToolSet,
  researchContinuationInstructions,
  type BotToolSetExecutionCompleted,
} from "./agent/tool-set.js";
import {
  AudioTranscriptionExecution,
  isDirectAudioTranscriptionRequest,
  renderDirectAudioTranscription,
} from "./agent/media-execution.js";
import { type BotMediaToolsPort } from "./media-tools.js";
import {
  agentAbortError,
  boundedInteger,
  isTimeoutError,
  modelStepTimeoutError,
  requireNonce,
  safeErrorCode,
  throwIfAgentAborted,
  throwIfTurnAborted,
} from "./agent/runtime-helpers.js";
import type { ReadToolEvidence } from "./read-tools/contracts.js";

const DEFAULT_CONTEXT_CHARS = 48_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_CHARS = 200_000;

export interface TurnModelRouter {
  executeWithFallback<T>(
    role: ModelRole,
    attempt: (
      candidate: ResolvedModelCandidate,
      attemptNumber: number,
    ) => Promise<T>,
  ): Promise<ModelExecutionResult<T>>;
}

export interface AiSdkBotTurnAgentOptions {
  router: TurnModelRouter;
  readTools: BotReadTools;
  mediaTools?: BotMediaToolsPort;
  memoryTools?: BotMemoryTools;
  prompt: Omit<BotSystemPromptOptions, "modelLabel" | "now">;
  logger?: JsonEventLogger;
  now?: () => Date;
  nonceFactory?: () => string;
  contextCharLimit?: number;
  maxOutputTokens?: number;
  totalTimeoutMs?: number;
  stepTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export type BotAgentProtocolErrorCode =
  | "empty_final"
  | "incomplete_finish";

export class BotAgentProtocolError extends Error {
  readonly name = "BotAgentProtocolError";
  readonly modelFallback: boolean;

  constructor(
    readonly code: BotAgentProtocolErrorCode,
    readonly finishReason?: string,
    fallbackEligible = code === "empty_final",
  ) {
    super(
      code === "empty_final"
        ? "The model returned an empty final response."
        : `The model did not finish normally (${finishReason ?? "unknown"}).`,
    );
    this.modelFallback = fallbackEligible;
  }
}

/**
 * A non-streaming, read-only model loop.
 *
 * Correctness state (tool budget and folds) is shared across provider
 * attempts. Provider-specific assistant/tool messages are not: a fallback
 * starts from application-owned context plus bounded successful tool results.
 */
export class AiSdkBotTurnAgent implements BotTurnAgent {
  readonly #router: TurnModelRouter;
  readonly #readTools: BotReadTools;
  readonly #mediaTools: BotMediaToolsPort | undefined;
  readonly #memoryTools: BotMemoryTools | undefined;
  readonly #prompt: Omit<BotSystemPromptOptions, "modelLabel" | "now">;
  readonly #logger: JsonEventLogger | undefined;
  readonly #now: () => Date;
  readonly #nonceFactory: () => string;
  readonly #contextCharLimit: number;
  readonly #maxOutputTokens: number;
  readonly #totalTimeoutMs: number;
  /**
   * Undefined deliberately means that only the whole-turn deadline applies.
   * Qwen can legitimately take longer than a fixed per-step ceiling after a
   * tool result, while the enclosing AbortSignal still bounds the turn.
   */
  readonly #stepTimeoutMs: number | undefined;
  readonly #toolTimeoutMs: number;

  constructor(options: AiSdkBotTurnAgentOptions) {
    this.#router = options.router;
    this.#readTools = options.readTools;
    this.#mediaTools = options.mediaTools;
    this.#memoryTools = options.memoryTools;
    this.#prompt = options.prompt;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#nonceFactory =
      options.nonceFactory ?? (() => randomBytes(12).toString("hex"));
    this.#contextCharLimit = boundedInteger(
      options.contextCharLimit ?? DEFAULT_CONTEXT_CHARS,
      1_000,
      MAX_CONTEXT_CHARS,
      "contextCharLimit",
    );
    this.#maxOutputTokens = boundedInteger(
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      64,
      32_768,
      "maxOutputTokens",
    );
    this.#totalTimeoutMs = boundedInteger(
      options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      100,
      15 * 60_000,
      "totalTimeoutMs",
    );
    this.#stepTimeoutMs = options.stepTimeoutMs === undefined
      ? undefined
      : boundedInteger(
          options.stepTimeoutMs,
          100,
          this.#totalTimeoutMs,
          "stepTimeoutMs",
        );
    this.#toolTimeoutMs = boundedInteger(
      options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      100,
      this.#stepTimeoutMs ?? this.#totalTimeoutMs,
      "toolTimeoutMs",
    );
  }

  async run(request: BotAgentRequest): Promise<BotAgentFinalResult> {
    throwIfTurnAborted(request.signal);
    const agentStartedAtMs = Date.now();
    const agentDeadlineAtMs = agentStartedAtMs + this.#totalTimeoutMs;
    const traceContext = {
      turnId: request.turn.id,
      updateId: request.turn.updateId,
    };
    const deadlineSignal = AbortSignal.timeout(this.#totalTimeoutMs);
    const turnSignal = AbortSignal.any([request.signal, deadlineSignal]);
    const now = this.#now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("now must return a valid Date");
    }
    const nonce = requireNonce(this.#nonceFactory());
    const baseMessages = buildTurnMessages(
      request,
      nonce,
      this.#contextCharLimit,
    );
    const researchMode = botResearchModeForText(request.trigger.text);
    const researchMinimumToolCalls = botResearchMinimumToolCalls(researchMode);
    const memoryWriteAllowed =
      this.#memoryTools !== undefined &&
      this.#memoryTools.isWriteAuthorizer(request.trigger.senderId) &&
      botMemoryWriteAllowedForText(request.trigger.text);
    const toolCallBudget = botToolCallBudget(researchMode);
    const folds: string[] = [];
    const carriedTools: CarriedToolResult[] = [];
    const toolEvidence: ReadToolEvidence[] = [];
    const readToolFailures: Array<{ name: string; code: string }> = [];
    const approvalOrder = new Map<string, number>();
    const usage = new TurnUsageAccumulator();
    let allowedExecutions = 0;
    let startedExecutions = 0;
    let startedReadExecutions = 0;
    let completedExecutions = 0;
    let deniedExecutions = 0;
    let requestedExecutions = 0;
    let researchQualityRetries = 0;
    const thinkingProgress = new ThinkingProgressTracker(
      request.toolProgressPort,
    );
    const mediaTools = this.#mediaTools;
    const photoTarget = mediaTools?.findPhoto(
      request.trigger,
      request.replyTarget,
    );
    const audioTarget = mediaTools?.findAudio(
      request.trigger,
      request.replyTarget,
    );
    let visionAttachmentPromise: ReturnType<BotMediaToolsPort["resolveVision"]> | undefined;
    const audioExecution = new AudioTranscriptionExecution({
      mediaTools,
      target: audioTarget,
      thinkingProgress,
      toolProgressPort: request.toolProgressPort,
      carriedTools,
      onStarted: () => { startedExecutions += 1; },
      onCompleted: () => { completedExecutions += 1; },
      getSequence: (callId) =>
        approvalOrder.get(callId) ?? allowedExecutions + carriedTools.length + 1,
      remainingTurnMs: () => Math.max(0, agentDeadlineAtMs - Date.now()),
      log: (level, event, fields) => this.#log(level, event, fields),
      traceContext,
    });

    const rememberFold = (boundary: "model" | "tool"): void => {
      const rendered = renderFoldBatch(request.drainFold(boundary));
      if (rendered) {
        folds.push(rendered);
      }
    };

    if (isDirectAudioTranscriptionRequest(request.trigger.text)) {
      // A reply + @mention saying "расшифруй" is an explicit local command,
      // not a suggestion for a remote language model. It intentionally never
      // sends the private transcript to a provider: the worker publishes the
      // full result through its application-owned plain-text path instead.
      allowedExecutions += audioExecution.available ? 1 : 0;
      const directAudio = await audioExecution.runDirect({
        callId: `audio:auto:${request.turn.id}`,
        signal: turnSignal,
      });
      usage.setFinalModel("flov", "local");
      usage.setExecutionStats({
        toolCalls: startedExecutions,
        durationMs: Math.max(0, Date.now() - agentStartedAtMs),
      });
      const final: BotAgentFinalResult = {
        kind: "final",
        text: renderDirectAudioTranscription(directAudio),
        telemetry: usage.build(),
        responseOrigin: "local_audio",
      };
      this.#log("info", "bot.agent.complete", {
        ...traceContext,
        candidate: "local:flov",
        attempt: 1,
        fallbackCount: 0,
        fallbackReasons: [],
        requestedToolCalls: requestedExecutions,
        allowedToolCalls: allowedExecutions,
        startedToolCalls: startedExecutions,
        startedReadToolCalls: startedReadExecutions,
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        researchMode,
        memoryWriteAllowed,
        toolCallBudget,
        researchMinimumToolCalls,
        researchQualityRetries,
      });
      return final;
    }

    try {
      const routed = await this.#router.executeWithFallback(
        "turn",
        async (candidate, attemptNumber) => {
          throwIfAgentAborted(request.signal, deadlineSignal);
          let visionAttachment:
            | Awaited<ReturnType<BotMediaToolsPort["resolveVision"]>>
            | undefined;
          if (
            photoTarget !== undefined &&
            mediaTools !== undefined &&
            candidate.capabilities.vision
          ) {
            try {
              visionAttachmentPromise ??= mediaTools.resolveVision(
                photoTarget,
                turnSignal,
              );
              visionAttachment = await visionAttachmentPromise;
            } catch (error) {
              if (turnSignal.aborted) {
                throw agentAbortError(request.signal, deadlineSignal);
              }
              this.#log("warn", "bot.agent.vision_unavailable", {
                ...traceContext,
                candidate: candidate.reference,
                attempt: attemptNumber,
                code: safeErrorCode(error),
              });
            }
          }
          const candidateBaseMessages = visionAttachment === undefined
            ? baseMessages
            : withImageAttachment(baseMessages, visionAttachment);
          const instructions = buildBotSystemPrompt({
            ...this.#prompt,
            modelLabel: candidate.reference,
            now,
            memoryBlock:
              request.memoryBlock ?? this.#prompt.memoryBlock,
            memoryMaxChars: this.#prompt.memoryMaxChars,
            fastMemory: request.fastMemory,
            longTermLessons: request.longTermLessons,
            chatSkills: request.chatSkills,
            memoryToolsAvailable: this.#memoryTools !== undefined,
            memoryWriteAllowed,
            researchMode,
            imageAttached: photoTarget !== undefined,
            visionAvailable: candidate.capabilities.vision,
            imageDelivered: visionAttachment !== undefined,
            audioTranscriptionAvailable:
              audioExecution.available && !audioExecution.hasModelTranscription,
          });
          let forceFinal = allowedExecutions >= toolCallBudget;
          const onToolCompleted = createBotToolCompletionObserver({
            traceContext,
            candidate: candidate.reference,
            attempt: attemptNumber,
            approvalOrder,
            allowedExecutions: () => allowedExecutions,
            carriedTools,
            toolEvidence,
            readToolFailures,
            toolProgressPort: request.toolProgressPort,
            onCompleted: () => {
              completedExecutions += 1;
            },
            log: (level, event, fields) => this.#log(level, event, fields),
          });
          const { tools, toolOrder } = createBotToolSet({
            readTools: this.#readTools,
            memoryTools: this.#memoryTools,
            memoryWriteAllowed,
            audioTranscriptionAvailable:
              audioExecution.available && !audioExecution.hasModelTranscription,
            nonce,
            turnSignal,
            chatId: request.turn.chatId,
            sourceMessageId: request.trigger.messageId,
            senderId: request.trigger.senderId,
            onExecutionStarted: (execution) => {
              startedExecutions += 1;
              if (execution.kind === "read") {
                startedReadExecutions += 1;
              }
              thinkingProgress.finish();
              request.toolProgressPort?.onToolStarted({
                toolName: execution.name,
                callId: execution.callId,
                input: execution.input,
              });
            },
            onExecutionCompleted: onToolCompleted,
            ...(!audioExecution.available || audioExecution.hasModelTranscription
              ? {}
              : {
                  runAudioTranscription: ({ callId, signal }) =>
                    audioExecution.runForModel({
                      callId,
                      signal,
                      candidate,
                      attempt: attemptNumber,
                    }),
                }),
          });

          try {
            while (true) {
              throwIfAgentAborted(request.signal, deadlineSignal);
              let foldCursor = folds.length;
              forceFinal = allowedExecutions >= toolCallBudget;
              const activeInstructions = researchQualityRetries === 0
                ? instructions
                : researchContinuationInstructions(
                    instructions,
                    researchMinimumToolCalls,
                    startedReadExecutions,
                  );
              const attemptMessages = [
                ...candidateBaseMessages,
                ...folds.map(userMessage),
                ...renderCarriedToolMessages(carriedTools, nonce),
              ];
              const result = await generateText({
                model: candidate.model,
                providerOptions: candidate.providerOptions,
                instructions: activeInstructions,
                messages: attemptMessages,
                tools,
                toolOrder,
                // Qwen's compatible Chat Completions endpoint rejects
                // tool_choice="required" with 400. A bounded quality gate
                // retries premature research finals while auto remains the
                // supported wire mode.
                toolChoice: "auto",
                toolApproval: ({ toolCall }) => {
                  throwIfAgentAborted(request.signal, deadlineSignal);
                  requestedExecutions += 1;
                  if (
                    forceFinal ||
                    allowedExecutions >= toolCallBudget
                  ) {
                    deniedExecutions += 1;
                    forceFinal = true;
                    return {
                      type: "denied",
                      reason: "tool_budget_exhausted",
                    };
                  }
                  rememberFold("tool");
                  allowedExecutions += 1;
                  approvalOrder.set(toolCall.toolCallId, allowedExecutions);
                  if (
                    allowedExecutions >= toolCallBudget
                  ) {
                    forceFinal = true;
                  }
                  return "not-applicable";
                },
                prepareStep: ({ steps, messages }) => {
                  throwIfAgentAborted(request.signal, deadlineSignal);
                  rememberFold("model");
                  const newFolds = folds.slice(foldCursor);
                  foldCursor = folds.length;
                  const nextMessages =
                    newFolds.length === 0
                      ? messages
                      : [...messages, ...newFolds.map(userMessage)];
                  const observedToolRequests = steps.reduce(
                    (count, step) => count + step.toolCalls.length,
                    0,
                  );
                  forceFinal ||= (
                    allowedExecutions >=
                      toolCallBudget ||
                    observedToolRequests >=
                      toolCallBudget
                  );
                  return forceFinal
                    ? {
                        messages: nextMessages,
                        activeTools: [],
                        toolChoice: "none",
                        instructions:
                          `${activeInstructions}\n\n` +
                          "Лимит инструментов исчерпан. Сейчас верни только " +
                          "финальный ответ по уже полученным данным; новых " +
                          "инструментов не вызывай.",
                      }
                    : {
                        messages: nextMessages,
                        toolChoice: "auto",
                      };
                },
                // Do not impose an artificial count of model steps. The model
                // stops naturally after a final response; tool execution stays
                // bounded by toolCallBudget and the entire turn by turnSignal.
                stopWhen: () => false,
                maxRetries: 0,
                abortSignal: turnSignal,
                timeout: {
                  ...(this.#stepTimeoutMs === undefined
                    ? {}
                    : { stepMs: this.#stepTimeoutMs }),
                  toolMs: this.#toolTimeoutMs,
                },
                maxOutputTokens: this.#maxOutputTokens,
                include: {
                  requestBody: false,
                  requestMessages: false,
                  responseBody: false,
                },
                onStepStart: () => {
                  thinkingProgress.start();
                },
                onStepEnd: (step) => {
                  thinkingProgress.finish();
                  usage.recordStep({
                    modelId: step.response.modelId ?? candidate.modelId,
                    providerId: candidate.providerId,
                    inputTokens: step.usage.inputTokens,
                    outputTokens: step.usage.outputTokens,
                    totalTokens: step.usage.totalTokens,
                    reasoningTokens: extractReasoningTokens(step.usage),
                    reasoningMode: extractReasoningMode(step),
                  });
                  this.#log("info", "bot.agent.step", {
                    ...traceContext,
                    candidate: candidate.reference,
                    attempt: attemptNumber,
                    researchQualityRetry: researchQualityRetries,
                    stepNumber: step.stepNumber,
                    callId: step.callId,
                    finishReason: step.finishReason,
                    rawFinishReason: step.rawFinishReason,
                    responseId: step.response.id,
                    responseModelId: step.response.modelId,
                    inputTokens: step.usage.inputTokens,
                    outputTokens: step.usage.outputTokens,
                    totalTokens: step.usage.totalTokens,
                    responseTimeMs: step.performance.responseTimeMs,
                    stepTimeMs: step.performance.stepTimeMs,
                    toolCalls: step.toolCalls.length,
                    toolResults: step.toolResults.length,
                  });
                },
              });

              if (
                result.finishReason === "content-filter" ||
                result.steps.some(
                  (step) => step.finishReason === "content-filter",
                )
              ) {
                throw new ModelContentFilterError(
                  "Provider blocked the generated response.",
                );
              }
              if (result.finishReason !== "stop") {
                throw new BotAgentProtocolError(
                  "incomplete_finish",
                  result.finishReason,
                  result.finishReason === "error" ||
                    result.finishReason === "other" ||
                    result.finishReason === "tool-calls",
                );
              }
              if (result.text.trim().length === 0) {
                throw new BotAgentProtocolError("empty_final");
              }
              const sanitizedText = sanitizeFinalText({
                text: result.text,
                toolEvidence,
                researchMode: researchMode === "research",
                readToolFailures,
              });
              if (sanitizedText.length === 0) {
                throw new BotAgentProtocolError("empty_final");
              }
              if (
                researchMinimumToolCalls > startedReadExecutions &&
                researchQualityRetries < BOT_AGENT_CONTRACT.researchQualityRetries &&
                allowedExecutions < toolCallBudget
              ) {
                researchQualityRetries += 1;
                this.#log("info", "bot.agent.research_depth_retry", {
                  ...traceContext,
                  candidate: candidate.reference,
                  attempt: attemptNumber,
                  retry: researchQualityRetries,
                  requiredReadToolCalls: researchMinimumToolCalls,
                  startedReadToolCalls: startedReadExecutions,
                });
                continue;
              }
              usage.setFinalModel(
                result.response.modelId ?? candidate.modelId,
                candidate.providerId,
              );
              usage.setExecutionStats({
                toolCalls: startedExecutions,
                durationMs: Math.max(0, Date.now() - agentStartedAtMs),
              });
              return {
                kind: "final" as const,
                text: sanitizedText,
                telemetry: usage.build(),
              };
            }
          } catch (error) {
            thinkingProgress.finish(false);
            if (turnSignal.aborted) {
              throw agentAbortError(request.signal, deadlineSignal);
            }
            if (isTimeoutError(error)) {
              throw modelStepTimeoutError();
            }
            throw error;
          }
        },
      );

      throwIfAgentAborted(request.signal, deadlineSignal);
      this.#log("info", "bot.agent.complete", {
        ...traceContext,
        candidate: routed.candidate.reference,
        attempt: routed.attempt,
        fallbackCount: routed.failures.length,
        fallbackReasons: routed.failures.map(
          ({ decision }) => decision.reason,
        ),
        requestedToolCalls: requestedExecutions,
        allowedToolCalls: allowedExecutions,
        startedToolCalls: startedExecutions,
        startedReadToolCalls: startedReadExecutions,
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        researchMode,
        memoryWriteAllowed,
        toolCallBudget,
        researchMinimumToolCalls,
        researchQualityRetries,
      });
      return routed.value;
    } catch (error) {
      this.#log("warn", "bot.agent.failed", {
        ...traceContext,
        requestedToolCalls: requestedExecutions,
        allowedToolCalls: allowedExecutions,
        startedToolCalls: startedExecutions,
        startedReadToolCalls: startedReadExecutions,
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        code: safeErrorCode(error),
        researchMode,
        memoryWriteAllowed,
        toolCallBudget,
        researchMinimumToolCalls,
        researchQualityRetries,
      });
      throw error;
    }
  }

  #log(
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    try {
      this.#logger?.[level]({ event, ...fields });
    } catch {
      // Observability is best-effort and must not alter the agent loop.
    }
  }
}

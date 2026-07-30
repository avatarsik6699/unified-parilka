import { randomBytes } from "node:crypto";
import {
  generateText,
  jsonSchema,
  tool,
  type ToolSet,
} from "ai";
import {
  ModelContentFilterError,
  type ModelExecutionResult,
  type ModelRole,
  type ResolvedModelCandidate,
} from "../providers/model-router.js";
import {
  BOT_AGENT_CONTRACT,
  buildBotSystemPrompt,
  renderFoldBatch,
  wrapUntrustedToolData,
  type BotSystemPromptOptions,
} from "./prompt.js";
import {
  BOT_READ_TOOL_DEFINITIONS,
  BOT_READ_TOOL_NAMES,
  type BotReadToolName,
  type BotReadToolResult,
  type BotReadTools,
} from "./read-tools.js";
import {
  TurnUsageAccumulator,
  type TurnTelemetry,
} from "./telemetry.js";
import type {
  BotAgentFinalResult,
  BotAgentRequest,
  BotTurnAgent,
  JsonEventLogger,
} from "./worker.js";
import { buildTurnMessages, userMessage } from "./agent/context.js";
import {
  boundedSerialize,
  collectQuoteEvidence,
  renderCarriedToolMessages,
  type CarriedToolResult,
} from "./agent/evidence.js";
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

const DEFAULT_CONTEXT_CHARS = 48_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_STEP_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_CHARS = 200_000;
const MAX_MODEL_STEPS = BOT_AGENT_CONTRACT.maxToolCalls + 1;

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
 * Correctness state (tool budget, folds, evidence) is shared across provider
 * attempts. Provider-specific assistant/tool messages are not: a fallback
 * starts from application-owned context plus bounded successful tool results.
 */
export class AiSdkBotTurnAgent implements BotTurnAgent {
  readonly #router: TurnModelRouter;
  readonly #readTools: BotReadTools;
  readonly #prompt: Omit<BotSystemPromptOptions, "modelLabel" | "now">;
  readonly #logger: JsonEventLogger | undefined;
  readonly #now: () => Date;
  readonly #nonceFactory: () => string;
  readonly #contextCharLimit: number;
  readonly #maxOutputTokens: number;
  readonly #totalTimeoutMs: number;
  readonly #stepTimeoutMs: number;
  readonly #toolTimeoutMs: number;

  constructor(options: AiSdkBotTurnAgentOptions) {
    this.#router = options.router;
    this.#readTools = options.readTools;
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
    this.#stepTimeoutMs = boundedInteger(
      options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      100,
      this.#totalTimeoutMs,
      "stepTimeoutMs",
    );
    this.#toolTimeoutMs = boundedInteger(
      options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      100,
      this.#stepTimeoutMs,
      "toolTimeoutMs",
    );
  }

  async run(request: BotAgentRequest): Promise<BotAgentFinalResult> {
    throwIfTurnAborted(request.signal);
    const traceContext = {
      turnId: request.turn.id,
      updateId: request.turn.updateId,
    };
    const deadlineSignal = AbortSignal.timeout(this.#totalTimeoutMs);
    const turnSignal = AbortSignal.any([
      request.signal,
      deadlineSignal,
    ]);
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
    const folds: string[] = [];
    const carriedTools: CarriedToolResult[] = [];
    const evidence: BotAgentFinalResult["evidence"][number][] = [];
    const evidenceKeys = new Set<string>();
    const approvalOrder = new Map<string, number>();
    const usage = new TurnUsageAccumulator();
    let allowedExecutions = 0;
    let startedExecutions = 0;
    let completedExecutions = 0;
    let deniedExecutions = 0;
    let requestedExecutions = 0;

    const rememberFold = (boundary: "model" | "tool"): void => {
      const rendered = renderFoldBatch(request.drainFold(boundary));
      if (rendered) {
        folds.push(rendered);
      }
    };

    try {
      const routed = await this.#router.executeWithFallback(
        "turn",
        async (candidate, attemptNumber) => {
          throwIfAgentAborted(request.signal, deadlineSignal);
          let foldCursor = folds.length;
          const attemptMessages = [
            ...baseMessages,
            ...folds.map(userMessage),
            ...renderCarriedToolMessages(carriedTools, nonce),
          ];
          const instructions = buildBotSystemPrompt({
            ...this.#prompt,
            modelLabel: candidate.reference,
            now,
          });
          let forceFinal = allowedExecutions >= BOT_AGENT_CONTRACT.maxToolCalls;

          const makeTool = (name: BotReadToolName) => {
            const definition = BOT_READ_TOOL_DEFINITIONS.find(
              (item) => item.name === name,
            );
            if (!definition) {
              throw new Error(`Missing read tool definition: ${name}`);
            }
            return tool({
              description: definition.description,
              inputSchema: jsonSchema<Record<string, unknown>>(
                definition.inputSchema as Parameters<typeof jsonSchema>[0],
              ),
              execute: async (input, options): Promise<BotReadToolResult> => {
                const startedAt = Date.now();
                startedExecutions += 1;
                const signal = options.abortSignal ?? turnSignal;
                const output = await this.#readTools.callTool(name, input, {
                  signal,
                });
                completedExecutions += 1;
                const sequence =
                  approvalOrder.get(options.toolCallId) ??
                  allowedExecutions + carriedTools.length + 1;
                carriedTools.push({
                  sequence,
                  name,
                  serialized: boundedSerialize(output),
                });
                collectQuoteEvidence(
                  output,
                  evidence,
                  evidenceKeys,
                );
                this.#log("info", "bot.agent.tool", {
                  ...traceContext,
                  candidate: candidate.reference,
                  attempt: attemptNumber,
                  tool: name,
                  durationMs: Math.max(0, Date.now() - startedAt),
                  ok: output.ok,
                  status: output.ok ? output.status : undefined,
                  errorCode: output.ok ? undefined : output.error.code,
                });
                return output;
              },
              toModelOutput: ({ output }) => ({
                type: "text",
                value: wrapUntrustedToolData(
                  name,
                  boundedSerialize(output),
                  nonce,
                ),
              }),
            });
          };

          const tools = {
            search_chat: makeTool("search_chat"),
            day_digest: makeTool("day_digest"),
            thread_context: makeTool("thread_context"),
            web_search: makeTool("web_search"),
          } satisfies ToolSet;

          try {
            const result = await generateText({
              model: candidate.model,
              providerOptions: candidate.providerOptions,
              instructions,
              messages: attemptMessages,
              tools,
              toolOrder: [...BOT_READ_TOOL_NAMES],
              toolChoice: "auto",
              toolApproval: ({ toolCall }) => {
                throwIfAgentAborted(request.signal, deadlineSignal);
                requestedExecutions += 1;
                if (
                  forceFinal ||
                  allowedExecutions >= BOT_AGENT_CONTRACT.maxToolCalls
                ) {
                  deniedExecutions += 1;
                  forceFinal = true;
                  return {
                    type: "denied",
                    reason: "read_tool_budget_exhausted",
                  };
                }
                rememberFold("tool");
                allowedExecutions += 1;
                approvalOrder.set(toolCall.toolCallId, allowedExecutions);
                if (
                  allowedExecutions >= BOT_AGENT_CONTRACT.maxToolCalls
                ) {
                  forceFinal = true;
                }
                return "not-applicable";
              },
              prepareStep: ({ stepNumber, steps, messages }) => {
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
                    BOT_AGENT_CONTRACT.maxToolCalls ||
                  observedToolRequests >=
                    BOT_AGENT_CONTRACT.maxToolCalls ||
                  stepNumber >= BOT_AGENT_CONTRACT.maxToolCalls
                );
                const mustForceFinal = forceFinal;
                return mustForceFinal
                  ? {
                      messages: nextMessages,
                      activeTools: [],
                      toolChoice: "none",
                      instructions:
                        `${instructions}\n\n` +
                        "Лимит инструментов исчерпан. Сейчас верни только " +
                        "финальный ответ по уже полученным данным; новых " +
                        "инструментов не вызывай.",
                    }
                  : { messages: nextMessages };
              },
              stopWhen: ({ steps }) => steps.length >= MAX_MODEL_STEPS,
              maxRetries: 0,
              abortSignal: turnSignal,
              timeout: {
                stepMs: this.#stepTimeoutMs,
                toolMs: this.#toolTimeoutMs,
              },
              maxOutputTokens: this.#maxOutputTokens,
              include: {
                requestBody: false,
                requestMessages: false,
                responseBody: false,
              },
              onStepEnd: (step) => {
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
            usage.setFinalModel(
              result.response.modelId ?? candidate.modelId,
              candidate.providerId,
            );
            return {
              kind: "final" as const,
              text: result.text,
              evidence: Object.freeze([...evidence]),
              telemetry: usage.build(),
            };
          } catch (error) {
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
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        evidenceCount: evidence.length,
      });
      return routed.value;
    } catch (error) {
      this.#log("warn", "bot.agent.failed", {
        ...traceContext,
        requestedToolCalls: requestedExecutions,
        allowedToolCalls: allowedExecutions,
        startedToolCalls: startedExecutions,
        completedToolCalls: completedExecutions,
        deniedToolCalls: deniedExecutions,
        code: safeErrorCode(error),
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

function extractReasoningTokens(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const direct = record.reasoningTokens;
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 0) {
    return direct;
  }
  const outputTokens = record.outputTokens;
  if (typeof outputTokens === "object" && outputTokens !== null) {
    const reasoning = (outputTokens as Record<string, unknown>).reasoning;
    if (typeof reasoning === "number" && Number.isSafeInteger(reasoning) && reasoning >= 0) {
      return reasoning;
    }
  }
  return undefined;
}

function extractReasoningMode(step: unknown): string | undefined {
  if (typeof step !== "object" || step === null) {
    return undefined;
  }
  const record = step as Record<string, unknown>;
  const usage = record.usage;
  if (typeof usage === "object" && usage !== null) {
    const reasoningTokens = extractReasoningTokens(usage);
    if (reasoningTokens !== undefined && reasoningTokens > 0) {
      return "on";
    }
  }
  return undefined;
}

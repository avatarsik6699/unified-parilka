import { generateText } from "ai";
import {
  ModelContentFilterError,
  type ResolvedModelCandidate,
} from "../providers/model-router.js";
import type {
  ModelExecutionResult,
  ModelRole,
} from "../providers/model-router.js";
import type {
  HumanPersonaTriggerDecisionRequest,
  HumanPersonaTriggerDecisionResult,
  HumanPersonaTriggerPort,
} from "./types.js";

// Reasoning-mode providers (e.g. deepseek with thinkingMode: "enabled")
// spend part of this budget on hidden reasoning tokens before any visible
// text -- a tight budget intermittently truncates before finishReason
// "stop", which this port treats as a fallback-eligible failure (see the
// same fix in src/news-brief/summarize.ts).
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 30_000;

export interface HumanPersonaTriggerModelRouter {
  executeWithFallback<T>(
    role: ModelRole,
    attempt: (
      candidate: ResolvedModelCandidate,
      attemptNumber: number,
    ) => Promise<T>,
  ): Promise<ModelExecutionResult<T>>;
}

interface ModelTextOutput {
  text: string;
  finishReason: string;
}

type ModelGenerate = (params: {
  candidate: ResolvedModelCandidate;
  instructions: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}) => Promise<ModelTextOutput>;

export interface AiSdkTriggerDecisionPortOptions {
  maxOutputTokens?: number;
  totalTimeoutMs?: number;
  candidateTimeoutMs?: number;
  generate?: ModelGenerate;
}

/**
 * Production trigger-decision adapter (plan Фаза 4e/5 Шаг 4). Uses the
 * "turn" model role, not "summary": the output is an actual chat message a
 * person will read, the same kind of artifact the assistant role's live
 * replies are (`src/bot/ai-agent.ts`), not an internal analytical summary.
 */
export class AiSdkTriggerDecisionPort implements HumanPersonaTriggerPort {
  readonly #router: HumanPersonaTriggerModelRouter;
  readonly #maxOutputTokens: number;
  readonly #totalTimeoutMs: number;
  readonly #candidateTimeoutMs: number;
  readonly #generate: ModelGenerate;

  constructor(
    router: HumanPersonaTriggerModelRouter,
    options: AiSdkTriggerDecisionPortOptions = {},
  ) {
    this.#router = router;
    this.#maxOutputTokens = boundedInteger(
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      32,
      8_192,
      "maxOutputTokens",
    );
    this.#totalTimeoutMs = boundedInteger(
      options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      1_000,
      10 * 60_000,
      "totalTimeoutMs",
    );
    this.#candidateTimeoutMs = boundedInteger(
      options.candidateTimeoutMs ??
        Math.min(DEFAULT_CANDIDATE_TIMEOUT_MS, this.#totalTimeoutMs),
      500,
      this.#totalTimeoutMs,
      "candidateTimeoutMs",
    );
    this.#generate = options.generate ?? generateWithAiSdk;
  }

  async decide(
    request: HumanPersonaTriggerDecisionRequest,
  ): Promise<HumanPersonaTriggerDecisionResult> {
    throwIfAborted(request.signal);
    const totalSignal = AbortSignal.timeout(this.#totalTimeoutMs);
    const signal = AbortSignal.any([request.signal, totalSignal]);
    const prompt = decisionPrompt(request);

    const routed = await this.#router.executeWithFallback(
      "turn",
      async (candidate) => {
        throwIfAborted(signal);
        const candidateController = new AbortController();
        const timer = setTimeout(
          () => candidateController.abort(),
          this.#candidateTimeoutMs,
        );
        timer.unref?.();
        try {
          const output = await this.#generate({
            candidate,
            instructions: request.systemPrompt,
            prompt,
            maxOutputTokens: this.#maxOutputTokens,
            signal: AbortSignal.any([signal, candidateController.signal]),
          });
          if (output.finishReason === "content-filter") {
            throw new ModelContentFilterError(
              "Provider blocked the trigger-decision response.",
            );
          }
          if (output.finishReason !== "stop") {
            throw fallbackEligibleOutputError("incomplete_trigger_decision");
          }
          return parseDecision(output.text, request.maxOutputChars);
        } catch (error) {
          if (request.signal.aborted || totalSignal.aborted) {
            throw abortError("Trigger decision was aborted.");
          }
          if (candidateController.signal.aborted) {
            throw Object.assign(
              new Error("Trigger decision model candidate timed out.", {
                cause: error,
              }),
              { code: "ETIMEDOUT" },
            );
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
    );

    return {
      ...routed.value,
      model: routed.candidate.reference,
      providerId: routed.candidate.providerId,
    };
  }
}

async function generateWithAiSdk(params: {
  candidate: ResolvedModelCandidate;
  instructions: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}): Promise<ModelTextOutput> {
  const result = await generateText({
    model: params.candidate.model,
    providerOptions: params.candidate.providerOptions,
    instructions: params.instructions,
    prompt: params.prompt,
    maxRetries: 0,
    maxOutputTokens: params.maxOutputTokens,
    abortSignal: params.signal,
    include: {
      requestBody: false,
      requestMessages: false,
      responseBody: false,
    },
  });
  return { text: result.text, finishReason: result.finishReason };
}

function decisionPrompt(request: HumanPersonaTriggerDecisionRequest): string {
  return [
    "<untrusted_recent_chat_ndjson>",
    request.recentMessagesText,
    "</untrusted_recent_chat_ndjson>",
    "Реши, стоит ли тебе сейчас что-то написать в этот чат по собственной инициативе,",
    "а не в ответ на прямое обращение — только если это уместно по духу переписки.",
    'Верни только JSON без пояснений: {"send": true, "text": "..."} если пишешь,',
    'или {"send": false} если сейчас не время. Текст — это то, что ты реально отправишь,',
    "в твоей обычной манере, без форматирования.",
  ].join("\n");
}

function parseDecision(
  text: string,
  maxOutputChars: number,
): { shouldSend: boolean; text?: string } {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) {
    return { shouldSend: false };
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null) {
      return { shouldSend: false };
    }
    const candidate = parsed as { send?: unknown; text?: unknown };
    if (candidate.send !== true || typeof candidate.text !== "string") {
      return { shouldSend: false };
    }
    const trimmed = candidate.text.trim();
    if (trimmed.length === 0 || trimmed.length > maxOutputChars) {
      return { shouldSend: false };
    }
    return { shouldSend: true, text: trimmed };
  } catch {
    return { shouldSend: false };
  }
}

function fallbackEligibleOutputError(code: string): Error {
  return Object.assign(
    new Error("Trigger-decision model output is incomplete."),
    { name: "BotAgentProtocolError", code, modelFallback: true },
  );
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError("Trigger decision was aborted.");
  }
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

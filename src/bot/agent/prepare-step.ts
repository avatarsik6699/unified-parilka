import type { PrepareStepFunction, ToolSet } from "ai";
import type { ResolvedModelCandidate } from "../../providers/model-router.js";
import { userMessage } from "./context.js";
import {
  compactModelContextIfNeeded,
  MODEL_CONTEXT_FINALIZATION_TOKENS,
} from "./model-context.js";
import { safeErrorCode, throwIfTurnAborted } from "./runtime-helpers.js";
import { appendFreshWebImages, type TurnImageTracker } from "./web-images.js";

/** Carries across every model step within one attempt (one candidate). */
export interface PrepareStepImageState {
  injectedImageCount: number;
}

/** Carries across every model step within one attempt (one candidate). */
export interface PrepareStepFinalizationState {
  requested: boolean;
}

/** Carries across every attempt (every candidate) of the whole turn. */
export interface PrepareStepCompactionState {
  count: number;
}

/**
 * Builds the `prepareStep` callback for one `generateText` call (one
 * candidate attempt). Must be called fresh per attempt -- its internal
 * `foldCursor` resets each call, matching the original inline closure's
 * per-attempt scope, while `imageState`/`finalizationState` are owned by
 * the caller so they persist correctly across the model steps within that
 * one attempt (and `compactionState` across attempts of the whole turn).
 */
export function createPrepareStepHandler(deps: {
  requestSignal: AbortSignal;
  turnSignal: AbortSignal;
  rememberFold: (boundary: "model" | "tool") => void;
  folds: readonly string[];
  imageTracker: TurnImageTracker;
  nonce: string;
  candidate: ResolvedModelCandidate;
  attemptNumber: number;
  activeInstructions: string;
  maxOutputTokens: number;
  traceContext: { turnId: number; updateId: number };
  imageState: PrepareStepImageState;
  finalizationState: PrepareStepFinalizationState;
  compactionState: PrepareStepCompactionState;
  log: (
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
}): PrepareStepFunction<ToolSet> {
  let foldCursor = deps.folds.length;

  return async ({ messages }) => {
    throwIfTurnAborted(deps.requestSignal);
    deps.rememberFold("model");
    const newFolds = deps.folds.slice(foldCursor);
    foldCursor = deps.folds.length;
    // Inject fresh web images before the next model step.
    const withFolds =
      newFolds.length === 0
        ? messages
        : [...messages, ...newFolds.map(userMessage)];
    const injected = appendFreshWebImages(
      withFolds,
      deps.imageTracker,
      deps.imageState.injectedImageCount,
      deps.candidate.capabilities.vision,
      deps.nonce,
    );
    deps.imageState.injectedImageCount = injected.injectedCount;
    const nextMessages = injected.messages;
    const compacted = await compactModelContextIfNeeded({
      model: deps.candidate.model,
      providerOptions: deps.candidate.providerOptions,
      messages: nextMessages,
      signal: deps.turnSignal,
      contextCompactions: deps.compactionState.count,
      remainingMs: Number.MAX_SAFE_INTEGER,
      toolLimitReached: false,
    });
    const compactedMessages = compacted.messages;
    const contextChars = compacted.contextChars;
    const contextTokens = compacted.contextTokens;
    deps.compactionState.count =
      compacted.compactionNumber ?? deps.compactionState.count;
    if (compacted.compactionNumber !== undefined) {
      deps.log("info", "bot.agent.context_compacted", {
        ...deps.traceContext,
        candidate: deps.candidate.reference,
        attempt: deps.attemptNumber,
        compaction: deps.compactionState.count,
        beforeChars: compacted.beforeChars,
        afterChars: contextChars,
        beforeTokens: compacted.beforeTokens,
        afterTokens: contextTokens,
      });
    }
    if (compacted.error !== undefined) {
      deps.log("warn", "bot.agent.context_compaction_failed", {
        ...deps.traceContext,
        candidate: deps.candidate.reference,
        attempt: deps.attemptNumber,
        code: safeErrorCode(compacted.error),
      });
    }
    const contextGuard = contextTokens >= MODEL_CONTEXT_FINALIZATION_TOKENS;
    const forceFinal = deps.finalizationState.requested || contextGuard;
    if (forceFinal && !deps.finalizationState.requested) {
      deps.finalizationState.requested = true;
      deps.log("warn", "bot.agent.finalization_guard", {
        ...deps.traceContext,
        candidate: deps.candidate.reference,
        attempt: deps.attemptNumber,
        reason: "context",
        estimatedContextChars: contextChars,
        estimatedContextTokens: contextTokens,
      });
    }
    const finalizationInstructions =
      `${deps.activeInstructions}\n\n` +
      "Сейчас обязательно верни полный финальный ответ по уже " +
      "собранным данным. Новые инструменты не вызывай. Если " +
      "каких-то данных не хватило, честно обозначь ограничение " +
      "в самом ответе.";
    return {
      messages: compactedMessages,
      ...(forceFinal
        ? {
            activeTools: [],
            toolChoice: "none" as const,
            instructions: finalizationInstructions,
            maxOutputTokens: deps.maxOutputTokens,
          }
        : {
            toolChoice: "auto" as const,
            maxOutputTokens: deps.maxOutputTokens,
          }),
    };
  };
}

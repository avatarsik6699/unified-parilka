import {
  AudioTranscriptionExecution,
  renderDirectAudioTranscription,
} from "./media-execution.js";
import type { BotResearchMode } from "../prompt.js";
import type { TurnUsageAccumulator } from "../telemetry.js";
import type { BotAgentFinalResult } from "../worker.js";

/**
 * Explicit local transcription never sends the private transcript to a
 * model -- this branch short-circuits the whole turn before any candidate
 * is resolved. `allowedExecutions` starts fresh here (the caller checks
 * this branch before the main model loop ever runs).
 */
export async function runDirectAudioTranscriptionBranch(options: {
  turnId: number;
  turnSignal: AbortSignal;
  audioExecution: AudioTranscriptionExecution;
  usage: TurnUsageAccumulator;
  agentStartedAtMs: number;
  traceContext: { turnId: number; updateId: number };
  startedExecutions: number;
  startedReadExecutions: number;
  completedExecutions: number;
  deniedExecutions: number;
  requestedExecutions: number;
  researchMode: BotResearchMode;
  memoryWriteAllowed: boolean;
  researchMinimumToolCalls: number;
  researchQualityRetries: number;
  log: (
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
}): Promise<BotAgentFinalResult> {
  const {
    turnId,
    turnSignal,
    audioExecution,
    usage,
    agentStartedAtMs,
    traceContext,
    startedExecutions,
    startedReadExecutions,
    completedExecutions,
    deniedExecutions,
    requestedExecutions,
    researchMode,
    memoryWriteAllowed,
    researchMinimumToolCalls,
    researchQualityRetries,
    log,
  } = options;

  const directAudioCallId = `audio:auto:${turnId}`;
  let allowedExecutions = 0;
  if (audioExecution.available) {
    allowedExecutions += 1;
  }
  const directAudio = await audioExecution.runDirect({
    callId: directAudioCallId,
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
  log("info", "bot.agent.complete", {
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
    researchMinimumToolCalls,
    researchQualityRetries,
  });
  return final;
}

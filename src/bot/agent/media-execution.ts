import type { ToolProgressPort } from "../tool-progress.js";
import type {
  AudioTranscribeToolResult,
  BotMediaToolsPort,
  DirectAudioTranscriptionResult,
} from "../media-tools.js";
import { flovRejectionDiagnostic } from "../media-tools.js";
import type { ResolvedModelCandidate } from "../../providers/model-router.js";
import {
  boundedSerialize,
  type CarriedToolResult,
} from "./evidence.js";
import { ThinkingProgressTracker } from "./thinking-progress.js";

const MODEL_AUDIO_FINAL_RESERVE_MS = 10_000;
const MIN_MODEL_AUDIO_EXECUTION_MS = 1_000;

export interface AudioTranscriptionExecutionOptions {
  readonly mediaTools?: BotMediaToolsPort;
  readonly target: ReturnType<BotMediaToolsPort["findAudio"]>;
  readonly thinkingProgress: ThinkingProgressTracker;
  readonly toolProgressPort?: ToolProgressPort;
  readonly carriedTools: CarriedToolResult[];
  readonly onStarted: () => void;
  readonly onCompleted: () => void;
  readonly getSequence: (callId: string) => number;
  /** Milliseconds left in the model turn, excluding post-turn publication. */
  readonly remainingTurnMs: () => number;
  readonly log: (
    level: "info" | "warn",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly traceContext: Readonly<Record<string, unknown>>;
}

/**
 * Per-turn local audio executor. It keeps the model-facing transcription
 * promise so retried tool calls cannot download or transcribe the same media
 * more than once; the direct path deliberately stays separate and never
 * carries a private transcript into a provider context.
 */
export class AudioTranscriptionExecution {
  readonly #options: AudioTranscriptionExecutionOptions;
  #modelTranscription:
    | Promise<AudioTranscribeToolResult>
    | undefined;

  constructor(options: AudioTranscriptionExecutionOptions) {
    this.#options = options;
  }

  get available(): boolean {
    return this.#options.mediaTools !== undefined && this.#options.target !== undefined;
  }

  get hasModelTranscription(): boolean {
    return this.#modelTranscription !== undefined;
  }

  async runForModel(input: {
    callId: string;
    signal: AbortSignal;
    candidate?: ResolvedModelCandidate;
    attempt?: number;
  }): Promise<AudioTranscribeToolResult> {
    const { mediaTools, target } = this.#options;
    if (!mediaTools || !target) {
      throw new Error("audio_transcribe is unavailable for this turn.");
    }
    if (this.#modelTranscription) {
      return this.#modelTranscription;
    }
    const startedAt = this.#start(input.callId);
    const remainingMs = this.#modelAudioExecutionMs();
    const output = remainingMs === undefined
      ? Promise.resolve(modelAudioReserveFailure())
      : mediaTools.transcribeAudio(
          target,
          AbortSignal.any([input.signal, AbortSignal.timeout(remainingMs)]),
        );
    this.#modelTranscription = output
      .then((output) => {
        this.#options.onCompleted();
        this.#options.toolProgressPort?.onToolCompleted(
          { toolName: "audio_transcribe", callId: input.callId },
          output.ok,
        );
        this.#options.carriedTools.push({
          sequence: this.#options.getSequence(input.callId),
          name: "audio_transcribe",
          serialized: boundedSerialize(output),
        });
        this.#options.log("info", "bot.agent.tool", {
          ...this.#options.traceContext,
          ...(input.candidate === undefined
            ? { candidate: "local" }
            : { candidate: input.candidate.reference }),
          ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
          tool: "audio_transcribe",
          durationMs: Math.max(0, Date.now() - startedAt),
          ok: output.ok,
          status: output.ok ? output.status : undefined,
          errorCode: output.ok ? undefined : output.error.code,
          ...(flovRejectionDiagnostic(output) ?? {}),
        });
        return output;
      });
    return this.#modelTranscription;
  }

  async runDirect(input: {
    callId: string;
    signal: AbortSignal;
  }): Promise<DirectAudioTranscriptionResult> {
    const { mediaTools, target } = this.#options;
    if (!mediaTools || !target) {
      return noEligibleAudioResult();
    }
    const startedAt = this.#start(input.callId);
    const output = await mediaTools.transcribeAudioDirect(target, input.signal);
    this.#options.onCompleted();
    this.#options.toolProgressPort?.onToolCompleted(
      { toolName: "audio_transcribe", callId: input.callId },
      output.ok,
    );
    this.#options.log("info", "bot.agent.tool", {
      ...this.#options.traceContext,
      candidate: "local:flov",
      tool: "audio_transcribe",
      durationMs: Math.max(0, Date.now() - startedAt),
      ok: output.ok,
      status: output.ok ? "done" : undefined,
      errorCode: output.ok ? undefined : output.error.code,
      ...(flovRejectionDiagnostic(output) ?? {}),
    });
    return output;
  }

  #start(callId: string): number {
    const target = this.#options.target;
    if (!target) {
      throw new Error("audio_transcribe is unavailable for this turn.");
    }
    const startedAt = Date.now();
    this.#options.onStarted();
    this.#options.thinkingProgress.finish();
    this.#options.toolProgressPort?.onToolStarted({
      toolName: "audio_transcribe",
      callId,
      input: { source: target.source },
    });
    return startedAt;
  }

  #modelAudioExecutionMs(): number | undefined {
    const remainingMs = Math.max(0, this.#options.remainingTurnMs());
    const usableMs = remainingMs - MODEL_AUDIO_FINAL_RESERVE_MS;
    return usableMs >= MIN_MODEL_AUDIO_EXECUTION_MS ? usableMs : undefined;
  }
}

/** Direct wording must not depend on a provider honouring an optional tool hint. */
export function isDirectAudioTranscriptionRequest(text: string): boolean {
  return /(?:расшифр|транскриб|транскрипц|текстом\s+(?:это|голос|аудио)|что\s+(?:там\s+)?(?:сказал|говорит|сказано))/iu.test(
    text,
  );
}

export function renderDirectAudioTranscription(
  result: DirectAudioTranscriptionResult,
): string {
  if (!result.ok) {
    switch (result.error.code) {
      case "invalid_media":
        return "⚠️ Не смог расшифровать: нужен голосовой, кружок или аудиофайл не длиннее 10 минут.";
      case "file_too_large":
        return "⚠️ Не смог расшифровать: файл превышает допустимый для Telegram размер.";
      case "no_audio":
        return "⚠️ Не удалось извлечь аудиодорожку для расшифровки.";
      case "timeout":
        return "⚠️ Локальный распознаватель не уложился в лимит времени. Попробуй прислать кусок покороче.";
      case "transcription_unavailable":
        return "⚠️ Локальный распознаватель сейчас недоступен; голосовое в облако не отправлял.";
      case "transcription_rejected":
        return "⚠️ Локальный распознаватель отклонил аудио после локальной конвертации; голосовое в облако не отправлял.";
      case "aborted":
        return "⚠️ Расшифровка была отменена до завершения.";
      default:
        return "⚠️ Не смог расшифровать это аудио локально. Попробуй прислать его ещё раз или более короткий кусок.";
    }
  }
  const transcript = result.transcript
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .trim();
  if (!transcript) {
    return "Расшифровка: речи не распознал.";
  }
  return `Расшифровка${result.durationSeconds === undefined ? "" : ` (${result.durationSeconds}с)`}:\n${transcript}`;
}

function noEligibleAudioResult(): DirectAudioTranscriptionResult {
  return {
    ok: false,
    tool: "audio_transcribe",
    error: {
      code: "invalid_media",
      retryable: false,
      message: "No eligible direct audio was attached to this request.",
    },
    evidence: [],
  };
}

function modelAudioReserveFailure(): AudioTranscribeToolResult {
  return {
    ok: false,
    tool: "audio_transcribe",
    error: {
      code: "timeout",
      retryable: true,
      message: "Not enough time remains for a local audio transcription.",
    },
    evidence: [],
  };
}

/**
 * Per-turn model usage accumulation and telemetry footer rendering.
 *
 * The accumulator lives inside the agent loop and collects usage from every
 * completed model step across all provider attempts. The footer is appended to
 * the final model text before output guards run, so it passes through the same
 * sanitization, guard, rich-render and Telegram chunking pipeline.
 */

export interface StepUsageRecord {
  readonly modelId: string;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
}

export interface TurnTelemetry {
  readonly finalModelId: string;
  readonly finalProviderId: string;
  readonly reasoningMode: string | undefined;
  readonly steps: readonly StepUsageRecord[];
  readonly totalInputTokens: number | undefined;
  readonly totalOutputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  /** True when at least one completed step did not report usage. */
  readonly incomplete: boolean;
}

export class TurnUsageAccumulator {
  readonly #steps: StepUsageRecord[] = [];
  #finalModelId = "";
  #finalProviderId = "";
  #reasoningMode: string | undefined;

  recordStep(record: {
    modelId: string;
    providerId?: string;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
    reasoningTokens?: number | undefined;
    reasoningMode?: string | undefined;
  }): void {
    this.#steps.push({
      modelId: boundedString(record.modelId, 128),
      inputTokens: safeTokenCount(record.inputTokens),
      outputTokens: safeTokenCount(record.outputTokens),
      totalTokens: safeTokenCount(record.totalTokens),
      reasoningTokens: safeTokenCount(record.reasoningTokens),
    });
    if (record.providerId) {
      this.#finalProviderId = boundedString(record.providerId, 64);
    }
    if (record.reasoningMode) {
      this.#reasoningMode = boundedString(record.reasoningMode, 32);
    }
  }

  setFinalModel(modelId: string, providerId: string): void {
    this.#finalModelId = boundedString(modelId, 128);
    this.#finalProviderId = boundedString(providerId, 64);
  }

  build(): TurnTelemetry {
    let totalInput: number | undefined;
    let totalOutput: number | undefined;
    let totalAll: number | undefined;
    let incomplete = false;

    for (const step of this.#steps) {
      if (step.inputTokens === undefined) {
        incomplete = true;
      } else {
        totalInput = (totalInput ?? 0) + step.inputTokens;
      }
      if (step.outputTokens === undefined) {
        incomplete = true;
      } else {
        totalOutput = (totalOutput ?? 0) + step.outputTokens;
      }
      if (step.totalTokens === undefined) {
        incomplete = true;
      } else {
        totalAll = (totalAll ?? 0) + step.totalTokens;
      }
    }

    return Object.freeze({
      finalModelId: this.#finalModelId || "unknown",
      finalProviderId: this.#finalProviderId || "unknown",
      reasoningMode: this.#reasoningMode,
      steps: Object.freeze([...this.#steps]),
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalAll,
      incomplete,
    });
  }
}

/**
 * Renders a compact, unobtrusive telemetry footer for the final answer.
 *
 * Format: `──\nmodel · reasoning · in/out/total tok [· incomplete]`
 *
 * Missing values are shown as `?` rather than invented. The footer is plain
 * text and must pass through the same output guards as the rest of the answer.
 */
export function buildTelemetryFooter(telemetry: TurnTelemetry): string {
  const model = telemetry.finalModelId || "unknown";
  const reasoning = telemetry.reasoningMode ?? "off";
  const input = formatTokens(telemetry.totalInputTokens);
  const output = formatTokens(telemetry.totalOutputTokens);
  const total = formatTokens(telemetry.totalTokens);
  const suffix = telemetry.incomplete ? " · reported" : "";

  return `──\n${model} · reasoning:${reasoning} · in:${input} out:${output} total:${total}${suffix}`;
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) {
    return "?";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function boundedString(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength
    ? trimmed.slice(0, maxLength)
    : trimmed;
}

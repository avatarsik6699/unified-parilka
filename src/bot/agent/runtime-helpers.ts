export function requireNonce(value: string): string {
  const nonce = value.trim().replace(/[^a-z0-9_-]/giu, "_");
  if (nonce.length < 8 || nonce.length > 64) {
    throw new Error("nonceFactory must return 8-64 safe characters");
  }
  return nonce;
}

export function throwIfTurnAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw turnAbortError();
  }
}

function turnAbortError(): Error {
  return Object.assign(new Error("Bot turn was aborted."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

export function modelStepTimeoutError(): Error {
  return Object.assign(new Error("Model step timed out."), {
    code: "ETIMEDOUT",
  });
}

export function safeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "unknown";
  }
  const candidate = error as {
    code?: unknown;
    name?: unknown;
  };
  if (
    typeof candidate.code === "string" &&
    /^[A-Za-z0-9_.:-]{1,100}$/u.test(candidate.code)
  ) {
    return candidate.code;
  }
  if (
    typeof candidate.name === "string" &&
    /^[A-Za-z0-9_.:-]{1,100}$/u.test(candidate.name)
  ) {
    return candidate.name;
  }
  return "unknown";
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

const DEFAULT_CONTEXT_CHARS = 48_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_STEP_TIMEOUT_MS = 180_000;
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
const MAX_CONTEXT_CHARS = 200_000;

export interface AgentLimitOptions {
  contextCharLimit?: number;
  maxOutputTokens?: number;
  stepTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface AgentLimits {
  contextCharLimit: number;
  maxOutputTokens: number;
  stepTimeoutMs: number;
  toolTimeoutMs: number;
}

/**
 * Resolves and bounds `AiSdkBotTurnAgent`'s configurable limits in one place,
 * kept outside the class so its constructor stays within the production-file
 * line ceiling.
 */
export function resolveAgentLimits(options: AgentLimitOptions): AgentLimits {
  const stepTimeoutMs = boundedInteger(
    options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    100,
    15 * 60_000,
    "stepTimeoutMs",
  );
  return {
    contextCharLimit: boundedInteger(
      options.contextCharLimit ?? DEFAULT_CONTEXT_CHARS,
      1_000,
      MAX_CONTEXT_CHARS,
      "contextCharLimit",
    ),
    maxOutputTokens: boundedInteger(
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      64,
      32_768,
      "maxOutputTokens",
    ),
    stepTimeoutMs,
    toolTimeoutMs: boundedInteger(
      options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      100,
      stepTimeoutMs,
      "toolTimeoutMs",
    ),
  };
}

import {
  DEFAULT_MAX_DAY_GENERATIONS_PER_RUN,
  DEFAULT_MAX_WEEK_GENERATIONS_PER_RUN,
  DigestGenerationError,
  MAX_DAY_GENERATIONS_PER_RUN,
  MAX_WEEK_GENERATIONS_PER_RUN,
  type DigestGenerationOptions,
  type DigestPhaseReport,
  type DigestReportItem,
  type DigestStore,
  type DigestSummaryKind,
  type DigestSummaryPort,
  type DigestSummaryRequest,
  type DigestSummaryResult,
} from "./types.js";

const DEFAULT_MAX_INPUT_CHARS = 160_000;
const DEFAULT_MAX_OUTPUT_CHARS = 24_000;
const DEFAULT_ITEM_TIMEOUT_MS = 150_000;

export interface DigestGenerationRuntime {
  store: DigestStore;
  chatId: string;
  apply: boolean;
  all: boolean;
  summaryPort?: DigestSummaryPort;
  now: () => Date;
  maxInputChars: number;
  maxOutputChars: number;
  itemTimeoutMs: number;
  maxDayGenerationsPerRun: number;
  maxWeekGenerationsPerRun: number;
}

export function normalizeGenerationOptions(
  options: DigestGenerationOptions,
): DigestGenerationRuntime {
  const apply = options.apply === true;
  if (apply && !options.summaryPort) {
    throw new Error("summaryPort is required in apply mode.");
  }
  return {
    store: options.store,
    chatId: requireChatId(options.chatId),
    apply,
    all: options.all === true,
    summaryPort: options.summaryPort,
    now: options.now ?? (() => new Date()),
    maxInputChars: boundedInteger(
      options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
      1_000,
      2_000_000,
      "maxInputChars",
    ),
    maxOutputChars: boundedInteger(
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      1_000,
      200_000,
      "maxOutputChars",
    ),
    itemTimeoutMs: boundedInteger(
      options.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS,
      1_000,
      15 * 60_000,
      "itemTimeoutMs",
    ),
    maxDayGenerationsPerRun: boundedInteger(
      options.maxDayGenerationsPerRun ??
        DEFAULT_MAX_DAY_GENERATIONS_PER_RUN,
      0,
      MAX_DAY_GENERATIONS_PER_RUN,
      "maxDayGenerationsPerRun",
    ),
    maxWeekGenerationsPerRun: boundedInteger(
      options.maxWeekGenerationsPerRun ??
        DEFAULT_MAX_WEEK_GENERATIONS_PER_RUN,
      0,
      MAX_WEEK_GENERATIONS_PER_RUN,
      "maxWeekGenerationsPerRun",
    ),
  };
}

export async function summarizeBounded(
  port: DigestSummaryPort,
  request: Omit<DigestSummaryRequest, "signal">,
  timeoutMs: number,
): Promise<DigestSummaryResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await abortable(port.summarize({ ...request, signal }), signal);
  } catch (error) {
    if (signal.aborted) {
      throw new DigestGenerationError(
        "summary_timeout",
        "Digest summary exceeded its item deadline.",
        error,
      );
    }
    throw error;
  }
}

export function emptyPhaseReport(): DigestPhaseReport {
  return {
    scanned: 0,
    candidates: 0,
    planned: 0,
    providerCalls: 0,
    generated: 0,
    unchanged: 0,
    invalidated: 0,
    deferred: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };
}

export function failedItem(
  kind: DigestSummaryKind,
  period: string,
  sourceCount: number,
  error: unknown,
): DigestReportItem {
  return {
    kind,
    period,
    status: "failed",
    reason: "generation_failed",
    sourceCount,
    error: safeErrorIdentity(error),
  };
}

export function isSourceChangedDuringGeneration(
  error: unknown,
): boolean {
  return (
    error instanceof DigestGenerationError &&
    error.code === "source_changed_during_generation"
  );
}

export function validNow(now: () => Date): Date {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new DigestGenerationError(
      "invalid_clock",
      "Clock returned an invalid date.",
    );
  }
  return date;
}

function safeErrorIdentity(error: unknown): {
  name: string;
  code: string;
} {
  if (error instanceof DigestGenerationError) {
    return { name: error.name, code: error.code };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown };
    return {
      name:
        typeof candidate.name === "string"
          ? candidate.name.slice(0, 80)
          : "Error",
      code:
        typeof candidate.code === "string" ||
        typeof candidate.code === "number"
          ? String(candidate.code).slice(0, 80)
          : "summary_failed",
    };
  }
  return { name: "NonError", code: "summary_failed" };
}

function requireChatId(value: string): string {
  const chatId = value.trim();
  if (chatId.length === 0 || chatId.length > 256) {
    throw new Error(
      "chatId must contain between 1 and 256 characters.",
    );
  }
  return chatId;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw abortError("Digest summary was aborted.");
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError("Digest summary was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

import {
  BOT_DURABLE_STATUSES,
  BOT_RETRY_INITIAL_MS,
  BOT_RETRY_MAX_MS,
  DEFAULT_BOT_MAX_ATTEMPTS,
  LEGACY_UNKNOWN_DELIVERY_AFTER_RESTART_ERROR,
  MAX_BOT_ATTEMPTS,
  MAX_BOT_LEASE_MS,
  MIN_BOT_LEASE_MS,
  UNKNOWN_DELIVERY_ERROR,
} from "./constants.js";
import type {
  BotDurableStatus,
  BotTransport,
  SparseTerm,
  StoredSendOutboxItem,
  UpsertDayDigestInput,
  UpsertDigestRollupInput,
} from "./types.js";

export function isUnknownDelivery(item: StoredSendOutboxItem): boolean {
  return (
    item.error === UNKNOWN_DELIVERY_ERROR ||
    item.error === LEGACY_UNKNOWN_DELIVERY_AFTER_RESTART_ERROR
  );
}

export function assertBotUpdateId(updateId: number): void {
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error("updateId must be a non-negative safe integer.");
  }
}

export function normalizeBotTransport(value: string | undefined): BotTransport {
  if (value === undefined || value === "telegram") {
    return "telegram";
  }
  if (value === "vk") {
    return "vk";
  }
  throw new Error('transport must be "telegram" or "vk".');
}

export function assertBotTurnId(turnId: number): void {
  if (!Number.isSafeInteger(turnId) || turnId <= 0) {
    throw new Error("turnId must be a positive safe integer.");
  }
}

export function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer timestamp.`);
  }
}

export function normalizeBotMaxAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_BOT_MAX_ATTEMPTS;
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > MAX_BOT_ATTEMPTS
  ) {
    throw new Error(
      `maxAttempts must be an integer between 1 and ${MAX_BOT_ATTEMPTS}.`,
    );
  }
  return attempts;
}

export function normalizeBotTriggerCooldown(
  value:
    | {
        userKey: string;
        cooldownMs: number;
      }
    | undefined,
):
  | {
      userKey: string;
      cooldownMs: number;
    }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  const userKey = value.userKey.trim();
  if (userKey.length === 0 || userKey.length > 256) {
    throw new Error(
      "triggerCooldown.userKey must contain between 1 and 256 characters.",
    );
  }
  if (
    !Number.isSafeInteger(value.cooldownMs) ||
    value.cooldownMs < 0 ||
    value.cooldownMs > 24 * 60 * 60_000
  ) {
    throw new Error(
      "triggerCooldown.cooldownMs must be an integer between 0 and 86400000.",
    );
  }
  return {
    userKey,
    cooldownMs: value.cooldownMs,
  };
}

export function botTriggerCooldownKey(userKey: string): string {
  return `__bot_trigger__:${userKey}`;
}

export function assertBotLeaseMs(leaseMs: number): void {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < MIN_BOT_LEASE_MS ||
    leaseMs > MAX_BOT_LEASE_MS
  ) {
    throw new Error(
      `leaseMs must be an integer between ${MIN_BOT_LEASE_MS} and ${MAX_BOT_LEASE_MS}.`,
    );
  }
}

export function botTurnRetryDelayMs(
  attempts: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs != null) {
    return Math.max(
      BOT_RETRY_INITIAL_MS,
      Math.min(retryAfterMs, BOT_RETRY_MAX_MS),
    );
  }
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(BOT_RETRY_INITIAL_MS * 2 ** exponent, BOT_RETRY_MAX_MS);
}

export function normalizeQueryLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("limit must be an integer between 1 and 1000.");
  }
  return limit;
}

export function validateDayDigestInput(input: UpsertDayDigestInput): void {
  assertNonEmptyBounded(input.chatId, 256, "chatId");
  assertCalendarDay(input.day, "day");
  assertPositiveSafeInteger(input.startMessageId, "startMessageId");
  assertPositiveSafeInteger(input.endMessageId, "endMessageId");
  if (input.endMessageId < input.startMessageId) {
    throw new Error(
      "endMessageId must be greater than or equal to startMessageId.",
    );
  }
  assertPositiveSafeInteger(input.messageCount, "messageCount");
  validateDigestMetadata(input);
}

export function validateDigestRollupInput(
  input: UpsertDigestRollupInput,
): void {
  assertNonEmptyBounded(input.chatId, 256, "chatId");
  if (input.kind !== "week" && input.kind !== "month") {
    throw new Error('kind must be either "week" or "month".');
  }
  assertNonEmptyBounded(input.period, 32, "period");
  assertCalendarDay(input.dayFrom, "dayFrom");
  assertCalendarDay(input.dayTo, "dayTo");
  if (input.dayTo < input.dayFrom) {
    throw new Error("dayTo must be greater than or equal to dayFrom.");
  }
  assertPositiveSafeInteger(input.dayCount, "dayCount");
  validateDigestMetadata(input);
}

export function validateDigestMetadata(
  input: Pick<
    UpsertDayDigestInput,
    | "text"
    | "promptVersion"
    | "model"
    | "inputTokens"
    | "outputTokens"
    | "sourceHash"
  >,
): void {
  assertNonEmptyBounded(input.text, 1_000_000, "text");
  assertNonEmptyBounded(input.promptVersion, 128, "promptVersion");
  if (input.model !== undefined) {
    assertNonEmptyBounded(input.model, 256, "model");
  }
  if (input.sourceHash !== undefined) {
    assertNonEmptyBounded(input.sourceHash, 256, "sourceHash");
  }
  for (const [name, value] of [
    ["inputTokens", input.inputTokens],
    ["outputTokens", input.outputTokens],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative safe integer.`);
    }
  }
}

const CANONICAL_UTC_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function assertIsoDateTime(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    !CANONICAL_UTC_ISO_RE.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(
      `${name} must be a canonical UTC ISO-8601 date-time string (YYYY-MM-DDTHH:mm:ss.sssZ, no offsets).`,
    );
  }
}

/**
 * Accept the same canonical UTC ISO-8601 forms as assertIsoDateTime, but
 * normalize a trailing `Z` without milliseconds to the fixed `.sssZ` lexical
 * form. This keeps SQLite string comparisons deterministic.
 */
export function normalizeIsoDateTime(value: string, name: string): string {
  assertIsoDateTime(value, name);
  return new Date(value).toISOString();
}

export function assertCalendarDay(value: string, name: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${name} must be a real Gregorian calendar day.`);
  }
}

export function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

export function assertNonEmptyBounded(
  value: string,
  maximumLength: number,
  name: string,
): void {
  if (value.trim().length === 0 || value.length > maximumLength) {
    throw new Error(
      `${name} must contain between 1 and ${maximumLength} characters.`,
    );
  }
}

export function boundedDigestQueryLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 400) {
    throw new Error("digest limit must be an integer between 1 and 400.");
  }
  return limit;
}

export function normalizeBotStatuses(
  statuses: BotDurableStatus[] | undefined,
): BotDurableStatus[] {
  if (statuses == null) {
    return [];
  }
  const allowed = new Set<string>(BOT_DURABLE_STATUSES);
  const unique = [...new Set(statuses)];
  for (const status of unique) {
    if (!allowed.has(status)) {
      throw new Error(`Unsupported bot durable status: ${String(status)}.`);
    }
  }
  return unique;
}

/** Hard bound on stored learned sparse postings per parent chunk. */
export const MAX_SPARSE_TERMS_PER_CHUNK = 1_024;
/** Hard bound on query terms used for one sparse posting lookup. */
export const MAX_SPARSE_QUERY_TERMS = 256;
/** BGE-M3 vocabulary is ~250k ids; leave bounded headroom, never unbounded. */
export const MAX_SPARSE_TOKEN_ID = 300_000;
/** Learned weights are small positive floats; anything larger is malformed. */
export const MAX_SPARSE_WEIGHT = 1_000;

/**
 * Validates and deterministically normalizes learned sparse terms.
 *
 * Duplicate token ids collapse to the maximum weight; the result keeps the
 * top `maxTerms` entries by (weight desc, tokenId asc) and is ordered by
 * tokenId ascending, so storage rows and SQL parameters are stable.
 */
export function normalizeSparseTerms(
  terms: readonly SparseTerm[],
  maxTerms: number,
): SparseTerm[] {
  if (!Number.isSafeInteger(maxTerms) || maxTerms < 1) {
    throw new Error("maxTerms must be a positive safe integer.");
  }
  const byTokenId = new Map<number, number>();
  for (const [index, term] of terms.entries()) {
    if (
      typeof term?.tokenId !== "number" ||
      !Number.isSafeInteger(term.tokenId) ||
      term.tokenId < 0 ||
      term.tokenId > MAX_SPARSE_TOKEN_ID
    ) {
      throw new Error(
        `Sparse term ${index} tokenId must be a safe integer between 0 and ${MAX_SPARSE_TOKEN_ID}.`,
      );
    }
    if (
      typeof term.weight !== "number" ||
      !Number.isFinite(term.weight) ||
      term.weight <= 0 ||
      term.weight > MAX_SPARSE_WEIGHT
    ) {
      throw new Error(
        `Sparse term ${index} weight must be finite and in (0, ${MAX_SPARSE_WEIGHT}].`,
      );
    }
    const existing = byTokenId.get(term.tokenId);
    if (existing === undefined || term.weight > existing) {
      byTokenId.set(term.tokenId, term.weight);
    }
  }
  return [...byTokenId.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, maxTerms)
    .sort((left, right) => left[0] - right[0])
    .map(([tokenId, weight]) => ({ tokenId, weight }));
}

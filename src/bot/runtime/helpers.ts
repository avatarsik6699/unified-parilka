import type { StoredMessage } from "../../store.js";

export function assertBotIdentity(
  value: unknown,
  expectedId: string,
  expectedUsername: string,
): void {
  const identity = asRecord(value);
  const id = telegramId(identity?.id);
  const username =
    typeof identity?.username === "string"
      ? identity.username
      : undefined;
  if (
    !identity ||
    identity.is_bot !== true ||
    id !== expectedId ||
    username?.toLowerCase() !== expectedUsername.toLowerCase()
  ) {
    throw new BotRuntimeProtocolError("BOT_IDENTITY_MISMATCH");
  }
}

export function updateBatch(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new BotRuntimeProtocolError("POLL_RESPONSE_MALFORMED");
  }
  return value;
}

export function updateIdentifier(value: unknown): number | undefined {
  return nonNegativeSafeInteger(asRecord(value)?.update_id);
}

export function durableMessageId(message: StoredMessage): string {
  return `${message.chatId}:${message.messageId}`;
}

export function stringifyUpdate(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function isFatalPollingError(error: unknown): boolean {
  const code = telegramErrorCode(error);
  return code === 401 || code === 409;
}

export function telegramErrorCode(error: unknown): number | undefined {
  const record = asRecord(error);
  const direct = positiveSafeInteger(record?.error_code);
  if (direct !== undefined) {
    return direct;
  }
  return positiveSafeInteger(asRecord(record?.error)?.error_code);
}

export function telegramRetryAfterMs(error: unknown): number | undefined {
  const record = asRecord(error);
  const seconds =
    positiveSafeInteger(asRecord(record?.parameters)?.retry_after) ??
    positiveSafeInteger(
      asRecord(asRecord(record?.error)?.parameters)?.retry_after,
    );
  return seconds === undefined
    ? undefined
    : Math.min(seconds * 1_000, 5 * 60_000);
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof BotRuntimeProtocolError) {
    return safeMachineCode(error.message);
  }
  const record = asRecord(error);
  const code =
    typeof record?.code === "string"
      ? record.code
      : typeof record?.name === "string"
        ? record.name
        : "UNKNOWN_ERROR";
  return safeMachineCode(code);
}

export function safeMachineCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_.:-]+/gu, "_")
    .slice(0, 96);
  return normalized || "UNKNOWN";
}

export function positiveTelegramId(value: string, name: string): string {
  if (!/^\d+$/u.test(value)) {
    throw new TypeError(`${name} must be a positive Telegram integer id.`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${name} must be a positive Telegram integer id.`);
  }
  return parsed.toString();
}

export function normalizeExpectedUsername(value: string): string {
  const username = value.trim().replace(/^@/u, "");
  if (!/^[A-Za-z0-9_]{5,32}$/u.test(username)) {
    throw new TypeError(
      "expectedBotUsername must be a valid Telegram username.",
    );
  }
  return username;
}

export function telegramId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  if (typeof value !== "string" || !/^-?\d+$/u.test(value)) {
    return undefined;
  }
  try {
    return BigInt(value).toString();
  } catch {
    return undefined;
  }
}

export function botApiDate(value: unknown): string | undefined {
  const seconds = nonNegativeSafeInteger(value);
  if (seconds === undefined) {
    return undefined;
  }
  try {
    return new Date(seconds * 1_000).toISOString();
  } catch {
    return undefined;
  }
}

export function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

export function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function boundedInteger(
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
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function compact(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
}

export async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true },
    );
  });
}

export class BotRuntimeProtocolError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "BotRuntimeProtocolError";
  }
}

export class BotRuntimeStopError extends Error {
  constructor() {
    super("BOT_RUNTIME_STOP");
    this.name = "BotRuntimeStopError";
  }
}

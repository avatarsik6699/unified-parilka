import type { StoredMessage } from "../../store.js";
import type { BotAgentFinalResult } from "./contracts.js";

export class WorkerAbortError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "WorkerAbortError";
  }
}

export class WorkerProtocolError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "WorkerProtocolError";
  }
}

export function isAgentFinal(value: unknown): value is BotAgentFinalResult {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "final" ||
    typeof candidate.text !== "string"
  ) {
    return false;
  }
  return true;
}

export function durableMessageId(message: StoredMessage): string {
  return `${message.chatId}:${message.messageId}`;
}

export function safeErrorCode(error: unknown): string {
  if (error != null && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown };
    if (
      typeof candidate.name === "string" &&
      /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(candidate.name)
    ) {
      return candidate.name;
    }
    if (
      typeof candidate.code === "string" &&
      /^[A-Z0-9_]{1,64}$/u.test(candidate.code)
    ) {
      return candidate.code;
    }
  }
  return "unknown_error";
}

export function safeMachineCode(value: string, fallback: string): string {
  return /^[A-Z0-9_]{1,64}$/u.test(value) ? value : fallback;
}

export function publisherFailureKind(value: unknown): string {
  return value === "network" ||
    value === "timeout" ||
    value === "telegram_rejected"
    ? value
    : "unknown";
}

export function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`${name} must not be empty`);
  }
  return trimmed;
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
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

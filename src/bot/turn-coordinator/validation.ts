import type {
  CapacityPolicy,
  TurnCoordinatorOptions,
  TurnTraceEvent,
} from "./contracts.js";

const DEFAULT_MAX_FOLD_MESSAGES = 20;
const DEFAULT_MAX_FOLD_CHARS = 4_000;
const DEFAULT_MAX_SEEN_MESSAGE_IDS = 50_000;

export interface ValidatedCoordinatorOptions {
  maxActiveTurns: number;
  capacityPolicy: CapacityPolicy;
  maxFoldMessages: number;
  maxFoldChars: number;
  maxSeenMessageIds: number;
  onTrace: ((event: TurnTraceEvent) => void) | undefined;
}

export function validateCoordinatorOptions(
  options: TurnCoordinatorOptions,
): ValidatedCoordinatorOptions {
  return {
    maxActiveTurns: positiveInteger(
      options.maxActiveTurns,
      "maxActiveTurns",
    ),
    capacityPolicy: options.capacityPolicy ?? "refuse",
    maxFoldMessages: boundedPositiveInteger(
      options.maxFoldMessages ?? DEFAULT_MAX_FOLD_MESSAGES,
      DEFAULT_MAX_FOLD_MESSAGES,
      "maxFoldMessages",
    ),
    maxFoldChars: boundedPositiveInteger(
      options.maxFoldChars ?? DEFAULT_MAX_FOLD_CHARS,
      DEFAULT_MAX_FOLD_CHARS,
      "maxFoldChars",
    ),
    maxSeenMessageIds: positiveInteger(
      options.maxSeenMessageIds ?? DEFAULT_MAX_SEEN_MESSAGE_IDS,
      "maxSeenMessageIds",
    ),
    onTrace: options.onTrace,
  };
}

export function requireNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedPositiveInteger(
  value: number,
  maximum: number,
  name: string,
): number {
  const checked = positiveInteger(value, name);
  if (checked > maximum) {
    throw new RangeError(`${name} must be at most ${maximum}`);
  }
  return checked;
}

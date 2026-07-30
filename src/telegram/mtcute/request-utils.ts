import { MtcuteTransportError } from "./errors.js";

export function validateRequestInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MtcuteTransportError(
      "invalid_request",
      "validation",
      false,
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

export function validateOptionalRequestInteger(
  name: string,
  value: number | undefined,
  minimum: number,
): void {
  if (value != null) {
    validateRequestInteger(name, value, minimum, Number.MAX_SAFE_INTEGER);
  }
}

export function setIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

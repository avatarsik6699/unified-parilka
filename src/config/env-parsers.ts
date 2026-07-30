import {
  BOOLEAN_ENV_RULES,
  NUMERIC_ENV_RULES,
  type NumericEnvRule,
} from "./env-rules.js";
import type { TelegramTransport } from "./types.js";

type NumericEnvName = keyof typeof NUMERIC_ENV_RULES;
type BooleanEnvName = keyof typeof BOOLEAN_ENV_RULES;

const TRUE_BOOL_VALUES = new Set([
  "1",
  "true",
  "yes",
  "on",
]);
const FALSE_BOOL_VALUES = new Set([
  "0",
  "false",
  "no",
  "off",
]);

export function intFromEnv(name: NumericEnvName): number {
  const rule = NUMERIC_ENV_RULES[name];
  validateInteger(name, rule.fallback, rule);
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return rule.fallback;
  }
  return parseInteger(name, raw.trim(), rule);
}

export function boolFromEnv(
  name: BooleanEnvName,
): boolean {
  const rule = BOOLEAN_ENV_RULES[name];
  const raw = process.env[name];
  if (raw == null) {
    return rule.fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") {
    throw new Error(
      `${name} must be a boolean: one of 1,true,yes,on or 0,false,no,off; empty values are invalid, unset the variable to use the default ${String(rule.fallback)}.`,
    );
  }
  if (TRUE_BOOL_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_BOOL_VALUES.has(normalized)) {
    return false;
  }
  throw new Error(
    `${name} must be a boolean: one of 1,true,yes,on or 0,false,no,off; got ${JSON.stringify(raw)}.`,
  );
}

export function csvFromEnv(
  raw: string | undefined,
): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function telegramTransportFromEnv(): TelegramTransport {
  const raw = process.env.TELEGRAM_TRANSPORT;
  if (raw == null) {
    return "mtcute";
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "mtcute" ||
    normalized === "gramjs"
  ) {
    return normalized;
  }
  throw new Error(
    `TELEGRAM_TRANSPORT must be one of mtcute or gramjs; got ${JSON.stringify(raw)}.`,
  );
}

function parseInteger(
  name: string,
  raw: string,
  rule: NumericEnvRule,
): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(
      `${name} must be an integer between ${rule.min} and ${rule.max}; got ${JSON.stringify(raw)}.`,
    );
  }
  const parsed = Number(raw);
  validateInteger(name, parsed, rule);
  return parsed;
}

function validateInteger(
  name: string,
  value: number,
  rule: NumericEnvRule,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < rule.min ||
    value > rule.max
  ) {
    throw new Error(
      `${name} must be an integer between ${rule.min} and ${rule.max}; got ${value}.`,
    );
  }
}

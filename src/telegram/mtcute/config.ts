import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { MtcuteTransportConfig } from "./contracts.js";
import { invalidMtcuteConfig } from "./errors.js";

const INT32_MAX = 2_147_483_647;
const TELEGRAM_HISTORY_PAGE_MAX = 100;

export function validateMtcuteTransportConfig(
  config: Readonly<MtcuteTransportConfig>,
): Readonly<MtcuteTransportConfig> {
  validateInteger("apiId", config.apiId, 0, INT32_MAX);
  if (typeof config.apiHash !== "string") {
    throw invalidMtcuteConfig("apiHash must be a string.");
  }
  if (
    typeof config.authStoragePath !== "string" ||
    config.authStoragePath.trim() === ""
  ) {
    throw invalidMtcuteConfig("authStoragePath must be a non-empty path.");
  }
  if (
    typeof config.applicationDbPath !== "string" ||
    config.applicationDbPath.trim() === ""
  ) {
    throw invalidMtcuteConfig("applicationDbPath must be a non-empty path.");
  }

  const authStoragePath = resolve(config.authStoragePath);
  const applicationDbPath = resolve(config.applicationDbPath);
  if (
    authStoragePath === applicationDbPath ||
    existingPathsReferToSameFile(authStoragePath, applicationDbPath)
  ) {
    throw invalidMtcuteConfig(
      "mtcute auth storage must be separate from the application database.",
    );
  }
  if (
    typeof config.defaultChatId !== "string" ||
    config.defaultChatId.trim() === ""
  ) {
    throw invalidMtcuteConfig(
      "defaultChatId must be a non-empty chat reference.",
    );
  }
  if (
    !Array.isArray(config.allowedChatIds) ||
    config.allowedChatIds.some(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    )
  ) {
    throw invalidMtcuteConfig(
      "allowedChatIds must contain only non-empty chat references.",
    );
  }
  if (
    typeof config.requireAllowlistedChat !== "boolean" ||
    (config.requireAllowlistedChat && config.allowedChatIds.length === 0)
  ) {
    throw invalidMtcuteConfig(
      "An enabled chat allowlist must contain at least one chat reference.",
    );
  }

  validateInteger(
    "historyPageSize",
    config.historyPageSize,
    1,
    TELEGRAM_HISTORY_PAGE_MAX,
  );
  validateInteger(
    "maxHistoryMessages",
    config.maxHistoryMessages,
    1,
    1_000_000,
  );
  validateInteger(
    "connectionMaxAttempts",
    config.connectionMaxAttempts,
    1,
    100,
  );
  validateInteger(
    "connectionTimeoutMs",
    config.connectionTimeoutMs,
    100,
    10 * 60_000,
  );
  validateInteger(
    "connectionRetryInitialMs",
    config.connectionRetryInitialMs,
    0,
    60_000,
  );
  validateInteger(
    "connectionRetryMaxMs",
    config.connectionRetryMaxMs,
    0,
    300_000,
  );
  if (config.connectionRetryMaxMs < config.connectionRetryInitialMs) {
    throw invalidMtcuteConfig(
      "connectionRetryMaxMs must be greater than or equal to connectionRetryInitialMs.",
    );
  }
  validateInteger(
    "requestTimeoutMs",
    config.requestTimeoutMs,
    100,
    24 * 60 * 60_000,
  );
  validateInteger("requestMaxRetries", config.requestMaxRetries, 0, 20);
  validateInteger(
    "requestRetryDelayMs",
    config.requestRetryDelayMs,
    0,
    60_000,
  );
  validateInteger(
    "floodWaitMaxMs",
    config.floodWaitMaxMs,
    0,
    24 * 60 * 60_000,
  );

  return Object.freeze({
    ...config,
    apiHash: config.apiHash,
    authStoragePath,
    applicationDbPath,
    defaultChatId: config.defaultChatId.trim(),
    allowedChatIds: Object.freeze(
      config.allowedChatIds.map((entry) => entry.trim()),
    ),
  });
}

export function normalizeMtcuteChatRef(chat: string): string {
  const trimmed = chat.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isSafeInteger(numeric) ? String(numeric) : trimmed;
  }
  return trimmed.startsWith("@") ? trimmed.toLowerCase() : trimmed;
}

function validateInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidMtcuteConfig(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function existingPathsReferToSameFile(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

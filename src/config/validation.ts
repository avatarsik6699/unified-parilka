import { isIP } from "node:net";
import { resolve } from "node:path";
import type { AppConfig } from "./types.js";
import {
  LOCAL_BGE_M3_DIMENSIONS,
  LOCAL_BGE_M3_MAX_TEXT_CHARS,
  LOCAL_BGE_M3_MODEL,
} from "./types.js";

export function validateRequiredApiCredentials(
  apiId: number,
  apiHash: string,
  required: boolean | undefined,
): void {
  if (!required) {
    return;
  }
  if (apiId <= 0) {
    throw new Error(
      "TELEGRAM_API_ID must be a positive integer for session generation.",
    );
  }
  if (!apiHash) {
    throw new Error(
      "TELEGRAM_API_HASH is required for session generation.",
    );
  }
}

export function validateChatReferences(
  defaultChatId: string,
  allowedChatIds: string[],
  requireChatConfig: boolean,
): void {
  if (requireChatConfig && !defaultChatId) {
    throw new Error("TELEGRAM_DEFAULT_CHAT_ID is required.");
  }
  if (
    requireChatConfig &&
    allowedChatIds.length === 0
  ) {
    throw new Error(
      "TELEGRAM_ALLOWED_CHAT_IDS must contain at least one explicit chat.",
    );
  }
  if (
    defaultChatId.length > 256 ||
    allowedChatIds.length > 100 ||
    allowedChatIds.some(
      (chatId) =>
        chatId.length === 0 || chatId.length > 256,
    )
  ) {
    throw new Error(
      "Telegram chat references must contain 1-256 characters and the allowlist may contain at most 100 chats.",
    );
  }
}

export function validateDefaultChatAllowlisted(
  defaultChatId: string,
  allowedChatIds: string[],
  requireChatConfig: boolean,
  requireAllowlistedChat: boolean,
): void {
  if (
    requireChatConfig &&
    requireAllowlistedChat &&
    !allowedChatIds.some(
      (chatId) =>
        normalizeConfiguredChatRef(chatId) ===
        normalizeConfiguredChatRef(defaultChatId),
    )
  ) {
    throw new Error(
      "TELEGRAM_DEFAULT_CHAT_ID must be present in TELEGRAM_ALLOWED_CHAT_IDS.",
    );
  }
}

export function validateConfig(config: AppConfig): void {
  if (
    config.sync.transientBackoffMaxMs <
    config.sync.transientBackoffInitialMs
  ) {
    throw new Error(
      "TELEGRAM_SYNC_BACKOFF_MAX_MS must be greater than or equal to TELEGRAM_SYNC_BACKOFF_INITIAL_MS.",
    );
  }
  if (
    config.telegram.mtcute.connectionRetryMaxMs <
    config.telegram.mtcute.connectionRetryInitialMs
  ) {
    throw new Error(
      "TELEGRAM_MTCUTE_CONNECTION_RETRY_MAX_MS must be greater than or equal to TELEGRAM_MTCUTE_CONNECTION_RETRY_INITIAL_MS.",
    );
  }
  if (
    config.embeddings.retryMaxMs <
    config.embeddings.retryInitialMs
  ) {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_RETRY_MAX_MS must be greater than or equal to TELEGRAM_EMBEDDINGS_RETRY_INITIAL_MS.",
    );
  }
  if (
    resolve(config.telegram.mtcute.authStoragePath) ===
    resolve(config.storage.dbPath)
  ) {
    throw new Error(
      "TELEGRAM_MTCUTE_AUTH_DB_PATH must be separate from TELEGRAM_DB_PATH.",
    );
  }
  validateEmbeddingBackend(config.embeddings);
}

function validateEmbeddingBackend(
  embeddings: AppConfig["embeddings"],
): void {
  if (embeddings.backend === "local_bge_m3") {
    validateLocalBgeM3Endpoint(embeddings.localEndpoint);
    // The local backend is pinned to the fixed BGE-M3 identity so an
    // incompatible dense/sparse index can never be mixed silently.
    if (embeddings.model !== LOCAL_BGE_M3_MODEL) {
      throw new Error(
        `TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3 requires model ${LOCAL_BGE_M3_MODEL}.`,
      );
    }
    if (embeddings.dimensions !== LOCAL_BGE_M3_DIMENSIONS) {
      throw new Error(
        `TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3 requires dimensions ${LOCAL_BGE_M3_DIMENSIONS}.`,
      );
    }
    if (embeddings.chunkMaxChars > LOCAL_BGE_M3_MAX_TEXT_CHARS) {
      throw new Error(
        `TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS must not exceed ${LOCAL_BGE_M3_MAX_TEXT_CHARS} for the local BGE-M3 backend.`,
      );
    }
    return;
  }
  validateEmbeddingBaseUrl(embeddings.baseUrl);
}

function validateLocalBgeM3Endpoint(raw: string): void {
  if (raw.trim() === "") {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT is required when TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT must be an absolute loopback URL.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT cannot contain credentials, query parameters, or a fragment.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT must use HTTP or HTTPS on a loopback host.",
    );
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT must bind a loopback host; the local BGE-M3 service is never remote.",
    );
  }
  // The endpoint is documented as a bare origin. A base path would make the
  // client silently request /base/encode and fail with opaque 404s.
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT must be a root origin without a path.",
    );
  }
}

function normalizeConfiguredChatRef(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@")
    ? trimmed.toLowerCase()
    : trimmed;
}

function validateEmbeddingBaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_BASE_URL must be an absolute URL.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "TELEGRAM_EMBEDDINGS_BASE_URL cannot contain credentials, query parameters, or a fragment.",
    );
  }
  if (url.protocol === "https:") {
    return;
  }
  if (
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname)
  ) {
    return;
  }
  throw new Error(
    "TELEGRAM_EMBEDDINGS_BASE_URL must use HTTPS; HTTP is allowed only for a loopback host.",
  );
}

function isLoopbackHostname(rawHostname: string): boolean {
  const hostname =
    rawHostname.startsWith("[") &&
    rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost")
  ) {
    return true;
  }
  const version = isIP(normalized);
  if (version === 4) {
    return normalized.split(".")[0] === "127";
  }
  return (
    version === 6 &&
    (normalized === "::1" ||
      normalized === "0:0:0:0:0:0:0:1")
  );
}

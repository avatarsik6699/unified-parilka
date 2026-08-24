import { requireHttpsBaseUrl } from "./url-validation.js";
import { composeAbortSignals } from "./loopback-json.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4_000_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES_BOUND = 32_000_000;

export interface ExternalJsonRequest {
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ExternalJsonResponse {
  status: number;
  text: string;
}

export interface ExternalJsonClientOptions {
  origin: string;
  bearerToken: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export class ExternalJsonTimeoutError extends Error {
  readonly code = "timeout";
}

export class ExternalJsonTransportError extends Error {
  readonly code = "provider_unavailable";
}

export class ExternalJsonResponseTooLargeError extends Error {
  readonly code = "provider_error";
}

/**
 * Bounded JSON transport for a trusted, operator-configured external HTTPS
 * API (paid, credentialed) -- unlike LoopbackJsonClient, the origin is a
 * real internet host, not a loopback-only service, and every request
 * carries a bearer token. Same one-deadline-covers-headers-and-body,
 * bounded-read, composed-abort discipline as the loopback transport; the
 * bearer token is never included in any thrown error message.
 */
export class ExternalJsonClient {
  readonly #origin: string;
  readonly #bearerToken: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetchImpl: typeof fetch;

  constructor(options: ExternalJsonClientOptions) {
    this.#origin = requireHttpsBaseUrl(options.origin);
    this.#bearerToken = options.bearerToken;
    this.#timeoutMs = boundedPositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
      MAX_TIMEOUT_MS,
    );
    this.#maxResponseBytes = boundedPositiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      MAX_RESPONSE_BYTES_BOUND,
    );
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(request: ExternalJsonRequest): Promise<ExternalJsonResponse> {
    const timeoutMs = boundedPositiveInteger(
      request.timeoutMs ?? this.#timeoutMs,
      "timeoutMs",
      MAX_TIMEOUT_MS,
    );
    const maxBytes = boundedPositiveInteger(
      request.maxResponseBytes ?? this.#maxResponseBytes,
      "maxResponseBytes",
      MAX_RESPONSE_BYTES_BOUND,
    );
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const composed = composeAbortSignals([request.signal, deadline.signal]);
    try {
      let response: Response;
      try {
        response = await this.#fetchImpl(`${this.#origin}${request.path}`, {
          method: request.method ?? "GET",
          ...(request.body === undefined ? {} : { body: request.body }),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#bearerToken}`,
            ...(request.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          redirect: "error",
          signal: composed.signal,
        });
      } catch (error) {
        throw mapFetchError(error, request.signal, deadline);
      }
      throwIfAborted(request.signal, deadline);

      let buffer = new Uint8Array(0);
      try {
        const reader = response.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            throwIfAborted(request.signal, deadline);
            const { done, value } = await reader.read();
            throwIfAborted(request.signal, deadline);
            if (done) {
              break;
            }
            total += value.length;
            if (total > maxBytes) {
              await reader.cancel("response_too_large");
              throw new ExternalJsonResponseTooLargeError(
                "External JSON response exceeded the byte limit.",
              );
            }
            chunks.push(value);
          }
          buffer = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
          }
        }
      } catch (error) {
        if (error instanceof ExternalJsonResponseTooLargeError) {
          throw error;
        }
        throw mapFetchError(error, request.signal, deadline);
      }

      return {
        status: response.status,
        text: new TextDecoder().decode(buffer),
      };
    } finally {
      clearTimeout(timer);
      composed.dispose();
    }
  }
}

function throwIfAborted(
  callerSignal: AbortSignal | undefined,
  deadline: AbortController,
): void {
  if (callerSignal?.aborted) {
    const reason = callerSignal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw new DOMException("Aborted", "AbortError");
  }
  if (deadline.signal.aborted) {
    throw new ExternalJsonTimeoutError("External JSON request timed out.");
  }
}

function mapFetchError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  deadline: AbortController,
): Error {
  if (callerSignal?.aborted) {
    throw error;
  }
  if (deadline.signal.aborted) {
    throw new ExternalJsonTimeoutError("External JSON request timed out.");
  }
  if (error instanceof Error && error.name === "AbortError") {
    throw new ExternalJsonTimeoutError("External JSON request timed out.");
  }
  if (
    error instanceof ExternalJsonResponseTooLargeError ||
    error instanceof ExternalJsonTimeoutError
  ) {
    throw error;
  }
  throw new ExternalJsonTransportError("External JSON request failed.");
}

function boundedPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be a positive safe integer up to ${maximum}.`,
    );
  }
  return value;
}

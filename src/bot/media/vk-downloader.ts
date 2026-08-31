import { BotMediaError } from "./contracts.js";
import type { VkMediaReference } from "./vk-contracts.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DownloadedVkMedia {
  media: VkMediaReference;
  data: Uint8Array;
  mediaType: string;
}

export interface VkMediaDownloaderOptions {
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Bounded, redirect-free plain HTTPS download of a VK photo CDN URL. Unlike
 * `TelegramMediaDownloader` this needs no token and no separate
 * getFile-style resolution step: `media.url` is already a directly
 * downloadable link (see `vk-media.ts`'s `safeVkUrl` for the trust/allowlist
 * reasoning).
 */
export class VkMediaDownloader {
  readonly #fetch: typeof fetch;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(options: VkMediaDownloaderOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#maxBytes = boundedInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      1_024,
      DEFAULT_MAX_BYTES,
    );
    this.#timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1_000,
      120_000,
    );
  }

  async download(
    media: VkMediaReference,
    externalSignal: AbortSignal,
  ): Promise<DownloadedVkMedia> {
    if (externalSignal.aborted) {
      throw abortedError();
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([externalSignal, timeout]);
    try {
      const response = await this.#fetch(media.url, {
        signal,
        redirect: "error",
        headers: { Accept: "image/*" },
      });
      if (!response.ok || !response.body) {
        throw new BotMediaError("download_failed", "VK media download failed.");
      }
      const length = response.headers.get("content-length");
      if (
        length &&
        (!/^[0-9]+$/u.test(length) || Number(length) > this.#maxBytes)
      ) {
        throw new BotMediaError(
          "file_too_large",
          "The selected media is too large.",
        );
      }
      const bytes = await readBoundedBody(
        response.body,
        this.#maxBytes,
        signal,
      );
      return {
        media,
        data: bytes,
        mediaType:
          contentType(response.headers.get("content-type")) ?? media.mediaType,
      };
    } catch (error) {
      if (externalSignal.aborted) {
        throw abortedError();
      }
      if (error instanceof BotMediaError) {
        throw error;
      }
      if (timeout.aborted) {
        throw new BotMediaError(
          "download_timeout",
          "VK media download timed out.",
        );
      }
      throw new BotMediaError("download_failed", "VK media download failed.");
    }
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw abortedError();
      }
      const next = await reader.read();
      if (next.done) {
        break;
      }
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new BotMediaError(
          "file_too_large",
          "The selected media is too large.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(
      `Media limit must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return result;
}

function contentType(value: string | null): string | undefined {
  return value &&
    value.length <= 256 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(
      value.split(";", 1)[0]?.trim() ?? "",
    )
    ? value.split(";", 1)[0]?.trim()
    : undefined;
}

function abortedError(): BotMediaError {
  return new BotMediaError("aborted", "VK media download was cancelled.");
}

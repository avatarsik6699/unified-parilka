import type { TelegramMediaReference } from "./contracts.js";
import { BotMediaError } from "./contracts.js";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300;

/**
 * Internal-only marker for a network-layer failure (connect/timeout/stream
 * reset, or a non-2xx response) as opposed to a deterministic content or
 * metadata problem. Only the former is worth retrying -- a flaky VPS route to
 * Telegram intermittently drops single connection attempts, while a size or
 * path mismatch will reproduce identically on every retry.
 */
class TransientMediaDownloadFailure extends Error {
  constructor(readonly failure: BotMediaError) {
    super(failure.message);
  }
}

export interface TelegramFileDescriptor {
  filePath: string;
  fileSize?: number;
}

export interface TelegramMediaDownloaderOptions {
  /** Must call Bot API getFile; file ids never enter a model-facing URL. */
  getFile(fileId: string, signal: AbortSignal): Promise<TelegramFileDescriptor>;
  /** Builds an authenticated Telegram download URL from a validated path. */
  fileUrl(filePath: string): string | URL;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface DownloadedTelegramMedia {
  media: TelegramMediaReference;
  data: Uint8Array;
  mediaType: string;
}

/** Bounded, redirect-free Bot API file download with no URL/file-id disclosure. */
export class TelegramMediaDownloader {
  readonly #getFile: TelegramMediaDownloaderOptions["getFile"];
  readonly #fileUrl: TelegramMediaDownloaderOptions["fileUrl"];
  readonly #fetch: typeof fetch;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;

  constructor(options: TelegramMediaDownloaderOptions) {
    this.#getFile = options.getFile;
    this.#fileUrl = options.fileUrl;
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
    this.#maxAttempts = boundedInteger(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      1,
      5,
    );
  }

  /**
   * A single dropped connection to Telegram's file servers should not sink an
   * otherwise-healthy turn. Only network-layer failures are retried; a
   * deterministic content/metadata mismatch reproduces identically on every
   * attempt, so #attempt throws those directly instead of the transient
   * marker.
   */
  async download(
    media: TelegramMediaReference,
    externalSignal: AbortSignal,
  ): Promise<DownloadedTelegramMedia> {
    let lastFailure: BotMediaError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (externalSignal.aborted) {
        throw abortedError();
      }
      try {
        return await this.#attempt(media, externalSignal);
      } catch (error) {
        if (externalSignal.aborted) {
          throw abortedError();
        }
        if (!(error instanceof TransientMediaDownloadFailure)) {
          throw error;
        }
        lastFailure = error.failure;
        if (attempt === this.#maxAttempts) {
          throw lastFailure;
        }
        await delay(RETRY_DELAY_MS, externalSignal);
      }
    }
    throw (
      lastFailure ??
      new BotMediaError("download_failed", "Telegram media download failed.")
    );
  }

  async #attempt(
    media: TelegramMediaReference,
    externalSignal: AbortSignal,
  ): Promise<DownloadedTelegramMedia> {
    if (!validFileId(media.fileId)) {
      throw new BotMediaError(
        "invalid_media",
        "The selected media is invalid.",
      );
    }
    if (media.fileSize !== undefined) {
      if (!validByteCount(media.fileSize)) {
        throw new BotMediaError(
          "invalid_media",
          "The selected media is invalid.",
        );
      }
      if (media.fileSize > this.#maxBytes) {
        throw new BotMediaError(
          "file_too_large",
          "The selected media is too large.",
        );
      }
    }
    if (externalSignal.aborted) {
      throw abortedError();
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = AbortSignal.any([externalSignal, timeout]);
    try {
      const descriptor = await this.#getFile(media.fileId, signal);
      if (!validFilePath(descriptor.filePath)) {
        throw new BotMediaError(
          "invalid_media",
          "The selected media is invalid.",
        );
      }
      if (
        descriptor.fileSize !== undefined &&
        (!validByteCount(descriptor.fileSize) ||
          descriptor.fileSize > this.#maxBytes)
      ) {
        throw new BotMediaError(
          "file_too_large",
          "The selected media is too large.",
        );
      }
      // A persisted Bot API message already includes its file size.  Keep it
      // as an integrity value even when a later getFile response omits
      // file_size; otherwise a valid-looking but truncated MP4 can reach
      // ffmpeg.  When both APIs report a size, a disagreement is likewise a
      // failed download, never a reason to pick one silently.
      if (
        media.fileSize !== undefined &&
        descriptor.fileSize !== undefined &&
        media.fileSize !== descriptor.fileSize
      ) {
        throw new BotMediaError(
          "download_failed",
          "Telegram media metadata disagreed.",
        );
      }
      const expectedSize = descriptor.fileSize ?? media.fileSize;
      const url = this.#fileUrl(descriptor.filePath);
      const response = await this.#fetch(url, {
        signal,
        redirect: "error",
        headers: { Accept: "application/octet-stream" },
      });
      if (!response.ok || !response.body) {
        throw new TransientMediaDownloadFailure(
          new BotMediaError(
            "download_failed",
            "Telegram media download failed.",
          ),
        );
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
      // Bot API's getFile size is an integrity bound, not merely a hint. Do
      // not hand a silently truncated MP4/Ogg container to ffmpeg/Flov: it can
      // look valid enough to open while containing no complete audio packets.
      if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
        throw new TransientMediaDownloadFailure(
          new BotMediaError(
            "download_failed",
            "Telegram media download was incomplete.",
          ),
        );
      }
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
      if (error instanceof TransientMediaDownloadFailure) {
        throw error;
      }
      if (timeout.aborted) {
        throw new TransientMediaDownloadFailure(
          new BotMediaError(
            "download_timeout",
            "Telegram media download timed out.",
          ),
        );
      }
      if (error instanceof BotMediaError) {
        throw error;
      }
      throw new TransientMediaDownloadFailure(
        new BotMediaError("download_failed", "Telegram media download failed."),
      );
    }
  }
}

/** Abortable delay used only for the brief pause between retry attempts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function validFileId(value: string): boolean {
  return (
    value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function validFilePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    /^[A-Za-z0-9._/-]+$/u.test(value) &&
    !value.startsWith("/") &&
    !value.includes("//") &&
    !value.split("/").includes("..")
  );
}

function validByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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
  return new BotMediaError("aborted", "Telegram media download was cancelled.");
}

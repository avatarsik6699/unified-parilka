import { randomUUID } from "node:crypto";
import {
  ExternalJsonClient,
  ExternalJsonResponseTooLargeError,
  ExternalJsonTimeoutError,
  ExternalJsonTransportError,
} from "./external-json.js";
import { composeAbortSignals } from "./loopback-json.js";

const MAX_PROMPT_CHARS = 2_000;
const MIN_PROMPT_CHARS = 2;
const MAX_IMAGE_BYTES = 15_000_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * A conservative allowlist of Runware model AIRs (`creator:family@version`)
 * the tool may request -- the model never picks an arbitrary provider
 * string. FLUX.2 [dev] (`runware:400@1`, Black Forest Labs) replaced the
 * earlier SahastraKoti XL default: the operator's own side-by-side testing
 * found it fast, reliable, and relatively cheap, unlike the operator's
 * earlier experience with FLUX.1 [dev] -- FLUX.2 is a materially different
 * model family, not the same one that previously underperformed.
 */
export const RUNWARE_MODEL_ALLOWLIST = ["runware:400@1"] as const;
const DEFAULT_MODEL = RUNWARE_MODEL_ALLOWLIST[0];

const SIZE_CHOICES = [512, 768, 1024] as const;
const DEFAULT_SIZE = 512;

export interface RunwareGenerateParams {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  nsfw?: boolean;
}

export interface RunwareGenerateSuccess {
  ok: true;
  imageBytes: Buffer;
  model: string;
  width: number;
  height: number;
}

export interface RunwareGenerateFailure {
  ok: false;
  error: {
    code:
      | "invalid_arguments"
      | "timeout"
      | "provider_error"
      | "provider_unavailable"
      | "aborted"
      | "content_blocked";
    message: string;
  };
}

export type RunwareGenerateResult =
  RunwareGenerateSuccess | RunwareGenerateFailure;

export interface RunwareClientOptions {
  endpoint: string;
  apiKey: string;
  nsfwAllowed: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Runware imageInference adapter over the bounded external-JSON transport.
 * `nsfwAllowed` gates the request-level safety toggle: even a caller asking
 * for `nsfw: true` is downgraded to the safe request when the operator has
 * not explicitly enabled it via config.
 */
export class RunwareClient {
  readonly #json: ExternalJsonClient;
  readonly #nsfwAllowed: boolean;
  readonly #fetchImpl: typeof fetch;

  constructor(options: RunwareClientOptions) {
    this.#json = new ExternalJsonClient({
      origin: options.endpoint,
      bearerToken: options.apiKey,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: 256_000,
      fetchImpl: options.fetchImpl,
    });
    this.#nsfwAllowed = options.nsfwAllowed;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    params: RunwareGenerateParams,
    signal: AbortSignal,
  ): Promise<RunwareGenerateResult> {
    const validated = validateParams(params);
    if (!validated.ok) {
      return {
        ok: false,
        error: { code: "invalid_arguments", message: validated.message },
      };
    }
    if (signal.aborted) {
      return {
        ok: false,
        error: { code: "aborted", message: "Operation aborted." },
      };
    }

    const taskUUID = randomUUID();
    const body = JSON.stringify([
      {
        taskType: "imageInference",
        taskUUID,
        model: validated.model,
        positivePrompt: validated.prompt,
        width: validated.width,
        height: validated.height,
        numberResults: 1,
        outputType: "URL",
        outputFormat: "JPG",
        safety: { checkContent: !(this.#nsfwAllowed && validated.nsfw) },
      },
    ]);

    let response;
    try {
      response = await this.#json.request({
        path: "",
        method: "POST",
        body,
        signal,
      });
    } catch (error) {
      return mapTransportError(error, signal);
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: `Runware returned HTTP ${response.status}.`,
        },
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonObject(response.text);
    } catch {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Runware response unreadable.",
        },
      };
    }

    const errors = Array.isArray(parsed.errors)
      ? parsed.errors
      : parsed.error !== undefined
        ? [parsed.error]
        : [];
    if (errors.length > 0) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Runware rejected the request.",
        },
      };
    }

    const entries = Array.isArray(parsed.data) ? parsed.data : [];
    const entry = entries.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).imageURL === "string",
    );
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: "provider_error",
          message: "Runware response contained no image.",
        },
      };
    }

    const imageUrl = entry.imageURL as string;
    let imageBytes: Buffer;
    try {
      imageBytes = await this.#downloadImage(imageUrl, signal);
    } catch (error) {
      return mapTransportError(error, signal);
    }

    return {
      ok: true,
      imageBytes,
      model: validated.model,
      width: validated.width,
      height: validated.height,
    };
  }

  async #downloadImage(url: string, signal: AbortSignal): Promise<Buffer> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new ExternalJsonTransportError(
        "Runware returned an invalid image URL.",
      );
    }
    if (parsedUrl.protocol !== "https:") {
      throw new ExternalJsonTransportError("Runware image URL must be HTTPS.");
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
    const composed = composeAbortSignals([signal, deadline.signal]);
    try {
      let response: Response;
      try {
        response = await this.#fetchImpl(parsedUrl.toString(), {
          method: "GET",
          redirect: "error",
          signal: composed.signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        if (deadline.signal.aborted) {
          throw new ExternalJsonTimeoutError("Image download timed out.");
        }
        throw new ExternalJsonTransportError("Image download failed.");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ExternalJsonTransportError(
          `Image download returned HTTP ${response.status}.`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new ExternalJsonTransportError("Image download had no body.");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.length;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel("response_too_large");
          throw new ExternalJsonResponseTooLargeError(
            "Generated image exceeded the byte limit.",
          );
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    } finally {
      clearTimeout(timer);
      composed.dispose();
    }
  }
}

function validateParams(params: RunwareGenerateParams):
  | {
      ok: true;
      prompt: string;
      model: string;
      width: number;
      height: number;
      nsfw: boolean;
    }
  | { ok: false; message: string } {
  const prompt = params.prompt.trim();
  if (prompt.length < MIN_PROMPT_CHARS || prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      message: `prompt must be between ${MIN_PROMPT_CHARS} and ${MAX_PROMPT_CHARS} characters.`,
    };
  }
  const model = params.model ?? DEFAULT_MODEL;
  if (!RUNWARE_MODEL_ALLOWLIST.includes(model as never)) {
    return {
      ok: false,
      message: `model must be one of: ${RUNWARE_MODEL_ALLOWLIST.join(", ")}.`,
    };
  }
  const width = params.width ?? DEFAULT_SIZE;
  const height = params.height ?? DEFAULT_SIZE;
  if (!SIZE_CHOICES.includes(width as never)) {
    return {
      ok: false,
      message: `width must be one of: ${SIZE_CHOICES.join(", ")}.`,
    };
  }
  if (!SIZE_CHOICES.includes(height as never)) {
    return {
      ok: false,
      message: `height must be one of: ${SIZE_CHOICES.join(", ")}.`,
    };
  }
  return { ok: true, prompt, model, width, height, nsfw: params.nsfw === true };
}

function mapTransportError(
  error: unknown,
  signal: AbortSignal,
): RunwareGenerateFailure {
  if (signal.aborted) {
    return {
      ok: false,
      error: { code: "aborted", message: "Operation aborted." },
    };
  }
  if (error instanceof ExternalJsonTimeoutError) {
    return {
      ok: false,
      error: { code: "timeout", message: "Runware request timed out." },
    };
  }
  if (error instanceof ExternalJsonResponseTooLargeError) {
    return {
      ok: false,
      error: {
        code: "provider_error",
        message: "Runware response too large.",
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "provider_unavailable",
      message: "Runware request failed.",
    },
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("not an object");
  }
  return parsed as Record<string, unknown>;
}

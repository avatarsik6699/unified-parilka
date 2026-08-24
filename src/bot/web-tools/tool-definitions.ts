import type { ReadToolEvidence } from "../read-tools/contracts.js";
import type { DownloadedImage, TurnImageTracker } from "../agent/web-images.js";
import type { DownloadImagesResult } from "./image-downloader.js";
import { SearXNGClient } from "./searxng-client.js";
import { FirecrawlClient } from "./firecrawl-client.js";
import { downloadImages as defaultDownloadImages } from "./image-downloader.js";
import type { RunwareClient } from "./runware-client.js";
import type { ImageGenerationBudget } from "../agent/image-generation-budget.js";
import type { ReactionCapability } from "./reaction-contracts.js";

export const WEB_TOOL_NAMES = [
  "searxng_search",
  "firecrawl_crawl",
  "inspect_web_images",
  "generate_image",
  "edit_image",
  "speak_text",
  "react_to_message",
] as const;

export interface GeneratedImage {
  bytes: Buffer;
  model: string;
  width: number;
  height: number;
}

export interface GeneratedSpeech {
  bytes: Buffer;
  model: string;
  voice: string;
}

/** The already-downloaded reply/current-message photo, reused as an edit source. */
export interface ReferenceImage {
  data: Uint8Array;
  mediaType: string;
}

export type TranslateImagePrompt = (
  text: string,
  signal: AbortSignal,
) => Promise<{ ok: true; text: string } | { ok: false }>;

export type WebToolName = (typeof WEB_TOOL_NAMES)[number];

export interface WebToolResultSuccess {
  ok: true;
  tool: WebToolName;
  status: "done" | "empty";
  result: Record<string, unknown>;
  evidence: ReadToolEvidence[];
}

export interface WebToolResultFailure {
  ok: false;
  tool: WebToolName;
  error: { code: string; message: string };
  evidence: [];
}

export type WebToolResult = WebToolResultSuccess | WebToolResultFailure;

export interface WebToolPort {
  searxngClient: SearXNGClient;
  firecrawlClient: FirecrawlClient;
  imageTracker: TurnImageTracker;
  nonce: string;
  turnSignal: AbortSignal;
  turnId: string;
  downloadImages: (
    urls: readonly string[],
    signal: AbortSignal,
  ) => Promise<DownloadImagesResult>;
  runwareClient?: RunwareClient;
  imageBudget?: ImageGenerationBudget;
  nsfwAllowed?: boolean;
  onImageGenerated?: (image: GeneratedImage) => void;
  /** Raw trigger text, mention-stripped, for generate_image's literal prompt. */
  rawImagePromptSource?: string;
  /** Best-effort literal translation to English before Runware sees the prompt. */
  translateImagePrompt?: TranslateImagePrompt;
  /** This turn's already-downloaded photo, offered to edit_image as a source. */
  referenceImage?: ReferenceImage;
  ttsClient?: RunwareClient;
  ttsBudget?: ImageGenerationBudget;
  onSpeechGenerated?: (speech: GeneratedSpeech) => void;
  reaction?: ReactionCapability;
}

export interface CreateWebToolPortOptions {
  searxngEndpoint?: string;
  firecrawlEndpoint?: string;
  imageTracker: TurnImageTracker;
  nonce: string;
  turnSignal: AbortSignal;
  turnId: string;
  searxngClient?: SearXNGClient;
  firecrawlClient?: FirecrawlClient;
  downloadImages?: WebToolPort["downloadImages"];
  runwareClient?: RunwareClient;
  imageBudget?: ImageGenerationBudget;
  nsfwAllowed?: boolean;
  onImageGenerated?: (image: GeneratedImage) => void;
  /** Raw trigger text, mention-stripped, for generate_image's literal prompt. */
  rawImagePromptSource?: string;
  /** Best-effort literal translation to English before Runware sees the prompt. */
  translateImagePrompt?: TranslateImagePrompt;
  referenceImage?: ReferenceImage;
  ttsClient?: RunwareClient;
  ttsBudget?: ImageGenerationBudget;
  onSpeechGenerated?: (speech: GeneratedSpeech) => void;
  reaction?: ReactionCapability;
}

export function createWebToolPort(
  options: CreateWebToolPortOptions,
): WebToolPort {
  return {
    searxngClient:
      options.searxngClient ??
      new SearXNGClient({ origin: options.searxngEndpoint }),
    firecrawlClient:
      options.firecrawlClient ??
      new FirecrawlClient({ origin: options.firecrawlEndpoint }),
    imageTracker: options.imageTracker,
    nonce: options.nonce,
    turnSignal: options.turnSignal,
    turnId: options.turnId,
    downloadImages:
      options.downloadImages ??
      ((urls, signal) =>
        defaultDownloadImages(urls, {
          tracker: options.imageTracker,
          signal,
        })),
    ...(options.runwareClient === undefined
      ? {}
      : { runwareClient: options.runwareClient }),
    ...(options.imageBudget === undefined
      ? {}
      : { imageBudget: options.imageBudget }),
    ...(options.nsfwAllowed === undefined
      ? {}
      : { nsfwAllowed: options.nsfwAllowed }),
    ...(options.onImageGenerated === undefined
      ? {}
      : { onImageGenerated: options.onImageGenerated }),
    ...(options.rawImagePromptSource === undefined
      ? {}
      : { rawImagePromptSource: options.rawImagePromptSource }),
    ...(options.translateImagePrompt === undefined
      ? {}
      : { translateImagePrompt: options.translateImagePrompt }),
    ...(options.referenceImage === undefined
      ? {}
      : { referenceImage: options.referenceImage }),
    ...(options.ttsClient === undefined
      ? {}
      : { ttsClient: options.ttsClient }),
    ...(options.ttsBudget === undefined
      ? {}
      : { ttsBudget: options.ttsBudget }),
    ...(options.onSpeechGenerated === undefined
      ? {}
      : { onSpeechGenerated: options.onSpeechGenerated }),
    ...(options.reaction === undefined ? {} : { reaction: options.reaction }),
  };
}

export interface WebToolSetOptions {
  port: WebToolPort;
  /** Candidate-driven capability; authoritative for tool visibility. */
  visionAvailable: boolean;
  onExecutionStarted?: (input: {
    name: string;
    callId: string;
    input: Readonly<Record<string, unknown>>;
  }) => void;
  onExecutionCompleted?: (input: {
    name: string;
    callId: string;
    startedAt: number;
    output: WebToolResult;
  }) => void;
}

export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Completes accounting and returns a typed failure with a generic message
 * when a web tool unexpectedly throws. Upstream error details never leak.
 */
export function failTyped(
  options: WebToolSetOptions,
  toolName: WebToolName,
  callId: string,
  startedAt: number,
): WebToolResult {
  const output: WebToolResult = {
    ok: false,
    tool: toolName,
    error: {
      code: "provider_error",
      message: "Инструмент не смог выполниться.",
    },
    evidence: [],
  };
  options.onExecutionCompleted?.({
    name: toolName,
    callId,
    startedAt,
    output,
  });
  return output;
}

export type { DownloadedImage };

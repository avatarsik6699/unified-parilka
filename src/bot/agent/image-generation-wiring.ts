import type { BotImageGenerationRuntimeConfig } from "../runtime-config.js";
import { RunwareClient } from "../web-tools/runware-client.js";
import { ImageGenerationBudget } from "./image-generation-budget.js";
import {
  createWebToolPort,
  type GeneratedImage,
  type WebToolPort,
} from "../web-tools/tool-definitions.js";

export interface ImageGenerationRuntime {
  runwareClient: RunwareClient | undefined;
  imageBudget: ImageGenerationBudget | undefined;
  nsfwAllowed: boolean;
}

/**
 * Builds the per-agent-instance Runware client and cost-guard budget from
 * runtime config, or an all-undefined runtime when image generation is
 * disabled -- kept as a small pure helper so `AiSdkBotTurnAgent`'s
 * constructor stays within the production-file line ceiling.
 */
export interface AgentWebToolPortOptions {
  searxngEndpoint: string | undefined;
  firecrawlEndpoint: string | undefined;
  runwareClient: RunwareClient | undefined;
  imageBudget: ImageGenerationBudget | undefined;
  nsfwAllowed: boolean;
  imageTracker: WebToolPort["imageTracker"];
  nonce: string;
  turnSignal: AbortSignal;
  turnId: string;
  onImageGenerated: (image: GeneratedImage) => void;
}

/**
 * Assembles the per-turn `WebToolPort` for a live agent instance, folding in
 * the Runware client/budget only when image generation is configured. Kept
 * outside `AiSdkBotTurnAgent` itself so its `run()` method stays within the
 * production-file line ceiling.
 */
export function buildAgentWebToolPort(
  options: AgentWebToolPortOptions,
): WebToolPort {
  return createWebToolPort({
    searxngEndpoint: options.searxngEndpoint,
    firecrawlEndpoint: options.firecrawlEndpoint,
    imageTracker: options.imageTracker,
    nonce: options.nonce,
    turnSignal: options.turnSignal,
    turnId: options.turnId,
    ...(options.runwareClient === undefined
      ? {}
      : {
          runwareClient: options.runwareClient,
          imageBudget: options.imageBudget,
          nsfwAllowed: options.nsfwAllowed,
          onImageGenerated: options.onImageGenerated,
        }),
  });
}

export function createImageGenerationRuntime(
  config: BotImageGenerationRuntimeConfig | undefined,
): ImageGenerationRuntime {
  if (config === undefined) {
    return {
      runwareClient: undefined,
      imageBudget: undefined,
      nsfwAllowed: false,
    };
  }
  return {
    runwareClient: new RunwareClient({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      nsfwAllowed: config.nsfwAllowed,
      timeoutMs: config.timeoutMs,
    }),
    imageBudget: new ImageGenerationBudget(
      config.maxImagesPerTurn,
      config.maxImagesPerChatPerDay,
    ),
    nsfwAllowed: config.nsfwAllowed,
  };
}

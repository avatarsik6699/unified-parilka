import type { BotImageGenerationRuntimeConfig } from "../runtime-config.js";
import { RunwareClient } from "../web-tools/runware-client.js";
import { ImageGenerationBudget } from "./image-generation-budget.js";
import {
  createWebToolPort,
  type GeneratedImage,
  type WebToolPort,
} from "../web-tools/tool-definitions.js";
import {
  translateImagePromptToEnglish,
  type PromptTranslationRouter,
} from "./image-prompt-translation.js";

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
  /** Raw trigger text and bot username, mention-stripped for generate_image. */
  triggerText: string;
  botUsername: string;
  /** Used to translate the raw prompt to English before Runware sees it. */
  router: PromptTranslationRouter;
}

/**
 * `generate_image` never lets the model write its own prompt text -- an LLM
 * asked to relay an explicit request tends to paraphrase or soften it (seen
 * live: users and the bot's own replies both noticed DeepSeek "rewriting the
 * order in its own words"). Using the literal trigger message instead
 * guarantees the user's own wording reaches Runware unmodified. Only the
 * bot's own @mention is stripped; everything else in the message is kept
 * verbatim, including punctuation and casing.
 */
export function stripBotMention(text: string, botUsername: string): string {
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`@${escaped}\\b`, "giu");
  return text.replace(pattern, "").trim();
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
          rawImagePromptSource: stripBotMention(
            options.triggerText,
            options.botUsername,
          ),
          translateImagePrompt: (text: string, signal: AbortSignal) =>
            translateImagePromptToEnglish({
              router: options.router,
              text,
              signal,
            }),
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

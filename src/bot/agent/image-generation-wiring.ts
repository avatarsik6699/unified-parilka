import type {
  BotImageGenerationRuntimeConfig,
  BotVoiceReplyRuntimeConfig,
} from "../runtime-config.js";
export type { BotImageGenerationRuntimeConfig, BotVoiceReplyRuntimeConfig };
import { RunwareClient } from "../web-tools/runware-client.js";
import { ImageGenerationBudget } from "./image-generation-budget.js";
import {
  createWebToolPort,
  type GeneratedImage,
  type GeneratedSpeech,
  type ReferenceImage,
  type WebToolPort,
} from "../web-tools/tool-definitions.js";
import type { ReactionCapability } from "../web-tools/reaction-contracts.js";
import type { BotAgentRequest } from "../worker/contracts.js";
import {
  translateImagePromptToEnglish,
  type PromptTranslationRouter,
} from "./image-prompt-translation.js";

export interface ImageGenerationRuntime {
  runwareClient: RunwareClient | undefined;
  imageBudget: ImageGenerationBudget | undefined;
  nsfwAllowed: boolean;
}

export interface VoiceReplyRuntime {
  ttsClient: RunwareClient | undefined;
  ttsBudget: ImageGenerationBudget | undefined;
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
  /** This turn's already-downloaded photo, offered to edit_image as a source. */
  referenceImage?: ReferenceImage;
  ttsClient: RunwareClient | undefined;
  ttsBudget: ImageGenerationBudget | undefined;
  onSpeechGenerated: (speech: GeneratedSpeech) => void;
  reaction?: ReactionCapability;
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
    ...(options.referenceImage === undefined
      ? {}
      : { referenceImage: options.referenceImage }),
    ...(options.ttsClient === undefined
      ? {}
      : {
          ttsClient: options.ttsClient,
          ttsBudget: options.ttsBudget,
          onSpeechGenerated: options.onSpeechGenerated,
        }),
    ...(options.reaction === undefined ? {} : { reaction: options.reaction }),
  });
}

/**
 * `react_to_message`'s target ids and chat scope come from the live request,
 * not agent-construction-time config -- the Bot API port itself is the only
 * part wired once, from `BotTurnWorker`, matching `toolProgressPort`.
 */
export function reactionPortOptions(
  request: Pick<
    BotAgentRequest,
    "reactionApi" | "turn" | "trigger" | "replyTarget"
  >,
): Pick<AgentWebToolPortOptions, "reaction"> {
  if (request.reactionApi === undefined) {
    return {};
  }
  return {
    reaction: {
      api: request.reactionApi,
      chatId: request.turn.chatId,
      triggerMessageId: request.trigger.messageId,
      ...(request.replyTarget === undefined
        ? {}
        : { replyMessageId: request.replyTarget.messageId }),
    },
  };
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

/** Offers the vision path's already-downloaded photo to edit_image, if any. */
export function webToolReferenceImage(
  visionAttachment: ReferenceImage | undefined,
): Pick<AgentWebToolPortOptions, "referenceImage"> {
  return visionAttachment === undefined
    ? {}
    : { referenceImage: visionAttachment };
}

export interface AgentMediaRuntime {
  image: ImageGenerationRuntime;
  voice: VoiceReplyRuntime;
}

export function createAgentMediaRuntime(
  imageGeneration: BotImageGenerationRuntimeConfig | undefined,
  voiceReply: BotVoiceReplyRuntimeConfig | undefined,
): AgentMediaRuntime {
  return {
    image: createImageGenerationRuntime(imageGeneration),
    voice: createVoiceReplyRuntime(voiceReply),
  };
}

/**
 * Bundles every generate_image/edit_image/speak_text port field the agent's
 * constructor-built runtimes contribute, so `AiSdkBotTurnAgent.run()` only
 * carries one field and one spread call instead of five.
 */
export function agentMediaPortOptions(
  runtime: AgentMediaRuntime,
  visionAttachment: ReferenceImage | undefined,
  onImageGenerated: (image: GeneratedImage) => void,
  onSpeechGenerated: (speech: GeneratedSpeech) => void,
): Pick<
  AgentWebToolPortOptions,
  | "runwareClient"
  | "imageBudget"
  | "nsfwAllowed"
  | "onImageGenerated"
  | "referenceImage"
  | "ttsClient"
  | "ttsBudget"
  | "onSpeechGenerated"
> {
  return {
    runwareClient: runtime.image.runwareClient,
    imageBudget: runtime.image.imageBudget,
    nsfwAllowed: runtime.image.nsfwAllowed,
    onImageGenerated,
    ...webToolReferenceImage(visionAttachment),
    ttsClient: runtime.voice.ttsClient,
    ttsBudget: runtime.voice.ttsBudget,
    onSpeechGenerated,
  };
}

/**
 * A generated image and a generated speech clip both claim the reply's
 * single-attachment slot; an image (already well-tested) wins a same-turn
 * collision rather than the two ambiguously overriding each other.
 */
export function finalMediaAttachments(
  generatedImage: GeneratedImage | undefined,
  generatedSpeech: GeneratedSpeech | undefined,
): {
  imageAttachment?: { bytes: Buffer };
  voiceAttachment?: { bytes: Buffer };
} {
  if (generatedImage !== undefined) {
    return { imageAttachment: { bytes: generatedImage.bytes } };
  }
  if (generatedSpeech !== undefined) {
    return { voiceAttachment: { bytes: generatedSpeech.bytes } };
  }
  return {};
}

export function createVoiceReplyRuntime(
  config: BotVoiceReplyRuntimeConfig | undefined,
): VoiceReplyRuntime {
  if (config === undefined) {
    return { ttsClient: undefined, ttsBudget: undefined };
  }
  return {
    ttsClient: new RunwareClient({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      nsfwAllowed: false,
      timeoutMs: config.timeoutMs,
    }),
    ttsBudget: new ImageGenerationBudget(
      config.maxRepliesPerTurn,
      config.maxRepliesPerChatPerDay,
    ),
  };
}

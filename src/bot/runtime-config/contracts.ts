export type BotRuntimeMode = "live" | "shadow";

export interface BotWebSearchHttpRuntimeConfig {
  kind: "http";
  endpoint: string;
  bearerToken?: string;
}

export interface BotWebSearchVertexRuntimeConfig {
  kind: "vertex";
  project: string;
  model: string;
  region: string;
  maxOutputTokens: number;
  systemInstruction: string;
  gcloudPath?: string;
}

export type BotWebSearchRuntimeConfig =
  BotWebSearchHttpRuntimeConfig | BotWebSearchVertexRuntimeConfig;

export interface BotResearchGatewayRuntimeConfig {
  socketPath: string;
  timeoutMs: number;
}

/** Machine-local Flov endpoint used only for audio sent to this bot. */
export interface BotAudioTranscribeRuntimeConfig {
  endpoint: string;
  timeoutMs: number;
  /** Optional bearer credential for a locally hardened Flov API. */
  bearerToken?: string;
}

/**
 * Runware image-generation backend. `nsfwAllowed` is a deliberate, off-by-
 * default operator decision -- the live bot speaks Bot API, not an MTProto
 * user session, and Telegram moderates bot-sent adult content far more
 * strictly, risking the bot token being banned.
 */
export interface BotImageGenerationRuntimeConfig {
  provider: "runware";
  apiKey: string;
  endpoint: string;
  timeoutMs: number;
  nsfwAllowed: boolean;
  maxImagesPerTurn: number;
  maxImagesPerChatPerDay: number;
}

/** Runware text-to-speech backend for `speak_text`. Independently opt-in. */
export interface BotVoiceReplyRuntimeConfig {
  provider: "runware";
  apiKey: string;
  endpoint: string;
  timeoutMs: number;
  maxRepliesPerTurn: number;
  maxRepliesPerChatPerDay: number;
}

/**
 * Enables one Telegram user id to trigger an early news-brief run by
 * messaging the bot the exact phrase "daily news-brief" -- checked in host
 * code against the sender id before any model turn runs, never delegated to
 * a prompt-level instruction. Absent means nobody can trigger it early.
 */
export interface BotNewsBriefTriggerRuntimeConfig {
  triggerUserId: string;
  seenStorePath?: string;
}

export interface BotRuntimeConfig {
  token: string;
  exclusivePollerConfirmed: true;
  botId: string;
  botUsername: string;
  botDisplayName: string;
  /**
   * Shared across every chat this process serves -- per-chat identity
   * (allowed chat id, title, persona) lives in `AssistantChatConfig`
   * (`src/bot-config/assistant.ts`), not here.
   */
  historyDescription: string;
  /** Private allowlist of immutable Telegram user IDs permitted to write chat memory. */
  memoryWriteAuthorizerIds: readonly string[];
  dbPath: string;
  modelConfigPath: string;
  webSearch?: BotWebSearchRuntimeConfig;
  researchGateway?: BotResearchGatewayRuntimeConfig;
  audioTranscribe: BotAudioTranscribeRuntimeConfig;
  imageGeneration?: BotImageGenerationRuntimeConfig;
  voiceReply?: BotVoiceReplyRuntimeConfig;
  newsBriefTrigger?: BotNewsBriefTriggerRuntimeConfig;
  /** Loopback SearXNG JSON API origin. Default http://127.0.0.1:8080. */
  searxngEndpoint: string;
  /** Loopback Firecrawl v2 API origin. Default http://127.0.0.1:3002. */
  firecrawlEndpoint: string;
  mode: BotRuntimeMode;
  workerConcurrency: number;
  triggerCooldownMs: number;
  updateMaxAttempts: number;
  initialOffset?: number;
  pollTimeoutSec: number;
  pollLimit: number;
  pollBackoffInitialMs: number;
  pollBackoffMaxMs: number;
  modelStepTimeoutMs: number;
  publishTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export type SafeBotRuntimeConfig = Omit<
  BotRuntimeConfig,
  | "token"
  | "webSearch"
  | "researchGateway"
  | "audioTranscribe"
  | "memoryWriteAuthorizerIds"
  | "imageGeneration"
  | "voiceReply"
  | "newsBriefTrigger"
> & {
  tokenConfigured: true;
  memoryWriteAuthorizerCount: number;
  audioTranscribe: Omit<BotAudioTranscribeRuntimeConfig, "bearerToken"> & {
    bearerTokenConfigured: boolean;
  };
  imageGeneration?: Omit<BotImageGenerationRuntimeConfig, "apiKey"> & {
    apiKeyConfigured: true;
  };
  voiceReply?: Omit<BotVoiceReplyRuntimeConfig, "apiKey"> & {
    apiKeyConfigured: true;
  };
  /** Never echoes the privileged Telegram user id, same as memoryWriteAuthorizerCount. */
  newsBriefTriggerConfigured: boolean;
  webSearch?:
    | {
        kind: "http";
        endpoint: string;
        bearerTokenConfigured: boolean;
      }
    | {
        kind: "vertex";
        project: string;
        model: string;
        region: string;
        maxOutputTokens: number;
        gcloudPathConfigured: boolean;
      };
  researchGateway?: {
    configured: true;
    timeoutMs: number;
  };
};

export type BotRuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

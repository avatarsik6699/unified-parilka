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

/**
 * VK.ru (second transport). Opt-in: absent means this process constructs no
 * VK client and never starts a VK long-poll loop, even if `config/bots.json`
 * lists no `transport: "vk"` entries -- both must agree (validated in
 * `validateBotRuntimeRelationships`).
 */
export interface BotVkRuntimeConfig {
  /** Community (group) access token with the `messages` scope. */
  groupToken: string;
  /** Numeric VK community id, positive (not the peer_id namespacing prefix). */
  groupId: number;
  apiVersion: string;
  /**
   * A personal VK account's own access token (`messages` scope), member of
   * every `transport: "vk"` beседа. Optional: absent means no history
   * backfill runs, same opt-in shape as `groupToken` itself. Required
   * because `messages.getHistory` rejects a community/group token outright
   * (`[15] Access denied`, confirmed against the live API) -- see
   * `src/vk/history-backfill.ts`.
   */
  userToken?: string;
  /**
   * Total per-chat cap on how many historic messages `userToken` backfill
   * ever pulls in, mirroring `TELEGRAM_SYNC_BACKFILL_LIMIT`'s own default
   * order of magnitude. Meaningless (never read) when `userToken` is unset.
   */
  historyBackfillLimit: number;
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
  vk?: BotVkRuntimeConfig;
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
  | "vk"
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
  vk?: {
    groupTokenConfigured: true;
    groupId: number;
    apiVersion: string;
    userTokenConfigured: boolean;
    historyBackfillLimit: number;
  };
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

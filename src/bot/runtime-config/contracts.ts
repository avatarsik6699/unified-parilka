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
  | BotWebSearchHttpRuntimeConfig
  | BotWebSearchVertexRuntimeConfig;

export interface BotRuntimeConfig {
  token: string;
  exclusivePollerConfirmed: true;
  allowedChatId: string;
  botId: string;
  botUsername: string;
  botDisplayName: string;
  chatTitle: string;
  historyDescription: string;
  approximateMemberCount?: number;
  allowedMentions: readonly string[];
  dbPath: string;
  modelConfigPath: string;
  webSearch?: BotWebSearchRuntimeConfig;
  mode: BotRuntimeMode;
  workerConcurrency: number;
  triggerCooldownMs: number;
  updateMaxAttempts: number;
  initialOffset?: number;
  pollTimeoutSec: number;
  pollLimit: number;
  pollBackoffInitialMs: number;
  pollBackoffMaxMs: number;
  turnTimeoutMs: number;
  publishTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export type SafeBotRuntimeConfig = Omit<
  BotRuntimeConfig,
  "token" | "webSearch"
> & {
  tokenConfigured: true;
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
};

export type BotRuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

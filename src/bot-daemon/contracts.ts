import type { Api } from "grammy";
import type { AppConfig } from "../config.js";
import type { AiSdkBotTurnAgent, TurnModelRouter } from "../bot/ai-agent.js";
import type {
  BotVectorSearchPort,
  CanonicalBotReadCache,
} from "../bot/read-cache.js";
import type {
  BotReadTools,
  ResearchGatewayProvider,
  WebSearchProvider,
} from "../bot/read-tools.js";
import type { BotMemoryTools } from "../bot/memory-tools.js";
import type { BotMediaTools } from "../bot/media-tools.js";
import type {
  BotApiLongPoller,
  BotApiRuntime,
  BotUpdateProcessor,
  BotWorkerDrainResult,
  BotWorkerPump,
} from "../bot/runtime.js";
import type {
  BotRuntimeConfig,
  BotResearchGatewayRuntimeConfig,
  BotWebSearchRuntimeConfig,
} from "../bot/runtime-config.js";
import type { TurnCoordinator } from "../bot/turn-coordinator.js";
import type { BotTurnWorker, JsonEventLogger } from "../bot/worker.js";
import type { ApprovalPosterLoop } from "../human-persona-approval-poster.js";
import type { MessageStore } from "../store.js";
import type { AssistantChatConfig } from "../bot-config/assistant.js";

export type BotDaemonApi = Pick<
  Api,
  | "getMe"
  | "deleteWebhook"
  | "getUpdates"
  | "getFile"
  | "sendMessage"
  | "sendRichMessage"
  | "sendPhoto"
  | "sendVoice"
  | "setMessageReaction"
  | "sendChatAction"
  | "editMessageText"
  | "deleteMessage"
>;

export interface ComposeBotDaemonOptions {
  config: Readonly<BotRuntimeConfig>;
  /**
   * One entry per assistant-role chat this process serves (Фаза 7, native
   * multi-chat) -- 1 to `MAX_ASSISTANT_CHATS`. Each carries its own
   * `personaPrompt`: this base is persona-agnostic, every chat must supply
   * its own persona explicitly, there is no shared fallback character.
   */
  chats: readonly AssistantChatConfig[];
  store: MessageStore;
  api: BotDaemonApi;
  router: TurnModelRouter;
  vector?: BotVectorSearchPort;
  webSearch?: WebSearchProvider;
  researchGateway?: ResearchGatewayProvider;
  appConfig?: Readonly<AppConfig>;
  logger?: JsonEventLogger;
  workerIdPrefix?: string;
  /**
   * Human-persona approval workflow (plan Фаза 4d/5 Шаг 5). Both must be
   * set for the approval poster to run; either missing means the feature
   * stays off, same shape as the other opt-in human-persona wiring
   * (`src/bot-config/human-persona.ts`).
   */
  humanPersonaId?: string;
  humanPersonaApprovalChatId?: string;
}

/**
 * One graph per assistant-role chat (Фаза 7): the coordinator must not be
 * shared across chats (its fold/routing has no chat filter), so neither can
 * the agent/readTools/workers built against it.
 */
export interface BotDaemonChatComposition {
  coordinator: TurnCoordinator;
  readTools: BotReadTools;
  agent: AiSdkBotTurnAgent;
  workers: readonly BotTurnWorker[];
}

export interface BotDaemonComposition {
  runtime: BotApiRuntime;
  poller: BotApiLongPoller;
  workerPump: BotWorkerPump;
  /** Flat union of every chat's `workers`, fed to `workerPump`/drain accounting. */
  workers: readonly BotTurnWorker[];
  processor: BotUpdateProcessor;
  /** Keyed by the chat's normalized Telegram id. */
  chats: ReadonlyMap<string, BotDaemonChatComposition>;
  cache: CanonicalBotReadCache;
  mediaTools: BotMediaTools;
  memoryTools: BotMemoryTools;
  approvalPoster?: ApprovalPosterLoop;
}

export interface ProductionBotDaemonFactories {
  createApi(token: string): BotDaemonApi;
  createStore(path: string): MessageStore;
  createRouter(
    path: string,
    env: Readonly<Record<string, string | undefined>>,
  ): TurnModelRouter;
  createVector(
    config: AppConfig,
    store: MessageStore,
  ): BotVectorSearchPort & { readonly isConfigured: boolean };
  createWebSearch(
    config: Readonly<BotWebSearchRuntimeConfig>,
  ): WebSearchProvider;
  createResearchGateway(
    config: Readonly<BotResearchGatewayRuntimeConfig>,
  ): ResearchGatewayProvider;
}

export interface CreateProductionBotDaemonOptions {
  env?: Readonly<Record<string, string | undefined>>;
  appConfig?: AppConfig;
  logger?: JsonEventLogger;
  factories?: Partial<ProductionBotDaemonFactories>;
  workerIdPrefix?: string;
}

export interface ProductionBotDaemon extends BotDaemonComposition {
  config: BotRuntimeConfig;
  appConfig: AppConfig;
  store: MessageStore;
  logger?: JsonEventLogger;
  vectorEnabled: boolean;
  webSearchEnabled: boolean;
  researchGatewayEnabled: boolean;
  activeWorkerCount(): number;
  close(): void;
}

export interface BotDaemonRuntimePort {
  run(signal?: AbortSignal): Promise<BotWorkerDrainResult>;
  requestStop(): void;
}

export interface BotDaemonLifecycleTarget {
  runtime: BotDaemonRuntimePort;
  activeWorkerCount?(): number;
  close(): void;
  logger?: JsonEventLogger;
}

export interface BotDaemonSignalSource {
  once(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): unknown;
  off(
    event: "SIGINT" | "SIGTERM",
    listener: (signal: NodeJS.Signals) => void,
  ): unknown;
}

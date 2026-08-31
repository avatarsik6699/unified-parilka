import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Api } from "grammy";
import type { VK } from "vk-io";
import { loadConfig, type AppConfig } from "../config.js";
import type { BotRuntimeConfig } from "../bot/runtime-config.js";
import { parseBotRuntimeConfig } from "../bot/runtime-config.js";
import { createVkClient, createVkUserClient } from "../vk/client.js";
import { ModelRouter } from "../providers/model-router.js";
import { MessageStore } from "../store.js";
import { VectorRag } from "../vector-rag.js";
import { HttpJsonWebSearchProvider } from "../bot/web-search.js";
import { VertexGeminiWebSearchProvider } from "../bot/web-search-vertex.js";
import { UnixSocketResearchGatewayProvider } from "../bot/read-tools.js";
import { loadBotDefinitionsFromEnv } from "../bot-config/load.js";
import {
  selectAssistantChats,
  type AssistantChatConfig,
} from "../bot-config/assistant.js";
import { selectHumanPersona } from "../bot-config/human-persona.js";
import { composeBotDaemon } from "./composition.js";
import type {
  BotDaemonComposition,
  CreateProductionBotDaemonOptions,
  ProductionBotDaemon,
  ProductionBotDaemonFactories,
} from "./contracts.js";
import { safeDaemonLog } from "./trace.js";

/**
 * Creates production adapters without beginning long polling. The returned
 * deployment owns its MessageStore and closes it idempotently.
 */
export function createProductionBotDaemon(
  options: CreateProductionBotDaemonOptions = {},
): ProductionBotDaemon {
  if (
    options.env !== undefined &&
    options.env !== process.env &&
    options.appConfig === undefined
  ) {
    throw new Error(
      "A custom bot environment requires an explicit appConfig so shared Telegram settings cannot be read from a different process.env.",
    );
  }
  const env = options.env ?? process.env;
  const config = parseBotRuntimeConfig(env);
  const appConfig = options.appConfig ?? loadConfig();
  // Kept outside BotRuntimeConfig's strict parser deliberately: same
  // feature-scoped env-read precedent as the rest of `src/bot-config/` --
  // persona-agnostic base config stays generic, persona content and the
  // optional human-persona role are supplied separately per deployment
  // (ADR 0007: one BOT_BOTS_CONFIG_PATH file for both roles).
  const definitions = loadBotDefinitionsFromEnv(env);
  const chats = selectAssistantChats(
    definitions.entries,
    definitions.configPath,
  );
  const humanPersona = selectHumanPersona(
    definitions.entries,
    definitions.configPath,
  );
  // Read here (not later, alongside the rest of the human-persona wiring)
  // so assertBotDaemonConfiguration can reject an approval chat id that
  // collides with one of the assistant chats before anything else starts.
  const humanPersonaApprovalChatId = humanPersona?.approvalChatId;
  assertBotDaemonConfiguration(
    config,
    appConfig,
    chats,
    humanPersonaApprovalChatId,
  );
  const factories: ProductionBotDaemonFactories = {
    ...DEFAULT_PRODUCTION_FACTORIES,
    ...options.factories,
  };

  // Provider configuration and referenced secrets fail before SQLite opens.
  const api = factories.createApi(config.token);
  const router = factories.createRouter(config.modelConfigPath, env);
  const webSearch =
    config.webSearch === undefined
      ? undefined
      : factories.createWebSearch(config.webSearch);
  const researchGateway =
    config.researchGateway === undefined
      ? undefined
      : factories.createResearchGateway(config.researchGateway);
  // Only constructed when at least one chat needs it -- a Telegram-only
  // deployment with no BOT_VK_GROUP_TOKEN never touches VK at all.
  const vkApi: VK | undefined =
    config.vk === undefined ? undefined : factories.createVk(config.vk);
  // Only constructed when the operator supplied a personal-account token --
  // see BotVkRuntimeConfig.userToken's doc comment for why this can't reuse
  // the community/group vkApi client above.
  const vkUserApi: VK | undefined =
    config.vk?.userToken === undefined
      ? undefined
      : factories.createVkUser(config.vk);
  const store = factories.createStore(config.dbPath);
  store.reconcileActiveSendsOnStartup();

  const chatIds = chats.map((chat) => chat.allowedChatId);
  // Self-heals after an allowlist reconfiguration (a chat that was removed
  // from BOT_BOTS_CONFIG_PATH still had queued/failed turns). Called
  // once with the full allowlist, at startup only -- never per-claim, which
  // would wrongly quarantine every *other* still-valid chat's turns (Фаза 7).
  store.quarantineBotTurnsOutsideAllowlist(chatIds);

  // Evidence-log stuck sending turns from a previous crash, per chat.
  // Oracle: НЕ переводить автоматически в lost_ack — allowedChatId не доказывает
  // ownership процесса; другой MCP-процесс может владеть отправкой.
  for (const chatId of chatIds) {
    const stuckSending = store.countStuckSendingTurns(chatId);
    if (stuckSending > 0) {
      safeDaemonLog(options.logger, "warn", {
        event: "bot.startup.stuck_sending",
        count: stuckSending,
        chatId,
      });
    }
  }

  let composition: BotDaemonComposition | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    const activeWorkers = composition?.workerPump.activeWorkers ?? 0;
    if (activeWorkers > 0) {
      safeDaemonLog(options.logger, "error", {
        event: "bot.runtime.sqlite_close_deferred",
        activeWorkers,
      });
      return;
    }
    closed = true;
    store.close();
  };

  try {
    const vectorCandidate = factories.createVector(appConfig, store);
    const vector = vectorCandidate.isConfigured ? vectorCandidate : undefined;
    const humanPersonaId = humanPersona?.trigger.personaId;
    composition = composeBotDaemon({
      config,
      chats,
      store,
      api,
      ...(vkApi === undefined ? {} : { vkApi }),
      ...(vkUserApi === undefined ? {} : { vkUserApi }),
      router,
      appConfig,
      ...(vector === undefined ? {} : { vector }),
      ...(webSearch === undefined ? {} : { webSearch }),
      ...(researchGateway === undefined ? {} : { researchGateway }),
      logger: options.logger,
      workerIdPrefix: options.workerIdPrefix,
      ...(humanPersonaId ? { humanPersonaId } : {}),
      ...(humanPersonaApprovalChatId ? { humanPersonaApprovalChatId } : {}),
    });
    return {
      ...composition,
      config,
      appConfig,
      store,
      logger: options.logger,
      vectorEnabled: vector !== undefined,
      webSearchEnabled: webSearch !== undefined,
      researchGatewayEnabled: researchGateway !== undefined,
      activeWorkerCount: () => composition?.workerPump.activeWorkers ?? 0,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Reconciles independently parsed bot and shared application configuration
 * before SQLite is opened.
 */
export function assertBotDaemonConfiguration(
  bot: Readonly<BotRuntimeConfig>,
  app: Readonly<AppConfig>,
  chats: readonly AssistantChatConfig[],
  humanPersonaApprovalChatId?: string,
): void {
  if (!sameConfiguredFile(bot.dbPath, app.storage.dbPath)) {
    throw new Error(
      "Bot and Telegram services must use the same SQLite database.",
    );
  }
  // TELEGRAM_ALLOWED_CHAT_IDS scopes bot-agi-sync's Telegram allowlist --
  // a `transport: "vk"` chat has no MTProto/Bot-API identity to check
  // against it, so only Telegram-transport chats are validated here.
  const allowed = new Set(app.telegram.allowedChatIds.map(normalizeTelegramId));
  for (const chat of chats) {
    if (chat.transport !== "telegram") {
      continue;
    }
    if (!allowed.has(normalizeTelegramId(chat.allowedChatId))) {
      throw new Error(
        `BOT_BOTS_CONFIG_PATH assistant chat ${chat.allowedChatId} must be present in TELEGRAM_ALLOWED_CHAT_IDS.`,
      );
    }
  }
  const vkChatConfigured = chats.some((chat) => chat.transport === "vk");
  if (vkChatConfigured && bot.vk === undefined) {
    throw new Error(
      'BOT_BOTS_CONFIG_PATH lists a transport: "vk" chat but BOT_VK_GROUP_TOKEN is not set.',
    );
  }
  if (humanPersonaApprovalChatId !== undefined) {
    const normalizedApprovalChatId = normalizeTelegramId(
      humanPersonaApprovalChatId,
    );
    const collidingChat = chats.find(
      (chat) =>
        chat.transport === "telegram" &&
        normalizeTelegramId(chat.allowedChatId) === normalizedApprovalChatId,
    );
    if (collidingChat !== undefined) {
      throw new Error(
        "BOT_BOTS_CONFIG_PATH's human-persona approvalChatId must not be " +
          "one of the assistant chats: the approval chat must stay " +
          "structurally outside the assistant role's fold/turn state.",
      );
    }
  }
}

const DEFAULT_PRODUCTION_FACTORIES: ProductionBotDaemonFactories = {
  createApi(token) {
    return new Api(token);
  },
  createStore(path) {
    return new MessageStore(path);
  },
  createRouter(path, env) {
    return ModelRouter.fromFile(path, { env });
  },
  createVector(config, store) {
    return new VectorRag(config, store);
  },
  createWebSearch(config) {
    if (config.kind === "vertex") {
      return new VertexGeminiWebSearchProvider(config);
    }
    return new HttpJsonWebSearchProvider({
      endpoint: config.endpoint,
      bearerToken: config.bearerToken,
    });
  },
  createResearchGateway(config) {
    return new UnixSocketResearchGatewayProvider({
      socketPath: config.socketPath,
    });
  },
  createVk(config) {
    return createVkClient(config);
  },
  createVkUser(config) {
    if (config.userToken === undefined) {
      throw new Error(
        "createVkUser called without BOT_VK_USER_TOKEN configured.",
      );
    }
    return createVkUserClient(config.userToken, config.apiVersion);
  },
};

function sameConfiguredFile(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) {
    return true;
  }
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function normalizeTelegramId(value: string): string {
  if (!/^-?\d+$/u.test(value)) {
    throw invalidTelegramAllowlist();
  }
  try {
    return BigInt(value).toString();
  } catch {
    throw invalidTelegramAllowlist();
  }
}

function invalidTelegramAllowlist(): Error {
  return new Error("Telegram allowlist contains a non-integer chat id.");
}

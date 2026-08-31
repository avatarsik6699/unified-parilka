import type { BotRuntimeConfig, BotRuntimeEnvironment } from "./contracts.js";
import {
  absolutePath,
  boundedPlain,
  enumValue,
  existingAbsoluteFile,
  integer,
  normalizeBotUsername,
  requiredPlain,
  requiredSecret,
  sameConfiguredFile,
  telegramId,
  telegramIdList,
} from "./env-rules.js";
import { optionalResearchGatewayConfig } from "./research-gateway.js";
import { optionalImageGenerationConfig } from "./image-generation.js";
import { optionalVoiceReplyConfig } from "./voice-reply.js";
import { optionalNewsBriefTriggerConfig } from "./news-brief-trigger.js";
import { optionalVkConfig } from "./vk.js";
import { audioTranscribeConfig } from "./audio-transcribe.js";
import { requireLoopbackHttpOrigin } from "../web-tools/url-validation.js";
import {
  assertBotTokenShape,
  assertExclusivePoller,
  validateBotRuntimeRelationships,
} from "./validation.js";
import { optionalWebSearchConfig } from "./web-search.js";

const DEFAULT_SHARED_DB_PATH = "~/.telegram-parilka-mcp/messages.sqlite";

/**
 * Parses only the bot runtime environment. Secret values never appear in
 * validation messages and getUpdates ownership is explicit even in shadow.
 */
export function parseBotRuntimeConfig(
  env: BotRuntimeEnvironment = process.env,
): BotRuntimeConfig {
  const token = requiredSecret(env, "BOT_TOKEN");
  assertBotTokenShape(token);
  assertExclusivePoller(env);

  const botId = telegramId(requiredPlain(env, "BOT_ID"), "BOT_ID", "positive");
  const botUsername = normalizeBotUsername(requiredPlain(env, "BOT_USERNAME"));
  const sharedDbPath = absolutePath(
    env.TELEGRAM_DB_PATH ?? DEFAULT_SHARED_DB_PATH,
    "TELEGRAM_DB_PATH",
  );
  const requestedBotDbPath = absolutePath(
    env.BOT_DB_PATH ?? sharedDbPath,
    "BOT_DB_PATH",
  );
  if (!sameConfiguredFile(requestedBotDbPath, sharedDbPath)) {
    throw new Error(
      "BOT_DB_PATH must resolve to the same shared SQLite file as TELEGRAM_DB_PATH.",
    );
  }
  const mode = enumValue(
    env.BOT_MODE,
    "BOT_MODE",
    ["live", "shadow"] as const,
    "shadow",
  );

  const config: BotRuntimeConfig = {
    token,
    exclusivePollerConfirmed: true,
    botId,
    botUsername,
    botDisplayName: boundedPlain(
      env.BOT_DISPLAY_NAME ?? "Машина",
      "BOT_DISPLAY_NAME",
      128,
    ),
    historyDescription: boundedPlain(
      env.BOT_HISTORY_DESCRIPTION ?? "вся доступная локальная история чата",
      "BOT_HISTORY_DESCRIPTION",
      200,
    ),
    memoryWriteAuthorizerIds: telegramIdList(
      env.BOT_MEMORY_WRITE_SENDER_IDS,
      "BOT_MEMORY_WRITE_SENDER_IDS",
      16,
    ),
    // Always return the common spelling, including hard-link aliases.
    dbPath: sharedDbPath,
    modelConfigPath: existingAbsoluteFile(
      requiredPlain(env, "BOT_MODEL_CONFIG_PATH"),
      "BOT_MODEL_CONFIG_PATH",
    ),
    ...optionalWebSearchConfig(env),
    ...optionalResearchGatewayConfig(env),
    ...optionalImageGenerationConfig(env),
    ...optionalVoiceReplyConfig(env),
    ...optionalNewsBriefTriggerConfig(env),
    ...optionalVkConfig(env),
    audioTranscribe: audioTranscribeConfig(env),
    searxngEndpoint: requireLoopbackHttpOrigin(
      env.BOT_SEARXNG_ENDPOINT ?? "http://127.0.0.1:8080",
    ),
    firecrawlEndpoint: requireLoopbackHttpOrigin(
      env.BOT_FIRECRAWL_ENDPOINT ?? "http://127.0.0.1:3002",
    ),
    mode,
    workerConcurrency: integer(env.BOT_WORKERS, "BOT_WORKERS", 3, 1, 3),
    triggerCooldownMs: integer(
      env.BOT_TRIGGER_COOLDOWN_MS,
      "BOT_TRIGGER_COOLDOWN_MS",
      5_000,
      0,
      60_000,
    ),
    updateMaxAttempts: integer(
      env.BOT_UPDATE_MAX_ATTEMPTS,
      "BOT_UPDATE_MAX_ATTEMPTS",
      3,
      1,
      20,
    ),
    ...(env.BOT_INITIAL_OFFSET === undefined
      ? {}
      : {
          initialOffset: integer(
            env.BOT_INITIAL_OFFSET,
            "BOT_INITIAL_OFFSET",
            0,
            0,
            Number.MAX_SAFE_INTEGER - 1,
          ),
        }),
    pollTimeoutSec: integer(
      env.BOT_POLL_TIMEOUT_SEC,
      "BOT_POLL_TIMEOUT_SEC",
      30,
      1,
      50,
    ),
    pollLimit: integer(env.BOT_POLL_LIMIT, "BOT_POLL_LIMIT", 100, 1, 100),
    pollBackoffInitialMs: integer(
      env.BOT_POLL_BACKOFF_INITIAL_MS,
      "BOT_POLL_BACKOFF_INITIAL_MS",
      1_000,
      10,
      60_000,
    ),
    pollBackoffMaxMs: integer(
      env.BOT_POLL_BACKOFF_MAX_MS,
      "BOT_POLL_BACKOFF_MAX_MS",
      30_000,
      10,
      5 * 60_000,
    ),
    modelStepTimeoutMs: integer(
      env.BOT_MODEL_STEP_TIMEOUT_MS,
      "BOT_MODEL_STEP_TIMEOUT_MS",
      180_000,
      1_000,
      15 * 60_000,
    ),
    publishTimeoutMs: integer(
      env.BOT_PUBLISH_TIMEOUT_MS,
      "BOT_PUBLISH_TIMEOUT_MS",
      30_000,
      1_000,
      5 * 60_000,
    ),
    shutdownTimeoutMs: integer(
      env.BOT_SHUTDOWN_TIMEOUT_MS,
      "BOT_SHUTDOWN_TIMEOUT_MS",
      660_000,
      1_000,
      15 * 60_000,
    ),
  };
  validateBotRuntimeRelationships(config);
  return config;
}

import type { AppConfig } from "../config.js";
import { TelegramService } from "../telegram-client.js";
import {
  createMtcuteBaseClient,
  MtcuteTelegramService,
  type MtcuteTransportConfig,
} from "./mtcute-client.js";
import {
  importGramjsStringSession,
  type GramjsSessionImportResult,
  type MtcuteSessionImportTarget,
} from "./session-import.js";
import type { TelegramGateway } from "./types.js";

type BootstrapClient = MtcuteSessionImportTarget & {
  destroy(): Promise<void>;
};

export type TelegramGatewayFactoryDependencies = {
  createGramjsGateway?: (
    config: AppConfig,
  ) => TelegramGateway | PromiseLike<TelegramGateway>;
  createMtcuteGateway?: (
    config: MtcuteTransportConfig,
  ) => TelegramGateway | PromiseLike<TelegramGateway>;
  createMtcuteBootstrapClient?: (
    config: MtcuteTransportConfig,
  ) => BootstrapClient | PromiseLike<BootstrapClient>;
  importGramjsSession?: (
    target: MtcuteSessionImportTarget,
    session: string,
  ) => GramjsSessionImportResult | PromiseLike<GramjsSessionImportResult>;
};

/**
 * Creates the one transport facade owned by an entrypoint. For mtcute, a
 * configured GramJS StringSession is imported into mtcute's private auth
 * database before the long-lived client can be constructed.
 */
export async function createTelegramGateway(
  config: AppConfig,
  dependencies: TelegramGatewayFactoryDependencies = {},
): Promise<TelegramGateway> {
  if (config.telegram.transport === "gramjs") {
    const createGramjs =
      dependencies.createGramjsGateway ??
      ((appConfig: AppConfig) => new TelegramService(appConfig));
    return createGramjs(config);
  }

  const mtcuteConfig = mtcuteTransportConfigFromAppConfig(config);
  if (config.telegram.session) {
    const createBootstrap =
      dependencies.createMtcuteBootstrapClient ??
      ((transportConfig: MtcuteTransportConfig) =>
        createMtcuteBaseClient(transportConfig));
    const importSession =
      dependencies.importGramjsSession ?? importGramjsStringSession;
    const bootstrap = await createBootstrap(mtcuteConfig);
    let importError: unknown;
    try {
      await importSession(bootstrap, config.telegram.session);
    } catch (error) {
      importError = error;
    }

    try {
      await bootstrap.destroy();
    } catch (destroyError) {
      if (importError === undefined) {
        throw destroyError;
      }
    }
    if (importError !== undefined) {
      throw importError;
    }
  }

  const createMtcute =
    dependencies.createMtcuteGateway ??
    ((transportConfig: MtcuteTransportConfig) =>
      new MtcuteTelegramService(transportConfig));
  return createMtcute(mtcuteConfig);
}

export function mtcuteTransportConfigFromAppConfig(
  config: AppConfig,
): MtcuteTransportConfig {
  return {
    apiId: config.telegram.apiId,
    apiHash: config.telegram.apiHash,
    authStoragePath: config.telegram.mtcute.authStoragePath,
    applicationDbPath: config.storage.dbPath,
    defaultChatId: config.telegram.defaultChatId,
    allowedChatIds: config.telegram.allowedChatIds,
    requireAllowlistedChat: config.telegram.requireAllowlistedChat,
    historyPageSize: config.telegram.mtcute.historyPageSize,
    maxHistoryMessages: config.telegram.mtcute.maxHistoryMessages,
    connectionMaxAttempts: config.telegram.mtcute.connectionMaxAttempts,
    connectionTimeoutMs: config.telegram.mtcute.connectionTimeoutMs,
    connectionRetryInitialMs:
      config.telegram.mtcute.connectionRetryInitialMs,
    connectionRetryMaxMs: config.telegram.mtcute.connectionRetryMaxMs,
    requestTimeoutMs: config.telegram.mtcute.requestTimeoutMs,
    requestMaxRetries: config.telegram.mtcute.requestMaxRetries,
    requestRetryDelayMs: config.telegram.mtcute.requestRetryDelayMs,
    floodWaitMaxMs: config.telegram.mtcute.floodWaitMaxMs,
  };
}

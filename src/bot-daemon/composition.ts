import type { Api } from "grammy";
import { AiSdkBotTurnAgent } from "../bot/ai-agent.js";
import { CanonicalBotReadCache } from "../bot/read-cache.js";
import { BotReadTools } from "../bot/read-tools.js";
import {
  BotApiLongPoller,
  BotApiRuntime,
  BotUpdateProcessor,
  BotWorkerPump,
  botRuntimeOptionsFromConfig,
  createDurableGrammyBotTurnPublisher,
  createGrammyLongPollingApi,
} from "../bot/runtime.js";
import { TurnCoordinator } from "../bot/turn-coordinator.js";
import type { TypingPort } from "../bot/typing.js";
import { BotTurnWorker } from "../bot/worker.js";
import type {
  BotDaemonComposition,
  ComposeBotDaemonOptions,
} from "./contracts.js";
import { coordinatorTraceOptions } from "./trace.js";

/**
 * Pure composition root: construction performs no Telegram or model I/O.
 */
export function composeBotDaemon(
  options: ComposeBotDaemonOptions,
): BotDaemonComposition {
  const { config } = options;
  const workerIdPrefix = requireWorkerIdPrefix(
    options.workerIdPrefix ?? `bot:${process.pid}`,
  );
  const coordinator = new TurnCoordinator({
    maxActiveTurns: config.workerConcurrency,
    capacityPolicy: "refuse",
    ...coordinatorTraceOptions(options.logger),
  });
  const cache = new CanonicalBotReadCache({
    store: options.store,
    ...(options.vector === undefined
      ? {}
      : { vector: options.vector }),
  });
  const readTools = new BotReadTools({
    chatId: config.allowedChatId,
    cache,
    ...(options.webSearch === undefined
      ? {}
      : { webSearch: options.webSearch }),
    timeZone: "Europe/Moscow",
  });
  const agent = new AiSdkBotTurnAgent({
    router: options.router,
    readTools,
    prompt: {
      botUsername: config.botUsername,
      botName: config.botDisplayName,
      chatTitle: config.chatTitle,
      historyDescription: config.historyDescription,
      ...(config.approximateMemberCount === undefined
        ? {}
        : {
            approximateMemberCount:
              config.approximateMemberCount,
          }),
    },
    logger: options.logger,
    totalTimeoutMs: config.turnTimeoutMs,
    stepTimeoutMs: Math.min(60_000, config.turnTimeoutMs),
    toolTimeoutMs: Math.min(15_000, config.turnTimeoutMs),
  });
  const publisher = createDurableGrammyBotTurnPublisher(options.api, {
    store: options.store,
    botId: config.botId,
    botUsername: config.botUsername,
  });
  const typingPort: TypingPort = {
    sendChatAction: (chatId, signal) =>
      options.api
        .sendChatAction(
          chatId,
          "typing",
          signal as unknown as Parameters<Api["sendChatAction"]>[2],
        )
        .then(() => undefined),
  };
  const workers = Array.from(
    { length: config.workerConcurrency },
    (_unused, index) =>
      new BotTurnWorker({
        store: options.store,
        coordinator,
        agent,
        publisher,
        workerId: `${workerIdPrefix}:${index + 1}`,
        allowedChatId: config.allowedChatId,
        mode: config.mode,
        turnTimeoutMs: config.turnTimeoutMs,
        publishTimeoutMs: config.publishTimeoutMs,
        additionalAllowedMentions: config.allowedMentions,
        typingPort,
        logger: options.logger,
      }),
  );
  const workerPump = new BotWorkerPump({
    workers,
    logger: options.logger,
  });
  const processor = new BotUpdateProcessor({
    store: options.store,
    coordinator,
    workNotifier: workerPump,
    telegram: {
      allowedChatId: config.allowedChatId,
      botId: config.botId,
      botUsername: config.botUsername,
    },
    triggerCooldownMs: config.triggerCooldownMs,
    updateMaxAttempts: config.updateMaxAttempts,
    logger: options.logger,
  });
  const poller = new BotApiLongPoller({
    api: createGrammyLongPollingApi(options.api),
    processor,
    ...botRuntimeOptionsFromConfig(config),
    logger: options.logger,
  });
  const runtime = new BotApiRuntime({
    poller,
    workers: workerPump,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    logger: options.logger,
  });

  return {
    runtime,
    poller,
    workerPump,
    workers,
    processor,
    coordinator,
    cache,
    readTools,
    agent,
  };
}

function requireWorkerIdPrefix(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/u.test(normalized)
  ) {
    throw new TypeError(
      "workerIdPrefix must contain 1-128 machine-safe characters.",
    );
  }
  return normalized;
}

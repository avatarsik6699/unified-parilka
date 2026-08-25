import { dirname, join } from "node:path";
import type { Api } from "grammy";
import { AiSdkCuriosityDecisionPort } from "../assistant-curiosity/port.js";
import {
  CuriosityTriggerLoop,
  type CuriosityTriggerChatRuntime,
} from "../assistant-curiosity-loop.js";
import { AiSdkBotTurnAgent } from "../bot/ai-agent.js";
import { BotMemoryTools } from "../bot/memory-tools.js";
import { BotMediaTools } from "../bot/media-tools.js";
import { FlovAudioTranscriber } from "../bot/media/flov-transcriber.js";
import { createNewsBriefTrigger } from "../bot/news-brief-trigger.js";
import { CanonicalBotReadCache } from "../bot/read-cache.js";
import { BotReadTools } from "../bot/read-tools.js";
import { FirecrawlClient } from "../bot/web-tools/firecrawl-client.js";
import { SearXNGClient } from "../bot/web-tools/searxng-client.js";
import {
  BotApiLongPoller,
  BotApiRuntime,
  BotUpdateProcessor,
  BotWorkerPump,
  botRuntimeOptionsFromConfig,
  createApprovalPosterApiPort,
  createAssistantCuriositySendPort,
  createDurableGrammyBotTurnPublisher,
  createGrammyLongPollingApi,
  createGrammyTelegramMediaDownloader,
  createReactionGrammyBotApiPort,
  createToolProgressGrammyBotApiPort,
} from "../bot/runtime.js";
import { TurnCoordinator } from "../bot/turn-coordinator.js";
import type { TypingPort } from "../bot/typing.js";
import { BotTurnWorker } from "../bot/worker.js";
import { ApprovalPosterLoop } from "../human-persona-approval-poster.js";
import type {
  BotDaemonChatComposition,
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
  const cache = new CanonicalBotReadCache({
    store: options.store,
    ...(options.vector === undefined ? {} : { vector: options.vector }),
    logger: options.logger,
    botSenderId: config.botId,
    rerankMaxCandidates:
      options.appConfig?.embeddings?.rerankMaxCandidates ?? 0,
  });
  const memoryTools = new BotMemoryTools({
    store: options.store,
    writeAuthorizerIds: config.memoryWriteAuthorizerIds,
  });
  const mediaTools = new BotMediaTools({
    downloader: createGrammyTelegramMediaDownloader(options.api, config.token),
    transcriber: new FlovAudioTranscriber({
      endpoint: `${config.audioTranscribe.endpoint}/v1/audio/transcriptions`,
      timeoutMs: config.audioTranscribe.timeoutMs,
      language: "ru",
      ...(config.audioTranscribe.bearerToken === undefined
        ? {}
        : { bearerToken: config.audioTranscribe.bearerToken }),
    }),
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
  const toolProgressBotApiPort = createToolProgressGrammyBotApiPort(
    options.api,
  );
  const reactionBotApiPort = createReactionGrammyBotApiPort(options.api);
  const newsBriefTrigger =
    config.newsBriefTrigger === undefined
      ? undefined
      : createNewsBriefTrigger({
          privilegedUserId: config.newsBriefTrigger.triggerUserId,
          api: options.api,
          store: options.store,
          router: options.router,
          searxng: new SearXNGClient({ origin: config.searxngEndpoint }),
          firecrawl: new FirecrawlClient({ origin: config.firecrawlEndpoint }),
          seenStorePath:
            config.newsBriefTrigger.seenStorePath ??
            join(dirname(config.dbPath), "news-brief-seen.json"),
          logger: options.logger,
        });

  // One full graph per assistant-role chat (Фаза 7): the coordinator's
  // fold/routing has no chat filter, so it -- and everything built against
  // it -- must not be shared across chats.
  const chats = new Map<string, BotDaemonChatComposition>();
  for (const chat of options.chats) {
    const coordinator = new TurnCoordinator({
      maxActiveTurns: config.workerConcurrency,
      capacityPolicy: "refuse",
      ...coordinatorTraceOptions(options.logger),
    });
    const readTools = new BotReadTools({
      chatId: chat.allowedChatId,
      cache,
      botSenderId: config.botId,
      ...(options.webSearch === undefined
        ? {}
        : { webSearch: options.webSearch }),
      ...(options.researchGateway === undefined
        ? {}
        : {
            researchGateway: options.researchGateway,
            ...(config.researchGateway === undefined
              ? {}
              : {
                  researchGatewayTimeoutMs: config.researchGateway.timeoutMs,
                }),
          }),
      timeZone: "Europe/Moscow",
    });
    const agent = new AiSdkBotTurnAgent({
      router: options.router,
      readTools,
      mediaTools,
      memoryTools,
      prompt: {
        botUsername: config.botUsername,
        botName: config.botDisplayName,
        chatTitle: chat.chatTitle,
        personaPrompt: chat.personaPrompt,
        historyDescription: config.historyDescription,
        memoryMaxChars: options.appConfig?.memory?.memoryMaxChars ?? 2_000,
        botSenderId: config.botId,
        ...(chat.approximateMemberCount === undefined
          ? {}
          : { approximateMemberCount: chat.approximateMemberCount }),
      },
      logger: options.logger,
      stepTimeoutMs: config.modelStepTimeoutMs,
      toolTimeoutMs: Math.min(
        config.audioTranscribe.timeoutMs,
        config.modelStepTimeoutMs,
      ),
      searxngEndpoint: config.searxngEndpoint,
      firecrawlEndpoint: config.firecrawlEndpoint,
      ...(config.imageGeneration === undefined
        ? {}
        : { imageGeneration: config.imageGeneration }),
      ...(config.voiceReply === undefined
        ? {}
        : { voiceReply: config.voiceReply }),
    });
    const workers = Array.from(
      { length: config.workerConcurrency },
      (_unused, index) =>
        new BotTurnWorker({
          store: options.store,
          coordinator,
          agent,
          publisher,
          workerId: `${workerIdPrefix}:${chat.allowedChatId}:${index + 1}`,
          allowedChatId: chat.allowedChatId,
          mode: config.mode,
          publishTimeoutMs: config.publishTimeoutMs,
          typingPort,
          toolProgressBotApiPort,
          reactionBotApiPort,
          logger: options.logger,
          botSenderId: config.botId,
        }),
    );
    chats.set(chat.allowedChatId, { coordinator, readTools, agent, workers });
  }

  const workers = Array.from(chats.values()).flatMap((chat) => chat.workers);
  const coordinators = new Map(
    Array.from(chats.entries(), ([chatId, chat]) => [chatId, chat.coordinator]),
  );
  const workerPump = new BotWorkerPump({
    workers,
    logger: options.logger,
  });
  const processor = new BotUpdateProcessor({
    store: options.store,
    coordinators,
    workNotifier: workerPump,
    telegram: {
      allowedChatIds: new Set(chats.keys()),
      botId: config.botId,
      botUsername: config.botUsername,
      ...(options.humanPersonaApprovalChatId === undefined
        ? {}
        : { humanPersonaApprovalChatId: options.humanPersonaApprovalChatId }),
    },
    triggerCooldownMs: config.triggerCooldownMs,
    updateMaxAttempts: config.updateMaxAttempts,
    logger: options.logger,
    ...(newsBriefTrigger === undefined ? {} : { newsBriefTrigger }),
  });
  const poller = new BotApiLongPoller({
    api: createGrammyLongPollingApi(options.api),
    processor,
    ...botRuntimeOptionsFromConfig(config),
    logger: options.logger,
  });
  const approvalPoster =
    options.humanPersonaId !== undefined &&
    options.humanPersonaApprovalChatId !== undefined
      ? new ApprovalPosterLoop({
          store: options.store,
          api: createApprovalPosterApiPort(options.api),
          personaId: options.humanPersonaId,
          approvalChatId: options.humanPersonaApprovalChatId,
          claimedBy: workerIdPrefix,
        })
      : undefined;
  const curiosityTrigger = buildCuriosityTriggerLoop(options, config);
  const runtime = new BotApiRuntime({
    poller,
    workers: workerPump,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    logger: options.logger,
    ...(approvalPoster === undefined ? {} : { approvalPoster }),
    ...(curiosityTrigger === undefined ? {} : { curiosityTrigger }),
  });

  return {
    runtime,
    poller,
    workerPump,
    ...(approvalPoster === undefined ? {} : { approvalPoster }),
    ...(curiosityTrigger === undefined ? {} : { curiosityTrigger }),
    workers,
    processor,
    chats,
    cache,
    mediaTools,
    memoryTools,
  };
}

/**
 * Builds one curiosity-trigger loop covering every assistant chat that opts
 * in via `curiosityTrigger.enabled` (undefined when none do). A single loop
 * polling multiple chats, not one loop per chat -- see
 * `src/assistant-curiosity-loop.ts`.
 */
function buildCuriosityTriggerLoop(
  options: ComposeBotDaemonOptions,
  config: ComposeBotDaemonOptions["config"],
): CuriosityTriggerLoop | undefined {
  const enabledChats = options.chats.filter(
    (chat) => chat.curiosityTrigger?.enabled === true,
  );
  if (enabledChats.length === 0) {
    return undefined;
  }
  const send = createAssistantCuriositySendPort(options.api, {
    store: options.store,
    botId: config.botId,
    botUsername: config.botUsername,
  });
  const chats: CuriosityTriggerChatRuntime[] = enabledChats.map((chat) => {
    const heuristics = chat.curiosityTrigger!;
    return {
      config: {
        chatId: chat.allowedChatId,
        chatTitle: chat.chatTitle,
        personaPrompt: chat.personaPrompt,
        botDisplayName: config.botDisplayName,
        heuristics: {
          activeHourStartMoscow: heuristics.activeHourStartMoscow,
          activeHourEndMoscow: heuristics.activeHourEndMoscow,
          minSilenceMs: heuristics.minSilenceMs,
          minSilenceSinceOwnQuestionMs: heuristics.minSilenceSinceOwnQuestionMs,
          maxInitiationsPerWindow: heuristics.maxInitiationsPerWindow,
          windowMs: heuristics.windowMs,
          pendingAnswerGraceMs: heuristics.pendingAnswerGraceMs,
          baseAskProbability: heuristics.baseAskProbability,
          maxAskProbability: heuristics.maxAskProbability,
        },
      },
      send,
    };
  });
  const idleIntervalMs = Math.min(
    ...enabledChats.map((chat) => chat.curiosityTrigger!.idleIntervalMs),
  );
  return new CuriosityTriggerLoop({
    store: options.store,
    port: new AiSdkCuriosityDecisionPort(options.router),
    chats,
    idleIntervalMs,
    onTick: (chatId, report) => {
      // Best-effort observability for the probabilistic gate (see
      // src/assistant-curiosity/heuristics.ts) -- without this, "why didn't
      // it ask today" is unanswerable after the fact.
      try {
        options.logger?.info({
          event: "assistant_curiosity.tick",
          chatId,
          status: report.status,
          ...(report.reason === undefined ? {} : { reason: report.reason }),
          ...(report.probability === undefined
            ? {}
            : { probability: report.probability }),
          ...(report.messageId === undefined
            ? {}
            : { messageId: report.messageId }),
        });
      } catch {
        // Logging is best-effort.
      }
    },
  });
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

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
  MAX_BOT_WORKER_CONCURRENCY,
  botRuntimeOptionsFromConfig,
  createApprovalPosterApiPort,
  createAssistantCuriositySendPort,
  createDurableGrammyBotTurnPublisher,
  createGrammyLongPollingApi,
  createGrammyTelegramMediaDownloader,
  createReactionGrammyBotApiPort,
  createToolProgressGrammyBotApiPort,
} from "../bot/runtime.js";
import {
  VkBotTurnPublisher,
  createVkToolProgressBotApiPort,
} from "../bot/runtime/vk-adapters.js";
import { TurnCoordinator } from "../bot/turn-coordinator.js";
import type { TypingPort } from "../bot/typing.js";
import type { BotTurnPublisher } from "../bot/worker.js";
import { BotTurnWorker } from "../bot/worker.js";
import { VkLongPollLoop } from "../vk/long-poll-loop.js";
import {
  VkHistoryBackfillLoop,
  createVkHistoryBackfillPort,
} from "../vk/history-backfill.js";
import { peerIdFromVkChatId } from "../vk/types.js";
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
  const vkPublisher: BotTurnPublisher | undefined =
    options.vkApi === undefined
      ? undefined
      : new VkBotTurnPublisher(options.vkApi);
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
  // VK typing indicator (`messages.setActivity`) was tried and reverted: it
  // reproducibly returns `[10] Internal server error` for this community
  // token/beседа (confirmed directly against the live VK API with and
  // without `group_id`, outside this codebase, before wiring anything) --
  // a VK-side limitation, not a bug here, and calling it on every typing-
  // heartbeat tick risked tripping VK's flood control on the whole token,
  // which would also break real message sends. Instead, VK gets the same
  // visible-progress-message substitute Telegram already has
  // (`createVkToolProgressBotApiPort`): a placeholder message, edited as
  // tool calls progress, deleted before the final answer.
  const toolProgressBotApiPort = createToolProgressGrammyBotApiPort(
    options.api,
  );
  const vkToolProgressBotApiPort =
    options.vkApi === undefined || config.vk === undefined
      ? undefined
      : createVkToolProgressBotApiPort(options.vkApi, config.vk.groupId);
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
  //
  // BotWorkerPump enforces one process-wide worker cap
  // (MAX_BOT_WORKER_CONCURRENCY), not a per-chat one -- with N>1 chats each
  // naively getting config.workerConcurrency workers, the flattened total
  // can exceed that cap (this is exactly what happens the first time a
  // second chat/transport is configured). Distribute the shared budget
  // across chats instead: each chat gets at least one worker, remainder
  // handed out to the first chats in config order, all clamped by the
  // operator's own config.workerConcurrency ceiling.
  const workersPerChat = distributeWorkerBudget(
    options.chats.length,
    config.workerConcurrency,
  );
  const chats = new Map<string, BotDaemonChatComposition>();
  for (const [chatIndex, chat] of options.chats.entries()) {
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
        transport: chat.transport,
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
    // VK chats get no Bot-API-only typing indicator or message-reaction port
    // (`src/bot/typing.ts`, `src/bot/web-tools/reaction-contracts.ts`) --
    // `messages.setActivity` was tried and reverted (see the comment above
    // `toolProgressBotApiPort`) and VK has no reaction equivalent wired in
    // v1; both are optional on `BotTurnWorkerOptions`, so the worker simply
    // skips them. VK does get its own ephemeral progress message
    // (`vkToolProgressBotApiPort`) and, as a v1 experiment requested by the
    // operator, no telemetry footer under its answers.
    const chatPublisher =
      chat.transport === "vk" ? requireVkPublisher(vkPublisher) : publisher;
    const workers = Array.from(
      { length: workersPerChat[chatIndex] },
      (_unused, index) =>
        new BotTurnWorker({
          store: options.store,
          coordinator,
          agent,
          publisher: chatPublisher,
          workerId: `${workerIdPrefix}:${chat.allowedChatId}:${index + 1}`,
          allowedChatId: chat.allowedChatId,
          mode: config.mode,
          publishTimeoutMs: config.publishTimeoutMs,
          logger: options.logger,
          botSenderId: config.botId,
          ...(chat.transport === "vk"
            ? {
                telemetryFooter: false,
                ...(vkToolProgressBotApiPort === undefined
                  ? {}
                  : { toolProgressBotApiPort: vkToolProgressBotApiPort }),
              }
            : { typingPort, toolProgressBotApiPort, reactionBotApiPort }),
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
  const telegramChatIds = new Set(
    options.chats
      .filter((chat) => chat.transport === "telegram")
      .map((chat) => chat.allowedChatId),
  );
  const vkChatIds = new Set(
    options.chats
      .filter((chat) => chat.transport === "vk")
      .map((chat) => chat.allowedChatId),
  );
  const processor = new BotUpdateProcessor({
    store: options.store,
    coordinators,
    workNotifier: workerPump,
    telegram: {
      allowedChatIds: telegramChatIds,
      botId: config.botId,
      botUsername: config.botUsername,
      ...(options.humanPersonaApprovalChatId === undefined
        ? {}
        : { humanPersonaApprovalChatId: options.humanPersonaApprovalChatId }),
    },
    ...(config.vk === undefined
      ? {}
      : { vk: { allowedChatIds: vkChatIds, groupId: config.vk.groupId } }),
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
  const vkPoller =
    options.vkApi === undefined
      ? undefined
      : new VkLongPollLoop({
          vk: options.vkApi,
          processor,
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
  const vkHistoryBackfill = buildVkHistoryBackfillLoop(options, config);
  const runtime = new BotApiRuntime({
    poller,
    workers: workerPump,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    logger: options.logger,
    ...(approvalPoster === undefined ? {} : { approvalPoster }),
    ...(curiosityTrigger === undefined ? {} : { curiosityTrigger }),
    ...(vkPoller === undefined ? {} : { vkPoller }),
    ...(vkHistoryBackfill === undefined ? {} : { vkHistoryBackfill }),
  });

  return {
    runtime,
    poller,
    workerPump,
    ...(approvalPoster === undefined ? {} : { approvalPoster }),
    ...(curiosityTrigger === undefined ? {} : { curiosityTrigger }),
    ...(vkHistoryBackfill === undefined ? {} : { vkHistoryBackfill }),
    workers,
    processor,
    chats,
    cache,
    mediaTools,
    memoryTools,
  };
}

/**
 * Builds the VK pre-join history backfill loop (undefined unless both
 * `BOT_VK_USER_TOKEN` is set and at least one `transport: "vk"` chat is
 * configured) -- see `src/vk/history-backfill.ts` for why this needs a
 * separate personal-account client from the community `vkApi`.
 */
function buildVkHistoryBackfillLoop(
  options: ComposeBotDaemonOptions,
  config: ComposeBotDaemonOptions["config"],
): VkHistoryBackfillLoop | undefined {
  if (
    options.vkUserApi === undefined ||
    config.vk === undefined ||
    config.vk.userToken === undefined
  ) {
    return undefined;
  }
  const vkChats = options.chats
    .filter((chat) => chat.transport === "vk")
    .map((chat) => {
      const peerId = peerIdFromVkChatId(chat.allowedChatId);
      return peerId === undefined
        ? undefined
        : { chatId: chat.allowedChatId, peerId, chatTitle: chat.chatTitle };
    })
    .filter((chat): chat is NonNullable<typeof chat> => chat !== undefined);
  if (vkChats.length === 0) {
    return undefined;
  }
  return new VkHistoryBackfillLoop({
    store: options.store,
    port: createVkHistoryBackfillPort(options.vkUserApi),
    chats: vkChats,
    totalLimit: config.vk.historyBackfillLimit,
    logger: options.logger,
  });
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

/**
 * Splits the process-wide MAX_BOT_WORKER_CONCURRENCY budget across
 * `chatCount` chats: each gets `floor(budget / chatCount)`, clamped by
 * `perChatCeiling` (the operator's own BOT_WORKERS setting), with the
 * remainder handed to the first chats in config order so the budget isn't
 * left partially unused. `chatCount` exceeding the budget is a
 * configuration error (no chat can end up with zero workers), not silently
 * degraded -- `selectAssistantChats`'s own MAX_ASSISTANT_CHATS ceiling (5)
 * is higher than this budget (3), so this is reachable in practice.
 */
function distributeWorkerBudget(
  chatCount: number,
  perChatCeiling: number,
): readonly number[] {
  if (chatCount > MAX_BOT_WORKER_CONCURRENCY) {
    throw new Error(
      `BOT_BOTS_CONFIG_PATH lists ${String(chatCount)} assistant chats, exceeding the process-wide worker budget of ${String(MAX_BOT_WORKER_CONCURRENCY)} (MAX_BOT_WORKER_CONCURRENCY) -- each chat needs at least one dedicated worker. Reduce the number of configured chats or raise the budget.`,
    );
  }
  const baseline = Math.floor(MAX_BOT_WORKER_CONCURRENCY / chatCount);
  const remainder = MAX_BOT_WORKER_CONCURRENCY - baseline * chatCount;
  return Array.from({ length: chatCount }, (_unused, index) =>
    Math.min(perChatCeiling, baseline + (index < remainder ? 1 : 0)),
  );
}

function requireVkPublisher(
  publisher: BotTurnPublisher | undefined,
): BotTurnPublisher {
  if (publisher === undefined) {
    // Invariant violation, not a runtime input error: `assertBotDaemonConfiguration`
    // (bot-daemon/production.ts) already refuses to start a `transport: "vk"`
    // chat without BOT_VK_GROUP_TOKEN configured.
    throw new Error(
      'A transport: "vk" chat was composed without a VK API client.',
    );
  }
  return publisher;
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

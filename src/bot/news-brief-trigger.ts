import type { Api } from "grammy";
import { calendarDayInTimeZone } from "../digests.js";
import {
  AiSdkNewsBriefSummaryPort,
  NEWS_BRIEF_TIME_ZONE,
  NewsBriefSeenStore,
  grammyNewsBriefApi,
  runNewsBrief,
  type NewsBriefModelRouter,
} from "../news-brief.js";
import type { FirecrawlClient } from "./web-tools/firecrawl-client.js";
import type { SearXNGClient } from "./web-tools/searxng-client.js";
import { createReactionGrammyBotApiPort } from "./runtime/grammy-adapters.js";
import type { NewsBriefTriggerPort } from "./runtime/contracts.js";
import type { JsonEventLogger } from "./worker.js";
import type { MessageStore } from "../store.js";

const TRIGGER_PHRASE = "daily news-brief";
const TRIGGER_RUN_TIMEOUT_MS = 8 * 60_000;
const TRIGGER_THROTTLE = {
  maxAgeMs: 10 * 60_000,
  userCooldownMs: 0,
  maxPendingPerUserPerChat: 1,
  maxQueuePerChat: 1,
};

export interface CreateNewsBriefTriggerOptions {
  privilegedUserId: string;
  api: Pick<Api, "sendMessage" | "setMessageReaction">;
  store: MessageStore;
  router: NewsBriefModelRouter;
  searxng: Pick<SearXNGClient, "search">;
  firecrawl: Pick<FirecrawlClient, "crawl">;
  seenStorePath: string;
  logger?: JsonEventLogger;
}

/**
 * Lets exactly one Telegram user id trigger an early news-brief run by
 * messaging the bot the exact phrase "daily news-brief" -- authorization is
 * a host-code identity check against `privilegedUserId`, never a prompt-
 * level instruction, so it cannot be granted or bypassed through chat text
 * or prompt injection from any other sender.
 */
export function createNewsBriefTrigger(
  options: CreateNewsBriefTriggerOptions,
): NewsBriefTriggerPort {
  const reactionApi = createReactionGrammyBotApiPort(options.api);
  const telegramApi = grammyNewsBriefApi(options.api);
  const summaryPort = new AiSdkNewsBriefSummaryPort(options.router);

  return {
    tryTrigger(message) {
      if (
        message.senderId === undefined ||
        message.senderId !== options.privilegedUserId ||
        normalizeTriggerText(message.text) !== TRIGGER_PHRASE
      ) {
        return false;
      }
      void runTriggeredNewsBrief({
        chatId: message.chatId,
        messageId: message.messageId,
        reactionApi,
        telegramApi,
        rawApi: options.api,
        summaryPort,
        searxng: options.searxng,
        firecrawl: options.firecrawl,
        store: options.store,
        seenStorePath: options.seenStorePath,
        logger: options.logger,
      });
      return true;
    },
  };
}

/** Strips a leading `@botname` mention token and normalizes case/whitespace. */
function normalizeTriggerText(text: string): string {
  return text
    .replace(/^@\S+\s+/u, "")
    .trim()
    .toLowerCase();
}

async function runTriggeredNewsBrief(params: {
  chatId: string;
  messageId: number;
  reactionApi: ReturnType<typeof createReactionGrammyBotApiPort>;
  telegramApi: ReturnType<typeof grammyNewsBriefApi>;
  rawApi: Pick<Api, "sendMessage">;
  summaryPort: AiSdkNewsBriefSummaryPort;
  searxng: Pick<SearXNGClient, "search">;
  firecrawl: Pick<FirecrawlClient, "crawl">;
  store: MessageStore;
  seenStorePath: string;
  logger?: JsonEventLogger;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIGGER_RUN_TIMEOUT_MS);
  timer.unref?.();
  await params.reactionApi.setMessageReaction(
    params.chatId,
    params.messageId,
    "👀",
    controller.signal,
  );
  try {
    const startedAtMs = Date.now();
    const seenStore = NewsBriefSeenStore.load(params.seenStorePath);
    const report = await runNewsBrief({
      store: params.store,
      chatId: params.chatId,
      apply: true,
      searxng: params.searxng,
      firecrawl: params.firecrawl,
      seenStore,
      summaryPort: params.summaryPort,
      api: params.telegramApi,
      throttle: TRIGGER_THROTTLE,
      // Unique per trigger, deliberately not the scheduled day-key: a manual
      // test run must never collide with (or block) the daily timer's send.
      dayKey: `manual:${calendarDayInTimeZone(
        new Date(startedAtMs),
        NEWS_BRIEF_TIME_ZONE,
      )}:${startedAtMs}`,
      signal: controller.signal,
    });
    params.logger?.info({
      event: "news_brief.trigger_completed",
      chatId: params.chatId,
      status: report.status,
      sendOutcome: report.send?.outcome,
    });
    if (report.status === "empty") {
      await replyBestEffort(
        params.rawApi,
        params.chatId,
        params.messageId,
        "Свежих новостей не нашлось.",
      );
    }
  } catch (error) {
    params.logger?.error({
      event: "news_brief.trigger_failed",
      chatId: params.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    await replyBestEffort(
      params.rawApi,
      params.chatId,
      params.messageId,
      "Не получилось собрать дайджест, проверь логи.",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function replyBestEffort(
  api: Pick<Api, "sendMessage">,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      reply_parameters: { message_id: messageId },
    } as Parameters<Api["sendMessage"]>[2]);
  } catch {
    // Best-effort status reply; the trigger itself already succeeded/failed.
  }
}

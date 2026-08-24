import type { FirecrawlClient } from "../bot/web-tools/firecrawl-client.js";
import type { SearXNGClient } from "../bot/web-tools/searxng-client.js";
import type { MessageStore } from "../store.js";
import { collectNewsBriefSources, normalizeUrl } from "./collect.js";
import { enrichWithArticleText } from "./enrich.js";
import type { NewsBriefSeenStore } from "./seen-store.js";
import {
  sendNewsBrief,
  type NewsBriefTelegramApi,
  type NewsBriefThrottleOptions,
} from "./send.js";
import {
  DEFAULT_MAX_ITEMS,
  DEFAULT_NEWS_BRIEF_TOPICS,
  MAX_ENRICH_ITEMS,
  MAX_ITEMS_CEILING,
  MAX_MESSAGE_CHARS,
  NEWS_BRIEF_TIME_ZONE,
  type NewsBriefRunReport,
  type NewsBriefSummaryPort,
} from "./types.js";

export interface RunNewsBriefOptions {
  store: MessageStore;
  chatId: string;
  apply: boolean;
  searxng: Pick<SearXNGClient, "search">;
  firecrawl: Pick<FirecrawlClient, "crawl">;
  seenStore: NewsBriefSeenStore;
  /** Absent means dry-run-only: collection/enrichment run, but nothing is summarized or sent. */
  summaryPort?: NewsBriefSummaryPort;
  api?: NewsBriefTelegramApi;
  topics?: readonly string[];
  maxItems?: number;
  throttle: NewsBriefThrottleOptions;
  /** Calendar day key (e.g. "2026-08-24") -- the send dedupe key. */
  dayKey: string;
  now?: () => Date;
  signal: AbortSignal;
}

export async function runNewsBrief(
  options: RunNewsBriefOptions,
): Promise<NewsBriefRunReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const topics = options.topics ?? DEFAULT_NEWS_BRIEF_TOPICS;
  const maxItems = boundedMaxItems(options.maxItems ?? DEFAULT_MAX_ITEMS);
  const mode = options.apply ? "applied" : "dry_run";

  const collected = await collectNewsBriefSources({
    searxng: options.searxng,
    topics,
    maxItems,
    isSeen: (url) => options.seenStore.has(url, now().getTime()),
    signal: options.signal,
  });

  if (collected.length === 0) {
    return {
      mode,
      chatId: options.chatId,
      timeZone: NEWS_BRIEF_TIME_ZONE,
      startedAt,
      finishedAt: now().toISOString(),
      collected: 0,
      enriched: 0,
      selected: [],
      status: "empty",
    };
  }

  const enriched = await enrichWithArticleText({
    firecrawl: options.firecrawl,
    items: collected,
    maxEnrich: MAX_ENRICH_ITEMS,
    signal: options.signal,
  });
  const selected = enriched.map((item) => ({
    title: item.title,
    url: item.url,
  }));
  const enrichedCount = enriched.filter(
    (item) => item.articleText !== undefined,
  ).length;

  if (options.summaryPort === undefined) {
    return {
      mode,
      chatId: options.chatId,
      timeZone: NEWS_BRIEF_TIME_ZONE,
      startedAt,
      finishedAt: now().toISOString(),
      collected: collected.length,
      enriched: enrichedCount,
      selected,
      status: "ok",
    };
  }

  const summary = await options.summaryPort.summarize({
    items: enriched,
    maxOutputChars: MAX_MESSAGE_CHARS,
    signal: options.signal,
  });

  let send: NewsBriefRunReport["send"];
  if (options.api !== undefined) {
    send = await sendNewsBrief({
      store: options.store,
      api: options.api,
      chatId: options.chatId,
      text: summary.text,
      dayKey: options.dayKey,
      apply: options.apply,
      throttle: options.throttle,
      nowMs: now().getTime(),
    });
    if (send.outcome === "sent") {
      const nowMs = now().getTime();
      for (const item of enriched) {
        const normalized = normalizeUrl(item.url);
        if (normalized !== undefined) {
          options.seenStore.markSeen(normalized, nowMs);
        }
      }
      options.seenStore.save(nowMs);
    }
  }

  return {
    mode,
    chatId: options.chatId,
    timeZone: NEWS_BRIEF_TIME_ZONE,
    startedAt,
    finishedAt: now().toISOString(),
    collected: collected.length,
    enriched: enrichedCount,
    selected,
    summary: {
      chars: summary.text.length,
      model: summary.model,
      providerId: summary.providerId,
      ...(summary.fallbackCount === undefined
        ? {}
        : { fallbackCount: summary.fallbackCount }),
    },
    ...(send === undefined ? {} : { send }),
    status: "ok",
  };
}

function boundedMaxItems(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ITEMS_CEILING) {
    throw new Error(
      `maxItems must be an integer between 1 and ${MAX_ITEMS_CEILING}.`,
    );
  }
  return value;
}

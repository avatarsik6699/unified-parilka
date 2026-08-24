import type { SearXNGClient } from "../bot/web-tools/searxng-client.js";
import type { NewsBriefSourceItem } from "./types.js";

export interface CollectNewsBriefSourcesOptions {
  searxng: Pick<SearXNGClient, "search">;
  topics: readonly string[];
  /** Results requested per topic query before dedupe. */
  perTopicLimit?: number;
  maxItems: number;
  isSeen: (normalizedUrl: string) => boolean;
  signal: AbortSignal;
}

/**
 * Runs one SearXNG news-category query per topic, dedupes by normalized URL
 * (both within this run and against previously seen/posted URLs), and stops
 * as soon as `maxItems` fresh candidates have been collected.
 */
export async function collectNewsBriefSources(
  options: CollectNewsBriefSourcesOptions,
): Promise<NewsBriefSourceItem[]> {
  const perTopicLimit = boundedPerTopicLimit(options.perTopicLimit ?? 5);
  const seenThisRun = new Set<string>();
  const collected: NewsBriefSourceItem[] = [];

  for (const topic of options.topics) {
    if (options.signal.aborted || collected.length >= options.maxItems) {
      break;
    }
    const result = await options.searxng.search(
      { query: topic, category: "news", limit: perTopicLimit },
      options.signal,
    );
    if (!result.ok) {
      continue;
    }
    for (const item of result.results) {
      if (collected.length >= options.maxItems) {
        break;
      }
      const normalized = normalizeUrl(item.url);
      if (normalized === undefined) {
        continue;
      }
      if (seenThisRun.has(normalized) || options.isSeen(normalized)) {
        continue;
      }
      seenThisRun.add(normalized);
      collected.push({
        title: item.title,
        url: item.url,
        ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
        ...(item.publishedAt === undefined
          ? {}
          : { publishedAt: item.publishedAt }),
      });
    }
  }
  return collected;
}

/**
 * Normalizes a URL for dedupe/seen-tracking: drops the fragment and common
 * tracking query params, lower-cases the result. Not a general-purpose
 * canonicalizer -- only stable enough to stop the same article resurfacing
 * under a slightly different query string on a later day.
 */
export function normalizeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^utm_|^fbclid$|^gclid$/u.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function boundedPerTopicLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error("perTopicLimit must be an integer between 1 and 10.");
  }
  return value;
}

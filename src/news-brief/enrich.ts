import type { FirecrawlClient } from "../bot/web-tools/firecrawl-client.js";
import type { NewsBriefSourceItem } from "./types.js";

export interface EnrichWithArticleTextOptions {
  firecrawl: Pick<FirecrawlClient, "crawl">;
  items: readonly NewsBriefSourceItem[];
  /** Only the first `maxEnrich` items get a Firecrawl call; the rest pass through with just their snippet. */
  maxEnrich: number;
  signal: AbortSignal;
}

/**
 * Best-effort: a failed or empty crawl for one item never fails the run, it
 * just leaves that item with its search snippet instead of full article text.
 */
export async function enrichWithArticleText(
  options: EnrichWithArticleTextOptions,
): Promise<NewsBriefSourceItem[]> {
  const enriched: NewsBriefSourceItem[] = [];
  let attempted = 0;
  for (const item of options.items) {
    if (options.signal.aborted || attempted >= options.maxEnrich) {
      enriched.push(item);
      continue;
    }
    attempted += 1;
    try {
      const result = await options.firecrawl.crawl(
        { url: item.url, limit: 1, maxDepth: 0 },
        options.signal,
      );
      const page = result.ok ? result.pages[0] : undefined;
      enriched.push(
        page?.markdown ? { ...item, articleText: page.markdown } : item,
      );
    } catch {
      enriched.push(item);
    }
  }
  return enriched;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichWithArticleText } from "../src/news-brief/enrich.js";
import type { FirecrawlCrawlResult } from "../src/bot/web-tools/firecrawl-client.js";
import type { NewsBriefSourceItem } from "../src/news-brief/types.js";

function fakeFirecrawl(
  byUrl: Record<
    string,
    FirecrawlCrawlResult | (() => Promise<FirecrawlCrawlResult>)
  >,
): {
  crawl: (
    params: { url: string },
    signal: AbortSignal,
  ) => Promise<FirecrawlCrawlResult>;
} {
  return {
    crawl: async (params) => {
      const entry = byUrl[params.url];
      if (entry === undefined) {
        return {
          ok: false,
          error: { code: "provider_error", message: "no fixture" },
        };
      }
      return typeof entry === "function" ? entry() : entry;
    },
  };
}

const items: NewsBriefSourceItem[] = [
  { title: "A", url: "https://example.com/a", snippet: "snippet a" },
  { title: "B", url: "https://example.com/b", snippet: "snippet b" },
];

test("merges crawled markdown into articleText on success", async () => {
  const firecrawl = fakeFirecrawl({
    "https://example.com/a": {
      ok: true,
      status: "done",
      id: "job1",
      pages: [
        {
          url: "https://example.com/a",
          markdown: "full article text",
          truncated: false,
        },
      ],
      completed: 1,
      total: 1,
      truncated: false,
    },
    "https://example.com/b": {
      ok: true,
      status: "done",
      id: "job2",
      pages: [
        {
          url: "https://example.com/b",
          markdown: "full article b",
          truncated: false,
        },
      ],
      completed: 1,
      total: 1,
      truncated: false,
    },
  });
  const enriched = await enrichWithArticleText({
    firecrawl,
    items,
    maxEnrich: 5,
    signal: new AbortController().signal,
  });
  assert.equal(enriched[0]!.articleText, "full article text");
  assert.equal(enriched[1]!.articleText, "full article b");
  assert.equal(enriched[0]!.snippet, "snippet a");
});

test("keeps the snippet when a crawl fails or throws", async () => {
  const firecrawl = fakeFirecrawl({
    "https://example.com/a": {
      ok: false,
      error: { code: "timeout", message: "slow" },
    },
    "https://example.com/b": () => Promise.reject(new Error("network down")),
  });
  const enriched = await enrichWithArticleText({
    firecrawl,
    items,
    maxEnrich: 5,
    signal: new AbortController().signal,
  });
  assert.equal(enriched[0]!.articleText, undefined);
  assert.equal(enriched[0]!.snippet, "snippet a");
  assert.equal(enriched[1]!.articleText, undefined);
  assert.equal(enriched[1]!.snippet, "snippet b");
});

test("items beyond maxEnrich pass through without a crawl call", async () => {
  let calls = 0;
  const firecrawl = {
    crawl: async (): Promise<FirecrawlCrawlResult> => {
      calls += 1;
      return {
        ok: true,
        status: "empty",
        id: "job",
        pages: [],
        completed: 0,
        total: 0,
        truncated: false,
      };
    },
  };
  const enriched = await enrichWithArticleText({
    firecrawl,
    items,
    maxEnrich: 1,
    signal: new AbortController().signal,
  });
  assert.equal(calls, 1);
  assert.equal(enriched.length, 2);
  assert.equal(enriched[1]!.articleText, undefined);
});

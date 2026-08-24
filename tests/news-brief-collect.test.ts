import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectNewsBriefSources,
  normalizeUrl,
} from "../src/news-brief/collect.js";
import type { SearXNGSearchResult } from "../src/bot/web-tools/searxng-client.js";

function fakeSearxng(byQuery: Record<string, SearXNGSearchResult>): {
  search: (
    params: { query: string },
    signal: AbortSignal,
  ) => Promise<SearXNGSearchResult>;
} {
  return {
    search: async (params) =>
      byQuery[params.query] ?? {
        ok: true,
        status: "empty",
        query: params.query,
        results: [],
        truncated: false,
      },
  };
}

test("dedupes results with the same normalized URL across topics", async () => {
  const searxng = fakeSearxng({
    a: {
      ok: true,
      status: "done",
      query: "a",
      results: [
        { title: "Study one", url: "https://example.com/story?utm_source=x" },
      ],
      truncated: false,
    },
    b: {
      ok: true,
      status: "done",
      query: "b",
      results: [
        { title: "Study one (again)", url: "https://example.com/story" },
      ],
      truncated: false,
    },
  });
  const collected = await collectNewsBriefSources({
    searxng,
    topics: ["a", "b"],
    maxItems: 10,
    isSeen: () => false,
    signal: new AbortController().signal,
  });
  assert.equal(collected.length, 1);
  assert.equal(collected[0]!.title, "Study one");
});

test("filters out previously seen URLs", async () => {
  const searxng = fakeSearxng({
    a: {
      ok: true,
      status: "done",
      query: "a",
      results: [
        { title: "Old", url: "https://example.com/old" },
        { title: "New", url: "https://example.com/new" },
      ],
      truncated: false,
    },
  });
  const collected = await collectNewsBriefSources({
    searxng,
    topics: ["a"],
    maxItems: 10,
    isSeen: (url) => url === normalizeUrl("https://example.com/old"),
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    collected.map((item) => item.url),
    ["https://example.com/new"],
  );
});

test("stops once maxItems is reached", async () => {
  const searxng = fakeSearxng({
    a: {
      ok: true,
      status: "done",
      query: "a",
      results: [
        { title: "One", url: "https://example.com/1" },
        { title: "Two", url: "https://example.com/2" },
        { title: "Three", url: "https://example.com/3" },
      ],
      truncated: false,
    },
  });
  const collected = await collectNewsBriefSources({
    searxng,
    topics: ["a"],
    maxItems: 2,
    isSeen: () => false,
    signal: new AbortController().signal,
  });
  assert.equal(collected.length, 2);
});

test("a failed topic search is skipped, not fatal", async () => {
  const searxng = fakeSearxng({
    a: { ok: false, error: { code: "provider_unavailable", message: "down" } },
    b: {
      ok: true,
      status: "done",
      query: "b",
      results: [{ title: "Works", url: "https://example.com/works" }],
      truncated: false,
    },
  });
  const collected = await collectNewsBriefSources({
    searxng,
    topics: ["a", "b"],
    maxItems: 10,
    isSeen: () => false,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    collected.map((item) => item.url),
    ["https://example.com/works"],
  );
});

test("normalizeUrl strips tracking params, hash and case", () => {
  assert.equal(
    normalizeUrl("HTTPS://Example.com/Path?utm_source=x&fbclid=y&keep=1#frag"),
    "https://example.com/path?keep=1",
  );
  assert.equal(normalizeUrl("not a url"), undefined);
});

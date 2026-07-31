import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
  type PaperSearchProvider,
} from "../src/bot/read-tools.js";
import {
  asFailure,
  CHAT,
  emptyCache,
} from "./support/bot-read-tools.js";

test("paper_search exposes provider-neutral result and bounded output", async () => {
  let observedMaxResults = 0;
  const provider: PaperSearchProvider = {
    async search({ query, source, maxResults }) {
      observedMaxResults = maxResults;
      assert.equal(source, "arxiv");
      return {
        query,
        source,
        papers: [
          {
            title: "Attention Is All You Need",
            authors: ["Vaswani et al."],
            year: "2017",
            abstract: "We propose a new simple network architecture.",
            url: "https://arxiv.org/abs/1706.03762",
          },
        ],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    paperSearch: provider,
  });

  const result = await tools.callTool("paper_search", {
    query: "transformer",
    max_results: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(observedMaxResults, 2);
  if (!result.ok) {
    return;
  }
  assert.equal(result.tool, "paper_search");
  assert.equal(result.status, "done");
  assert.equal(result.result.source, "arxiv");
  assert.equal(result.result.resultCount, 1);
  assert.equal(result.evidence[0]?.source, "paper");
  assert.equal(
    result.evidence[0]?.url,
    "https://arxiv.org/abs/1706.03762",
  );
});

test("paper_search defaults to arxiv and three results", async () => {
  const provider: PaperSearchProvider = {
    async search({ source, maxResults }) {
      assert.equal(source, "arxiv");
      assert.equal(maxResults, 3);
      return {
        query: "q",
        source,
        papers: [],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    paperSearch: provider,
  });

  const result = await tools.callTool("paper_search", {
    query: "foo",
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.status, "empty");
});

test("paper_search rejects invalid max_results", async () => {
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
  });
  const result = asFailure(
    await tools.callTool("paper_search", {
      query: "x",
      max_results: 10,
    }),
  );
  assert.equal(result.error.code, "invalid_arguments");
});

test("paper_search enforces timeout and caller abort", async () => {
  let timeoutSignalObserved = false;
  const hangingProvider: PaperSearchProvider = {
    async search({ signal }) {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            timeoutSignalObserved = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    paperSearch: hangingProvider,
    paperSearchTimeoutMs: 10,
    paperSearchRateLimitMs: 1,
  });

  const timeout = asFailure(
    await tools.callTool("paper_search", { query: "hang" }),
  );
  assert.equal(timeout.error.code, "timeout");
  assert.equal(timeout.error.retryable, true);
  assert.equal(timeoutSignalObserved, true);

  const controller = new AbortController();
  controller.abort(new Error("turn ended"));
  const aborted = asFailure(
    await tools.callTool(
      "paper_search",
      { query: "cancel" },
      { signal: controller.signal },
    ),
  );
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.retryable, false);
});

test("paper_search parses built-in arxiv atom response", async () => {
  const originalFetch = globalThis.fetch;
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Sample Paper</title>
    <summary>Abstract text.</summary>
    <published>2024-05-20T00:00:00Z</published>
    <id>https://arxiv.org/abs/2405.12345</id>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
  </entry>
</feed>`;
  globalThis.fetch = async () =>
    new Response(atom, { status: 200 });
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 5_000,
      paperSearchRateLimitMs: 1,
    });
    const result = await tools.callTool("paper_search", {
      query: "sample",
      max_results: 1,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.result.resultCount, 1);
    assert.equal(result.evidence[0]?.title, "Sample Paper");
    assert.equal(result.evidence[0]?.url, "https://arxiv.org/abs/2405.12345");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper_search parses built-in europepmc json response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        resultList: {
          result: [
            {
              title: "PMC Paper",
              authorString: "Smith A, Jones B",
              pubYear: "2023",
              abstractText: "A study.",
              pmcid: "PMC123456",
            },
          ],
        },
      }),
      { status: 200 },
    );
  try {
    const tools = new BotReadTools({
      chatId: CHAT.chatId,
      cache: emptyCache(),
      paperSearchTimeoutMs: 5_000,
      paperSearchRateLimitMs: 1,
    });
    const result = await tools.callTool("paper_search", {
      query: "pmc",
      source: "europepmc",
      max_results: 1,
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.result.source, "europepmc");
    assert.equal(result.result.resultCount, 1);
    assert.equal(result.evidence[0]?.url, "https://europepmc.org/article/PMC/123456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BotReadTools,
  type WebSearchProvider,
} from "../src/bot/read-tools.js";
import {
  asFailure,
  CHAT,
  emptyCache,
} from "./support/bot-read-tools.js";

test("web_search exposes provider-neutral sources and an AbortSignal", async () => {
  let observedQuery: string | undefined;
  let observedSignal: AbortSignal | undefined;
  const provider: WebSearchProvider = {
    async search({ query, signal }) {
      observedQuery = query;
      observedSignal = signal;
      return {
        text: "Вышла новая версия.",
        sources: [
          {
            url: "https://example.com/release",
            title: "Release notes",
            snippet: "Version 2.0 was released.",
            publishedAt: "2026-07-30",
          },
        ],
      };
    },
  };
  const tools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webSearch: provider,
  });

  const result = await tools.callTool("web_search", {
    query: "  новая версия  ",
  });

  assert.equal(observedQuery, "новая версия");
  assert.ok(observedSignal);
  assert.equal(observedSignal?.aborted, false);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.result, {
    query: "новая версия",
    text: "Вышла новая версия.",
    sourceCount: 1,
  });
  assert.deepEqual(result.evidence, [
    {
      source: "web",
      chat: null,
      message: null,
      speaker: { id: null, name: null },
      date: "2026-07-30",
      text: "Version 2.0 was released.",
      url: "https://example.com/release",
      title: "Release notes",
    },
  ]);
});

test("web_search enforces timeout and caller abort even when provider hangs", async () => {
  let timeoutSignalObserved = false;
  const hangingProvider: WebSearchProvider = {
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
    webSearch: hangingProvider,
    webSearchTimeoutMs: 10,
  });

  const timeout = asFailure(
    await tools.callTool("web_search", { query: "hang" }),
  );
  assert.equal(timeout.error.code, "timeout");
  assert.equal(timeout.error.retryable, true);
  assert.equal(timeoutSignalObserved, true);

  const controller = new AbortController();
  controller.abort(new Error("turn ended"));
  const aborted = asFailure(
    await tools.callTool(
      "web_search",
      { query: "cancel" },
      { signal: controller.signal },
    ),
  );
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.retryable, false);

  const externalDeadlineTools = new BotReadTools({
    chatId: CHAT.chatId,
    cache: emptyCache(),
    webSearch: hangingProvider,
    webSearchTimeoutMs: 1_000,
  });
  const externalTimeout = asFailure(
    await externalDeadlineTools.callTool(
      "web_search",
      { query: "sdk timeout" },
      { signal: AbortSignal.timeout(10) },
    ),
  );
  assert.equal(externalTimeout.error.code, "timeout");
  assert.equal(externalTimeout.error.retryable, true);
});

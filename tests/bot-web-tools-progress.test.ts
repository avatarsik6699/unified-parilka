import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolProgressPublisher } from "../src/bot/tool-progress.js";

// ─── Tool progress previews ─────────────────────────────────────────────────

async function settle(): Promise<void> {
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
}

function progressHarness() {
  const sent: string[] = [];
  const botApi = {
    sendMessage: async (
      _chatId: string,
      text: string,
    ): Promise<{ ok: true; messageId: number }> => {
      sent.push(text);
      return { ok: true, messageId: sent.length };
    },
    editMessageText: async (): Promise<{ ok: true }> => ({ ok: true }),
    deleteMessage: async (): Promise<{ ok: true }> => ({ ok: true }),
  };
  const store = {
    saveBotTurnProgress: () => true,
    clearBotTurnProgress: () => true,
  };
  const publisher = new ToolProgressPublisher({
    turnId: 1,
    workerId: "w1",
    chatId: "c1",
    signal: new AbortController().signal,
    botApi,
    store,
  });
  return { publisher, sent };
}

test("progress never echoes tool names, URLs, tokens, or query text into the chat", async () => {
  const { publisher, sent } = progressHarness();
  publisher.onToolStarted({
    toolName: "firecrawl_crawl",
    callId: "1",
    input: { url: "https://example.com/docs/page?token=SECRET" },
  });
  publisher.onToolStarted({
    toolName: "inspect_web_images",
    callId: "2",
    input: { urls: ["https://example.com/1.jpg?sig=SECRET"] },
  });
  publisher.onToolStarted({
    toolName: "searxng_search",
    callId: "3",
    input: { query: "интересная тема" },
  });
  await settle();
  assert.ok(sent.length >= 1);
  const rendered = sent.join("\n");
  assert.doesNotMatch(rendered, /example\.com/u);
  assert.doesNotMatch(rendered, /token=SECRET|sig=SECRET/u);
  assert.doesNotMatch(rendered, /интересная тема/u);
  assert.doesNotMatch(
    rendered,
    /firecrawl_crawl|inspect_web_images|searxng_search/u,
  );
});

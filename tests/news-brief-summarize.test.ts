import assert from "node:assert/strict";
import test from "node:test";
import { AiSdkNewsBriefSummaryPort } from "../src/news-brief/summarize.js";
import { ModelRouter } from "../src/providers/model-router.js";
import type { NewsBriefSourceItem } from "../src/news-brief/types.js";

function testRouter(): ModelRouter {
  return new ModelRouter(
    {
      allowInsecureLocal: false,
      providers: [
        {
          id: "primary",
          protocol: "openai",
          baseUrl: "https://primary.invalid/v1",
          apiKeyEnv: "NEWS_BRIEF_TEST_PRIMARY",
        },
        {
          id: "secondary",
          protocol: "openai",
          baseUrl: "https://secondary.invalid/v1",
          apiKeyEnv: "NEWS_BRIEF_TEST_SECONDARY",
        },
      ],
      roles: {
        turn: ["primary:turn-model"],
        summary: ["primary:summary-model", "secondary:summary-model"],
      },
    },
    {
      env: {
        NEWS_BRIEF_TEST_PRIMARY: "unit-test-primary",
        NEWS_BRIEF_TEST_SECONDARY: "unit-test-secondary",
      },
    },
  );
}

const items: NewsBriefSourceItem[] = [
  { title: "Study", url: "https://example.com/study", snippet: "A finding." },
];

test("falls back to the next router candidate on a transport error", async () => {
  const attempted: string[] = [];
  const port = new AiSdkNewsBriefSummaryPort(testRouter(), {
    generate: async ({ candidate }) => {
      attempted.push(candidate.reference);
      if (candidate.providerId === "primary") {
        throw Object.assign(new Error("transport"), { code: "ECONNRESET" });
      }
      return {
        text: "• Пункт. [источник](https://example.com/study)",
        finishReason: "stop",
      };
    },
  });
  const result = await port.summarize({
    items,
    maxOutputChars: 1_000,
    signal: new AbortController().signal,
  });
  assert.equal(attempted.length, 2);
  assert.equal(result.providerId, "secondary");
  assert.match(result.text, /источник/);
  assert.equal(result.fallbackCount, 1);
});

test("rejects empty model output and falls back", async () => {
  const port = new AiSdkNewsBriefSummaryPort(testRouter(), {
    generate: async ({ candidate }) =>
      candidate.providerId === "primary"
        ? { text: "   ", finishReason: "stop" }
        : { text: "• Готово.", finishReason: "stop" },
  });
  const result = await port.summarize({
    items,
    maxOutputChars: 1_000,
    signal: new AbortController().signal,
  });
  assert.equal(result.text, "• Готово.");
});

test("truncates output longer than maxOutputChars", async () => {
  const port = new AiSdkNewsBriefSummaryPort(testRouter(), {
    generate: async () => ({ text: "x".repeat(50), finishReason: "stop" }),
  });
  const result = await port.summarize({
    items,
    maxOutputChars: 10,
    signal: new AbortController().signal,
  });
  assert.equal(result.text.length, 10);
});

test("a non-stop finish reason is treated as a fallback-eligible failure", async () => {
  const port = new AiSdkNewsBriefSummaryPort(testRouter(), {
    generate: async ({ candidate }) =>
      candidate.providerId === "primary"
        ? { text: "partial", finishReason: "length" }
        : { text: "• Complete.", finishReason: "stop" },
  });
  const result = await port.summarize({
    items,
    maxOutputChars: 1_000,
    signal: new AbortController().signal,
  });
  assert.equal(result.text, "• Complete.");
  assert.equal(result.fallbackCount, 1);
});

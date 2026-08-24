import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedModelCandidate } from "../src/providers/model-router.js";
import {
  translateImagePromptToEnglish,
  type PromptTranslationRouter,
  type TranslateGenerate,
  type TranslateGenerateResult,
} from "../src/bot/agent/image-prompt-translation.js";

const FAKE_CANDIDATE = {
  reference: "deepseek:deepseek-v4-flash",
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  model: {} as never,
  capabilities: { vision: false },
} as ResolvedModelCandidate;

function singleCandidateRouter(): PromptTranslationRouter {
  return {
    async executeWithFallback(_role, attempt) {
      const value = await attempt(FAKE_CANDIDATE, 1);
      return { value, candidate: FAKE_CANDIDATE, attempt: 1, failures: [] };
    },
  };
}

function throwingRouter(): PromptTranslationRouter {
  return {
    executeWithFallback() {
      return Promise.reject(new Error("router unavailable"));
    },
  };
}

function scriptedGenerate(result: TranslateGenerateResult): {
  generate: TranslateGenerate;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    generate: (params) => {
      calls.push(params);
      return Promise.resolve(result);
    },
  };
}

test("Latin-script text is returned unchanged without calling the router", async () => {
  const router: PromptTranslationRouter = {
    executeWithFallback() {
      throw new Error("must not be called for already-English input");
    },
  };
  const result = await translateImagePromptToEnglish({
    router,
    text: "a golden retriever running in a park",
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, {
    ok: true,
    text: "a golden retriever running in a park",
  });
});

test("Cyrillic text is translated via the router and generate seam", async () => {
  const { generate, calls } = scriptedGenerate({
    text: "a golden retriever running in a park",
    finishReason: "stop",
  });
  const result = await translateImagePromptToEnglish({
    router: singleCandidateRouter(),
    text: "золотистый ретривер бежит в парке",
    signal: new AbortController().signal,
    generate,
  });
  assert.deepEqual(result, {
    ok: true,
    text: "a golden retriever running in a park",
  });
  assert.equal(calls.length, 1);
});

test("an empty raw prompt fails closed without calling the router", async () => {
  const router: PromptTranslationRouter = {
    executeWithFallback() {
      throw new Error("must not be called for empty input");
    },
  };
  const result = await translateImagePromptToEnglish({
    router,
    text: "   ",
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { ok: false });
});

test("a non-stop finish reason falls back to failure, not a partial translation", async () => {
  const { generate } = scriptedGenerate({
    text: "a golden retr",
    finishReason: "length",
  });
  const result = await translateImagePromptToEnglish({
    router: singleCandidateRouter(),
    text: "золотистый ретривер",
    signal: new AbortController().signal,
    generate,
  });
  assert.deepEqual(result, { ok: false });
});

test("empty model output falls back to failure", async () => {
  const { generate } = scriptedGenerate({ text: "   ", finishReason: "stop" });
  const result = await translateImagePromptToEnglish({
    router: singleCandidateRouter(),
    text: "золотистый ретривер",
    signal: new AbortController().signal,
    generate,
  });
  assert.deepEqual(result, { ok: false });
});

test("a refusal-shaped response falls back to failure instead of blocking generation", async () => {
  const { generate } = scriptedGenerate({
    text: "I'm sorry, I can't help with that request.",
    finishReason: "stop",
  });
  const result = await translateImagePromptToEnglish({
    router: singleCandidateRouter(),
    text: "золотистый ретривер",
    signal: new AbortController().signal,
    generate,
  });
  assert.deepEqual(result, { ok: false });
});

test("a router failure (timeout, provider error) falls back to failure, never throws", async () => {
  const result = await translateImagePromptToEnglish({
    router: throwingRouter(),
    text: "золотистый ретривер",
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { ok: false });
});

test("an oversized translation falls back to failure", async () => {
  const { generate } = scriptedGenerate({
    text: "a ".repeat(1_000),
    finishReason: "stop",
  });
  const result = await translateImagePromptToEnglish({
    router: singleCandidateRouter(),
    text: "золотистый ретривер",
    signal: new AbortController().signal,
    generate,
  });
  assert.deepEqual(result, { ok: false });
});

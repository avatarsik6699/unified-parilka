import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnImageTracker } from "../src/bot/agent/web-images.js";
import { createBotToolSet } from "../src/bot/agent/tool-set.js";
import type { BotToolSetExecutionCompleted } from "../src/bot/agent/tool-set.js";
import {
  createWebToolPort,
  type GeneratedImage,
  type GeneratedSpeech,
  type WebToolResult,
} from "../src/bot/web-tools/tool-definitions.js";
import type { WebToolPort } from "../src/bot/web-tools/tool-definitions.js";
import { RunwareClient } from "../src/bot/web-tools/runware-client.js";
import { ImageGenerationBudget } from "../src/bot/agent/image-generation-budget.js";
import type { BotReadTools } from "../src/bot/read-tools.js";

function fakeReadTools(): BotReadTools {
  return {} as BotReadTools;
}

interface ExecutableTestTool {
  execute: (
    input: Record<string, unknown>,
    execution: { toolCallId: string },
  ) => Promise<WebToolResult>;
}

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);
const AUDIO_BYTES = new Uint8Array([9, 8, 7]);

function imageEditFetch(): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url === "https://api.runware.ai/v1") {
      return new Response(
        JSON.stringify({
          data: [
            {
              taskType: "imageInference",
              imageURL: "https://im.runware.ai/x.jpg",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://im.runware.ai/x.jpg") {
      return new Response(IMAGE_BYTES, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function speechFetch(): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url === "https://api.runware.ai/v1") {
      return new Response(
        JSON.stringify({
          data: [
            {
              taskType: "audioInference",
              audioURL: "https://am.runware.ai/x.ogg",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://am.runware.ai/x.ogg") {
      return new Response(AUDIO_BYTES, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function makeToolSet(port: WebToolPort): {
  tools: Record<string, ExecutableTestTool>;
  completed: BotToolSetExecutionCompleted[];
} {
  const completed: BotToolSetExecutionCompleted[] = [];
  const { tools } = createBotToolSet({
    readTools: fakeReadTools(),
    memoryTools: undefined,
    memoryWriteAllowed: false,
    audioTranscriptionAvailable: false,
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    chatId: "-1004242",
    sourceMessageId: 1,
    visionAvailable: false,
    webToolPort: port,
    onExecutionStarted: () => {},
    onExecutionCompleted: (input) => completed.push(input),
  });
  return {
    tools: tools as unknown as Record<string, ExecutableTestTool>,
    completed,
  };
}

// ─── edit_image ─────────────────────────────────────────────────────────────

test("edit_image is absent without a Runware client", () => {
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    referenceImage: { data: IMAGE_BYTES, mediaType: "image/jpeg" },
  });
  const { tools } = makeToolSet(port);
  assert.equal("edit_image" in tools, false);
});

test("edit_image is absent without a reference image even when Runware is configured", () => {
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    runwareClient: new RunwareClient({
      endpoint: "https://api.runware.ai/v1",
      apiKey: "rw-secret",
      nsfwAllowed: false,
      fetchImpl: imageEditFetch(),
    }),
    rawImagePromptSource: "перекрась в синий",
  });
  const { tools } = makeToolSet(port);
  assert.equal("edit_image" in tools, false);
});

test("edit_image sends the reference photo as a data URI and attaches the result", async () => {
  let capturedBody = "";
  let captured: GeneratedImage | undefined;
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    runwareClient: new RunwareClient({
      endpoint: "https://api.runware.ai/v1",
      apiKey: "rw-secret",
      nsfwAllowed: false,
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        if (String(input) === "https://api.runware.ai/v1") {
          capturedBody = String(init?.body ?? "");
        }
        return imageEditFetch()(input as never, init);
      }) as typeof fetch,
    }),
    imageBudget: new ImageGenerationBudget(1, 20),
    rawImagePromptSource: "перекрась в синий",
    referenceImage: { data: IMAGE_BYTES, mediaType: "image/jpeg" },
    onImageGenerated: (image) => {
      captured = image;
    },
  });
  const { tools } = makeToolSet(port);
  const output = await tools.edit_image.execute({}, { toolCallId: "call-1" });
  assert.equal(output.ok, true);
  assert.ok(captured);
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed[0].positivePrompt, "перекрась в синий");
  assert.equal(
    parsed[0].inputs.referenceImages[0],
    `data:image/jpeg;base64,${Buffer.from(IMAGE_BYTES).toString("base64")}`,
  );
});

// ─── speak_text ─────────────────────────────────────────────────────────────

test("speak_text is absent without a TTS client", () => {
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
  });
  const { tools } = makeToolSet(port);
  assert.equal("speak_text" in tools, false);
});

test("speak_text synthesizes the given text and attaches the result", async () => {
  let captured: GeneratedSpeech | undefined;
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    ttsClient: new RunwareClient({
      endpoint: "https://api.runware.ai/v1",
      apiKey: "rw-secret",
      nsfwAllowed: false,
      fetchImpl: speechFetch(),
    }),
    ttsBudget: new ImageGenerationBudget(1, 20),
    onSpeechGenerated: (speech) => {
      captured = speech;
    },
  });
  const { tools } = makeToolSet(port);
  const output = await tools.speak_text.execute(
    { text: "привет из логова" },
    { toolCallId: "call-1" },
  );
  assert.equal(output.ok, true);
  assert.ok(captured);
  assert.deepEqual(Array.from(captured!.bytes), Array.from(AUDIO_BYTES));
});

test("speak_text is denied once the per-turn budget is spent", async () => {
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    ttsClient: new RunwareClient({
      endpoint: "https://api.runware.ai/v1",
      apiKey: "rw-secret",
      nsfwAllowed: false,
      fetchImpl: speechFetch(),
    }),
    ttsBudget: new ImageGenerationBudget(1, 20),
  });
  const { tools } = makeToolSet(port);
  const first = await tools.speak_text.execute(
    { text: "привет" },
    { toolCallId: "call-1" },
  );
  assert.equal(first.ok, true);
  const second = await tools.speak_text.execute(
    { text: "ещё раз" },
    { toolCallId: "call-2" },
  );
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, "budget_exceeded_turn");
  }
});

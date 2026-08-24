import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnImageTracker } from "../src/bot/agent/web-images.js";
import { createBotToolSet } from "../src/bot/agent/tool-set.js";
import type { BotToolSetExecutionCompleted } from "../src/bot/agent/tool-set.js";
import {
  createWebToolPort,
  type GeneratedImage,
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
  toModelOutput: (options: {
    toolCallId: string;
    input: Record<string, unknown>;
    output: WebToolResult;
  }) =>
    { type: string; value: string } | Promise<{ type: string; value: string }>;
}

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

function successFetch(): typeof fetch {
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

function configuredPort(
  overrides: {
    nsfwAllowed?: boolean;
    maxPerTurn?: number;
    maxPerDay?: number;
    turnId?: string;
    onImageGenerated?: (image: GeneratedImage) => void;
    fetchImpl?: typeof fetch;
  } = {},
): WebToolPort {
  const nsfwAllowed = overrides.nsfwAllowed ?? false;
  return createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: overrides.turnId ?? "turn-1",
    runwareClient: new RunwareClient({
      endpoint: "https://api.runware.ai/v1",
      apiKey: "rw-secret",
      nsfwAllowed,
      fetchImpl: overrides.fetchImpl ?? successFetch(),
    }),
    imageBudget: new ImageGenerationBudget(
      overrides.maxPerTurn ?? 1,
      overrides.maxPerDay ?? 20,
    ),
    nsfwAllowed,
    ...(overrides.onImageGenerated === undefined
      ? {}
      : { onImageGenerated: overrides.onImageGenerated }),
  });
}

// ─── generate_image tool registration ──────────────────────────────────────

test("generate_image is absent from the tool set when no Runware client is configured", () => {
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
  });
  const { tools } = makeToolSet(port);
  assert.equal("generate_image" in tools, false);
});

test("a successful generation attaches the image via onImageGenerated and never leaks bytes to the model", async () => {
  let captured: GeneratedImage | undefined;
  const port = configuredPort({
    onImageGenerated: (image) => {
      captured = image;
    },
  });
  const { tools, completed } = makeToolSet(port);
  const output = await tools.generate_image.execute(
    { prompt: "a golden retriever" },
    { toolCallId: "call-1" },
  );
  assert.equal(output.ok, true);
  assert.deepEqual(output.evidence, []);
  assert.ok(captured);
  assert.deepEqual(Array.from(captured!.bytes), Array.from(IMAGE_BYTES));

  const modelOutput = await tools.generate_image.toModelOutput({
    toolCallId: "call-1",
    input: { prompt: "a golden retriever" },
    output,
  });
  assert.equal(modelOutput.value.includes("1,2,3,4"), false);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.output.ok, true);
});

test("a second generation in the same turn is denied once the per-turn cap is spent", async () => {
  const port = configuredPort({ maxPerTurn: 1, maxPerDay: 20 });
  const { tools } = makeToolSet(port);
  const first = await tools.generate_image.execute(
    { prompt: "a golden retriever" },
    { toolCallId: "call-1" },
  );
  assert.equal(first.ok, true);
  const second = await tools.generate_image.execute(
    { prompt: "a red fox" },
    { toolCallId: "call-2" },
  );
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error.code, "budget_exceeded_turn");
  }
});

test("a failed generation releases its budget reservation", async () => {
  const port = configuredPort({
    maxPerTurn: 1,
    fetchImpl: (async () =>
      new Response("boom", { status: 500 })) as typeof fetch,
  });
  const { tools } = makeToolSet(port);
  const first = await tools.generate_image.execute(
    { prompt: "a golden retriever" },
    { toolCallId: "call-1" },
  );
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.notEqual(first.error.code, "budget_exceeded_turn");
  }

  // The failed call must have released its reservation: a second attempt in
  // the same turn fails on the provider again, never on the turn cap.
  const second = await tools.generate_image.execute(
    { prompt: "a red fox" },
    { toolCallId: "call-2" },
  );
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.notEqual(second.error.code, "budget_exceeded_turn");
  }
});

test("nsfw input is ignored by the request body when the operator has not enabled it", async () => {
  let capturedBody = "";
  const port = configuredPort({
    nsfwAllowed: false,
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      if (String(input) === "https://api.runware.ai/v1") {
        capturedBody = String(init?.body ?? "");
      }
      return successFetch()(input as never, init);
    }) as typeof fetch,
  });
  const { tools } = makeToolSet(port);
  await tools.generate_image.execute(
    { prompt: "a golden retriever", nsfw: true },
    { toolCallId: "call-1" },
  );
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed[0].safety.checkContent, true);
});

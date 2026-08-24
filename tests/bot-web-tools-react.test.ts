import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnImageTracker } from "../src/bot/agent/web-images.js";
import { createBotToolSet } from "../src/bot/agent/tool-set.js";
import type { BotToolSetExecutionCompleted } from "../src/bot/agent/tool-set.js";
import {
  createWebToolPort,
  type WebToolResult,
} from "../src/bot/web-tools/tool-definitions.js";
import type { WebToolPort } from "../src/bot/web-tools/tool-definitions.js";
import type { BotReactionApiPort } from "../src/bot/web-tools/reaction-contracts.js";
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

interface ReactionCall {
  chatId: string;
  messageId: number;
  emoji: string;
}

function fakeReactionApi(handler?: (call: ReactionCall) => { ok: boolean }): {
  api: BotReactionApiPort;
  calls: ReactionCall[];
} {
  const calls: ReactionCall[] = [];
  return {
    calls,
    api: {
      async setMessageReaction(chatId, messageId, emoji) {
        calls.push({ chatId, messageId, emoji });
        return handler?.({ chatId, messageId, emoji }) ?? { ok: true };
      },
    },
  };
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

test("react_to_message is absent without a reaction port", () => {
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
  });
  const { tools } = makeToolSet(port);
  assert.equal("react_to_message" in tools, false);
});

test("reacts to the trigger message by default", async () => {
  const { api, calls } = fakeReactionApi();
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    reaction: { api, chatId: "-1004242", triggerMessageId: 55 },
  });
  const { tools } = makeToolSet(port);
  const output = await tools.react_to_message.execute(
    { emoji: "🔥" },
    { toolCallId: "call-1" },
  );
  assert.equal(output.ok, true);
  assert.deepEqual(calls, [{ chatId: "-1004242", messageId: 55, emoji: "🔥" }]);
});

test("reacts to the reply target when explicitly requested", async () => {
  const { api, calls } = fakeReactionApi();
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    reaction: {
      api,
      chatId: "-1004242",
      triggerMessageId: 55,
      replyMessageId: 41,
    },
  });
  const { tools } = makeToolSet(port);
  await tools.react_to_message.execute(
    { emoji: "👍", target: "reply" },
    { toolCallId: "call-1" },
  );
  assert.deepEqual(calls, [{ chatId: "-1004242", messageId: 41, emoji: "👍" }]);
});

test("fails closed asking for a reply reaction with no reply target this turn", async () => {
  const { api, calls } = fakeReactionApi();
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    reaction: { api, chatId: "-1004242", triggerMessageId: 55 },
  });
  const { tools } = makeToolSet(port);
  const output = await tools.react_to_message.execute(
    { emoji: "👍", target: "reply" },
    { toolCallId: "call-1" },
  );
  assert.equal(output.ok, false);
  if (!output.ok) {
    assert.equal(output.error.code, "invalid_arguments");
  }
  assert.equal(calls.length, 0);
});

test("rejects an emoji outside Telegram's allowed reaction set", async () => {
  const { api, calls } = fakeReactionApi();
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    reaction: { api, chatId: "-1004242", triggerMessageId: 55 },
  });
  const { tools } = makeToolSet(port);
  const output = await tools.react_to_message.execute(
    { emoji: "🚀" },
    { toolCallId: "call-1" },
  );
  assert.equal(output.ok, false);
  if (!output.ok) {
    assert.equal(output.error.code, "invalid_arguments");
  }
  assert.equal(calls.length, 0);
});

test("surfaces a Telegram-side rejection as a typed provider_error", async () => {
  const { api } = fakeReactionApi(() => ({ ok: false }));
  const port = createWebToolPort({
    imageTracker: createTurnImageTracker(),
    nonce: "fixed_nonce_1234",
    turnSignal: new AbortController().signal,
    turnId: "turn-1",
    reaction: { api, chatId: "-1004242", triggerMessageId: 55 },
  });
  const { tools } = makeToolSet(port);
  const output = await tools.react_to_message.execute(
    { emoji: "👍" },
    { toolCallId: "call-1" },
  );
  assert.equal(output.ok, false);
  if (!output.ok) {
    assert.equal(output.error.code, "provider_error");
  }
});

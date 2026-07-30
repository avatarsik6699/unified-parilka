import assert from "node:assert/strict";
import { test } from "node:test";
import { BotAgentProtocolError } from "../src/bot/ai-agent.js";
import {
  candidate,
  emptyFold,
  makeAgent,
  mockModel,
  promptUserText,
  request,
  response,
  storedMessage,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";

test("returns only the final step text, never reasoning or an intermediate draft", async () => {
  const model = mockModel([
    response(
      [
        { type: "reasoning", text: "PRIVATE_CHAIN_OF_THOUGHT" },
        { type: "text", text: "безопасный финальный ответ" },
      ],
      "stop",
    ),
  ]);
  const providerOptions = {
    deepseek: { thinking: { type: "disabled" as const } },
  };
  const fixture = makeAgent([
    candidate("primary:test", model, providerOptions),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "безопасный финальный ответ");
  assert.doesNotMatch(result.text, /PRIVATE_CHAIN_OF_THOUGHT/);
  assert.deepEqual(result.evidence, []);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.deepEqual(
    model.doGenerateCalls[0]?.providerOptions,
    providerOptions,
  );
  assert.match(
    promptUserText(model.doGenerateCalls[0]),
    /"target":true/,
  );
});

test("executes a read tool, wraps its output as untrusted data, and records quote evidence", async () => {
  const exactQuote = "эта реплика действительно была в истории";
  const model = mockModel([
    toolResponse([
      toolCall("call-search", "search_chat", {
        query: "реплика",
        limit: 1,
      }),
    ]),
    response(
      [
        {
          type: "text",
          text: `Коля: «${exactQuote}»`,
        },
      ],
      "stop",
    ),
  ]);
  const fixture = makeAgent(
    [candidate("primary:test", model)],
    {
      searchResults: [
        storedMessage(77, exactQuote, "42", "Коля"),
      ],
    },
  );

  const result = await fixture.agent.run(request());

  assert.equal(fixture.searchCalls, 1);
  assert.deepEqual(result.evidence, [
    { speaker: "Коля", text: exactQuote },
  ]);
  assert.equal(model.doGenerateCalls.length, 2);
  const secondPrompt = JSON.stringify(
    model.doGenerateCalls[1]?.prompt,
  );
  assert.match(secondPrompt, /<ДАННЫЕ_fixed_nonce_1234/);
  assert.match(secondPrompt, /chat_message/);
});

test("five parallel requests execute exactly four tools and force a tool-free final step", async () => {
  const calls = Array.from({ length: 5 }, (_, index) =>
    toolCall(`parallel-${index}`, "search_chat", {
      query: `query-${index}`,
      limit: 1,
    }),
  );
  const model = mockModel([
    toolResponse(calls),
    response(
      [{ type: "text", text: "финал после лимита" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);
  let toolDrains = 0;

  const result = await fixture.agent.run(
    request({
      drainFold: (boundary) => {
        if (boundary === "tool") {
          toolDrains += 1;
        }
        return emptyFold(boundary);
      },
    }),
  );

  assert.equal(result.text, "финал после лимита");
  assert.equal(fixture.searchCalls, 4);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(model.doGenerateCalls[1]?.tools, undefined);
  assert.deepEqual(model.doGenerateCalls[1]?.toolChoice, {
    type: "none",
  });
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.complete",
  );
  assert.equal(completed?.requestedToolCalls, 5);
  assert.equal(completed?.allowedToolCalls, 4);
  assert.equal(completed?.startedToolCalls, 4);
  assert.equal(completed?.completedToolCalls, 4);
  assert.equal(completed?.deniedToolCalls, 1);
  assert.equal(completed?.turnId, 1);
  assert.equal(completed?.updateId, 2);
  assert.equal(
    fixture.logs.every(
      (record) =>
        record.turnId === 1 &&
        record.updateId === 2,
    ),
    true,
  );
  assert.equal(toolDrains, 4);
});

test("forced-final denies a valid tool after four malformed tool-call steps", async () => {
  const malformed = Array.from({ length: 4 }, (_, index) =>
    toolResponse([
      {
        type: "tool-call" as const,
        toolCallId: `malformed-${index}`,
        toolName: "search_chat",
        input: '{"query":',
      },
    ]),
  );
  const validAtForcedFinal = toolResponse([
    toolCall("must-be-denied", "search_chat", {
      query: "must not execute",
    }),
  ]);
  const model = mockModel([...malformed, validAtForcedFinal]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  await assert.rejects(
    fixture.agent.run(request()),
    (error) =>
      error instanceof BotAgentProtocolError &&
      error.code === "incomplete_finish",
  );
  assert.equal(model.doGenerateCalls.length, 5);
  assert.equal(model.doGenerateCalls[4]?.tools, undefined);
  assert.deepEqual(model.doGenerateCalls[4]?.toolChoice, {
    type: "none",
  });
  assert.equal(fixture.searchCalls, 0);
});

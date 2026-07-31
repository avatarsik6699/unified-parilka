import assert from "node:assert/strict";
import { test } from "node:test";
import { BotAgentProtocolError } from "../src/bot/ai-agent.js";
import { BotMemoryTools } from "../src/bot/memory-tools.js";
import type { ToolProgressPort } from "../src/bot/tool-progress.js";
import { MessageStore } from "../src/store.js";
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

test("reports safe thinking boundaries around model and tool steps", async () => {
  const model = mockModel([
    toolResponse([
      toolCall("call-search", "search_chat", { query: "реплика", limit: 1 }),
    ]),
    response([{ type: "text", text: "готово" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);
  const events: string[] = [];
  const progress: ToolProgressPort = {
    onThinkingStarted: () => events.push("thinking:start"),
    onThinkingCompleted: (_event, ok) => events.push(`thinking:${ok ? "ok" : "error"}`),
    onToolStarted: (event) => events.push(`tool:start:${event.toolName}`),
    onToolCompleted: (event, ok) => events.push(`tool:${ok ? "ok" : "error"}:${event.toolName}`),
  };

  const result = await fixture.agent.run(request({ toolProgressPort: progress }));

  assert.equal(result.text, "готово");
  assert.deepEqual(events, [
    "thinking:start",
    "thinking:ok",
    "tool:start:search_chat",
    "tool:ok:search_chat",
    "thinking:start",
    "thinking:ok",
  ]);
});

test("seven parallel requests execute exactly six tools and force a tool-free final step", async () => {
  const calls = Array.from({ length: 7 }, (_, index) =>
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
  assert.equal(fixture.searchCalls, 6);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(model.doGenerateCalls[1]?.tools, undefined);
  assert.deepEqual(model.doGenerateCalls[1]?.toolChoice, {
    type: "none",
  });
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.complete",
  );
  assert.equal(completed?.requestedToolCalls, 7);
  assert.equal(completed?.allowedToolCalls, 6);
  assert.equal(completed?.startedToolCalls, 6);
  assert.equal(completed?.completedToolCalls, 6);
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
  assert.equal(toolDrains, 6);
});

test("research depth gate retries a premature final through Qwen-compatible auto tool choice", async () => {
  const model = mockModel([
    toolResponse([
      toolCall("scan", "search_chat", { query: "topic", limit: 1 }),
      toolCall("drill", "search_chat", { query: "topic context", limit: 1 }),
    ]),
    response([{ type: "text", text: "слишком ранний итог" }], "stop"),
    toolResponse([
      toolCall("audit", "search_chat", { query: "topic counterpoint", limit: 1 }),
      toolCall("source", "search_chat", { query: "topic primary source", limit: 1 }),
    ]),
    response([{ type: "text", text: "проверенный итог" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  const result = await fixture.agent.run(
    request({
      trigger: storedMessage(
        100,
        "исследуй тему нормально, а не по верхам",
        "42",
        "Коля",
      ),
    }),
  );

  assert.equal(result.text, "проверенный итог");
  assert.equal(fixture.searchCalls, 4);
  assert.equal(model.doGenerateCalls.length, 4);
  for (const call of model.doGenerateCalls) {
    assert.deepEqual(call.toolChoice, { type: "auto" });
  }
  assert.match(
    promptUserText(model.doGenerateCalls[2]),
    /Результат уже выполненного инструмента из предыдущего раунда работы/,
  );
  const retried = fixture.logs.find(
    (record) => record.event === "bot.agent.research_depth_retry",
  );
  assert.equal(retried?.requiredReadToolCalls, 4);
  assert.equal(retried?.startedReadToolCalls, 2);
  const completed = fixture.logs.find(
    (record) => record.event === "bot.agent.complete",
  );
  assert.equal(completed?.researchMode, "research");
  assert.equal(completed?.toolCallBudget, 12);
  assert.equal(completed?.startedReadToolCalls, 4);
  assert.equal(completed?.researchQualityRetries, 1);
});

test("malformed tool-call steps do not hit an arbitrary step ceiling", async () => {
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
  const model = mockModel([
    ...malformed,
    response([{ type: "text", text: "финал после исправления" }], "stop"),
  ]);
  const fixture = makeAgent([candidate("primary:test", model)]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "финал после исправления");
  assert.equal(model.doGenerateCalls.length, 5);
  assert.equal(fixture.searchCalls, 0);
});

test("memory write tools exist only for an explicit authoritative trigger", async () => {
  const store = new MessageStore(":memory:");
  try {
    const memoryTools = new BotMemoryTools({ store });
    const directModel = mockModel([
      toolResponse([
        toolCall("remember", "remember_fast", {
          title: "release",
          note: "run full gates before restart",
        }),
      ]),
      response([{ type: "text", text: "запомнил" }], "stop"),
    ]);
    const directFixture = makeAgent(
      [candidate("primary:test", directModel)],
      { memoryTools },
    );

    await directFixture.agent.run(
      request({
        trigger: storedMessage(
          100,
          "запомни это в память: перед рестартом прогони все гейты",
          "42",
          "Коля",
        ),
      }),
    );
    assert.equal(store.listFastChatMemory("-1004242")[0]?.title, "release");
    assert.equal(directModel.doGenerateCalls.length, 2);

    const ordinaryModel = mockModel([
      response([{ type: "text", text: "обычный ответ" }], "stop"),
    ]);
    const ordinaryFixture = makeAgent(
      [candidate("primary:test", ordinaryModel)],
      { memoryTools },
    );
    await ordinaryFixture.agent.run(request());
    assert.equal(ordinaryModel.doGenerateCalls.length, 1);
    assert.equal(store.listFastChatMemory("-1004242").length, 1);
  } finally {
    store.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import {
  candidate,
  makeAgent,
  mockModel,
  request,
  response,
  toolCall,
  toolResponse,
} from "./support/ai-agent.js";

test("content filtering is terminal and never tries the backup provider", async () => {
  const blocked = mockModel([response([], "content-filter")]);
  const backup = mockModel([
    response(
      [{ type: "text", text: "ответ запасной модели" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([
    candidate("primary:blocked", blocked),
    candidate("backup:working", backup),
  ]);

  await assert.rejects(fixture.agent.run(request()), (error) => {
    assert.equal((error as Error).name, "ModelContentFilterError");
    return true;
  });
  assert.equal(blocked.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 0);
});

test("an empty successful provider response falls back as invalid candidate output", async () => {
  const empty = mockModel([response([], "stop")]);
  const backup = mockModel([
    response([{ type: "text", text: "непустой ответ" }], "stop"),
  ]);
  const fixture = makeAgent([
    candidate("primary:empty", empty),
    candidate("backup:working", backup),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "непустой ответ");
  assert.equal(empty.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 1);
});

test("provider fallback keeps bounded tool data and shares one four-call budget", async () => {
  const first = mockModel([
    toolResponse([
      toolCall("first-1", "search_chat", {
        query: "first-one",
      }),
      toolCall("first-2", "search_chat", {
        query: "first-two",
      }),
    ]),
    Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
    }) as never,
  ]);
  const second = mockModel([
    toolResponse([
      toolCall("second-1", "search_chat", {
        query: "second-one",
      }),
      toolCall("second-2", "search_chat", {
        query: "second-two",
      }),
      toolCall("second-3", "search_chat", {
        query: "second-denied",
      }),
    ]),
    response(
      [{ type: "text", text: "собранный финал" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([
    candidate("primary:unstable", first),
    candidate("backup:stable", second),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "собранный финал");
  assert.equal(fixture.searchCalls, 4);
  assert.match(
    JSON.stringify(second.doGenerateCalls[0]?.prompt),
    /Результат уже выполненного инструмента из предыдущей попытки/,
  );
  assert.match(
    JSON.stringify(second.doGenerateCalls[0]?.prompt),
    /first-one/,
  );
  assert.equal(second.doGenerateCalls[1]?.tools, undefined);
});

test("an external abort is terminal and never tries the backup provider", async () => {
  const first = new MockLanguageModelV4({
    doGenerate: async (options) =>
      await new Promise<LanguageModelV4GenerateResult>(
        (_resolve, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException(
                  "The operation was aborted",
                  "AbortError",
                ),
              ),
            { once: true },
          );
        },
      ),
  });
  const backup = mockModel([
    response(
      [{ type: "text", text: "не должен запуститься" }],
      "stop",
    ),
  ]);
  const fixture = makeAgent([
    candidate("primary:slow", first),
    candidate("backup:no", backup),
  ]);
  const controller = new AbortController();
  const running = fixture.agent.run(
    request({ signal: controller.signal }),
  );

  setImmediate(() => controller.abort());

  await assert.rejects(running, (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(first.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 0);
});

test("one total deadline covers all candidates and is terminal", async () => {
  const slow = new MockLanguageModelV4({
    doGenerate: async (options) =>
      await new Promise<LanguageModelV4GenerateResult>(
        (_resolve, reject) => {
          options.abortSignal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException(
                  "The operation was aborted",
                  "AbortError",
                ),
              ),
            { once: true },
          );
        },
      ),
  });
  const backup = mockModel([
    response([{ type: "text", text: "слишком поздно" }], "stop"),
  ]);
  const fixture = makeAgent(
    [
      candidate("primary:slow", slow),
      candidate("backup:no", backup),
    ],
    {
      agentOptions: {
        totalTimeoutMs: 100,
        stepTimeoutMs: 100,
        toolTimeoutMs: 100,
      },
    },
  );

  await assert.rejects(fixture.agent.run(request()), (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(slow.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 0);
});

test("a live-turn TimeoutError becomes a transport failure and falls back", async () => {
  const timeout = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new DOMException(
        "Step timeout of 100ms exceeded",
        "TimeoutError",
      );
    },
  });
  const backup = mockModel([
    response([{ type: "text", text: "таймаут пережит" }], "stop"),
  ]);
  const fixture = makeAgent([
    candidate("primary:timeout", timeout),
    candidate("backup:ok", backup),
  ]);

  const result = await fixture.agent.run(request());

  assert.equal(result.text, "таймаут пережит");
  assert.equal(timeout.doGenerateCalls.length, 1);
  assert.equal(backup.doGenerateCalls.length, 1);
});

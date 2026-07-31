import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TurnUsageAccumulator,
  buildTelemetryFooter,
} from "../src/bot/telemetry.js";

test("footer shows only model, compact input/output, tool calls and duration", () => {
  const telemetry = Object.freeze({
    finalProviderId: "qwen",
    finalModelId: "qwen/qwen3.8-max-preview",
    reasoningMode: "on",
    steps: Object.freeze([]),
    totalInputTokens: 7_400,
    totalOutputTokens: 219,
    totalTokens: 7_600,
    toolCalls: 6,
    durationMs: 81_200,
    incomplete: false,
  });

  const footer = buildTelemetryFooter(telemetry);

  assert.match(footer, /qwen3\.8-max-preview 🧠/u);
  assert.match(footer, /7\.4k\/219/u);
  assert.match(footer, /6 tool calls/u);
  assert.match(footer, /1м 21с/u);
  assert.doesNotMatch(footer, /reasoning|qwen\/|total:|reported|──/u);
});

test("footer keeps compact unknown token fields without a reasoning marker", () => {
  const telemetry = Object.freeze({
    finalProviderId: "deepseek",
    finalModelId: "deepseek-v4-flash",
    reasoningMode: undefined,
    steps: Object.freeze([]),
    totalInputTokens: 100,
    totalOutputTokens: undefined,
    totalTokens: undefined,
    toolCalls: 0,
    durationMs: 0,
    incomplete: true,
  });

  const footer = buildTelemetryFooter(telemetry);

  assert.match(footer, /100\/\?/u);
  assert.match(footer, /0 tool calls · 0с/u);
  assert.doesNotMatch(footer, /reasoning|total:|reported|──/u);
});

test("accumulator sums steps and marks incomplete when usage missing", () => {
  const acc = new TurnUsageAccumulator();
  acc.recordStep({
    modelId: "m1",
    providerId: "p1",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  acc.recordStep({
    modelId: "m2",
    providerId: "p2",
    inputTokens: 20,
    outputTokens: undefined,
    totalTokens: 25,
  });
  acc.setFinalModel("m-final", "p-final");
  acc.setExecutionStats({ toolCalls: 2, durationMs: 3_000 });

  const telemetry = acc.build();

  assert.equal(telemetry.totalInputTokens, 30);
  assert.equal(telemetry.totalOutputTokens, 5);
  assert.equal(telemetry.totalTokens, 40);
  assert.equal(telemetry.incomplete, true);
  assert.equal(telemetry.finalModelId, "m-final");
  assert.equal(telemetry.finalProviderId, "p-final");
  assert.equal(telemetry.toolCalls, 2);
  assert.equal(telemetry.durationMs, 3_000);
});

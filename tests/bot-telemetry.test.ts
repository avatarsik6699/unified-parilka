import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TurnUsageAccumulator,
  buildTelemetryFooter,
} from "../src/bot/telemetry.js";

test("footer shows provider/model, reasoning mode and complete tokens", () => {
  const telemetry = Object.freeze({
    finalProviderId: "qwen",
    finalModelId: "qwen3.8-max-preview",
    reasoningMode: "on",
    steps: Object.freeze([]),
    totalInputTokens: 7_400,
    totalOutputTokens: 219,
    totalTokens: 7_600,
    incomplete: false,
  });

  const footer = buildTelemetryFooter(telemetry);

  assert.match(footer, /qwen\/qwen3\.8-max-preview/u);
  assert.match(footer, /reasoning:on/u);
  assert.match(footer, /in:7\.4k/u);
  assert.match(footer, /out:219/u);
  assert.match(footer, /total:7\.6k/u);
  assert.doesNotMatch(footer, /reported/u);
});

test("footer marks unknown reasoning and incomplete usage", () => {
  const telemetry = Object.freeze({
    finalProviderId: "deepseek",
    finalModelId: "deepseek-v4-flash",
    reasoningMode: undefined,
    steps: Object.freeze([]),
    totalInputTokens: 100,
    totalOutputTokens: undefined,
    totalTokens: undefined,
    incomplete: true,
  });

  const footer = buildTelemetryFooter(telemetry);

  assert.match(footer, /reasoning:\?/u);
  assert.match(footer, /out:\?/u);
  assert.match(footer, /total:\?/u);
  assert.match(footer, /reported/u);
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

  const telemetry = acc.build();

  assert.equal(telemetry.totalInputTokens, 30);
  assert.equal(telemetry.totalOutputTokens, 5);
  assert.equal(telemetry.totalTokens, 40);
  assert.equal(telemetry.incomplete, true);
  assert.equal(telemetry.finalModelId, "m-final");
  assert.equal(telemetry.finalProviderId, "p-final");
});

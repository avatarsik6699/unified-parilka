import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageGenerationBudget } from "../src/bot/agent/image-generation-budget.js";

// ─── Image generation budget ───────────────────────────────────────────────

test("allows up to maxImagesPerTurn within one turn", () => {
  const budget = new ImageGenerationBudget(2, 10);
  assert.equal(budget.reserve("turn-1").ok, true);
  assert.equal(budget.reserve("turn-1").ok, true);
  const denied = budget.reserve("turn-1");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "turn_limit");
});

test("a different turn id gets its own per-turn budget", () => {
  const budget = new ImageGenerationBudget(1, 10);
  assert.equal(budget.reserve("turn-1").ok, true);
  assert.equal(budget.reserve("turn-2").ok, true);
});

test("release frees both the turn and day slot for a failed generation", () => {
  const budget = new ImageGenerationBudget(1, 1);
  assert.equal(budget.reserve("turn-1").ok, true);
  budget.release("turn-1");
  assert.equal(budget.reserve("turn-1").ok, true);
});

test("day limit blocks even a fresh turn once the daily cap is spent", () => {
  const budget = new ImageGenerationBudget(5, 1);
  assert.equal(budget.reserve("turn-1").ok, true);
  const denied = budget.reserve("turn-2");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "day_limit");
});

test("day count resets on UTC day rollover", () => {
  let now = new Date("2026-08-24T23:59:00Z");
  const budget = new ImageGenerationBudget(5, 1, () => now);
  assert.equal(budget.reserve("turn-1").ok, true);
  assert.equal(budget.reserve("turn-2").ok, false);
  now = new Date("2026-08-25T00:01:00Z");
  assert.equal(budget.reserve("turn-3").ok, true);
});

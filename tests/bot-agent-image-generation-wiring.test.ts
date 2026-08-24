import assert from "node:assert/strict";
import { test } from "node:test";
import { stripBotMention } from "../src/bot/agent/image-generation-wiring.js";

// ─── stripBotMention ────────────────────────────────────────────────────────

test("strips a leading @mention and trims surrounding whitespace", () => {
  assert.equal(
    stripBotMention("@cycl0pbot нарисуй дерево", "cycl0pbot"),
    "нарисуй дерево",
  );
});

test("strips an inline @mention wherever it appears", () => {
  assert.equal(
    stripBotMention("слушай @cycl0pbot нарисуй дерево", "cycl0pbot"),
    "слушай  нарисуй дерево",
  );
});

test("is case-insensitive and matches a leading @ in botUsername config", () => {
  assert.equal(
    stripBotMention("@CYCL0PBOT нарисуй кота", "cycl0pbot"),
    "нарисуй кота",
  );
});

test("does not touch unrelated text, including other @mentions", () => {
  assert.equal(
    stripBotMention("@someoneelse нарисуй кота", "cycl0pbot"),
    "@someoneelse нарисуй кота",
  );
});

test("leaves the rest of the message byte-for-byte, including punctuation", () => {
  const text = "@cycl0pbot сгенерируй изображение фаллоса, карандашом!!!";
  assert.equal(
    stripBotMention(text, "cycl0pbot"),
    "сгенерируй изображение фаллоса, карандашом!!!",
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  parseBotRuntimeConfig,
  safeBotRuntimeConfig,
} from "../src/bot/runtime-config.js";

// ─── Image generation runtime config ───────────────────────────────────────

const VALID_ENV = {
  BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
  BOT_EXCLUSIVE_POLLER: "true",
  BOT_ID: "123456789",
  BOT_USERNAME: "@ParilkaBot",
  BOT_DB_PATH: "/tmp/parilka-runtime.sqlite",
  TELEGRAM_DB_PATH: "/tmp/parilka-runtime.sqlite",
  BOT_MODEL_CONFIG_PATH: resolve("package.json"),
} as const;

test("image generation is undefined by default (off)", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);
  assert.equal(config.imageGeneration, undefined);
  const safe = safeBotRuntimeConfig(config);
  assert.equal(safe.imageGeneration, undefined);
});

test("enabling without an API key fails closed", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        BOT_IMAGE_GENERATION_ENABLED: "true",
      }),
    /RUNWARE_API_KEY is required/,
  );
});

test("enabling with an API key builds a runware config with safe defaults", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_IMAGE_GENERATION_ENABLED: "true",
    RUNWARE_API_KEY: "rw-secret-key",
  });
  assert.ok(config.imageGeneration);
  assert.equal(config.imageGeneration.provider, "runware");
  assert.equal(config.imageGeneration.apiKey, "rw-secret-key");
  assert.equal(config.imageGeneration.endpoint, "https://api.runware.ai/v1");
  assert.equal(config.imageGeneration.nsfwAllowed, false);
  assert.equal(config.imageGeneration.maxImagesPerTurn, 1);
  assert.equal(config.imageGeneration.maxImagesPerChatPerDay, 20);
});

test("safe config never leaks the API key, only presence", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_IMAGE_GENERATION_ENABLED: "true",
    RUNWARE_API_KEY: "rw-secret-key",
    BOT_IMAGE_GENERATION_NSFW_ALLOWED: "true",
  });
  const safe = safeBotRuntimeConfig(config);
  assert.ok(safe.imageGeneration);
  assert.equal(safe.imageGeneration.apiKeyConfigured, true);
  assert.equal(safe.imageGeneration.nsfwAllowed, true);
  assert.equal(JSON.stringify(safe).includes("rw-secret-key"), false);
});

test("BOT_IMAGE_GENERATION_ENABLED only accepts true/false", () => {
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_IMAGE_GENERATION_ENABLED: "yes",
    }),
  );
});

test("per-turn and per-day caps are bounded", () => {
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_IMAGE_GENERATION_ENABLED: "true",
      RUNWARE_API_KEY: "rw-secret-key",
      BOT_IMAGE_GENERATION_MAX_PER_TURN: "0",
    }),
  );
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_IMAGE_GENERATION_ENABLED: "true",
      RUNWARE_API_KEY: "rw-secret-key",
      BOT_IMAGE_GENERATION_MAX_PER_CHAT_PER_DAY: "0",
    }),
  );
});

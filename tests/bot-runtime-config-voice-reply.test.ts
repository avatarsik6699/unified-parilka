import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  parseBotRuntimeConfig,
  safeBotRuntimeConfig,
} from "../src/bot/runtime-config.js";

// ─── Voice reply runtime config ─────────────────────────────────────────────

const VALID_ENV = {
  BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
  BOT_EXCLUSIVE_POLLER: "true",
  BOT_ID: "123456789",
  BOT_USERNAME: "@ParilkaBot",
  BOT_DB_PATH: "/tmp/parilka-runtime.sqlite",
  TELEGRAM_DB_PATH: "/tmp/parilka-runtime.sqlite",
  BOT_MODEL_CONFIG_PATH: resolve("package.json"),
} as const;

test("voice reply is undefined by default (off)", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);
  assert.equal(config.voiceReply, undefined);
  const safe = safeBotRuntimeConfig(config);
  assert.equal(safe.voiceReply, undefined);
});

test("enabling without an API key fails closed", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        BOT_VOICE_REPLY_ENABLED: "true",
      }),
    /RUNWARE_API_KEY is required/,
  );
});

test("enabling with an API key builds a runware config with safe defaults", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_VOICE_REPLY_ENABLED: "true",
    RUNWARE_API_KEY: "rw-secret-key",
  });
  assert.ok(config.voiceReply);
  assert.equal(config.voiceReply.provider, "runware");
  assert.equal(config.voiceReply.apiKey, "rw-secret-key");
  assert.equal(config.voiceReply.endpoint, "https://api.runware.ai/v1");
  assert.equal(config.voiceReply.maxRepliesPerTurn, 1);
  assert.equal(config.voiceReply.maxRepliesPerChatPerDay, 20);
});

test("safe config never leaks the API key, only presence", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_VOICE_REPLY_ENABLED: "true",
    RUNWARE_API_KEY: "rw-secret-key",
  });
  const safe = safeBotRuntimeConfig(config);
  assert.ok(safe.voiceReply);
  assert.equal(safe.voiceReply.apiKeyConfigured, true);
  assert.equal(JSON.stringify(safe).includes("rw-secret-key"), false);
});

test("BOT_VOICE_REPLY_ENABLED only accepts true/false", () => {
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_VOICE_REPLY_ENABLED: "yes",
    }),
  );
});

test("per-turn and per-day caps are bounded", () => {
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_VOICE_REPLY_ENABLED: "true",
      RUNWARE_API_KEY: "rw-secret-key",
      BOT_VOICE_REPLY_MAX_PER_TURN: "0",
    }),
  );
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_VOICE_REPLY_ENABLED: "true",
      RUNWARE_API_KEY: "rw-secret-key",
      BOT_VOICE_REPLY_MAX_PER_CHAT_PER_DAY: "0",
    }),
  );
});

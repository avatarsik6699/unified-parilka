import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  parseBotRuntimeConfig,
  safeBotRuntimeConfig,
} from "../src/bot/runtime-config.js";

const VALID_ENV = {
  BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
  BOT_EXCLUSIVE_POLLER: "true",
  BOT_ID: "123456789",
  BOT_USERNAME: "@ParilkaBot",
  BOT_DB_PATH: "/tmp/parilka-runtime.sqlite",
  TELEGRAM_DB_PATH: "/tmp/parilka-runtime.sqlite",
  BOT_MODEL_CONFIG_PATH: resolve("package.json"),
} as const;

test("news-brief trigger is undefined by default (off, nobody can trigger early)", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);
  assert.equal(config.newsBriefTrigger, undefined);
  const safe = safeBotRuntimeConfig(config);
  assert.equal(safe.newsBriefTriggerConfigured, false);
});

test("a configured trigger user id is normalized to a canonical decimal string", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_NEWS_BRIEF_TRIGGER_USER_ID: "00042",
  });
  assert.ok(config.newsBriefTrigger);
  assert.equal(config.newsBriefTrigger.triggerUserId, "42");
  assert.equal(config.newsBriefTrigger.seenStorePath, undefined);
});

test("a negative or non-integer trigger user id is rejected", () => {
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_NEWS_BRIEF_TRIGGER_USER_ID: "-42",
    }),
  );
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_NEWS_BRIEF_TRIGGER_USER_ID: "not-an-id",
    }),
  );
});

test("an optional seen-store path override is resolved to an absolute path", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_NEWS_BRIEF_TRIGGER_USER_ID: "42",
    BOT_NEWS_BRIEF_SEEN_STORE_PATH: "/tmp/news-brief-seen.json",
  });
  assert.equal(
    config.newsBriefTrigger?.seenStorePath,
    "/tmp/news-brief-seen.json",
  );
});

test("safe config never leaks the privileged user id, only whether it is configured", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_NEWS_BRIEF_TRIGGER_USER_ID: "987654321",
  });
  const safe = safeBotRuntimeConfig(config);
  assert.equal(safe.newsBriefTriggerConfigured, true);
  assert.equal(JSON.stringify(safe).includes("987654321"), false);
});

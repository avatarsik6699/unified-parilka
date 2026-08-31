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

test("VK config is undefined by default (opt-in second transport)", () => {
  const config = parseBotRuntimeConfig(VALID_ENV);
  assert.equal(config.vk, undefined);
  const safe = safeBotRuntimeConfig(config);
  assert.equal(safe.vk, undefined);
});

test("a configured group token requires a group id", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
      }),
    /BOT_VK_GROUP_ID is required/u,
  );
});

test("a well-formed group token and id parse with the default API version", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
    BOT_VK_GROUP_ID: "123456",
  });
  assert.ok(config.vk);
  assert.equal(config.vk.groupToken, "vk1.a-fake-token");
  assert.equal(config.vk.groupId, 123_456);
  assert.equal(config.vk.apiVersion, "5.199");
});

test("an explicit API version overrides the default", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
    BOT_VK_GROUP_ID: "123456",
    BOT_VK_API_VERSION: "5.131",
  });
  assert.equal(config.vk?.apiVersion, "5.131");
});

test("a malformed API version is rejected", () => {
  assert.throws(
    () =>
      parseBotRuntimeConfig({
        ...VALID_ENV,
        BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
        BOT_VK_GROUP_ID: "123456",
        BOT_VK_API_VERSION: "not-a-version",
      }),
    /BOT_VK_API_VERSION/u,
  );
});

test("a non-positive or non-integer group id is rejected", () => {
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
      BOT_VK_GROUP_ID: "0",
    }),
  );
  assert.throws(() =>
    parseBotRuntimeConfig({
      ...VALID_ENV,
      BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
      BOT_VK_GROUP_ID: "not-an-id",
    }),
  );
});

test("safe config never leaks the raw group token, only whether it is configured", () => {
  const config = parseBotRuntimeConfig({
    ...VALID_ENV,
    BOT_VK_GROUP_TOKEN: "vk1.super-secret-token-value",
    BOT_VK_GROUP_ID: "123456",
  });
  const safe = safeBotRuntimeConfig(config);
  assert.deepEqual(safe.vk, {
    groupTokenConfigured: true,
    groupId: 123_456,
    apiVersion: "5.199",
  });
  assert.equal(
    JSON.stringify(safe).includes("vk1.super-secret-token-value"),
    false,
  );
});

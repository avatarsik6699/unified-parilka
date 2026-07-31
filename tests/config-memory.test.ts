import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BOOLEAN_ENV_RULES, loadConfig } from "../src/config.js";

test("memory config rejects max messages below dream threshold", () => {
  withEnv(
    {
      PARILKA_DREAM_EVERY_N_MESSAGES: "100",
      PARILKA_DREAM_MAX_MESSAGES: "50",
    },
    () => {
      assert.throws(
        () => loadConfig(),
        /PARILKA_DREAM_MAX_MESSAGES must be greater than or equal to PARILKA_DREAM_EVERY_N_MESSAGES/,
      );
    },
  );
});

test("memory config loads bounded defaults", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.memory.dreamEveryNMessages, 50);
    assert.equal(config.memory.dreamMaxMessages, 200);
    assert.equal(config.memory.memoryMaxChars, 2000);
  });
});

function unsetBooleanEnv(): Record<string, undefined> {
  return Object.fromEntries(
    Object.keys(BOOLEAN_ENV_RULES).map((name) => [name, undefined]),
  ) as Record<string, undefined>;
}

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-test-"));
  const applied = {
    TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
    TELEGRAM_DEFAULT_CHAT_ID: "-1000000000000",
    TELEGRAM_ALLOWED_CHAT_IDS: "-1000000000000",
    ...unsetBooleanEnv(),
    ...vars,
  };
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(applied)) {
    previous.set(key, process.env[key]);
    const value = applied[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

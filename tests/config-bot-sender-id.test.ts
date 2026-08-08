import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, redactedConfig } from "../src/config.js";

test("PARILKA_BOT_ID accepts positive decimals up to MAX_SAFE_INTEGER", () => {
  for (const raw of ["1", "123456789", "9007199254740991"]) {
    withEnv({ PARILKA_BOT_ID: raw }, () => {
      assert.equal(loadConfig().telegram.botSenderId, raw);
    });
  }
});

test("PARILKA_BOT_ID unset or empty yields undefined and redacts the value", () => {
  withEnv({ PARILKA_BOT_ID: undefined }, () => {
    assert.equal(loadConfig().telegram.botSenderId, undefined);
  });
  withEnv({ PARILKA_BOT_ID: "" }, () => {
    assert.equal(loadConfig().telegram.botSenderId, undefined);
  });
  withEnv({ PARILKA_BOT_ID: "9007199254740991" }, () => {
    const config = redactedConfig(loadConfig()) as {
      telegram: { botSenderId: string };
    };
    assert.equal(config.telegram.botSenderId, "<set>");
    assert.doesNotMatch(JSON.stringify(config), /9007199254740991/);
  });
});

test("PARILKA_BOT_ID rejects zero, leading zeros, and non-decimal values", () => {
  for (const raw of ["0", "00", "0123", "abc", "123a", "-5", "1.5"]) {
    withEnv({ PARILKA_BOT_ID: raw }, () => {
      assert.throws(
        () => loadConfig(),
        /PARILKA_BOT_ID must be a positive decimal integer without a leading zero/,
        `must reject ${JSON.stringify(raw)}`,
      );
    });
  }
});

test("PARILKA_BOT_ID rejects values above the safe integer range", () => {
  for (const raw of ["9007199254740992", "99999999999999999999"]) {
    withEnv({ PARILKA_BOT_ID: raw }, () => {
      assert.throws(
        () => loadConfig(),
        /PARILKA_BOT_ID must not exceed the JavaScript safe integer range/,
        `must reject ${JSON.stringify(raw)}`,
      );
    });
  }
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "telegram-config-test-"));
  const applied: Record<string, string | undefined> = {
    TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
    TELEGRAM_DEFAULT_CHAT_ID: "-1000000000000",
    TELEGRAM_ALLOWED_CHAT_IDS: "-1000000000000",
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

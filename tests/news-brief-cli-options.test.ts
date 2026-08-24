import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  NewsBriefCliConfigError,
  parseOptions,
} from "../src/news-brief-cli/options.js";

function tempDbPath(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-news-brief-cli-"));
  const dbPath = join(dir, "state.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY);
    PRAGMA user_version = 20;
  `);
  db.close();
  return { dbPath, dir };
}

test("dry run does not require a bot token or model config", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    const options = parseOptions(
      ["--chat", "-1001234567890", "--db", dbPath],
      {},
    );
    assert.equal(options.apply, false);
    assert.equal(options.botToken, undefined);
    assert.equal(options.modelConfigPath, undefined);
    assert.equal(options.maxItems, 6);
    assert.equal(options.searxngEndpoint, "http://127.0.0.1:8080");
    assert.equal(options.firecrawlEndpoint, "http://127.0.0.1:3002");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply without a bot token fails clearly", () => {
  const { dbPath, dir } = tempDbPath();
  const modelConfigPath = join(dir, "model-router.json");
  writeFileSync(modelConfigPath, "{}");
  try {
    assert.throws(
      () =>
        parseOptions(
          [
            "--chat",
            "-1001234567890",
            "--db",
            dbPath,
            "--apply",
            "--model-config",
            modelConfigPath,
          ],
          {},
        ),
      (error: unknown) =>
        error instanceof NewsBriefCliConfigError &&
        error.code === "missing_bot_token",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply without a model config fails clearly", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    assert.throws(
      () =>
        parseOptions(
          [
            "--chat",
            "-1001234567890",
            "--db",
            dbPath,
            "--apply",
            "--bot-token",
            "test-token",
          ],
          {},
        ),
      (error: unknown) =>
        error instanceof NewsBriefCliConfigError &&
        error.code === "missing_model_config",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply accepts bot token and model config from env", () => {
  const { dbPath, dir } = tempDbPath();
  const modelConfigPath = join(dir, "model-router.json");
  writeFileSync(modelConfigPath, "{}");
  try {
    const options = parseOptions(
      ["--chat", "-1001234567890", "--db", dbPath, "--apply"],
      { BOT_TOKEN: "env-token", BOT_MODEL_CONFIG_PATH: modelConfigPath },
    );
    assert.equal(options.botToken, "env-token");
    assert.equal(options.modelConfigPath, modelConfigPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat id must match a single-entry TELEGRAM_ALLOWED_CHAT_IDS", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    assert.throws(
      () =>
        parseOptions(["--chat", "-1009999999999", "--db", dbPath], {
          TELEGRAM_ALLOWED_CHAT_IDS: "-1001234567890",
        }),
      (error: unknown) =>
        error instanceof NewsBriefCliConfigError &&
        error.code === "chat_not_allowlisted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("max-items is bounded", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    assert.throws(
      () =>
        parseOptions(
          ["--chat", "-1001234567890", "--db", dbPath, "--max-items", "50"],
          {},
        ),
      (error: unknown) =>
        error instanceof NewsBriefCliConfigError &&
        error.code === "integer_out_of_range",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown arguments are rejected", () => {
  const { dbPath, dir } = tempDbPath();
  try {
    assert.throws(
      () =>
        parseOptions(
          ["--chat", "-1001234567890", "--db", dbPath, "--bogus"],
          {},
        ),
      (error: unknown) =>
        error instanceof NewsBriefCliConfigError &&
        error.code === "unknown_argument",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

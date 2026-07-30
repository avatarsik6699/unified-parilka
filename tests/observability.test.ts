import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { createLogger } from "../src/observability/logger.js";
import {
  providerIdentityUrl,
  redactLogValue,
  redactUrl,
  safeError,
} from "../src/observability/redaction.js";

test("redacts nested credentials and credential-bearing URLs", () => {
  const value = redactLogValue({
    apiKey: "sk-live-secret",
    nested: {
      telegram_session: "session-secret",
      endpoint: "https://alice:password@example.test/v1?api_key=abc&model=x#fragment",
    },
  }) as Record<string, unknown>;

  assert.equal(value.apiKey, "[REDACTED]");
  assert.deepEqual(value.nested, {
    telegram_session: "[REDACTED]",
    endpoint: "https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/v1?api_key=%5BREDACTED%5D&model=x",
  });
  assert.equal(JSON.stringify(value).includes("sk-live-secret"), false);
  assert.equal(JSON.stringify(value).includes("session-secret"), false);
  assert.equal(JSON.stringify(value).includes("password"), false);
});

test("provider identity excludes credentials and sensitive query while preserving endpoint identity", () => {
  assert.equal(
    providerIdentityUrl("https://alice:secret@example.test/v1/?region=eu&api_key=one#two"),
    "https://example.test/v1/?region=eu",
  );
});

test("redactUrl preserves harmless query parameters", () => {
  assert.equal(
    redactUrl("https://example.test/v1?model=qwen&token=secret"),
    "https://example.test/v1?model=qwen&token=%5BREDACTED%5D",
  );
});

test("safeError keeps typed operational fields but drops stacks and arbitrary data", () => {
  const error = Object.assign(new Error("provider failed"), {
    code: "ETIMEDOUT",
    category: "provider",
    retryable: true,
    apiKey: "must-not-leak",
  });

  assert.deepEqual(safeError(error), {
    name: "Error",
    message: "provider failed",
    code: "ETIMEDOUT",
    category: "provider",
    retryable: true,
  });
});

test("redacts credentials embedded inside otherwise ordinary error strings", () => {
  const value = redactLogValue(
    "request to https://alice:password@example.test/v1?token=secret failed " +
      "with Bearer abcdefghijklmnopqrstuvwxyz and " +
      "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd",
  );

  assert.equal(typeof value, "string");
  assert.equal(String(value).includes("password"), false);
  assert.equal(String(value).includes("secret"), false);
  assert.equal(
    String(value).includes("abcdefghijklmnopqrstuvwxyz"),
    false,
  );
  assert.equal(
    String(value).includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd"),
    false,
  );
  assert.match(String(value), /\[REDACTED\]/u);
});

test("logger emits JSON to the supplied stderr-like stream with redaction", () => {
  let output = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = createLogger(
    { service: "bot", commit: "deadbeef" },
    { destination, level: "info" },
  );

  logger.info(
    {
      turnId: "turn-1",
      api_key: "secret",
      config: { session: "session-secret" },
    },
    "turn finished",
  );

  const record = JSON.parse(output.trim()) as Record<string, unknown>;
  assert.equal(record.service, "bot");
  assert.equal(record.commit, "deadbeef");
  assert.equal(record.turnId, "turn-1");
  assert.equal(record.api_key, "[REDACTED]");
  assert.deepEqual(record.config, { session: "[REDACTED]" });
  assert.equal(record.msg, "turn finished");
});

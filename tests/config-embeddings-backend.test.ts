import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BOOLEAN_ENV_RULES, loadConfig } from "../src/config.js";
import { redactedConfig } from "../src/config/redaction.js";

function unsetBooleanEnv(): Record<string, undefined> {
  return Object.fromEntries(
    Object.keys(BOOLEAN_ENV_RULES).map((name) => [name, undefined]),
  ) as Record<string, undefined>;
}

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "parilka-config-backend-"));
  const applied: Record<string, string | undefined> = {
    TELEGRAM_DB_PATH: join(dir, "messages.sqlite"),
    TELEGRAM_DEFAULT_CHAT_ID: "-1000000000000",
    TELEGRAM_ALLOWED_CHAT_IDS: "-1000000000000",
    ...unsetBooleanEnv(),
    TELEGRAM_EMBEDDINGS_ENABLED: "true",
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

test("embedding backend defaults to external_openai", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.embeddings.backend, "external_openai");
    assert.equal(config.embeddings.localEndpoint, "");
    assert.equal(config.embeddings.model, "text-embedding-3-small");
    assert.equal(config.embeddings.dimensions, 256);
  });
});

test("local_bge_m3 pins model/dimensions and never carries an API key", () => {
  withEnv(
    {
      TELEGRAM_EMBEDDINGS_BACKEND: "local_bge_m3",
      TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT: "http://127.0.0.1:8767",
      OPENAI_API_KEY: "test-key-must-not-attach",
      TELEGRAM_EMBEDDINGS_MODEL: "something-else",
      TELEGRAM_EMBEDDINGS_DIMENSIONS: "512",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.embeddings.backend, "local_bge_m3");
      assert.equal(config.embeddings.model, "bge-m3");
      assert.equal(config.embeddings.dimensions, 1024);
      assert.equal(config.embeddings.apiKey, "");
      assert.equal(
        config.embeddings.localEndpoint,
        "http://127.0.0.1:8767",
      );
    },
  );
});

test("local backend requires a loopback endpoint", () => {
  withEnv(
    {
      TELEGRAM_EMBEDDINGS_BACKEND: "local_bge_m3",
      TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT: "",
    },
    () => {
      assert.throws(
        () => loadConfig(),
        /TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT is required/,
      );
    },
  );
});

test("local backend rejects remote, credentialed, and query endpoints", () => {
  for (const endpoint of [
    "https://embeddings.example.com",
    "http://192.168.1.10:8767",
    "http://user:pass@127.0.0.1:8767",
    "http://127.0.0.1:8767?token=abc",
    "http://127.0.0.1:8767#fragment",
    "http://127.0.0.1:8767/base",
    "http://127.0.0.1:8767/nested/path",
  ]) {
    withEnv(
      {
        TELEGRAM_EMBEDDINGS_BACKEND: "local_bge_m3",
        TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT: endpoint,
      },
      () => {
        assert.throws(
          () => loadConfig(),
          /TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT/,
          `endpoint ${endpoint} must be rejected`,
        );
      },
    );
  }
});

test("local backend accepts a root origin with a trailing slash", () => {
  withEnv(
    {
      TELEGRAM_EMBEDDINGS_BACKEND: "local_bge_m3",
      TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT: "http://127.0.0.1:8767/",
    },
    () => {
      const config = loadConfig();
      assert.equal(
        config.embeddings.localEndpoint,
        "http://127.0.0.1:8767/",
      );
    },
  );
});

test("local backend rejects chunk windows wider than the service bound", () => {
  withEnv(
    {
      TELEGRAM_EMBEDDINGS_BACKEND: "local_bge_m3",
      TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT: "http://127.0.0.1:8767",
      TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS: "9000",
    },
    () => {
      assert.throws(
        () => loadConfig(),
        /TELEGRAM_EMBEDDINGS_CHUNK_MAX_CHARS must not exceed 8000/,
      );
    },
  );
});

test("unknown backend values fail closed", () => {
  withEnv(
    { TELEGRAM_EMBEDDINGS_BACKEND: "quantum" },
    () => {
      assert.throws(
        () => loadConfig(),
        /TELEGRAM_EMBEDDINGS_BACKEND must be one of/,
      );
    },
  );
});

test("redacted inspection names the backend without leaking credentials", () => {
  withEnv(
    {
      TELEGRAM_EMBEDDINGS_BACKEND: "local_bge_m3",
      TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT: "http://127.0.0.1:8767",
    },
    () => {
      const config = loadConfig();
      const inspected = JSON.stringify(redactedConfig(config));
      assert.match(inspected, /local_bge_m3/);
      assert.match(inspected, /localConfigured/);
      assert.doesNotMatch(inspected, /sk-|Bearer|api[_-]?key":"[^<]/i);
    },
  );
});

test("redactedConfig is backend-aware for the local BGE-M3 backend", () => {
  withEnv(
    {
      TELEGRAM_EMBEDDINGS_BACKEND: "local_bge_m3",
      TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT: "http://127.0.0.1:8767",
      TELEGRAM_EMBEDDINGS_LOCAL_REQUEST_TIMEOUT_MS: "15000",
      TELEGRAM_EMBEDDINGS_RERANK_TIMEOUT_MS: "5000",
      TELEGRAM_EMBEDDINGS_RERANK_MAX_CANDIDATES: "16",
      OPENAI_API_KEY: "test-key-must-not-attach",
    },
    () => {
      const embeddings = redactedConfig(loadConfig()).embeddings as Record<string, unknown>;
      assert.equal(embeddings.backend, "local_bge_m3");
      assert.equal(embeddings.configured, true);
      assert.equal(embeddings.localConfigured, true);
      assert.equal(embeddings.localEndpoint, "http://127.0.0.1:8767/");
      assert.equal(embeddings.localRequestTimeoutMs, 15_000);
      assert.equal(embeddings.rerankTimeoutMs, 5_000);
      assert.equal(embeddings.rerankMaxCandidates, 16);
      assert.equal("baseUrl" in embeddings, false);
      assert.doesNotMatch(JSON.stringify(embeddings), /api\.openai\.com|test-key/u);
    },
  );
});

test("redactedConfig keeps baseUrl and key-driven configured for the external backend", () => {
  withEnv({ TELEGRAM_EMBEDDINGS_API_KEY: "test-external-key" }, () => {
    const embeddings = redactedConfig(loadConfig()).embeddings as Record<string, unknown>;
    assert.equal(embeddings.backend, "external_openai");
    assert.equal(embeddings.configured, true);
    assert.equal(embeddings.baseUrl, "https://api.openai.com/v1");
    assert.equal("localEndpoint" in embeddings, false);
    assert.doesNotMatch(JSON.stringify(embeddings), /test-external-key/u);
  });

  withEnv(
    { TELEGRAM_EMBEDDINGS_API_KEY: "", OPENAI_API_KEY: "" },
    () => {
      const embeddings = redactedConfig(loadConfig()).embeddings as Record<string, unknown>;
      assert.equal(embeddings.backend, "external_openai");
      assert.equal(embeddings.configured, false);
    },
  );
});

test("rerank bounds are parsed from env", () => {
  withEnv(
    {
      TELEGRAM_EMBEDDINGS_RERANK_MAX_CANDIDATES: "16",
      TELEGRAM_EMBEDDINGS_RERANK_TIMEOUT_MS: "5000",
      TELEGRAM_EMBEDDINGS_LOCAL_REQUEST_TIMEOUT_MS: "15000",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.embeddings.rerankMaxCandidates, 16);
      assert.equal(config.embeddings.rerankTimeoutMs, 5_000);
      assert.equal(config.embeddings.localRequestTimeoutMs, 15_000);
    },
  );
});

test("rerank candidate bound is capped at 32", () => {
  withEnv(
    { TELEGRAM_EMBEDDINGS_RERANK_MAX_CANDIDATES: "33" },
    () => {
      assert.throws(() => loadConfig(), /between 0 and 32/);
    },
  );
});

import assert from "node:assert/strict";
import http from "node:http";
import { test, type TestContext } from "node:test";
import { LOCAL_BGE_M3_DIMENSIONS } from "../src/config/types.js";
import { LocalBgeM3Client } from "../src/vector/bge-client.js";
import { baseAppConfig } from "./support/app-config.js";

type Behavior = {
  status?: number;
  /** Respond 503 for the next N requests, then behave normally. */
  failuresLeft?: number;
  delayMs?: number;
  rawBody?: string;
  encodeResults?: unknown;
  rerankScores?: unknown;
  responseContract?: string;
  responseModel?: string;
  healthStatus?: string;
};

function startFakeService(): Promise<{
  origin: string;
  behavior: Behavior;
  requests: Array<{ method: string; path: string }>;
  close: () => Promise<void>;
}> {
  const behavior: Behavior = {};
  const requests: Array<{ method: string; path: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
    });
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const respond = () => {
        if (
          behavior.failuresLeft !== undefined &&
          behavior.failuresLeft > 0
        ) {
          behavior.failuresLeft -= 1;
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "transient" }));
          return;
        }
        if (behavior.status) {
          res.writeHead(behavior.status, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify({ error: "failure" }));
          return;
        }
        if (behavior.rawBody !== undefined) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(behavior.rawBody);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        const model = behavior.responseModel ?? "BAAI/bge-m3";
        const contract = behavior.responseContract ?? "bge-m3-v1";
        if (req.url === "/health") {
          res.end(
            JSON.stringify({
              status: behavior.healthStatus ?? "ok",
              model,
              contract,
            }),
          );
          return;
        }
        if (req.url === "/encode") {
          res.end(
            JSON.stringify({
              model,
              contract,
              results: behavior.encodeResults,
            }),
          );
          return;
        }
        if (req.url === "/rerank") {
          res.end(
            JSON.stringify({
              model,
              contract,
              scores: behavior.rerankScores,
            }),
          );
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      };
      if (behavior.delayMs && behavior.delayMs > 0) {
        setTimeout(respond, behavior.delayMs);
      } else {
        respond();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("fake service failed to bind");
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        behavior,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function denseVector(seed: number): number[] {
  return Array.from(
    { length: LOCAL_BGE_M3_DIMENSIONS },
    (_unused, index) => Math.sin(seed + index) / 32,
  );
}

function clientFor(
  origin: string,
  overrides: Record<string, unknown> = {},
): LocalBgeM3Client {
  const config = baseAppConfig();
  config.embeddings = {
    ...config.embeddings,
    enabled: true,
    backend: "local_bge_m3",
    localEndpoint: origin,
    localRequestTimeoutMs: 2_000,
    rerankTimeoutMs: 2_000,
    maxRetries: 2,
    retryInitialMs: 0,
    retryMaxMs: 5,
    ...overrides,
  };
  return new LocalBgeM3Client(config);
}

test("local BGE-M3 client decodes dense+sparse from one encode pass", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  service.behavior.encodeResults = [
    {
      dense: denseVector(1),
      sparse: [
        { token_id: 10, weight: 0.8 },
        { token_id: 4, weight: 0.3 },
        { token_id: 10, weight: 0.9 },
      ],
    },
  ];
  const client = clientFor(service.origin);
  const [encoded] = await client.encodeTexts(["привет мир"]);
  assert.equal(encoded.dense.length, LOCAL_BGE_M3_DIMENSIONS);
  assert.deepEqual(
    encoded.sparseTerms,
    [
      { tokenId: 4, weight: 0.3 },
      { tokenId: 10, weight: 0.9 },
    ],
    "duplicates collapse to max weight and sort deterministically",
  );
  assert.equal(service.requests.length, 1);
});

test("local BGE-M3 client enforces request bounds before sending", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin);
  const tooMany = Array.from({ length: 65 }, () => "текст");
  await assert.rejects(client.encodeTexts(tooMany), /batch is limited/);
  await assert.rejects(
    client.encodeTexts(["x".repeat(8_001)]),
    /exceeds 8000 characters/,
  );
  await assert.rejects(
    client.encodeQuery(""),
    /non-empty string/,
  );
  await assert.rejects(
    client.rerank("q", Array.from({ length: 33 }, () => "t")),
    /at most 32 candidates/,
  );
  assert.equal(service.requests.length, 0);
});

test("local BGE-M3 client retries transient statuses and stops on success", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  service.behavior.failuresLeft = 2;
  service.behavior.encodeResults = [
    { dense: denseVector(2), sparse: [] },
  ];
  const client = clientFor(service.origin, { maxRetries: 3 });
  const encoded = await client.encodeTexts(["текст"]);
  assert.equal(encoded.length, 1);
  assert.equal(
    service.requests.length,
    3,
    "two transient failures then one success",
  );
});

test("local BGE-M3 client treats malformed payloads as permanent failures", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin, { maxRetries: 2 });

  service.behavior.rawBody = "{not json";
  await assert.rejects(client.encodeTexts(["a"]), /invalid JSON/);
  assert.equal(service.requests.length, 1, "no retry for malformed JSON");

  service.behavior.rawBody = undefined;
  service.behavior.encodeResults = [
    { dense: denseVector(1).slice(0, 5), sparse: [] },
  ];
  await assert.rejects(
    client.encodeTexts(["a"]),
    /1024 finite dense values/,
  );

  service.behavior.encodeResults = [
    {
      dense: denseVector(1),
      sparse: [{ token_id: 1, weight: 5_000 }],
    },
  ];
  await assert.rejects(
    client.encodeTexts(["a"]),
    /sparse terms .* invalid/,
  );
});

test("local BGE-M3 client honors abort and timeout without retry", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin);

  const controller = new AbortController();
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(
    client.encodeTexts(["a"], controller.signal),
    (error: Error) => error.name === "AbortError",
  );

  service.behavior.delayMs = 500;
  const slow = clientFor(service.origin, {
    localRequestTimeoutMs: 50,
    maxRetries: 0,
  });
  await assert.rejects(
    slow.encodeTexts(["a"]),
    /timed out after 50ms/,
  );
});

test("local BGE-M3 rerank returns bounded scores and rejects malformed", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin);
  service.behavior.rerankScores = [0.2, 0.9];
  const scores = await client.rerank("запрос", ["один", "два"]);
  assert.deepEqual(scores, [0.2, 0.9]);

  service.behavior.rerankScores = [0.2];
  await assert.rejects(
    client.rerank("запрос", ["один", "два"]),
    /must return 2 finite scores/,
  );
});

test("local BGE-M3 client is unconfigured without backend and endpoint", (t: TestContext) => {
  const config = baseAppConfig();
  config.embeddings = {
    ...config.embeddings,
    enabled: true,
    backend: "external_openai",
    localEndpoint: "",
  };
  const client = new LocalBgeM3Client(config);
  assert.equal(client.isConfigured, false);
  assert.throws(
    () => client.assertConfigured(),
    /TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3/,
  );
  t.diagnostic("external backend never routes to the local client");
});

test("local BGE-M3 client rejects a foreign contract or model identity", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin);
  service.behavior.encodeResults = [
    { dense: denseVector(1), sparse: [] },
  ];

  service.behavior.responseContract = "bge-m3-v0";
  await assert.rejects(
    client.encodeTexts(["текст"]),
    /contract does not match bge-m3-v1/,
  );

  service.behavior.responseContract = "bge-m3-v1";
  service.behavior.responseModel = "bge-m3";
  await assert.rejects(
    client.encodeTexts(["текст"]),
    /model does not match BAAI\/bge-m3/,
  );

  service.behavior.responseModel = "other-model";
  service.behavior.rerankScores = [0.1];
  await assert.rejects(
    client.rerank("запрос", ["кандидат"]),
    /model does not match BAAI\/bge-m3/,
  );
});

test("local BGE-M3 health validates identity and shape before returning", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin);
  const health = await client.health();
  assert.deepEqual(health, {
    status: "ok",
    model: "BAAI/bge-m3",
    contract: "bge-m3-v1",
  });

  service.behavior.responseModel = "foreign";
  await assert.rejects(client.health(), /model does not match/);
});

test("local BGE-M3 health rejects foreign status values permanently", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin, { maxRetries: 2 });
  service.behavior.healthStatus = "degraded";
  await assert.rejects(client.health(), /unknown status/);
  assert.equal(service.requests.length, 1, "no retry for a foreign status");
});

test("local BGE-M3 client rejects oversized sparse instead of truncating", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin);
  const oversized = Array.from(
    { length: 1025 },
    (_unused, index) => ({ token_id: index, weight: 0.1 }),
  );
  service.behavior.encodeResults = [
    { dense: denseVector(1), sparse: oversized },
  ];
  await assert.rejects(
    client.encodeTexts(["текст"]),
    /at most 1024 are accepted/,
  );
});

test("encodeQuery deterministically bounds sparse terms for long queries", async (t) => {
  const service = await startFakeService();
  t.after(() => service.close());
  const client = clientFor(service.origin);
  const manyTerms = Array.from(
    { length: 400 },
    (_unused, index) => ({
      token_id: index,
      weight: 0.1 + index / 10_000,
    }),
  );
  service.behavior.encodeResults = [
    { dense: denseVector(1), sparse: manyTerms },
  ];
  const encoded = await client.encodeQuery(
    "длинный запрос со множеством слов",
  );
  assert.equal(encoded.sparseTerms.length, 256);
  // Top-256 by weight are the highest token ids; ordered by tokenId asc.
  assert.equal(encoded.sparseTerms[0]!.tokenId, 400 - 256);
  assert.equal(encoded.sparseTerms.at(-1)!.tokenId, 399);
});

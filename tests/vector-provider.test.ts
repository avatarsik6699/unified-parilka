import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbeddingClient } from "../src/embeddings.js";
import { MessageStore } from "../src/store.js";
import { VectorRag } from "../src/vector-rag.js";
import {
  CHAT,
  config,
  embeddingResponse,
  mockFetch,
} from "./support/vector-rag.js";

test("embedding API requests time out with AbortController", async (t) => {
  mockFetch(t, async (_url, init) => {
    const signal = (init as RequestInit).signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ requestTimeoutMs: 10, maxRetries: 0 }), store);
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" }]);

  await assert.rejects(
    () =>
      vectorRag.indexCachedMessages({
        chatId: CHAT.chatId,
        limitChunks: 1,
        confirmFirstRun: true,
      }),
    /Embedding API request timed out after 10ms/,
  );
});

test("embedding queries honor a caller AbortSignal before the provider timeout", async (t) => {
  mockFetch(t, async (_url, init) => {
    const signal = (init as RequestInit).signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  });
  const client = new EmbeddingClient(
    config({ requestTimeoutMs: 60_000, maxRetries: 3 }),
  );
  const controller = new AbortController();
  const pending = client.embedQuery("cancel me", controller.signal);

  controller.abort(new DOMException("caller cancelled", "AbortError"));

  await assert.rejects(pending, {
    name: "AbortError",
    message: "caller cancelled",
  });
});

test("embedding API retry honors retry-after for 429 responses", async (t) => {
  let calls = 0;
  mockFetch(t, async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "0" },
      });
    }
    return embeddingResponse(init as RequestInit);
  });
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ maxRetries: 1, retryInitialMs: 0 }), store);
  store.upsertMessages(CHAT, [{ chatId: CHAT.chatId, messageId: 1, senderName: "alice", text: "plain alpha" }]);

  const result = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });

  assert.equal(calls, 2);
  assert.equal(result.chunksCreated, 1);
});

test("embedding provider bodies and network messages are never kept in ToolError text", async (t) => {
  const marker = "EMBEDDING_PROVIDER_MARKER_DO_NOT_LEAK";
  const hostile = `${marker} https://user:pass@provider.test/v1?api_key=unit-marker Bearer unit-marker`;
  let mode: "http" | "network" = "http";
  mockFetch(t, async () => {
    if (mode === "http") {
      return new Response(
        JSON.stringify({ error: { message: hostile } }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    throw new Error(hostile);
  });
  const client = new EmbeddingClient(config({ maxRetries: 0 }));

  await assert.rejects(
    () => client.embedTexts(["first"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Embedding API request failed with HTTP 500.");
      assert.doesNotMatch(error.message, new RegExp(marker));
      assert.doesNotMatch(error.message, /provider\.test|Bearer unit-marker/u);
      return true;
    },
  );

  mode = "network";
  await assert.rejects(
    () => client.embedTexts(["first"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Embedding API request failed.");
      assert.doesNotMatch(error.message, new RegExp(marker));
      assert.doesNotMatch(error.message, /provider\.test|Bearer unit-marker/u);
      return true;
    },
  );
});

test("embedding API clamps a hostile retry-after before retrying", async (t) => {
  let calls = 0;
  mockFetch(t, async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: { message: "slow down" } }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "86400",
          },
        },
      );
    }
    return embeddingResponse(init as RequestInit);
  });
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(
    config({
      maxRetries: 1,
      retryInitialMs: 0,
      retryMaxMs: 5,
    }),
    store,
  );
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "bounded retry",
    },
  ]);

  const started = Date.now();
  const result = await vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
  });

  assert.equal(result.chunksCreated, 1);
  assert.equal(calls, 2);
  assert.equal(Date.now() - started < 250, true);
});

test("embedding API validates exact indices and finite consistent vectors", async (t) => {
  let payload: unknown = {};
  mockFetch(
    t,
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const client = new EmbeddingClient(
    config({ dimensions: undefined, maxRetries: 0 }),
  );

  for (const invalid of [
    {
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 0, embedding: [0, 1] },
      ],
    },
    {
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 2, embedding: [0, 1] },
      ],
    },
    {
      data: [
        { index: 0, embedding: [1, Number.NaN] },
        { index: 1, embedding: [0, 1] },
      ],
    },
    {
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1, 0] },
      ],
    },
  ]) {
    payload = invalid;
    await assert.rejects(
      () => client.embedTexts(["first", "second"]),
      /unexpected response shape|inconsistent vector dimensions/u,
    );
  }

  payload = {
    data: [
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ],
  };
  assert.deepEqual(
    await client.embedTexts(["first", "second"]),
    [
      [1, 0],
      [0, 1],
    ],
  );
});

test("embedding auth failures are permanent and endpoint joining is URL-safe", async (t) => {
  let requestedUrl = "";
  mockFetch(t, async (input) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({ error: { message: "invalid key" } }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  const client = new EmbeddingClient(
    config({
      baseUrl: "https://embeddings.example.test/openai/v1///",
      maxRetries: 3,
    }),
  );

  await assert.rejects(
    () => client.embedTexts(["first"]),
    (error: unknown) => {
      const normalized = (
        error as { normalized?: { category?: string; retryable?: boolean } }
      ).normalized;
      assert.equal(normalized?.category, "auth");
      assert.equal(normalized?.retryable, false);
      return true;
    },
  );
  assert.equal(
    requestedUrl,
    "https://embeddings.example.test/openai/v1/embeddings",
  );
});

test("embedding timeout covers a response body that stalls after headers", async (t) => {
  mockFetch(
    t,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"data":['),
            );
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  const client = new EmbeddingClient(
    config({
      requestTimeoutMs: 15,
      maxRetries: 0,
    }),
  );

  await assert.rejects(
    () => client.embedTexts(["stalled body"]),
    /timed out after 15ms/u,
  );
});

test("embedding indexing propagates shutdown and leaves no partial batch", async (t) => {
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  mockFetch(
    t,
    async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        requestStarted();
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing embedding abort signal"));
          return;
        }
        const rejectAbort = (): void => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("aborted", "AbortError"),
          );
        };
        if (signal.aborted) {
          rejectAbort();
        } else {
          signal.addEventListener("abort", rejectAbort, {
            once: true,
          });
        }
      }),
  );
  const store = new MessageStore(":memory:");
  const vectorRag = new VectorRag(config({ maxRetries: 0 }), store);
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: 1,
      senderName: "alice",
      text: "cancel this batch",
    },
  ]);
  const shutdown = new AbortController();
  const pending = vectorRag.indexCachedMessages({
    chatId: CHAT.chatId,
    limitChunks: 1,
    confirmFirstRun: true,
    signal: shutdown.signal,
  });
  await started;
  shutdown.abort(new DOMException("test shutdown", "AbortError"));

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );
  assert.equal(store.getEmbeddingStats(CHAT.chatId).length, 0);
});

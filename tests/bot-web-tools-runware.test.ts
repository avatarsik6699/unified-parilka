import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RunwareClient,
  RUNWARE_MODEL_ALLOWLIST,
} from "../src/bot/web-tools/runware-client.js";

// ─── Fake helpers ───────────────────────────────────────────────────────────

function fakeFetch(
  handler: (input: string, init?: RequestInit) => Response,
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function runwareClient(
  handler: (input: string, init?: RequestInit) => Response,
  overrides: { nsfwAllowed?: boolean } = {},
): RunwareClient {
  return new RunwareClient({
    endpoint: "https://api.runware.ai/v1",
    apiKey: "rw-secret",
    nsfwAllowed: overrides.nsfwAllowed ?? false,
    fetchImpl: fakeFetch(handler),
  });
}

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

function successHandler(input: string): Response {
  if (input === "https://api.runware.ai/v1") {
    return new Response(
      JSON.stringify({
        data: [
          {
            taskType: "imageInference",
            imageURL: "https://im.runware.ai/image/os/x.jpg",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (input === "https://im.runware.ai/image/os/x.jpg") {
    return new Response(IMAGE_BYTES, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}

// ─── Runware client ─────────────────────────────────────────────────────────

test("generate() rejects an out-of-range prompt", async () => {
  const client = runwareClient(successHandler);
  const result = await client.generate(
    { prompt: "" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_arguments");
  }
});

test("generate() rejects a model outside the allowlist", async () => {
  const client = runwareClient(successHandler);
  const result = await client.generate(
    { prompt: "a golden retriever", model: "arbitrary:model@1" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_arguments");
  }
});

test("generate() sends bearer auth and returns downloaded bytes", async () => {
  let capturedAuth: string | undefined;
  let capturedBody = "";
  const client = runwareClient((input, init) => {
    if (input === "https://api.runware.ai/v1") {
      capturedAuth = (init?.headers as Record<string, string>).authorization;
      capturedBody = String(init?.body ?? "");
    }
    return successHandler(input);
  });
  const result = await client.generate(
    { prompt: "a golden retriever" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.model, RUNWARE_MODEL_ALLOWLIST[0]);
    assert.deepEqual(Array.from(result.imageBytes), Array.from(IMAGE_BYTES));
  }
  assert.equal(capturedAuth, "Bearer rw-secret");
  const parsedBody = JSON.parse(capturedBody);
  assert.equal(parsedBody[0].safety.checkContent, true);
});

test("nsfw request only bypasses safety when operator has enabled it", async () => {
  let capturedBody = "";
  const client = runwareClient(
    (input, init) => {
      if (input === "https://api.runware.ai/v1") {
        capturedBody = String(init?.body ?? "");
      }
      return successHandler(input);
    },
    { nsfwAllowed: true },
  );
  await client.generate(
    { prompt: "a golden retriever", nsfw: true },
    new AbortController().signal,
  );
  const parsedBody = JSON.parse(capturedBody);
  assert.equal(parsedBody[0].safety.checkContent, false);
});

test("nsfw request is ignored when operator has not enabled it", async () => {
  let capturedBody = "";
  const client = runwareClient(
    (input, init) => {
      if (input === "https://api.runware.ai/v1") {
        capturedBody = String(init?.body ?? "");
      }
      return successHandler(input);
    },
    { nsfwAllowed: false },
  );
  await client.generate(
    { prompt: "a golden retriever", nsfw: true },
    new AbortController().signal,
  );
  const parsedBody = JSON.parse(capturedBody);
  assert.equal(parsedBody[0].safety.checkContent, true);
});

test("generate() maps a provider error envelope to provider_error", async () => {
  const client = runwareClient((input) => {
    if (input === "https://api.runware.ai/v1") {
      return new Response(
        JSON.stringify({ errors: [{ code: "badRequest", message: "nope" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  const result = await client.generate(
    { prompt: "a golden retriever" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "provider_error");
    assert.equal(result.error.message.includes("nope"), false);
  }
});

test("generate() maps an HTTP failure to provider_error without leaking the key", async () => {
  const client = runwareClient(() => new Response("boom", { status: 500 }));
  const result = await client.generate(
    { prompt: "a golden retriever" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "provider_error");
    assert.equal(result.error.message.includes("rw-secret"), false);
  }
});

test("generate() reports aborted when the caller signal is already aborted", async () => {
  const client = runwareClient(successHandler);
  const controller = new AbortController();
  controller.abort();
  const result = await client.generate(
    { prompt: "a golden retriever" },
    controller.signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "aborted");
  }
});

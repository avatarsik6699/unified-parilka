import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RunwareClient,
  RUNWARE_MODEL_ALLOWLIST,
  RUNWARE_TTS_MODEL,
  RUNWARE_TTS_RU_VOICES,
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

test("generate() forwards a reference image as inputs.referenceImages", async () => {
  let capturedBody = "";
  const client = runwareClient((input, init) => {
    if (input === "https://api.runware.ai/v1") {
      capturedBody = String(init?.body ?? "");
    }
    return successHandler(input);
  });
  const result = await client.generate(
    {
      prompt: "перекрась это в синий",
      referenceImages: ["data:image/jpeg;base64,AAAA"],
    },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  const parsedBody = JSON.parse(capturedBody);
  assert.deepEqual(parsedBody[0].inputs, {
    referenceImages: ["data:image/jpeg;base64,AAAA"],
  });
});

test("generate() rejects an empty referenceImages array", async () => {
  const client = runwareClient(successHandler);
  const result = await client.generate(
    { prompt: "a golden retriever", referenceImages: [] },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_arguments");
  }
});

// ─── Runware TTS ────────────────────────────────────────────────────────────

const AUDIO_BYTES = new Uint8Array([9, 8, 7]);

function speechSuccessHandler(input: string): Response {
  if (input === "https://api.runware.ai/v1") {
    return new Response(
      JSON.stringify({
        data: [
          {
            taskType: "audioInference",
            audioURL: "https://am.runware.ai/audio/os/x.ogg",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (input === "https://am.runware.ai/audio/os/x.ogg") {
    return new Response(AUDIO_BYTES, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}

test("synthesizeSpeech() sends the Russian voice and returns downloaded bytes", async () => {
  let capturedBody = "";
  const client = runwareClient((input, init) => {
    if (input === "https://api.runware.ai/v1") {
      capturedBody = String(init?.body ?? "");
    }
    return speechSuccessHandler(input);
  });
  const result = await client.synthesizeSpeech(
    { text: "привет" },
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.model, RUNWARE_TTS_MODEL);
    assert.equal(result.voice, RUNWARE_TTS_RU_VOICES[0]);
    assert.deepEqual(Array.from(result.audioBytes), Array.from(AUDIO_BYTES));
  }
  const parsedBody = JSON.parse(capturedBody);
  assert.equal(parsedBody[0].speech.language, "ru");
  assert.equal(parsedBody[0].outputFormat, "OGG");
});

test("synthesizeSpeech() rejects a voice outside the Russian allowlist", async () => {
  const client = runwareClient(speechSuccessHandler);
  const result = await client.synthesizeSpeech(
    { text: "привет", voice: "Claire" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_arguments");
  }
});

test("synthesizeSpeech() rejects an out-of-range text", async () => {
  const client = runwareClient(speechSuccessHandler);
  const result = await client.synthesizeSpeech(
    { text: "a" },
    new AbortController().signal,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_arguments");
  }
});

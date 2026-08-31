import assert from "node:assert/strict";
import { test } from "node:test";
import { VkMediaDownloader } from "../src/bot/media/vk-downloader.js";
import type { VkMediaReference } from "../src/bot/media/vk-contracts.js";

const MEDIA: VkMediaReference = {
  kind: "vk_photo",
  url: "https://sun9-1.userapi.com/photo.jpg",
  mediaType: "image/jpeg",
  width: 800,
  height: 600,
};

test("downloads bytes directly from the VK CDN URL, no token or getFile step", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  let requestedUrl: string | undefined;
  const downloader = new VkMediaDownloader({
    async fetch(url) {
      requestedUrl = String(url);
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "image/jpeg" },
      });
    },
  });
  const result = await downloader.download(MEDIA, new AbortController().signal);
  assert.equal(requestedUrl, MEDIA.url);
  assert.deepEqual([...result.data], [1, 2, 3, 4]);
  assert.equal(result.mediaType, "image/jpeg");
});

test("rejects a response whose declared content-length exceeds the byte cap", async () => {
  const downloader = new VkMediaDownloader({
    maxBytes: 1_024,
    async fetch() {
      return new Response(new Uint8Array(5) as Uint8Array<ArrayBuffer>, {
        headers: { "content-length": "2000" },
      });
    },
  });
  await assert.rejects(
    downloader.download(MEDIA, new AbortController().signal),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === "file_too_large",
  );
});

test("a non-ok response is a download_failed error", async () => {
  const downloader = new VkMediaDownloader({
    async fetch() {
      return new Response(null, { status: 404 });
    },
  });
  await assert.rejects(
    downloader.download(MEDIA, new AbortController().signal),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === "download_failed",
  );
});

test("an already-aborted external signal fails fast without calling fetch", async () => {
  let calls = 0;
  const downloader = new VkMediaDownloader({
    async fetch() {
      calls += 1;
      return new Response(null);
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloader.download(MEDIA, controller.signal),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "aborted",
  );
  assert.equal(calls, 0);
});

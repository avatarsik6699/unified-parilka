import type { AppConfig } from "../../src/config.js";
import { embeddingNamespace } from "../../src/embeddings.js";
import type { ChatInfo } from "../../src/telegram-client.js";
import { appConfigWithEmbeddings } from "./app-config.js";

export const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

export function mockEmbeddingFetch(t: { after(fn: () => void): void }): void {
  mockFetch(t, async (_url, init) => embeddingResponse(init as RequestInit));
}

export function mockFetch(
  t: { after(fn: () => void): void },
  handler: typeof globalThis.fetch,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

export function embeddingResponse(init: RequestInit): Response {
  const body = JSON.parse(String(init.body ?? "{}")) as { input?: string | string[] };
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  return new Response(
    JSON.stringify({
      data: inputs.map((input, index) => ({
        index,
        embedding: embeddingForText(String(input)),
      })),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export function embeddingForText(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes("older") || normalized.includes("needle")) {
    return [1, 0];
  }
  return [0, 1];
}

export function config(
  embeddings: Partial<AppConfig["embeddings"]> = {},
): AppConfig {
  const cfg = appConfigWithEmbeddings(embeddings);
  cfg.telegram.defaultChatId = CHAT.chatId;
  cfg.telegram.allowedChatIds = [CHAT.chatId];
  return cfg;
}

export function namespace(
  embeddings: Partial<AppConfig["embeddings"]> = {},
): string {
  return embeddingNamespace(config(embeddings));
}

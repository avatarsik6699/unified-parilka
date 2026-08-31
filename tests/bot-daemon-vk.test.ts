import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { VK } from "vk-io";
import type { AppConfig } from "../src/config.js";
import { composeBotDaemon } from "../src/bot-daemon/composition.js";
import { assertBotDaemonConfiguration } from "../src/bot-daemon/production.js";
import type { BotDaemonApi } from "../src/bot-daemon/contracts.js";
import type { AssistantChatConfig } from "../src/bot-config/assistant.js";
import { parseBotRuntimeConfig } from "../src/bot/runtime-config.js";
import type { TurnModelRouter } from "../src/bot/ai-agent.js";
import { MessageStore } from "../src/store.js";

const CHAT_ID = "-1003179772905";

test("a VK chat needs no TELEGRAM_ALLOWED_CHAT_IDS entry, but does need BOT_VK_GROUP_TOKEN configured", (t) => {
  const { dbPath } = fixtureStore(t);
  const vkChats = [
    {
      transport: "vk" as const,
      allowedChatId: "vk:2000000001",
      chatTitle: "VK Chat",
      personaPrompt: "persona",
    },
  ];

  const configWithoutVk = botConfig(dbPath);
  assert.throws(
    () =>
      assertBotDaemonConfiguration(
        configWithoutVk,
        minimalAppConfig(dbPath),
        vkChats,
      ),
    /BOT_VK_GROUP_TOKEN is not set/u,
  );

  const configWithVk = botConfig(dbPath, {
    BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
    BOT_VK_GROUP_ID: "123456",
  });
  // minimalAppConfig's TELEGRAM_ALLOWED_CHAT_IDS-equivalent lists only
  // CHAT_ID, never the VK chat -- a VK chat has no Telegram identity to
  // check against it.
  assert.doesNotThrow(() =>
    assertBotDaemonConfiguration(
      configWithVk,
      minimalAppConfig(dbPath),
      vkChats,
    ),
  );
});

test("worker budget is split across a Telegram chat and a VK chat, not multiplied", (t) => {
  const { store, dbPath } = fixtureStore(t);
  const config = botConfig(dbPath, {
    BOT_WORKERS: "3",
    BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
    BOT_VK_GROUP_ID: "123456",
  });
  const chats: AssistantChatConfig[] = [
    {
      transport: "telegram",
      allowedChatId: CHAT_ID,
      chatTitle: "Telegram Chat",
      personaPrompt: "persona",
    },
    {
      transport: "vk",
      allowedChatId: "vk:2000000001",
      chatTitle: "VK Chat",
      personaPrompt: "persona",
    },
  ];

  const composition = composeBotDaemon({
    config,
    chats,
    store,
    api: noNetworkApi(),
    vkApi: {} as unknown as VK,
    router: noNetworkRouter(),
  });

  // MAX_BOT_WORKER_CONCURRENCY(3) split across 2 chats: 2 + 1, never 3 + 3.
  assert.equal(composition.workers.length, 3);
  const telegramWorkers = composition.chats.get(CHAT_ID)!.workers.length;
  const vkWorkers = composition.chats.get("vk:2000000001")!.workers.length;
  assert.equal(telegramWorkers + vkWorkers, 3);
  assert.ok(telegramWorkers >= 1 && vkWorkers >= 1);
});

test("more assistant chats than the worker budget fails composition with a clear error", (t) => {
  const { store, dbPath } = fixtureStore(t);
  const config = botConfig(dbPath, { BOT_WORKERS: "1" });
  const chats: AssistantChatConfig[] = Array.from(
    { length: 4 },
    (_unused, index) => ({
      transport: "telegram" as const,
      allowedChatId: `-${1000 + index}`,
      chatTitle: `Chat ${index}`,
      personaPrompt: "persona",
    }),
  );

  assert.throws(
    () =>
      composeBotDaemon({
        config,
        chats,
        store,
        api: noNetworkApi(),
        router: noNetworkRouter(),
      }),
    /exceeding the process-wide worker budget/u,
  );
});

function noNetworkRouter(): TurnModelRouter {
  return {
    async executeWithFallback<T>(): Promise<never> {
      throw new Error("model router must not execute during composition");
    },
  };
}

function noNetworkApi(): BotDaemonApi {
  return {
    async getMe() {
      throw new Error("unexpected Bot API call");
    },
    async deleteWebhook() {
      throw new Error("unexpected Bot API call");
    },
    async getUpdates() {
      throw new Error("unexpected Bot API call");
    },
    async sendMessage() {
      throw new Error("unexpected Bot API call");
    },
  } as unknown as BotDaemonApi;
}

function fixtureStore(t: TestContext): {
  store: MessageStore;
  dbPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-daemon-vk-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, dbPath };
}

function botConfig(
  dbPath: string,
  overrides: Readonly<Record<string, string>> = {},
) {
  return parseBotRuntimeConfig({
    ...botEnv(dbPath),
    ...overrides,
  });
}

function botEnv(dbPath: string): Readonly<Record<string, string>> {
  const directory = dirname(dbPath);
  const personaPromptPath = join(directory, "persona.md");
  writeFileSync(
    personaPromptPath,
    "# Кто ты\nТестовая персона для юнит-тестов.",
  );
  const botsConfigPath = join(directory, "bots.json");
  writeFileSync(
    botsConfigPath,
    JSON.stringify([
      {
        role: "assistant",
        chatId: CHAT_ID,
        chatTitle: "Test Chat",
        personaPromptPath,
      },
    ]),
  );
  return {
    BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz_ABCD",
    BOT_EXCLUSIVE_POLLER: "true",
    BOT_ID: "123456789",
    BOT_USERNAME: "ParilkaBot",
    BOT_DB_PATH: dbPath,
    TELEGRAM_DB_PATH: dbPath,
    BOT_MODEL_CONFIG_PATH: resolve("package.json"),
    BOT_BOTS_CONFIG_PATH: botsConfigPath,
  };
}

function minimalAppConfig(dbPath: string, allowedChatId = CHAT_ID): AppConfig {
  return {
    storage: { dbPath },
    telegram: {
      allowedChatIds: [allowedChatId],
    },
  } as unknown as AppConfig;
}

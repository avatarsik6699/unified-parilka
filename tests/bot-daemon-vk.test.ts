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

  // MAX_BOT_WORKER_CONCURRENCY(15) comfortably covers 2 chats x BOT_WORKERS(3)
  // each -- both keep their full per-chat ceiling, nothing is starved.
  assert.equal(composition.workers.length, 6);
  const telegramWorkers = composition.chats.get(CHAT_ID)!.workers.length;
  const vkWorkers = composition.chats.get("vk:2000000001")!.workers.length;
  assert.equal(telegramWorkers, 3);
  assert.equal(vkWorkers, 3);
});

test("VK history backfill is wired only when both a personal-account client and a VK chat are present", (t) => {
  const { store, dbPath } = fixtureStore(t);
  const vkChats: AssistantChatConfig[] = [
    {
      transport: "vk",
      allowedChatId: "vk:2000000001",
      chatTitle: "VK Chat",
      personaPrompt: "persona",
      // The personal (BOT_VK_USER_TOKEN) account's own view of this
      // beседа's peer_id -- deliberately different from the community-
      // token peer_id (2000000001) encoded in allowedChatId, to prove the
      // composition actually threads this field through rather than
      // re-deriving the (wrong) community one.
      vkHistoryPeerId: 2000000901,
    },
  ];

  // BOT_VK_USER_TOKEN configured, but no vkUserApi client supplied to
  // composeBotDaemon (mirrors how it would look if the operator hadn't
  // actually restarted the daemon with the new token wired through
  // production.ts's factories) -- must not build the loop.
  const configWithUserToken = botConfig(dbPath, {
    BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
    BOT_VK_GROUP_ID: "123456",
    BOT_VK_USER_TOKEN: "vk1.a-fake-user-token",
  });
  const withoutClient = composeBotDaemon({
    config: configWithUserToken,
    chats: vkChats,
    store,
    api: noNetworkApi(),
    vkApi: {} as unknown as VK,
    router: noNetworkRouter(),
  });
  assert.equal(withoutClient.vkHistoryBackfill, undefined);

  // vkUserApi supplied, but BOT_VK_USER_TOKEN never configured -- config.vk
  // itself is present (group token is set), but this still must not build
  // the loop: composeBotDaemon only wires it when both sides agree.
  const configWithoutUserToken = botConfig(dbPath, {
    BOT_VK_GROUP_TOKEN: "vk1.a-fake-token",
    BOT_VK_GROUP_ID: "123456",
  });
  const withClientOnly = composeBotDaemon({
    config: configWithoutUserToken,
    chats: vkChats,
    store,
    api: noNetworkApi(),
    vkApi: {} as unknown as VK,
    vkUserApi: {} as unknown as VK,
    router: noNetworkRouter(),
  });
  assert.equal(withClientOnly.vkHistoryBackfill, undefined);

  // Both present, VK chat configured -- the loop is built.
  const composition = composeBotDaemon({
    config: configWithUserToken,
    chats: vkChats,
    store,
    api: noNetworkApi(),
    vkApi: {} as unknown as VK,
    vkUserApi: {} as unknown as VK,
    router: noNetworkRouter(),
  });
  assert.notEqual(composition.vkHistoryBackfill, undefined);

  // Both present, but zero VK chats configured (Telegram-only deployment) --
  // nothing to back-fill, so the loop stays unbuilt even though the token
  // is set.
  const telegramOnly = composeBotDaemon({
    config: configWithUserToken,
    chats: [
      {
        transport: "telegram",
        allowedChatId: CHAT_ID,
        chatTitle: "Telegram Chat",
        personaPrompt: "persona",
      },
    ],
    store,
    api: noNetworkApi(),
    vkApi: {} as unknown as VK,
    vkUserApi: {} as unknown as VK,
    router: noNetworkRouter(),
  });
  assert.equal(telegramOnly.vkHistoryBackfill, undefined);
});

test("worker budget is split proportionally once chat count pushes past it", (t) => {
  const { store, dbPath } = fixtureStore(t);
  const config = botConfig(dbPath, { BOT_WORKERS: "3" });
  // 6 chats x 3 desired workers each = 18, over the 15 budget -- must be
  // split (2 or 3 per chat), never naively multiplied out to 18.
  const chats: AssistantChatConfig[] = Array.from(
    { length: 6 },
    (_unused, index) => ({
      transport: "telegram" as const,
      allowedChatId: `-${1000 + index}`,
      chatTitle: `Chat ${index}`,
      personaPrompt: "persona",
    }),
  );

  const composition = composeBotDaemon({
    config,
    chats,
    store,
    api: noNetworkApi(),
    router: noNetworkRouter(),
  });

  assert.equal(composition.workers.length, 15);
  for (const chat of chats) {
    const workers = composition.chats.get(chat.allowedChatId)!.workers.length;
    assert.ok(
      workers === 2 || workers === 3,
      `unexpected worker count ${workers}`,
    );
  }
});

test("more assistant chats than the worker budget fails composition with a clear error", (t) => {
  const { store, dbPath } = fixtureStore(t);
  const config = botConfig(dbPath, { BOT_WORKERS: "1" });
  const chats: AssistantChatConfig[] = Array.from(
    { length: 16 },
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

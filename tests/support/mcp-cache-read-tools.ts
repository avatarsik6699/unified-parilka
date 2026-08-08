import { CanonicalBotReadCache } from "../../src/bot/read-cache.js";
import { BotReadTools } from "../../src/bot/read-tools.js";
import { MessageStore } from "../../src/store.js";
import type { ChatInfo } from "../../src/telegram-client.js";
import type { TelegramToolContext } from "../../src/mcp-tools/contracts.js";

export const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

/**
 * Minimal TelegramToolContext that only satisfies the cache-read code path.
 * Other fields (config, telegram, throttler, etc.) are stubbed because the
 * five cache-only tools never touch them.
 */
export function fakeContext(
  store = new MessageStore(":memory:"),
  botSenderId?: string,
): TelegramToolContext {
  const cache = new CanonicalBotReadCache({
    store,
    botSenderId,
  });
  const botReadTools = new BotReadTools({
    chatId: CHAT.chatId,
    cache,
    timeZone: "Europe/Moscow",
    botSenderId,
  });
  return {
    config: undefined as unknown as TelegramToolContext["config"],
    telegram: undefined as unknown as TelegramToolContext["telegram"],
    store,
    throttler: undefined as unknown as TelegramToolContext["throttler"],
    syncer: undefined as unknown as TelegramToolContext["syncer"],
    vectorRag: undefined as unknown as TelegramToolContext["vectorRag"],
    approvals: undefined as unknown as TelegramToolContext["approvals"],
    botReadTools,
    cacheChat: () => CHAT,
  };
}

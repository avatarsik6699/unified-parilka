import type { AppConfig } from "../../src/config.js";
import { MessageStore } from "../../src/store.js";
import { appConfigWithSync } from "./app-config.js";
import { CHAT } from "./sync-telegram.js";

export function seededStore(newestMessageId: number): MessageStore {
  const store = new MessageStore(":memory:");
  store.upsertMessages(CHAT, [
    {
      chatId: CHAT.chatId,
      messageId: newestMessageId,
      senderName: "Alice",
      text: `message ${newestMessageId}`,
    },
  ]);
  store.updateSyncState(CHAT, {
    oldestMessageId: newestMessageId,
    newestMessageId,
    syncedCount: store.countMessages(CHAT.chatId),
    mode: "recent",
    error: null,
  });
  return store;
}

export function config(
  sync: Partial<AppConfig["sync"]> = {},
): AppConfig {
  const cfg = appConfigWithSync(sync);
  cfg.telegram.defaultChatId = CHAT.chatId;
  cfg.telegram.allowedChatIds = [CHAT.chatId];
  return cfg;
}

export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

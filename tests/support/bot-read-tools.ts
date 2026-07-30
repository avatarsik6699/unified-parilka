import assert from "node:assert/strict";
import {
  type BotReadToolCache,
  type BotReadToolFailure,
  type BotReadToolResult,
} from "../../src/bot/read-tools.js";
import { MessageStore, type StoredMessage } from "../../src/store.js";
import type { ChatInfo } from "../../src/telegram-client.js";

export const CHAT: ChatInfo = {
  chatId: "-100123",
  requested: "-100123",
  title: "Парилка",
  kind: "Supergroup",
};

export function storeCache(store: MessageStore): BotReadToolCache {
  return {
    search(params) {
      return store.search(params);
    },
    getThreadContext(params) {
      return store.getThreadContext(params);
    },
    getDigests() {
      return { digests: [] };
    },
  };
}

export function emptyCache(
  overrides: Partial<BotReadToolCache> = {},
): BotReadToolCache {
  return {
    search() {
      return [];
    },
    getThreadContext() {
      return [];
    },
    getDigests() {
      return { digests: [] };
    },
    ...overrides,
  };
}

export function message(
  messageId: number,
  text: string,
  senderName: string,
  date = "2026-07-30T08:00:00.000Z",
): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    senderId: `speaker-${messageId}`,
    senderName,
    date,
    text,
  };
}

export function asFailure(result: BotReadToolResult): BotReadToolFailure {
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("Expected tool failure.");
  }
  return result;
}

export function durationHours(range: {
  startInclusive: string;
  endExclusive: string;
}): number {
  return (
    (Date.parse(range.endExclusive) - Date.parse(range.startInclusive)) /
    3_600_000
  );
}

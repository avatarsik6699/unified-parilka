import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  MessageStore,
  type BotUpdateIngestResult,
  type StoredMessage,
} from "../../src/store.js";
import type { ChatInfo } from "../../src/telegram-client.js";

export const CHAT: ChatInfo = {
  chatId: "-1004242",
  requested: "-1004242",
  title: "Parilka",
  kind: "supergroup",
};

export const OTHER_CHAT: ChatInfo = {
  chatId: "-1005252",
  requested: "-1005252",
  title: "Other",
  kind: "supergroup",
};

export function makeStore(t: TestContext): MessageStore {
  const directory = mkdtempSync(join(tmpdir(), "parilka-bot-durable-"));
  const store = new MessageStore(join(directory, "cache.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

export function ingest(
  store: MessageStore,
  updateId: number,
  messageId: number,
  options: { maxAttempts?: number; nowMs?: number } = {},
): BotUpdateIngestResult {
  return store.ingestBotUpdate({
    updateId,
    rawJson: JSON.stringify({
      update_id: updateId,
      message: { message_id: messageId, chat: { id: CHAT.chatId } },
    }),
    chat: CHAT,
    message: message(messageId),
    addressed: true,
    maxAttempts: options.maxAttempts,
    nowMs: options.nowMs,
  });
}

export function message(
  messageId: number,
  overrides: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    chatId: CHAT.chatId,
    messageId,
    date: "2026-07-30T12:00:00.000Z",
    senderId: "42",
    senderName: "owner",
    text: "@bot answer this",
    rawJson: JSON.stringify({ message_id: messageId }),
    ...overrides,
  };
}

export function assertAddressedAckHasReservation(
  store: MessageStore,
  result: BotUpdateIngestResult,
): void {
  assert.equal(result.update.addressed, true);
  assert.ok(
    result.turn,
    "addressed update must reserve a turn before exposing ackUpdateId",
  );
  assert.equal(result.turn.updateId, result.update.updateId);
  assert.equal(
    store.getBotTurnByTrigger(result.turn.chatId, result.turn.triggerMessageId)
      ?.id,
    result.turn.id,
  );
}

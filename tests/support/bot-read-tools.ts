import assert from "node:assert/strict";
import {
  type BotReadToolCache,
  type BotReadToolFailure,
  type BotReadToolResult,
} from "../../src/bot/read-tools.js";
import {
  MessageStore,
  type LiveTranscriptResult,
  type StoredMessage,
  type TranscriptForm,
} from "../../src/store.js";
import type { ChatInfo } from "../../src/telegram-client.js";

export const CHAT: ChatInfo = {
  chatId: "-100123",
  requested: "-100123",
  title: "Парилка",
  kind: "Supergroup",
};

export function storeCache(
  store: MessageStore,
  botSenderId?: string,
): BotReadToolCache {
  return {
    search(params) {
      return store.search(params);
    },
    findMessages(params) {
      return store
        .searchLexical({
          chatId: params.chatId,
          query: params.query,
          match: params.match,
          ...(params.sender === undefined ? {} : { sender: params.sender }),
          ...(params.includeBot === false && botSenderId !== undefined
            ? { excludeSenderIds: [botSenderId] }
            : {}),
          ...(params.startInclusive === undefined
            ? {}
            : { dateFromInclusive: params.startInclusive }),
          ...(params.endExclusive === undefined
            ? {}
            : { dateToExclusive: params.endExclusive }),
          ...(params.beforeId === undefined
            ? {}
            : { beforeId: params.beforeId }),
          ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
          order: params.order,
          limit: params.limit,
        })
        .map((hit) => hit.message);
    },
    readSlice(params) {
      return store.getLiveTranscript(params);
    },
    getThreadContext(params) {
      return store.getThreadContext(params);
    },
    getDigests() {
      return { digests: [] };
    },
  };
}

export function emptyTranscript(
  form: TranscriptForm = "recent",
): LiveTranscriptResult {
  return {
    form,
    messages: [],
    coverage: {
      upperMessageId: 0,
      totalAvailable: 0,
      returnedCount: 0,
      coveredCount: 0,
      emptyTextCount: 0,
      mediaOrEmptyTextCount: 0,
      truncated: false,
      omittedCount: 0,
      hasMore: false,
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
    findMessages() {
      return [];
    },
    readSlice() {
      return emptyTranscript();
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

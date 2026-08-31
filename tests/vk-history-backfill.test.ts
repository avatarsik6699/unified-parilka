import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatInfo } from "../src/telegram/types.js";
import type { StoredMessage, SyncState } from "../src/store.js";
import {
  createVkHistoryBackfillPort,
  runVkHistoryBackfillTick,
  VkHistoryBackfillLoop,
  type VkHistoryBackfillStore,
  type VkHistoryMessage,
  type VkHistoryPort,
} from "../src/vk/history-backfill.js";

const CHAT = {
  chatId: "vk:2000000002",
  peerId: 2_000_000_002,
  chatTitle: "Test VK Chat",
};

class FakeStore implements VkHistoryBackfillStore {
  #states = new Map<string, SyncState>();
  #exhausted = new Set<string>();
  #upserted: StoredMessage[] = [];

  get upsertedMessages(): readonly StoredMessage[] {
    return this.#upserted;
  }

  getSyncState(chatId: string): SyncState | undefined {
    const exhaustedAt = this.#exhausted.has(chatId)
      ? "2026-01-01T00:00:00.000Z"
      : undefined;
    const state = this.#states.get(chatId);
    return state === undefined && exhaustedAt === undefined
      ? undefined
      : {
          chatId,
          syncedCount: 0,
          ...state,
          ...(exhaustedAt === undefined
            ? {}
            : { backfillExhaustedAt: exhaustedAt }),
        };
  }

  updateSyncState(
    chat: ChatInfo,
    state: {
      oldestMessageId?: number;
      nextBackfillOffsetId?: number;
      syncedCount: number;
      mode?: "recent" | "backfill" | "manual";
    },
  ): void {
    const previous = this.#states.get(chat.chatId);
    this.#states.set(chat.chatId, {
      chatId: chat.chatId,
      syncedCount: state.syncedCount,
      oldestMessageId: state.oldestMessageId ?? previous?.oldestMessageId,
      nextBackfillOffsetId:
        state.nextBackfillOffsetId ?? previous?.nextBackfillOffsetId,
    });
  }

  setBackfillExhausted(chat: ChatInfo, exhausted: boolean): void {
    if (exhausted) {
      this.#exhausted.add(chat.chatId);
    } else {
      this.#exhausted.delete(chat.chatId);
    }
  }

  upsertMessages(_chat: ChatInfo, messages: StoredMessage[]): number {
    this.#upserted.push(...messages);
    return messages.length;
  }
}

function historyMessage(
  conversationMessageId: number,
  overrides: Partial<VkHistoryMessage> = {},
): VkHistoryMessage {
  return {
    conversationMessageId,
    fromId: 42,
    text: `message ${String(conversationMessageId)}`,
    hasAttachments: false,
    ...overrides,
  };
}

test("first tick pages from offset 0 and stores what it fetched", async () => {
  const store = new FakeStore();
  const page = [historyMessage(300), historyMessage(299), historyMessage(298)];
  let capturedParams:
    { peerId: number; count: number; offset: number } | undefined;
  const port: VkHistoryPort = {
    async getHistory(params) {
      capturedParams = params;
      return page;
    },
  };

  const report = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    // A full page (3 requested, 3 returned) must not be treated as reaching
    // the beседа's start -- only a *short* page (fewer returned than
    // requested) signals that.
    pageSize: 3,
    totalLimit: 1_000,
  });

  assert.deepEqual(report, {
    chatId: CHAT.chatId,
    status: "progress",
    fetched: 3,
    saved: 3,
  });
  assert.deepEqual(capturedParams, {
    peerId: CHAT.peerId,
    count: 3,
    offset: 0,
  });
  assert.equal(store.upsertedMessages.length, 3);
  assert.equal(store.getSyncState(CHAT.chatId)?.nextBackfillOffsetId, 3);
  assert.equal(store.getSyncState(CHAT.chatId)?.oldestMessageId, 298);
});

test("a short page (fewer items than requested) marks the chat exhausted", async () => {
  const store = new FakeStore();
  const port: VkHistoryPort = {
    async getHistory() {
      return [historyMessage(2), historyMessage(1)];
    },
  };

  const report = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    pageSize: 200,
    totalLimit: 1_000,
  });

  assert.equal(report.status, "exhausted");
  assert.equal(
    store.getSyncState(CHAT.chatId)?.backfillExhaustedAt !== undefined,
    true,
  );
});

test("an empty page marks the chat exhausted without touching the store further", async () => {
  const store = new FakeStore();
  const port: VkHistoryPort = {
    async getHistory() {
      return [];
    },
  };

  const report = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    totalLimit: 1_000,
  });

  assert.deepEqual(report, {
    chatId: CHAT.chatId,
    status: "exhausted",
    fetched: 0,
  });
});

test("reaching totalLimit stops the backfill even mid-page", async () => {
  const store = new FakeStore();
  let calls = 0;
  const port: VkHistoryPort = {
    async getHistory({ count }) {
      calls += 1;
      return Array.from({ length: count }, (_unused, index) =>
        historyMessage(100 - index),
      );
    },
  };

  const first = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    pageSize: 5,
    totalLimit: 8,
  });
  assert.equal(first.status, "progress");
  assert.equal(first.fetched, 5);

  const second = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    pageSize: 5,
    totalLimit: 8,
  });
  assert.equal(second.status, "exhausted");
  assert.equal(second.fetched, 3);
  assert.equal(calls, 2);

  const third = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    pageSize: 5,
    totalLimit: 8,
  });
  assert.equal(third.status, "already_exhausted");
  assert.equal(calls, 2, "no further API call once exhausted");
});

test("an already-exhausted chat is skipped without any API call", async () => {
  const store = new FakeStore();
  store.setBackfillExhausted(
    { chatId: CHAT.chatId, requested: CHAT.chatId, kind: "chat" },
    true,
  );
  let called = false;
  const port: VkHistoryPort = {
    async getHistory() {
      called = true;
      return [];
    },
  };

  const report = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    totalLimit: 1_000,
  });

  assert.deepEqual(report, {
    chatId: CHAT.chatId,
    status: "already_exhausted",
  });
  assert.equal(called, false);
});

test("a port failure is reported, not thrown, and does not touch sync state", async () => {
  const store = new FakeStore();
  const port: VkHistoryPort = {
    async getHistory() {
      throw new Error("VK API is down");
    },
  };

  const report = await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    totalLimit: 1_000,
  });

  assert.equal(report.status, "error");
  assert.equal(report.error, "VK API is down");
  assert.equal(store.getSyncState(CHAT.chatId), undefined);
});

test("empty text with attachments becomes a placeholder, never a bare empty string", async () => {
  const store = new FakeStore();
  const port: VkHistoryPort = {
    async getHistory() {
      return [historyMessage(1, { text: "", hasAttachments: true })];
    },
  };

  await runVkHistoryBackfillTick({
    store,
    port,
    chat: CHAT,
    totalLimit: 1_000,
  });

  assert.equal(store.upsertedMessages[0]?.text, "[вложение]");
});

test("createVkHistoryBackfillPort reads conversation_message_id/from_id and drops malformed rows", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fakeVk = {
    api: {
      messages: {
        async getHistory(params: Record<string, unknown>) {
          requests.push(params);
          return {
            items: [
              {
                conversation_message_id: 42,
                from_id: 100,
                text: "hello",
                date: 1_700_000_000,
                attachments: [{ type: "photo" }],
                reply_message: { conversation_message_id: 41 },
              },
              {
                conversation_message_id: 0,
                from_id: 100,
                text: "bad id, dropped",
              },
              { from_id: 100, text: "missing id, dropped" },
              null,
            ],
          };
        },
      },
    },
  } as unknown as Parameters<typeof createVkHistoryBackfillPort>[0];

  const port = createVkHistoryBackfillPort(fakeVk);
  const items = await port.getHistory({
    peerId: 2_000_000_002,
    count: 200,
    offset: 0,
  });

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    conversationMessageId: 42,
    fromId: 100,
    text: "hello",
    hasAttachments: true,
    date: 1_700_000_000,
    replyConversationMessageId: 41,
  });
  assert.deepEqual(requests[0], {
    peer_id: 2_000_000_002,
    count: 200,
    offset: 0,
    rev: 0,
  });
});

test("VkHistoryBackfillLoop ticks every configured chat once per pass and stops on abort", async () => {
  const store = new FakeStore();
  const calls: string[] = [];
  const port: VkHistoryPort = {
    async getHistory() {
      return [];
    },
  };
  const loop = new VkHistoryBackfillLoop({
    store,
    port,
    chats: [
      CHAT,
      { chatId: "vk:2000000003", peerId: 2_000_000_003, chatTitle: "Second" },
    ],
    totalLimit: 1_000,
    tickIntervalMs: 10,
    onTick: (report) => calls.push(report.chatId),
  });
  const controller = new AbortController();

  const runPromise = loop.run(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await runPromise;

  assert.ok(calls.includes(CHAT.chatId));
  assert.ok(calls.includes("vk:2000000003"));
});

test("VkHistoryBackfillLoop with no chats returns immediately without ticking", async () => {
  const store = new FakeStore();
  const port: VkHistoryPort = {
    async getHistory() {
      throw new Error("must not be called");
    },
  };
  const loop = new VkHistoryBackfillLoop({
    store,
    port,
    chats: [],
    totalLimit: 1_000,
  });

  await loop.run(new AbortController().signal);
});

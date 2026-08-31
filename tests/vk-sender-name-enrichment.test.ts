import assert from "node:assert/strict";
import { test } from "node:test";
import type { VK } from "vk-io";
import {
  runVkSenderNameEnrichmentTick,
  VkSenderNameEnrichmentLoop,
  type VkSenderNameEnrichmentStore,
} from "../src/vk/sender-name-enrichment.js";
import { VkSenderNameCache } from "../src/vk/sender-name-cache.js";

const CHAT_ID = "vk:2000000002";

class FakeStore implements VkSenderNameEnrichmentStore {
  #pending: { chatId: string; senderId: string }[];
  #backfilled: { chatId: string; senderId: string; senderName: string }[] = [];

  constructor(pending: { chatId: string; senderId: string }[]) {
    this.#pending = pending;
  }

  get backfilled(): readonly {
    chatId: string;
    senderId: string;
    senderName: string;
  }[] {
    return this.#backfilled;
  }

  listDistinctUnresolvedVkSenderIds(): { chatId: string; senderId: string }[] {
    return this.#pending;
  }

  backfillSenderName(
    chatId: string,
    senderId: string,
    senderName: string,
  ): number {
    this.#backfilled.push({ chatId, senderId, senderName });
    this.#pending = this.#pending.filter(
      (p) => !(p.chatId === chatId && p.senderId === senderId),
    );
    return 1;
  }
}

function fakeVk(usersGet: (ids: string[]) => unknown[]): VK {
  return {
    api: {
      users: {
        get: (params: { user_ids?: string[] }) =>
          usersGet(params.user_ids ?? []),
      },
    },
  } as unknown as VK;
}

test("a tick resolves pending senders and backfills their name", async () => {
  const store = new FakeStore([{ chatId: CHAT_ID, senderId: "111" }]);
  const vk = fakeVk((ids) =>
    ids.map((id) => ({
      id: Number(id),
      first_name: "Вадим",
      last_name: "Мурашов",
    })),
  );
  const cache = new VkSenderNameCache();

  const report = await runVkSenderNameEnrichmentTick({
    store,
    vk,
    cache,
    chatIds: [CHAT_ID],
  });

  assert.equal(report.status, "progress");
  assert.equal(report.resolved, 1);
  assert.equal(report.updated, 1);
  assert.deepEqual(store.backfilled, [
    { chatId: CHAT_ID, senderId: "111", senderName: "Вадим Мурашов" },
  ]);
});

test("a sender users.get can't resolve stays unresolved without failing the tick", async () => {
  const store = new FakeStore([{ chatId: CHAT_ID, senderId: "-999" }]);
  const vk = fakeVk(() => []);
  const cache = new VkSenderNameCache();

  const report = await runVkSenderNameEnrichmentTick({
    store,
    vk,
    cache,
    chatIds: [CHAT_ID],
  });

  assert.equal(report.status, "progress");
  assert.equal(report.resolved, 0);
  assert.equal(report.updated, 0);
  assert.deepEqual(store.backfilled, []);
});

test("no configured chats or nothing pending both report idle", async () => {
  const cache = new VkSenderNameCache();
  const vk = fakeVk(() => []);

  const noChatIds = await runVkSenderNameEnrichmentTick({
    store: new FakeStore([]),
    vk,
    cache,
    chatIds: [],
  });
  assert.equal(noChatIds.status, "idle");

  const nothingPending = await runVkSenderNameEnrichmentTick({
    store: new FakeStore([]),
    vk,
    cache,
    chatIds: [CHAT_ID],
  });
  assert.equal(nothingPending.status, "idle");
});

test("VkSenderNameEnrichmentLoop ticks once per pass and stops on abort", async () => {
  const store = new FakeStore([{ chatId: CHAT_ID, senderId: "111" }]);
  const vk = fakeVk((ids) =>
    ids.map((id) => ({ id: Number(id), first_name: "U", last_name: id })),
  );
  const cache = new VkSenderNameCache();
  const reports: string[] = [];
  const loop = new VkSenderNameEnrichmentLoop({
    store,
    vk,
    cache,
    chatIds: [CHAT_ID],
    tickIntervalMs: 5,
    onTick: (report) => {
      reports.push(report.status);
      if (reports.length >= 2) {
        controller.abort();
      }
    },
  });
  const controller = new AbortController();

  await loop.run(controller.signal);

  assert.ok(reports.length >= 2);
});

test("VkSenderNameEnrichmentLoop with no chatIds returns immediately without ticking", async () => {
  const store = new FakeStore([]);
  const vk = fakeVk(() => []);
  const cache = new VkSenderNameCache();
  let ticks = 0;
  const loop = new VkSenderNameEnrichmentLoop({
    store,
    vk,
    cache,
    chatIds: [],
    onTick: () => {
      ticks += 1;
    },
  });

  await loop.run(new AbortController().signal);

  assert.equal(ticks, 0);
});

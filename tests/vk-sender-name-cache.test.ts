import assert from "node:assert/strict";
import { test } from "node:test";
import type { VK } from "vk-io";
import {
  formatVkDisplayName,
  VkSenderNameCache,
} from "../src/vk/sender-name-cache.js";

function fakeVk(usersGet: (params: { user_ids?: unknown }) => unknown): VK {
  return { api: { users: { get: usersGet } } } as unknown as VK;
}

test("formatVkDisplayName joins first/last name, trimming empty parts", () => {
  assert.equal(
    formatVkDisplayName({ firstName: "Вадим", lastName: "Мурашов" }),
    "Вадим Мурашов",
  );
  assert.equal(
    formatVkDisplayName({ firstName: "Вадим", lastName: "" }),
    "Вадим",
  );
  assert.equal(formatVkDisplayName({ firstName: "", lastName: "" }), "");
});

test("resolveMany caches resolved names, readable via get", async () => {
  let requestedIds: unknown;
  const vk = fakeVk((params) => {
    requestedIds = params.user_ids;
    return [{ id: 111, first_name: "Вадим", last_name: "Мурашов" }];
  });
  const cache = new VkSenderNameCache();

  await cache.resolveMany(vk, ["111"]);

  assert.deepEqual(requestedIds, ["111"]);
  assert.equal(cache.get("111"), "Вадим Мурашов");
});

test("negative (community/group) sender ids are never sent to users.get", async () => {
  let calls = 0;
  const vk = fakeVk(() => {
    calls += 1;
    return [];
  });
  const cache = new VkSenderNameCache();

  await cache.resolveMany(vk, ["-241183834"]);

  assert.equal(calls, 0);
  assert.equal(cache.get("-241183834"), undefined);
});

test("already-cached ids are not requested again", async () => {
  let calls = 0;
  const vk = fakeVk(() => {
    calls += 1;
    return [{ id: 111, first_name: "Вадим", last_name: "Мурашов" }];
  });
  const cache = new VkSenderNameCache();

  await cache.resolveMany(vk, ["111"]);
  await cache.resolveMany(vk, ["111"]);

  assert.equal(calls, 1);
});

test("a failed users.get batch leaves those ids unresolved rather than throwing", async () => {
  const vk = fakeVk(() => {
    throw new Error("VK API down");
  });
  const cache = new VkSenderNameCache();

  await assert.doesNotReject(cache.resolveMany(vk, ["111"]));
  assert.equal(cache.get("111"), undefined);
});

test("more than 1000 ids are batched across multiple users.get calls", async () => {
  const batches: unknown[][] = [];
  const vk = fakeVk((params) => {
    const ids = params.user_ids as string[];
    batches.push(ids);
    return ids.map((id) => ({
      id: Number(id),
      first_name: "U",
      last_name: id,
    }));
  });
  const cache = new VkSenderNameCache();
  const ids = Array.from({ length: 1_500 }, (_, index) => String(index + 1));

  await cache.resolveMany(vk, ids);

  assert.equal(batches.length, 2);
  assert.equal(batches[0]?.length, 1_000);
  assert.equal(batches[1]?.length, 500);
  assert.equal(cache.get("1500"), "U 1500");
});

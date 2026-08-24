import assert from "node:assert/strict";
import test from "node:test";
import { sendNewsBrief } from "../src/news-brief/send.js";
import { MessageStore } from "../src/store.js";

const THROTTLE = {
  maxAgeMs: 600_000,
  userCooldownMs: 0,
  maxPendingPerUserPerChat: 3,
  maxQueuePerChat: 3,
};

function fakeApi(handler?: (text: string) => number) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      async sendMessage(_chatId: string, text: string) {
        calls.push(text);
        return { message_id: handler?.(text) ?? 100 };
      },
    },
  };
}

test("dry run never reserves or sends", async () => {
  const store = new MessageStore(":memory:");
  const { api, calls } = fakeApi();
  const result = await sendNewsBrief({
    store,
    api,
    chatId: "-1001",
    text: "digest",
    dayKey: "2026-08-24",
    apply: false,
    throttle: THROTTLE,
  });
  assert.deepEqual(result, { outcome: "skipped_dry_run" });
  assert.equal(calls.length, 0);
});

test("apply sends once and marks the outbox row sent", async () => {
  const store = new MessageStore(":memory:");
  const { api, calls } = fakeApi(() => 555);
  const result = await sendNewsBrief({
    store,
    api,
    chatId: "-1001",
    text: "digest",
    dayKey: "2026-08-24",
    apply: true,
    throttle: THROTTLE,
    nowMs: 1_000,
  });
  assert.deepEqual(result, { outcome: "sent", telegramMessageId: 555 });
  assert.equal(calls.length, 1);
});

test("a same-day re-run with identical text is a no-op duplicate, not a second send", async () => {
  const store = new MessageStore(":memory:");
  const { api, calls } = fakeApi(() => 555);
  const first = await sendNewsBrief({
    store,
    api,
    chatId: "-1001",
    text: "digest",
    dayKey: "2026-08-24",
    apply: true,
    throttle: THROTTLE,
    nowMs: 1_000,
  });
  const second = await sendNewsBrief({
    store,
    api,
    chatId: "-1001",
    text: "digest",
    dayKey: "2026-08-24",
    apply: true,
    throttle: THROTTLE,
    nowMs: 2_000,
  });
  assert.equal(first.outcome, "sent");
  assert.equal(second.outcome, "duplicate");
  assert.equal(second.telegramMessageId, 555);
  assert.equal(calls.length, 1);
});

test("a same-day re-run with different (re-generated) text fails closed instead of double-posting", async () => {
  const store = new MessageStore(":memory:");
  const { api, calls } = fakeApi(() => 555);
  await sendNewsBrief({
    store,
    api,
    chatId: "-1001",
    text: "digest",
    dayKey: "2026-08-24",
    apply: true,
    throttle: THROTTLE,
    nowMs: 1_000,
  });
  await assert.rejects(() =>
    sendNewsBrief({
      store,
      api,
      chatId: "-1001",
      text: "digest (regenerated slightly differently)",
      dayKey: "2026-08-24",
      apply: true,
      throttle: THROTTLE,
      nowMs: 2_000,
    }),
  );
  assert.equal(calls.length, 1);
});

test("a different dayKey is not deduped against a prior send", async () => {
  const store = new MessageStore(":memory:");
  const { api, calls } = fakeApi(() => 555);
  await sendNewsBrief({
    store,
    api,
    chatId: "-1001",
    text: "digest 1",
    dayKey: "2026-08-24",
    apply: true,
    throttle: THROTTLE,
    nowMs: 1_000,
  });
  const second = await sendNewsBrief({
    store,
    api,
    chatId: "-1001",
    text: "digest 2",
    dayKey: "2026-08-25",
    apply: true,
    throttle: THROTTLE,
    nowMs: 2_000,
  });
  assert.equal(second.outcome, "sent");
  assert.equal(calls.length, 2);
});

test("a send failure marks delivery unknown and rethrows", async () => {
  const store = new MessageStore(":memory:");
  const api = {
    async sendMessage(): Promise<{ message_id: number }> {
      throw new Error("telegram unavailable");
    },
  };
  await assert.rejects(
    () =>
      sendNewsBrief({
        store,
        api,
        chatId: "-1001",
        text: "digest",
        dayKey: "2026-08-24",
        apply: true,
        throttle: THROTTLE,
        nowMs: 1_000,
      }),
    /telegram unavailable/,
  );
});

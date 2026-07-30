import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api } from "grammy";
import {
  BotWorkerPump,
  createDurableGrammyBotTurnPublisher,
  type BotWorkerPort,
} from "../src/bot/runtime.js";
import type { GuardedChunk } from "../src/bot/output-guards.js";
import {
  BOT_ID,
  BOT_USERNAME,
  CHAT_ID,
  makeStore,
} from "./support/bot-runtime.js";

function plainChunks(texts: readonly string[]): GuardedChunk[] {
  return texts.map((text) => ({ text, entities: [] }));
}

test("worker pump never exceeds three concurrent runs and drains the durable hint", async () => {
  let remainingTurns = 7;
  let active = 0;
  let maximumActive = 0;
  const perWorkerActive = new Set<number>();
  const workers: BotWorkerPort[] = Array.from(
    { length: 3 },
    (_unused, index) => ({
      async runOnce() {
        assert.equal(perWorkerActive.has(index), false);
        perWorkerActive.add(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const hadTurn = remainingTurns > 0;
        if (hadTurn) {
          remainingTurns -= 1;
        }
        active -= 1;
        perWorkerActive.delete(index);
        return hadTurn
          ? { status: "sent", turnId: 100 - remainingTurns }
          : { status: "idle" };
      },
    }),
  );
  const pump = new BotWorkerPump({ workers });

  pump.start();
  const result = await pump.drain(2_000);

  assert.deepEqual(result, { drained: true, activeWorkers: 0 });
  assert.equal(remainingTurns, 0);
  assert.equal(maximumActive, 3);
  assert.equal(perWorkerActive.size, 0);
  assert.throws(
    () => new BotWorkerPump({ workers: [...workers, workers[0]!] }),
    /between 1 and 3/u,
  );
});

test("worker pump wakes once when a durable retry becomes due", async () => {
  let calls = 0;
  let wake: (() => void) | undefined;
  let scheduledDelay: number | undefined;
  const pump = new BotWorkerPump({
    workers: [
      {
        async runOnce() {
          calls += 1;
          return calls === 1
            ? { status: "idle", retryAfterMs: 61_000 }
            : { status: "idle" };
        },
      },
    ],
    setTimeout: ((callback: () => void, delay?: number) => {
      wake = callback;
      scheduledDelay = delay;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });

  pump.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(scheduledDelay, 61_000);

  wake?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(await pump.stop(1_000), {
    drained: true,
    activeWorkers: 0,
  });
});

test("durable publisher inserts every acknowledged own message before returning success", async (t) => {
  const store = makeStore(t);
  let nextMessageId = 900;
  const api = {
    async sendMessage(
      chatId: string | number,
      text: string,
    ) {
      nextMessageId += 1;
      return {
        message_id: nextMessageId,
        date: 1_700_000_000 + nextMessageId,
        chat: {
          id: Number(chatId),
          type: "supergroup",
          title: "Парилка",
        },
        from: {
          id: Number(BOT_ID),
          is_bot: true,
          username: BOT_USERNAME,
        },
        text,
      };
    },
  } as unknown as Pick<Api, "sendMessage">;
  const publisher = createDurableGrammyBotTurnPublisher(api, {
    store,
    botId: BOT_ID,
    botUsername: BOT_USERNAME,
  });

  const result = await publisher.publish({
    chatId: CHAT_ID,
    replyToMessageId: 777,
    chunks: plainChunks(["первая часть", "вторая часть"]),
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 2,
    telegramMessageId: 901,
  });
  const stored = store
    .getHistory({ chatId: CHAT_ID, limit: 10, order: "asc" })
    .filter((message) => message.senderId === BOT_ID);
  assert.deepEqual(
    stored.map((message) => ({
      messageId: message.messageId,
      text: message.text,
      replyToMessageId: message.replyToMessageId,
      senderName: message.senderName,
    })),
    [
      {
        messageId: 901,
        text: "первая часть",
        replyToMessageId: 777,
        senderName: BOT_USERNAME,
      },
      {
        messageId: 902,
        text: "вторая часть",
        replyToMessageId: 777,
        senderName: BOT_USERNAME,
      },
    ],
  );
});

test("own-send recording failure stays ambiguous and cannot become a definitive retry", async () => {
  let networkCalls = 0;
  const api = {
    async sendMessage() {
      networkCalls += 1;
      return {
        message_id: 999,
        chat: { id: Number(CHAT_ID), type: "supergroup" },
        from: { id: Number(BOT_ID), is_bot: true },
      };
    },
  } as unknown as Pick<Api, "sendMessage">;
  const publisher = createDurableGrammyBotTurnPublisher(api, {
    store: {
      getCachedChat() {
        return undefined;
      },
      upsertMessages() {
        throw new Error("private sqlite failure");
      },
    },
    botId: BOT_ID,
    botUsername: BOT_USERNAME,
  });

  const result = await publisher.publish({
    chatId: CHAT_ID,
    replyToMessageId: 1,
    chunks: plainChunks(["already dispatched"]),
    signal: new AbortController().signal,
  });

  assert.equal(networkCalls, 1);
  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "unknown", code: "UNKNOWN_ERROR" },
  });
});

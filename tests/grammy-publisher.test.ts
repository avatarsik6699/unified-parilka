import assert from "node:assert/strict";
import { test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import {
  GrammyBotTurnPublisher,
  type GrammyBotApiPort,
  type GrammySendMessageOptions,
} from "../src/bot/grammy-publisher.js";
import type { GuardedChunk } from "../src/bot/output-guards.js";

function plainChunks(texts: readonly string[]): GuardedChunk[] {
  return texts.map((text) => ({ text, entities: [] }));
}

const BASE_OPTIONS = {
  reply_parameters: {
    message_id: 99,
    allow_sending_without_reply: false as const,
  },
  link_preview_options: { is_disabled: true as const },
};

interface SendCall {
  chatId: string;
  text: string;
  options: GrammySendMessageOptions;
  signal: AbortSignal;
}

test("publishes guarded plain-text chunks sequentially in their original order", async () => {
  const calls: SendCall[] = [];
  const responses = [{ message_id: 701 }, { message_id: 702 }];
  const api: GrammyBotApiPort = {
    async sendMessage(chatId, text, options, signal) {
      calls.push({ chatId, text, options, signal });
      return responses[calls.length - 1];
    },
  };
  const signal = new AbortController().signal;
  const publisher = new GrammyBotTurnPublisher(api);

  const result = await publisher.publish({
    chatId: "-1004242",
    replyToMessageId: 99,
    chunks: plainChunks(["первый <b>не HTML</b>", "второй"]),
    signal,
  });

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 2,
    telegramMessageId: 701,
  });
  assert.deepEqual(
    calls.map(({ chatId, text, options }) => ({
      chatId,
      text,
      options,
    })),
    [
      {
        chatId: "-1004242",
        text: "первый <b>не HTML</b>",
        options: BASE_OPTIONS,
      },
      {
        chatId: "-1004242",
        text: "второй",
        options: BASE_OPTIONS,
      },
    ],
  );
  assert.equal(calls[0]?.signal, signal);
  assert.equal(calls[1]?.signal, signal);
});

test("classifies a first-call grammY 400 as a definitive non-retryable rejection", async () => {
  const publisher = publisherThrowing(
    telegramError(400, "secret response description"),
  );

  const result = await publisher.publish(request(["answer token secret"]));

  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_400",
      retryable: false,
    },
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret response description|answer token secret/u,
  );
});

test("marks a definitive Telegram 429 as retryable", async () => {
  const publisher = publisherThrowing(telegramError(429, "flood wait"));

  assert.deepEqual(await publisher.publish(request(["answer"])), {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_429",
      retryable: true,
    },
  });
});

test("extracts and clamps Telegram retry_after from a 429 rejection", async () => {
  const raw = {
    ok: false,
    error_code: 429,
    description: "Too Many Requests",
    parameters: { retry_after: 61 },
  };
  const publisher = new GrammyBotTurnPublisher({
    async sendMessage() {
      return raw;
    },
  });

  assert.deepEqual(await publisher.publish(request(["answer"])), {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_429",
      retryable: true,
      retryAfterMs: 61_000,
    },
  });

  raw.parameters.retry_after = 999_999;
  assert.equal(
    (
      (await publisher.publish(request(["answer"]))) as {
        ok: false;
        error: { retryAfterMs?: number };
      }
    ).error.retryAfterMs,
    15 * 60_000,
  );
});

test("accepts a raw definitive Bot API rejection response without treating it as success", async () => {
  const publisher = new GrammyBotTurnPublisher({
    async sendMessage() {
      return {
        ok: false,
        error_code: 503,
        description: "backend unavailable",
      };
    },
  });

  assert.deepEqual(await publisher.publish(request(["answer"])), {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "telegram_rejected",
      code: "TELEGRAM_503",
      retryable: true,
    },
  });
});

test("keeps grammY HttpError and socket failures out of telegram_rejected", async (t) => {
  await t.test("HttpError", async () => {
    const socketError = Object.assign(new Error("socket details"), {
      code: "ECONNRESET",
    });
    const publisher = publisherThrowing(
      new HttpError("network request failed", socketError),
    );

    assert.deepEqual(await publisher.publish(request(["answer"])), {
      ok: false,
      chunksSent: 0,
      error: { kind: "network", code: "ECONNRESET" },
    });
  });

  await t.test("direct socket error", async () => {
    const publisher = publisherThrowing(
      Object.assign(new Error("dns details"), { code: "ENOTFOUND" }),
    );

    assert.deepEqual(await publisher.publish(request(["answer"])), {
      ok: false,
      chunksSent: 0,
      error: { kind: "network", code: "ENOTFOUND" },
    });
  });
});

test("honors an already-aborted publish signal without making a Bot API call", async () => {
  let calls = 0;
  const publisher = new GrammyBotTurnPublisher({
    async sendMessage() {
      calls += 1;
      return { message_id: 1 };
    },
  });
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));

  const result = await publisher.publish({
    ...request(["answer"]),
    signal: controller.signal,
  });

  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "timeout", code: "ABORTED" },
  });
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /private abort reason/u);
});

test("a rejection on the second chunk reports the acknowledged prefix as partial delivery", async () => {
  let calls = 0;
  const publisher = new GrammyBotTurnPublisher({
    async sendMessage() {
      calls += 1;
      if (calls === 1) {
        return { message_id: 801 };
      }
      throw telegramError(400, "second chunk rejected");
    },
  });

  assert.deepEqual(
    await publisher.publish(request(["first", "second", "third"])),
    {
      ok: false,
      chunksSent: 1,
      error: { kind: "unknown", code: "PARTIAL_DELIVERY" },
    },
  );
  assert.equal(calls, 2);
});

test("rejects a malformed successful response without trusting message_id", async () => {
  const publisher = new GrammyBotTurnPublisher({
    async sendMessage() {
      return { message_id: "901" };
    },
  });

  assert.deepEqual(await publisher.publish(request(["answer"])), {
    ok: false,
    chunksSent: 0,
    error: {
      kind: "unknown",
      code: "MALFORMED_SUCCESS_RESPONSE",
    },
  });
});

function publisherThrowing(error: unknown): GrammyBotTurnPublisher {
  return new GrammyBotTurnPublisher({
    async sendMessage() {
      throw error;
    },
  });
}

function telegramError(
  errorCode: number,
  description: string,
): GrammyError {
  return new GrammyError(
    "Call to sendMessage failed",
    {
      ok: false,
      error_code: errorCode,
      description,
    },
    "sendMessage",
    {},
  );
}

function request(chunks: readonly string[]) {
  return {
    chatId: "-1004242",
    replyToMessageId: 99,
    chunks: plainChunks(chunks),
    signal: new AbortController().signal,
  };
}

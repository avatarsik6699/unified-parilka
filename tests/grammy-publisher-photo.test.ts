import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GrammyBotTurnPublisher,
  type GrammyBotApiPort,
  type GrammyRichMessageOptions,
} from "../src/bot/grammy-publisher.js";
import type { TelegramPublication } from "../src/bot/telegram-publication.js";

interface PhotoCall {
  chatId: string;
  photoBytes: Buffer;
  caption: string;
  options: GrammyRichMessageOptions;
}

interface PlainCall {
  chatId: string;
  text: string;
}

function makeFakeApi(options: { withSendPhoto?: boolean } = {}) {
  const photoCalls: PhotoCall[] = [];
  const plainCalls: PlainCall[] = [];
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw new Error("unexpected sendRichMessage");
    },
    async sendMessage(chatId, text) {
      plainCalls.push({ chatId, text });
      return { message_id: 702 };
    },
    ...(options.withSendPhoto === false
      ? {}
      : {
          async sendPhoto(input) {
            photoCalls.push({
              chatId: input.chatId,
              photoBytes: input.photoBytes,
              caption: input.caption,
              options: input.options,
            });
            return { message_id: 703 };
          },
        }),
  };
  return { api, photoCalls, plainCalls };
}

function photoPublication(
  photoBytes = Buffer.from([1, 2, 3]),
  caption = "готово",
): TelegramPublication {
  return { mode: "photo", photoBytes, caption };
}

function request(publication: TelegramPublication, replyToMessageId = 99) {
  return {
    chatId: "-1004242",
    replyToMessageId,
    publication,
    signal: new AbortController().signal,
  };
}

// ─── photo publication ──────────────────────────────────────────────────────

test("publishes a photo publication as one native sendPhoto with the caption", async () => {
  const { api, photoCalls } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);
  const bytes = Buffer.from([9, 8, 7]);

  const result = await publisher.publish(
    request(photoPublication(bytes, "вот картинка")),
  );

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 703,
  });
  assert.equal(photoCalls.length, 1);
  assert.deepEqual(photoCalls[0]!.photoBytes, bytes);
  assert.equal(photoCalls[0]!.caption, "вот картинка");
  assert.equal(photoCalls[0]!.options.reply_parameters.message_id, 99);
});

test("degrades to plain text when the port has no sendPhoto implementation", async () => {
  const { api, plainCalls } = makeFakeApi({ withSendPhoto: false });
  const publisher = new GrammyBotTurnPublisher(api);

  const result = await publisher.publish(
    request(photoPublication(Buffer.from([1]), "текст вместо фото")),
  );

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 702,
  });
  assert.equal(plainCalls.length, 1);
  assert.equal(plainCalls[0]!.text, "текст вместо фото");
});

test("an aborted signal fails a photo publish without calling the API", async () => {
  const { api, photoCalls } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);
  const controller = new AbortController();
  controller.abort();

  const result = await publisher.publish({
    chatId: "-1004242",
    replyToMessageId: 99,
    publication: photoPublication(),
    signal: controller.signal,
  });

  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "timeout", code: "ABORTED" },
  });
  assert.equal(photoCalls.length, 0);
});

test("an empty photo buffer is rejected as an invalid publish request", async () => {
  const { api } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);

  const result = await publisher.publish(
    request(photoPublication(Buffer.alloc(0), "пусто")),
  );

  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "unknown", code: "INVALID_PUBLISH_REQUEST" },
  });
});

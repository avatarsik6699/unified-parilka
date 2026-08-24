import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GrammyBotTurnPublisher,
  type GrammyBotApiPort,
  type GrammyRichMessageOptions,
} from "../src/bot/grammy-publisher.js";
import type { TelegramPublication } from "../src/bot/telegram-publication.js";

interface VoiceCall {
  chatId: string;
  voiceBytes: Buffer;
  caption: string;
  options: GrammyRichMessageOptions;
}

interface PlainCall {
  chatId: string;
  text: string;
}

function makeFakeApi(options: { withSendVoice?: boolean } = {}) {
  const voiceCalls: VoiceCall[] = [];
  const plainCalls: PlainCall[] = [];
  const api: GrammyBotApiPort = {
    async sendRichMessage() {
      throw new Error("unexpected sendRichMessage");
    },
    async sendMessage(chatId, text) {
      plainCalls.push({ chatId, text });
      return { message_id: 702 };
    },
    ...(options.withSendVoice === false
      ? {}
      : {
          async sendVoice(input) {
            voiceCalls.push({
              chatId: input.chatId,
              voiceBytes: input.voiceBytes,
              caption: input.caption,
              options: input.options,
            });
            return { message_id: 704 };
          },
        }),
  };
  return { api, voiceCalls, plainCalls };
}

function voicePublication(
  voiceBytes = Buffer.from([1, 2, 3]),
  caption = "готово",
): TelegramPublication {
  return { mode: "voice", voiceBytes, caption };
}

function request(publication: TelegramPublication, replyToMessageId = 99) {
  return {
    chatId: "-1004242",
    replyToMessageId,
    publication,
    signal: new AbortController().signal,
  };
}

// ─── voice publication ──────────────────────────────────────────────────────

test("publishes a voice publication as one native sendVoice with the caption", async () => {
  const { api, voiceCalls } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);
  const bytes = Buffer.from([9, 8, 7]);

  const result = await publisher.publish(
    request(voicePublication(bytes, "привет из логова")),
  );

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 704,
  });
  assert.equal(voiceCalls.length, 1);
  assert.deepEqual(voiceCalls[0]!.voiceBytes, bytes);
  assert.equal(voiceCalls[0]!.caption, "привет из логова");
  assert.equal(voiceCalls[0]!.options.reply_parameters.message_id, 99);
});

test("degrades to plain text when the port has no sendVoice implementation", async () => {
  const { api, plainCalls } = makeFakeApi({ withSendVoice: false });
  const publisher = new GrammyBotTurnPublisher(api);

  const result = await publisher.publish(
    request(voicePublication(Buffer.from([1]), "текст вместо голоса")),
  );

  assert.deepEqual(result, {
    ok: true,
    chunksSent: 1,
    telegramMessageId: 702,
  });
  assert.equal(plainCalls.length, 1);
  assert.equal(plainCalls[0]!.text, "текст вместо голоса");
});

test("an aborted signal fails a voice publish without calling the API", async () => {
  const { api, voiceCalls } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);
  const controller = new AbortController();
  controller.abort();

  const result = await publisher.publish({
    chatId: "-1004242",
    replyToMessageId: 99,
    publication: voicePublication(),
    signal: controller.signal,
  });

  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "timeout", code: "ABORTED" },
  });
  assert.equal(voiceCalls.length, 0);
});

test("an empty voice buffer is rejected as an invalid publish request", async () => {
  const { api } = makeFakeApi();
  const publisher = new GrammyBotTurnPublisher(api);

  const result = await publisher.publish(
    request(voicePublication(Buffer.alloc(0), "пусто")),
  );

  assert.deepEqual(result, {
    ok: false,
    chunksSent: 0,
    error: { kind: "unknown", code: "INVALID_PUBLISH_REQUEST" },
  });
});

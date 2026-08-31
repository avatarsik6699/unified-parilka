import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseStoredVkPhoto,
  parseStoredVkVoice,
  selectVkPhotoTarget,
  selectVkVoiceTarget,
} from "../src/bot/media/vk-media.js";
import type { StoredMessage } from "../src/store.js";

function stored(rawJson: unknown, messageId = 5): StoredMessage {
  return {
    chatId: "vk:2000000001",
    messageId,
    text: "",
    rawJson: JSON.stringify(rawJson),
  };
}

test("parses a valid vkPhoto payload from an allowed VK CDN host", () => {
  const message = stored({
    vkPhoto: {
      url: "https://sun9-1.userapi.com/photo.jpg",
      width: 800,
      height: 600,
    },
  });
  const media = parseStoredVkPhoto(message);
  assert.deepEqual(media, {
    kind: "vk_photo",
    url: "https://sun9-1.userapi.com/photo.jpg",
    mediaType: "image/jpeg",
    width: 800,
    height: 600,
  });
});

test("rejects a non-VK host even inside an otherwise well-formed vkPhoto payload", () => {
  const message = stored({
    vkPhoto: {
      url: "https://evil.example.com/photo.jpg",
      width: 800,
      height: 600,
    },
  });
  assert.equal(parseStoredVkPhoto(message), undefined);
});

test("rejects a non-https scheme", () => {
  const message = stored({
    vkPhoto: { url: "http://sun9-1.userapi.com/photo.jpg" },
  });
  assert.equal(parseStoredVkPhoto(message), undefined);
});

test("Telegram-shaped rawJson never parses as a VK photo", () => {
  const message = stored({
    photo: [{ file_id: "abc", width: 100, height: 100 }],
  });
  assert.equal(parseStoredVkPhoto(message), undefined);
});

test("selectVkPhotoTarget prefers the trigger, falls back to the reply target", () => {
  const trigger = stored({ text: "нет фото" }, 10);
  const reply = stored(
    { vkPhoto: { url: "https://sun9-3.userapi.com/reply.jpg" } },
    9,
  );
  const target = selectVkPhotoTarget(trigger, reply);
  assert.ok(target);
  assert.equal(target.source, "reply");
  assert.equal(target.url, "https://sun9-3.userapi.com/reply.jpg");
  assert.equal(target.message.messageId, 9);
});

test("selectVkPhotoTarget returns undefined when neither message has a photo", () => {
  const trigger = stored({ text: "привет" }, 1);
  assert.equal(selectVkPhotoTarget(trigger), undefined);
});

test("parses a valid vkVoice payload", () => {
  const message = stored({
    vkVoice: {
      url: "https://psv4.userapi.com/voice.ogg",
      mediaType: "audio/ogg",
      durationSeconds: 5,
    },
  });
  const media = parseStoredVkVoice(message);
  assert.deepEqual(media, {
    kind: "vk_voice",
    url: "https://psv4.userapi.com/voice.ogg",
    mediaType: "audio/ogg",
    durationSeconds: 5,
  });
});

test("rejects a vkVoice payload from a non-VK host", () => {
  const message = stored({
    vkVoice: { url: "https://evil.example.com/voice.ogg" },
  });
  assert.equal(parseStoredVkVoice(message), undefined);
});

test("Telegram-shaped rawJson never parses as a VK voice message", () => {
  const message = stored({
    voice: { file_id: "abc", duration: 3, mime_type: "audio/ogg" },
  });
  assert.equal(parseStoredVkVoice(message), undefined);
});

test("selectVkVoiceTarget prefers the trigger, falls back to the reply target", () => {
  const trigger = stored({ text: "нет голосового" }, 20);
  const reply = stored(
    {
      vkVoice: {
        url: "https://psv4.userapi.com/reply.ogg",
        durationSeconds: 4,
      },
    },
    19,
  );
  const target = selectVkVoiceTarget(trigger, reply);
  assert.ok(target);
  assert.equal(target.source, "reply");
  assert.equal(target.url, "https://psv4.userapi.com/reply.ogg");
  assert.equal(target.message.messageId, 19);
});

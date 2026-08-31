import assert from "node:assert/strict";
import { test } from "node:test";
import type { VK } from "vk-io";
import { createVkToolProgressBotApiPort } from "../src/bot/runtime/vk-adapters.js";

const SIGNAL = new AbortController().signal;
const CHAT_ID = "vk:2000000002";
const GROUP_ID = 241183834;

function fakeVk(overrides: {
  send?: (params: Record<string, unknown>) => unknown;
  edit?: (params: Record<string, unknown>) => unknown;
  del?: (params: Record<string, unknown>) => unknown;
}): VK {
  return {
    api: {
      messages: {
        send: overrides.send ?? (() => Promise.resolve([])),
        edit: overrides.edit ?? (() => Promise.resolve(1)),
        delete: overrides.del ?? (() => Promise.resolve([])),
      },
    },
  } as unknown as VK;
}

test("sendMessage reads conversation_message_id from the peer_ids-array response, never the useless message_id", async () => {
  let capturedParams: Record<string, unknown> | undefined;
  const vk = fakeVk({
    send: (params) => {
      capturedParams = params;
      return Promise.resolve([
        {
          peer_id: 2_000_000_002,
          message_id: 0,
          conversation_message_id: 391_153,
        },
      ]);
    },
  });
  const port = createVkToolProgressBotApiPort(vk, GROUP_ID);

  const result = await port.sendMessage(CHAT_ID, "⏳ шаманю", SIGNAL);

  assert.deepEqual(result, { ok: true, messageId: 391_153 });
  assert.equal(capturedParams?.group_id, GROUP_ID);
  assert.deepEqual(capturedParams?.peer_ids, [2_000_000_002]);
});

test("sendMessage fails closed when the response has no matching peer_id entry", async () => {
  const vk = fakeVk({ send: () => Promise.resolve([]) });
  const port = createVkToolProgressBotApiPort(vk, GROUP_ID);

  const result = await port.sendMessage(CHAT_ID, "⏳ шаманю", SIGNAL);

  assert.deepEqual(result, { ok: false });
});

test("editMessageText and deleteMessage address the message by cmid, not message_id", async () => {
  let editParams: Record<string, unknown> | undefined;
  let deleteParams: Record<string, unknown> | undefined;
  const vk = fakeVk({
    edit: (params) => {
      editParams = params;
      return Promise.resolve(1);
    },
    del: (params) => {
      deleteParams = params;
      return Promise.resolve([{ peer_id: 2_000_000_002, response: 1 }]);
    },
  });
  const port = createVkToolProgressBotApiPort(vk, GROUP_ID);

  const editResult = await port.editMessageText(
    CHAT_ID,
    391_153,
    "✓ готово",
    SIGNAL,
  );
  const deleteResult = await port.deleteMessage(CHAT_ID, 391_153, SIGNAL);

  assert.deepEqual(editResult, { ok: true });
  assert.deepEqual(deleteResult, { ok: true });
  assert.equal(editParams?.cmid, 391_153);
  assert.equal(editParams?.peer_id, 2_000_000_002);
  assert.deepEqual(deleteParams?.cmids, [391_153]);
  assert.equal(deleteParams?.delete_for_all, true);
});

test("an invalid VK chatId fails every operation closed without calling the API", async () => {
  let called = false;
  const vk = fakeVk({
    send: () => {
      called = true;
      return Promise.resolve([]);
    },
    edit: () => {
      called = true;
      return Promise.resolve(1);
    },
    del: () => {
      called = true;
      return Promise.resolve([]);
    },
  });
  const port = createVkToolProgressBotApiPort(vk, GROUP_ID);

  assert.deepEqual(await port.sendMessage("-1002501807882", "x", SIGNAL), {
    ok: false,
  });
  assert.deepEqual(
    await port.editMessageText("-1002501807882", 1, "x", SIGNAL),
    { ok: false },
  );
  assert.deepEqual(await port.deleteMessage("-1002501807882", 1, SIGNAL), {
    ok: false,
  });
  assert.equal(called, false);
});

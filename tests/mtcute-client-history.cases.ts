import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MtcuteTelegramService,
  type MtcuteClientFactory,
} from "../src/telegram/mtcute-client.js";
import {
  CHAT_ID,
  CHAT_PEER,
  FakeMtcuteClient,
  config,
  errorWithCode,
  harness,
  historyPage,
  message,
} from "./support/mtcute-client.js";

test("history pagination uses mtcute offsets and emits provider-neutral messages", async () => {
  const fake = new FakeMtcuteClient();
  const { service } = harness(fake, { historyPageSize: 2 });
  fake.historyHandler = async ({ params }) => {
    if (params.offset?.id === 10) {
      return historyPage(
        [
          message(9, {
            date: new Date("2026-07-30T10:20:30.000Z"),
            editDate: new Date("2026-07-30T10:21:00.000Z"),
            replyToMessage: {
              id: 7,
              threadId: 5,
              isForumTopic: true,
            },
            isTopicMessage: true,
          }),
          message(8, {
            replyToMessage: {
              id: 6,
              threadId: null,
              isForumTopic: true,
            },
          }),
        ],
        { id: 8, date: 1_722_336_000 },
      );
    }
    assert.deepEqual(params.offset, {
      id: 8,
      date: 1_722_336_000,
    });
    return historyPage(
      [message(7)],
      { id: 7, date: 1_722_335_000 },
    );
  };

  const stream = await service.iterateMessages({
    limit: 3,
    offsetId: 10,
    minId: 3,
    maxId: 20,
  });
  const messages = [];
  for await (const item of stream.messages) {
    messages.push(item);
  }

  assert.equal(stream.chat.chatId, String(CHAT_ID));
  assert.deepEqual(
    fake.peerCalls,
    [{ peer: CHAT_ID, refresh: false }],
    "a marked numeric Telegram ID must reach mtcute as a number",
  );
  assert.deepEqual(
    fake.historyCalls.map(({ params }) => params),
    [
      {
        limit: 2,
        offset: { id: 10, date: 0 },
        minId: 3,
        maxId: 20,
      },
      {
        limit: 1,
        offset: { id: 8, date: 1_722_336_000 },
        minId: 3,
        maxId: 20,
      },
    ],
  );
  assert.deepEqual(messages[0], {
    messageId: 9,
    text: "message 9",
    sentAt: "2026-07-30T10:20:30.000Z",
    editedAt: "2026-07-30T10:21:00.000Z",
    sender: {
      id: "42",
      kind: "user",
      displayName: "Alice Example",
      username: "alice",
    },
    replyToMessageId: 7,
    topicId: 5,
    isTopicMessage: true,
    isOutgoing: false,
    isService: false,
    isChannelPost: false,
  });
  assert.equal(messages[1]?.topicId, 6);
  assert.equal(messages[2]?.messageId, 7);
  assert.equal("date" in (messages[0] ?? {}), false);
  assert.equal(typeof messages[0]?.sentAt, "string");
});

test("history follows next after mtcute filters an otherwise partial page", async () => {
  const fake = new FakeMtcuteClient();
  const { service } = harness(fake, { historyPageSize: 3 });
  fake.historyHandler = async ({ params }) =>
    params.offset
      ? historyPage([message(8)])
      : historyPage(
          [message(9)],
          { id: 9, date: 1_722_336_000 },
        );

  const result = await service.getMessages({ limit: 3 });

  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [9, 8],
  );
  assert.equal(fake.historyCalls.length, 2);
  assert.deepEqual(fake.historyCalls[1]?.params.offset, {
    id: 9,
    date: 1_722_336_000,
  });
});

test("direct getMessages is bounded, chunked, and drops mtcute null slots", async () => {
  const fake = new FakeMtcuteClient();
  const { service } = harness(fake, { historyPageSize: 2 });
  fake.directMessagesHandler = async (_peer, ids) => {
    const requested = Array.isArray(ids) ? ids : [ids];
    return requested.map((id) =>
      id === 2 ? null : message(id),
    );
  };

  const result = await service.getMessages({
    limit: 3,
    ids: [1, 2, 3, 4],
  });

  assert.deepEqual(
    fake.directMessageCalls.map(({ ids }) => ids),
    [
      [1, 2],
      [3],
    ],
  );
  assert.deepEqual(
    result.messages.map(({ messageId }) => messageId),
    [1, 3],
  );
});

test("allowlist is enforced before and after peer resolution", async () => {
  const preResolveFake = new FakeMtcuteClient();
  let factoryCalls = 0;
  const preResolveFactory: MtcuteClientFactory = () => {
    factoryCalls += 1;
    return preResolveFake;
  };
  const preResolve = new MtcuteTelegramService(
    config({
      defaultChatId: "@allowed",
      allowedChatIds: ["@allowed", String(CHAT_ID)],
    }),
    preResolveFactory,
  );

  await assert.rejects(
    preResolve.resolveChat("@blocked"),
    errorWithCode("chat_not_allowed"),
  );
  assert.equal(factoryCalls, 0);

  const postResolveFake = new FakeMtcuteClient();
  postResolveFake.peer = {
    ...CHAT_PEER,
    id: -1_001_111_111_111,
  };
  const { service: postResolve } = harness(postResolveFake, {
    defaultChatId: "@allowed",
    allowedChatIds: ["@allowed"],
  });
  await assert.rejects(
    postResolve.resolveChat(),
    errorWithCode("chat_not_allowed"),
  );
  assert.equal(postResolveFake.peerCalls.length, 1);
});

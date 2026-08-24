import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message, ReactionType } from "grammy/types";
import { createNewsBriefTrigger } from "../src/bot/news-brief-trigger.js";
import { MessageStore } from "../src/store.js";
import type { SearXNGSearchResult } from "../src/bot/web-tools/searxng-client.js";
import type { FirecrawlCrawlResult } from "../src/bot/web-tools/firecrawl-client.js";

const PRIVILEGED_ID = "42";
const CHAT_ID = "-1001";

function emptySearxng(): { search: () => Promise<SearXNGSearchResult> } {
  return {
    search: async () => ({
      ok: true,
      status: "empty",
      query: "",
      results: [],
      truncated: false,
    }),
  };
}

function unreachableFirecrawl(): {
  crawl: () => Promise<FirecrawlCrawlResult>;
} {
  return {
    crawl: async () => {
      throw new Error("must not be called when no candidates were collected");
    },
  };
}

function fakeApi() {
  const reactions: Array<{ chatId: string; messageId: number; emoji: string }> =
    [];
  const sends: Array<{ chatId: string; text: string }> = [];
  let resolveSend: (() => void) | undefined;
  const sendCalled = new Promise<void>((resolve) => {
    resolveSend = resolve;
  });
  return {
    reactions,
    sends,
    sendCalled,
    api: {
      async setMessageReaction(
        chatId: string,
        messageId: number,
        reaction: readonly ReactionType[],
      ): Promise<true> {
        const first = reaction[0];
        const emoji = first?.type === "emoji" ? first.emoji : "";
        reactions.push({ chatId, messageId, emoji });
        return true;
      },
      async sendMessage(
        chatId: string,
        text: string,
      ): Promise<Message.TextMessage> {
        sends.push({ chatId, text });
        resolveSend?.();
        return {
          message_id: 1,
          date: 0,
          chat: { id: Number(chatId), type: "supergroup", title: "" },
          text,
        } as unknown as Message.TextMessage;
      },
    },
  };
}

function fakeRouter() {
  return {
    executeWithFallback: async (): Promise<never> => {
      throw new Error("must not be called when no candidates were collected");
    },
  };
}

function tempSeenStorePath(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "parilka-news-brief-trigger-"));
  return { path: join(dir, "seen.json"), dir };
}

test("matches the privileged sender's exact trigger phrase and acks with a reaction", async () => {
  const { api, reactions, sendCalled } = fakeApi();
  const { path, dir } = tempSeenStorePath();
  try {
    const trigger = createNewsBriefTrigger({
      privilegedUserId: PRIVILEGED_ID,
      api,
      store: new MessageStore(":memory:"),
      router: fakeRouter(),
      searxng: emptySearxng(),
      firecrawl: unreachableFirecrawl(),
      seenStorePath: path,
    });
    const handled = trigger.tryTrigger({
      chatId: CHAT_ID,
      messageId: 7,
      senderId: PRIVILEGED_ID,
      text: "Daily News-Brief",
    });
    assert.equal(handled, true);
    await sendCalled;
    assert.deepEqual(reactions, [
      { chatId: CHAT_ID, messageId: 7, emoji: "👀" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strips a leading bot mention before matching", async () => {
  const { api, sendCalled } = fakeApi();
  const { path, dir } = tempSeenStorePath();
  try {
    const trigger = createNewsBriefTrigger({
      privilegedUserId: PRIVILEGED_ID,
      api,
      store: new MessageStore(":memory:"),
      router: fakeRouter(),
      searxng: emptySearxng(),
      firecrawl: unreachableFirecrawl(),
      seenStorePath: path,
    });
    const handled = trigger.tryTrigger({
      chatId: CHAT_ID,
      messageId: 7,
      senderId: PRIVILEGED_ID,
      text: "@ParilkaBot daily news-brief",
    });
    assert.equal(handled, true);
    await sendCalled;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-privileged sender never triggers, even with the exact phrase", () => {
  const { api, reactions, sends } = fakeApi();
  const { path, dir } = tempSeenStorePath();
  try {
    const trigger = createNewsBriefTrigger({
      privilegedUserId: PRIVILEGED_ID,
      api,
      store: new MessageStore(":memory:"),
      router: fakeRouter(),
      searxng: emptySearxng(),
      firecrawl: unreachableFirecrawl(),
      seenStorePath: path,
    });
    const handled = trigger.tryTrigger({
      chatId: CHAT_ID,
      messageId: 7,
      senderId: "999",
      text: "daily news-brief",
    });
    assert.equal(handled, false);
    assert.equal(reactions.length, 0);
    assert.equal(sends.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unset sender id (anonymous/sender_chat) never triggers", () => {
  const { api } = fakeApi();
  const { path, dir } = tempSeenStorePath();
  try {
    const trigger = createNewsBriefTrigger({
      privilegedUserId: PRIVILEGED_ID,
      api,
      store: new MessageStore(":memory:"),
      router: fakeRouter(),
      searxng: emptySearxng(),
      firecrawl: unreachableFirecrawl(),
      seenStorePath: path,
    });
    assert.equal(
      trigger.tryTrigger({
        chatId: CHAT_ID,
        messageId: 7,
        senderId: undefined,
        text: "daily news-brief",
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the privileged sender saying anything else never triggers", () => {
  const { api, reactions } = fakeApi();
  const { path, dir } = tempSeenStorePath();
  try {
    const trigger = createNewsBriefTrigger({
      privilegedUserId: PRIVILEGED_ID,
      api,
      store: new MessageStore(":memory:"),
      router: fakeRouter(),
      searxng: emptySearxng(),
      firecrawl: unreachableFirecrawl(),
      seenStorePath: path,
    });
    assert.equal(
      trigger.tryTrigger({
        chatId: CHAT_ID,
        messageId: 7,
        senderId: PRIVILEGED_ID,
        text: "daily news brief please",
      }),
      false,
    );
    assert.equal(reactions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

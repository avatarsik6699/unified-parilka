import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamConsolidator } from "../src/dream/consolidator.js";
import type {
  DigestModelRouter,
} from "../src/digests.js";
import { MessageStore } from "../src/store.js";
import type { StoredMessage } from "../src/store.js";
import type { ResolvedModelCandidate } from "../src/providers/model-router.js";

const CHAT_ID = "-1003179772905";

function fixtureStore() {
  const directory = mkdtempSync(join(tmpdir(), "parilka-dream-"));
  const dbPath = join(directory, "shared.sqlite");
  const store = new MessageStore(dbPath);
  store.upsertChat({
    chatId: CHAT_ID,
    requested: CHAT_ID,
    title: "Dream Test",
    kind: "channel",
    isForum: false,
  });
  return {
    store,
    dbPath,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function fakeRouter(text: string): DigestModelRouter {
  return {
    async executeWithFallback<T>(
      _role: string,
      _attempt: (
        candidate: ResolvedModelCandidate,
        attemptNumber: number,
      ) => Promise<T>,
    ) {
      const candidate = {
        reference: "provider/model",
        providerId: "provider",
        modelId: "model",
        model: {} as ResolvedModelCandidate["model"],
        capabilities: { vision: false },
      };
      return {
        value: text as T,
        candidate,
        attempt: 1,
        failures: [],
      };
    },
  };
}

function invokingRouter(): DigestModelRouter {
  return {
    async executeWithFallback<T>(
      _role: string,
      attempt: (candidate: ResolvedModelCandidate, attemptNumber: number) => Promise<T>,
    ) {
      const candidate = {
        reference: "provider/model",
        providerId: "provider",
        modelId: "model",
        model: {} as ResolvedModelCandidate["model"],
        capabilities: { vision: false },
      };
      return {
        value: await attempt(candidate, 1),
        candidate,
        attempt: 1,
        failures: [],
      };
    },
  };
}

function seedMessages(store: MessageStore, count: number): number[] {
  const ids: number[] = [];
  const messages: StoredMessage[] = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push({
      chatId: CHAT_ID,
      messageId: index,
      date: `2026-07-${String(index).padStart(2, "0")}T12:00:00Z`,
      senderId: "user",
      senderName: "Alice",
      text: `message ${index}`,
    });
    ids.push(index);
  }
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Dream Test",
      kind: "channel",
      isForum: false,
    },
    messages,
  );
  return ids;
}

test("dream returns no_new_messages when threshold is not met", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 5);
    const consolidator = new DreamConsolidator({
      router: fakeRouter("new block"),
      maxOutputChars: 1_000,
    });
    const result = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });
    assert.equal(result.status, "no_new_messages");
    if (result.status === "no_new_messages") {
      assert.equal(result.pendingCount, 5);
    }
  } finally {
    cleanup();
  }
});

test("dream consolidates messages and advances watermark", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 12);
    const consolidator = new DreamConsolidator({
      router: fakeRouter("Alice was here."),
      maxOutputChars: 1_000,
    });
    const result = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.equal(result.messageCount, 12);
      assert.equal(result.newWatermark, 12);
      assert.equal(result.revision, 1);
      assert.equal(result.chars, 15);
    }
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "Alice was here.");
    assert.equal(memory?.lastConsolidatedMessageId, 12);
  } finally {
    cleanup();
  }
});

test("dream keeps its compact default output budget separate from day and week digests", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 10);
    let observedMaxOutputTokens: number | undefined;
    const consolidator = new DreamConsolidator({
      router: invokingRouter(),
      maxOutputChars: 1_000,
      generate: async ({ maxOutputTokens }) => {
        observedMaxOutputTokens = maxOutputTokens;
        return { text: "compact memory", finishReason: "stop" };
      },
    });

    const result = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });

    assert.equal(result.status, "success");
    assert.equal(observedMaxOutputTokens, 1_024);
  } finally {
    cleanup();
  }
});

test("dream clamps oversized output after retry", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 15);
    let calls = 0;
    const router: DigestModelRouter = {
      async executeWithFallback<T>(
        _role: string,
        _attempt: (candidate: ResolvedModelCandidate, attemptNumber: number) => Promise<T>,
      ) {
        const candidate = {
          reference: "provider/model",
          providerId: "provider",
          modelId: "model",
          model: {} as ResolvedModelCandidate["model"],
          capabilities: { vision: false },
        };
        calls += 1;
        const text =
          calls === 1 ? "a".repeat(600) : "short summary";
        return {
          value: text as T,
          candidate,
          attempt: calls,
          failures: [],
        };
      },
    };
    const consolidator = new DreamConsolidator({
      router,
      maxOutputChars: 500,
    });
    const result = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.equal(result.chars, 13);
    }
    assert.equal(calls, 2);
  } finally {
    cleanup();
  }
});

test("dream fail-closed preserves old block and watermark", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 5);
    store.upsertChatMemory({
      chatId: CHAT_ID,
      memoryText: "existing memory",
      lastConsolidatedMessageId: 2,
    });
    seedMessages(store, 10);
    const consolidator = new DreamConsolidator({
      router: fakeRouter("a".repeat(600)),
      maxOutputChars: 500,
    });
    const result = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 5,
      maxMessages: 20,
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.preservedRevision, 1);
    }
    const memory = store.getChatMemory(CHAT_ID);
    assert.equal(memory?.memoryText, "existing memory");
    assert.equal(memory?.lastConsolidatedMessageId, 2);
  } finally {
    cleanup();
  }
});

test("dream reports a candidate timeout without mutating memory", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 10);
    const consolidator = new DreamConsolidator({
      router: invokingRouter(),
      maxOutputChars: 1_000,
      totalTimeoutMs: 1_500,
      candidateTimeoutMs: 500,
      generate: ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const result = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error, "ETIMEDOUT");
      assert.equal(result.preservedRevision, 0);
    }
    assert.equal(store.getChatMemory(CHAT_ID), undefined);
  } finally {
    cleanup();
  }
});

test("dream retries one timed-out Qwen candidate within its total deadline", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 10);
    let calls = 0;
    const consolidator = new DreamConsolidator({
      router: invokingRouter(),
      maxOutputChars: 1_000,
      totalTimeoutMs: 1_500,
      candidateTimeoutMs: 500,
      generate: ({ signal }) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }
        return Promise.resolve({
          text: "recovered memory",
          finishReason: "stop",
        });
      },
    });

    const result = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });

    assert.equal(result.status, "success");
    assert.equal(calls, 2);
    assert.equal(store.getChatMemory(CHAT_ID)?.memoryText, "recovered memory");
  } finally {
    cleanup();
  }
});

test("dream is idempotent without new messages", async () => {
  const { store, cleanup } = fixtureStore();
  try {
    seedMessages(store, 12);
    const consolidator = new DreamConsolidator({
      router: fakeRouter("Alice was here."),
      maxOutputChars: 1_000,
    });
    const first = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });
    assert.equal(first.status, "success");
    const second = await consolidator.run(store, {
      chatId: CHAT_ID,
      threshold: 10,
      maxMessages: 20,
    });
    assert.equal(second.status, "no_new_messages");
  } finally {
    cleanup();
  }
});

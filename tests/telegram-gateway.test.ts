import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { normalizeError } from "../src/errors.js";
import { gramMessageToTelegramHistory } from "../src/telegram-client.js";
import {
  createTelegramGateway,
  mtcuteTransportConfigFromAppConfig,
} from "../src/telegram/gateway-factory.js";
import { telegramMessageToStored } from "../src/telegram/message-converter.js";
import { MessageStore } from "../src/store.js";
import { MtcuteTransportError } from "../src/telegram/mtcute-client.js";
import type {
  ChatInfo,
  TelegramGateway,
  TelegramHistoryMessage,
} from "../src/telegram/types.js";

const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "@parilka",
  title: "Parilka",
  username: "parilka",
  kind: "Channel",
  isForum: true,
};

test("provider-neutral message converter maps stable DTO fields only", () => {
  const message: TelegramHistoryMessage = {
    messageId: 42,
    text: "hello",
    sentAt: "2026-07-30T10:00:00+03:00",
    editedAt: "2026-07-30T11:00:00+03:00",
    sender: {
      id: "7",
      kind: "User",
      displayName: "Alice",
      username: "alice",
    },
    replyToMessageId: 40,
    topicId: 11,
    isTopicMessage: true,
    isOutgoing: false,
    isService: false,
    isChannelPost: true,
    metadata: {
      groupedId: "99",
      views: 123,
      forwards: 4,
    },
  };

  const stored = telegramMessageToStored(CHAT, message);

  assert.deepEqual(stored, {
    chatId: "-1001",
    messageId: 42,
    date: "2026-07-30T07:00:00.000Z",
    senderId: "7",
    senderName: "alice",
    text: "hello",
    replyToMessageId: 40,
    topicId: 11,
    rawJson: JSON.stringify({
      groupedId: "99",
      views: 123,
      forwards: 4,
      post: true,
    }),
  });
  assert.equal(
    telegramMessageToStored(CHAT, { ...message, messageId: 0 }),
    undefined,
  );
});

test("rich reconciliation retains an existing canonical plain-text projection", () => {
  const store = new MessageStore(":memory:");
  const canonical: TelegramHistoryMessage = {
    messageId: 42,
    text: "Example Domain",
    sentAt: "2026-07-30T10:00:00.000Z",
    isTopicMessage: false,
    isOutgoing: true,
    isService: false,
    isChannelPost: false,
  };
  const richPlaceholder: TelegramHistoryMessage = {
    ...canonical,
    text: "",
    textAvailable: false,
  };
  const initial = telegramMessageToStored(CHAT, canonical);
  const reconciled = telegramMessageToStored(CHAT, richPlaceholder);
  assert.ok(initial);
  assert.ok(reconciled);

  store.upsertMessages(CHAT, [initial]);
  store.upsertMessages(CHAT, [reconciled]);

  const [stored] = store.getHistory({
    chatId: CHAT.chatId,
    limit: 1,
    order: "asc",
  });
  assert.equal(stored?.text, "Example Domain");
});

test("an ordinary empty-text edit still replaces cached content", () => {
  const store = new MessageStore(":memory:");
  const original: TelegramHistoryMessage = {
    messageId: 42,
    text: "stale content",
    isTopicMessage: false,
    isOutgoing: false,
    isService: false,
    isChannelPost: false,
  };
  const edited = { ...original, text: "" };
  const initial = telegramMessageToStored(CHAT, original);
  const replacement = telegramMessageToStored(CHAT, edited);
  assert.ok(initial);
  assert.ok(replacement);

  store.upsertMessages(CHAT, [initial]);
  store.upsertMessages(CHAT, [replacement]);

  const [stored] = store.getHistory({
    chatId: CHAT.chatId,
    limit: 1,
    order: "asc",
  });
  assert.equal(stored?.text, "");
});

test("GramJS adapter normalizes transport classes before they reach the application", () => {
  const message = gramMessageToTelegramHistory({
    id: 42,
    className: "Message",
    message: "hello",
    date: 1_700_000_000,
    editDate: 1_700_000_100,
    senderId: 7n,
    sender: {
      className: "User",
      firstName: "Alice",
      lastName: "Example",
      username: "alice",
    },
    replyTo: {
      replyToMsgId: 40,
      topMsgId: 11,
      forumTopic: true,
    },
    groupedId: 99n,
    views: 123,
    forwards: 4,
    out: true,
    post: true,
  });

  assert.deepEqual(message, {
    messageId: 42,
    text: "hello",
    sentAt: "2023-11-14T22:13:20.000Z",
    editedAt: "2023-11-14T22:15:00.000Z",
    sender: {
      id: "7",
      kind: "User",
      displayName: "Alice Example",
      username: "alice",
    },
    replyToMessageId: 40,
    topicId: 11,
    isTopicMessage: true,
    isOutgoing: true,
    isService: false,
    isChannelPost: true,
    metadata: {
      groupedId: "99",
      views: 123,
      forwards: 4,
    },
  });
  assert.equal(
    gramMessageToTelegramHistory({ id: 42, className: "MessageEmpty" }),
    undefined,
  );
});

test("mtcute transport errors preserve provider-neutral tool categories", () => {
  const normalized = normalizeError(
    new MtcuteTransportError(
      "chat_not_allowed",
      "permission",
      false,
      "Chat is not allowlisted.",
    ),
  );

  assert.deepEqual(normalized, {
    category: "permission",
    retryable: false,
    message: "Chat is not allowlisted.",
  });
});

test("mtcute factory imports and closes bootstrap before service construction", async () => {
  const events: string[] = [];
  const appConfig = config();
  const expectedGateway = fakeGateway();
  let bootstrapAuthPath: string | undefined;
  let serviceAuthPath: string | undefined;
  let importedSession: string | undefined;
  const bootstrap = bootstrapClient(async () => {
    events.push("bootstrap-destroy");
  });

  const gateway = await createTelegramGateway(appConfig, {
    createMtcuteBootstrapClient: (transport) => {
      events.push("bootstrap-create");
      bootstrapAuthPath = transport.authStoragePath;
      return bootstrap;
    },
    importGramjsSession: async (target, session) => {
      assert.equal(target, bootstrap);
      importedSession = session;
      events.push("session-import");
      return { status: "imported", forced: false };
    },
    createMtcuteGateway: (transport) => {
      events.push("service-create");
      serviceAuthPath = transport.authStoragePath;
      return expectedGateway;
    },
  });

  assert.equal(gateway, expectedGateway);
  assert.equal(importedSession, "gramjs-session-secret");
  assert.equal(bootstrapAuthPath, appConfig.telegram.mtcute.authStoragePath);
  assert.equal(serviceAuthPath, bootstrapAuthPath);
  assert.deepEqual(events, [
    "bootstrap-create",
    "session-import",
    "bootstrap-destroy",
    "service-create",
  ]);
});

test("factory skips migration for GramJS and for mtcute without a source session", async () => {
  const gramjs = fakeGateway();
  let bootstrapCalls = 0;
  let mtcuteCalls = 0;
  const gramjsConfig = config("gramjs");
  const selectedGramjs = await createTelegramGateway(gramjsConfig, {
    createGramjsGateway: () => gramjs,
    createMtcuteBootstrapClient: () => {
      bootstrapCalls += 1;
      return bootstrapClient();
    },
    createMtcuteGateway: () => {
      mtcuteCalls += 1;
      return fakeGateway();
    },
  });
  assert.equal(selectedGramjs, gramjs);
  assert.equal(bootstrapCalls, 0);
  assert.equal(mtcuteCalls, 0);

  const noSessionConfig = config();
  noSessionConfig.telegram.session = "";
  const mtcute = fakeGateway();
  const selectedMtcute = await createTelegramGateway(noSessionConfig, {
    createMtcuteBootstrapClient: () => {
      bootstrapCalls += 1;
      return bootstrapClient();
    },
    createMtcuteGateway: () => {
      mtcuteCalls += 1;
      return mtcute;
    },
  });
  assert.equal(selectedMtcute, mtcute);
  assert.equal(bootstrapCalls, 0);
  assert.equal(mtcuteCalls, 1);
});

test("failed session migration destroys bootstrap and never constructs service", async () => {
  let destroyCalls = 0;
  let serviceCalls = 0;
  const expected = new Error("migration failed without secret material");

  await assert.rejects(
    () =>
      createTelegramGateway(config(), {
        createMtcuteBootstrapClient: () =>
          bootstrapClient(async () => {
            destroyCalls += 1;
          }),
        importGramjsSession: async () => {
          throw expected;
        },
        createMtcuteGateway: () => {
          serviceCalls += 1;
          return fakeGateway();
        },
      }),
    (error) => error === expected,
  );
  assert.equal(destroyCalls, 1);
  assert.equal(serviceCalls, 0);
});

test("factory maps every bounded mtcute setting", () => {
  const appConfig = config();
  const transport = mtcuteTransportConfigFromAppConfig(appConfig);

  assert.deepEqual(transport, {
    apiId: 123,
    apiHash: "api-hash-secret",
    authStoragePath: "/tmp/parilka-mtcute-auth.sqlite",
    applicationDbPath: "/tmp/parilka-messages.sqlite",
    defaultChatId: "-1001",
    allowedChatIds: ["-1001"],
    requireAllowlistedChat: true,
    historyPageSize: 100,
    maxHistoryMessages: 1_000_000,
    connectionMaxAttempts: 5,
    connectionTimeoutMs: 30_000,
    connectionRetryInitialMs: 250,
    connectionRetryMaxMs: 4_000,
    requestTimeoutMs: 120_000,
    requestMaxRetries: 2,
    requestRetryDelayMs: 1_000,
    floodWaitMaxMs: 10_000,
  });
});

function fakeGateway(): TelegramGateway {
  return {
    isConfigured: true,
    assertChatAllowed: () => undefined,
    resolveChat: async () => ({ info: CHAT }),
    getMessages: async () => ({ chat: CHAT, messages: [] }),
    iterateMessages: async () => ({
      chat: CHAT,
      messages: (async function* () {})(),
    }),
    sendMessage: async () => ({ id: 1, chat: CHAT }),
    disconnect: async () => undefined,
    destroy: async () => undefined,
  };
}

function bootstrapClient(onDestroy: () => Promise<void> = async () => undefined) {
  return {
    prepare: async () => undefined,
    importSession: async () => undefined,
    mt: {
      storage: {
        dcs: {
          fetch: async () => null,
        },
        provider: {
          authKeys: {
            get: async () => null,
          },
        },
      },
    },
    destroy: onDestroy,
  };
}

function config(transport: "mtcute" | "gramjs" = "mtcute"): AppConfig {
  return {
    telegram: {
      apiId: 123,
      apiHash: "api-hash-secret",
      session: "gramjs-session-secret",
      phone: "",
      defaultChatId: "-1001",
      allowedChatIds: ["-1001"],
      requireAllowlistedChat: true,
      connectionRetries: 5,
      transport,
      mtcute: {
        authStoragePath: "/tmp/parilka-mtcute-auth.sqlite",
        historyPageSize: 100,
        maxHistoryMessages: 1_000_000,
        connectionMaxAttempts: 5,
        connectionTimeoutMs: 30_000,
        connectionRetryInitialMs: 250,
        connectionRetryMaxMs: 4_000,
        requestTimeoutMs: 120_000,
        requestMaxRetries: 2,
        requestRetryDelayMs: 1_000,
        floodWaitMaxMs: 10_000,
      },
    },
    storage: {
      dbPath: "/tmp/parilka-messages.sqlite",
    },
    safety: {
      sendEnabled: false,
      dryRunDefault: true,
      maxSendChars: 4096,
      liveSendApprovalTtlMs: 300_000,
      liveSendApprovalBypass: false,
    },
    sync: {
      batchSize: 100,
      maxSyncLimit: 500_000,
      floodWaitMaxSleepSec: 10,
      historyWaitTimeSec: 1,
      historyOperationTimeoutMs: 120_000,
      intervalMs: 60_000,
      recentLimit: 300,
      backfillLimit: 1_000,
      transientBackoffInitialMs: 5_000,
      transientBackoffMaxMs: 300_000,
    },
    embeddings: {
      enabled: false,
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimensions: 256,
      apiBatchSize: 64,
      requestTimeoutMs: 60_000,
      maxRetries: 2,
      retryInitialMs: 1_000,
      retryMaxMs: 30_000,
      tickIntervalMs: 60_000,
      tickBudgetMs: 30_000,
      chunkMessages: 12,
      chunkOverlapMessages: 0,
      chunkMaxChars: 1_600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1_000,
      maxCharsPerRun: 500_000,
      vectorCandidateLimit: 20_000,
      searchLimit: 12,
    },
    throttle: {
      userCooldownMs: 20_000,
      maxPendingPerUserPerChat: 1,
      maxQueuePerChat: 25,
      maxAgeMs: 120_000,
      globalConcurrency: 2,
      maxRunningPerChat: 1,
    },
  };
}

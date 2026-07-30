import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MtcuteTelegramService,
  type MtcuteClientFactory,
} from "../src/telegram/mtcute-client.js";
import { createOwnerManagedNodePlatform } from "../src/telegram/mtcute/client.js";
import {
  importGramjsStringSession,
  MtcuteSessionImportError,
} from "../src/telegram/session-import.js";
import {
  CHAT_ID,
  FakeMtcuteClient,
  FakeSessionTarget,
  config,
  errorWithCode,
  harness,
  validGramjsStringSession,
  validTelethonStringSession,
} from "./support/mtcute-client.js";

test("owner-managed mtcute platform leaves process signals to the daemon", () => {
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  const beforeExitListeners = process.listenerCount("beforeExit");
  const platform = createOwnerManagedNodePlatform();
  const cancel = platform.beforeExit(() => undefined);

  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
  assert.equal(
    process.listenerCount("beforeExit"),
    beforeExitListeners + 1,
  );

  cancel();
  assert.equal(
    process.listenerCount("beforeExit"),
    beforeExitListeners,
  );
});

test("one process owner shares creation and has idempotent lifecycle", async () => {
  const fake = new FakeMtcuteClient();
  let factoryCalls = 0;
  const factory: MtcuteClientFactory = async () => {
    factoryCalls += 1;
    await Promise.resolve();
    return fake;
  };
  const first = new MtcuteTelegramService(config(), factory);
  const second = new MtcuteTelegramService(config(), factory);

  const clients = await Promise.all([
    first.getClient(),
    first.getClient(),
    second.getClient(),
  ]);
  assert.ok(clients.every((client) => client === fake));
  assert.equal(factoryCalls, 1);
  assert.equal(fake.connectCalls, 1);

  await Promise.all([first.disconnect(), second.disconnect()]);
  assert.equal(fake.disconnectCalls, 1);
  assert.equal(await second.getClient(), fake);
  assert.equal(factoryCalls, 1);
  assert.equal(fake.connectCalls, 2);

  await Promise.all([first.destroy(), second.destroy()]);
  assert.equal(fake.destroyCalls, 1);
  await assert.rejects(
    second.getClient(),
    errorWithCode("client_destroyed"),
  );
  assert.equal(factoryCalls, 1);
});

test("a hung connection attempt is bounded and the client remains destroyable", async () => {
  const fake = new FakeMtcuteClient();
  fake.connect = async () =>
    new Promise<void>(() => {
      // Deliberately never settles: the transport deadline must win.
    });
  const { service } = harness(fake, {
    connectionTimeoutMs: 100,
  });

  await assert.rejects(
    service.getClient(),
    errorWithCode("connection_failed"),
  );
  assert.equal(fake.disconnectCalls, 1);
  await service.destroy();
  assert.equal(fake.destroyCalls, 1);
});

test("send maps parse mode, topic, reply, preview, and silent options", async () => {
  const fake = new FakeMtcuteClient();
  const { service } = harness(fake);

  const sent = await service.sendMessage({
    text: "<b>Hello</b>\nworld",
    replyToMessageId: 77,
    topicId: 55,
    parseMode: "html",
    linkPreview: false,
    silent: true,
  });

  assert.equal(sent.id, 999);
  assert.deepEqual(
    fake.directMessageCalls,
    [{ peer: CHAT_ID, ids: 77 }],
  );
  assert.equal(typeof fake.sendCalls[0]?.text, "object");
  assert.equal(
    typeof fake.sendCalls[0]?.text === "string"
      ? undefined
      : fake.sendCalls[0]?.text.text,
    "Hello\nworld",
  );
  assert.deepEqual(fake.sendCalls[0]?.params, {
    replyTo: 77,
    threadId: 55,
    silent: true,
    disableWebPreview: true,
  });

  await service.sendMessage({
    text: "**Hello**",
    parseMode: "markdown",
    linkPreview: true,
  });
  assert.equal(typeof fake.sendCalls[1]?.text, "object");
  assert.equal(
    typeof fake.sendCalls[1]?.text === "string"
      ? undefined
      : fake.sendCalls[1]?.text.text,
    "Hello",
  );
  assert.deepEqual(fake.sendCalls[1]?.params, {
    disableWebPreview: false,
  });

  await service.sendMessage({
    text: "**literal**",
    parseMode: "none",
  });
  assert.equal(fake.sendCalls[2]?.text, "**literal**");
});

test("send performs its own exact reply lookup before live send", async () => {
  const fake = new FakeMtcuteClient();
  fake.directMessagesHandler = async () => [null];
  const { service } = harness(fake);

  await assert.rejects(
    service.sendMessage({
      text: "reply",
      replyToMessageId: 404,
    }),
    errorWithCode("reply_target_not_found"),
  );
  assert.equal(fake.sendCalls.length, 0);
});

test("bounded parameters and separate auth database are validated", () => {
  assert.throws(
    () =>
      new MtcuteTelegramService(
        config({
          applicationDbPath:
            "/tmp/parilka-mtcute-test/auth.sqlite",
          authStoragePath:
            "/tmp/parilka-mtcute-test/auth.sqlite",
        }),
        () => new FakeMtcuteClient(),
      ),
    errorWithCode("invalid_config"),
  );
  assert.throws(
    () =>
      new MtcuteTelegramService(
        config({ historyPageSize: 101 }),
        () => new FakeMtcuteClient(),
      ),
    errorWithCode("invalid_config"),
  );
  assert.throws(
    () =>
      new MtcuteTelegramService(
        config({
          connectionRetryInitialMs: 2_000,
          connectionRetryMaxMs: 1_000,
        }),
        () => new FakeMtcuteClient(),
      ),
    errorWithCode("invalid_config"),
  );
  assert.throws(
    () =>
      new MtcuteTelegramService(
        config({ allowedChatIds: [] }),
        () => new FakeMtcuteClient(),
      ),
    errorWithCode("invalid_config"),
  );
});

test("GramJS session import is idempotent and never returns the secret", async () => {
  const target = new FakeSessionTarget();
  const sourceSecret = validGramjsStringSession();

  const first = await importGramjsStringSession(
    target,
    sourceSecret,
  );
  assert.deepEqual(first, {
    status: "imported",
    forced: false,
  });
  assert.equal(target.imports.length, 1);
  assert.equal(target.imports[0]?.authKeyLength, 256);
  assert.equal(
    JSON.stringify(first).includes(sourceSecret),
    false,
  );

  const second = await importGramjsStringSession(
    target,
    "not-even-a-valid-session",
  );
  assert.deepEqual(second, {
    status: "skipped",
    reason: "already_authorized",
    forced: false,
  });
  assert.equal(
    target.imports.length,
    1,
    "an authorized target must be checked before converting the source",
  );
  assert.equal(
    JSON.stringify(second).includes(sourceSecret),
    false,
  );

  const forced = await importGramjsStringSession(
    target,
    sourceSecret,
    { force: true },
  );
  assert.deepEqual(forced, {
    status: "imported",
    forced: true,
  });
  assert.equal(target.imports.length, 2);
  assert.equal(target.imports[1]?.force, true);

  const legacyTarget = new FakeSessionTarget();
  const legacySecret = validTelethonStringSession();
  const legacy = await importGramjsStringSession(
    legacyTarget,
    legacySecret,
  );
  assert.deepEqual(legacy, {
    status: "imported",
    forced: false,
  });
  assert.equal(legacyTarget.imports[0]?.authKeyLength, 256);
  assert.equal(JSON.stringify(legacy).includes(legacySecret), false);

  const corruptTarget = new FakeSessionTarget(true, 32);
  await assert.rejects(
    importGramjsStringSession(corruptTarget, sourceSecret),
    (error: unknown) =>
      error instanceof MtcuteSessionImportError &&
      error.code === "storage_inspection_failed",
  );
  const repaired = await importGramjsStringSession(
    corruptTarget,
    sourceSecret,
    { force: true },
  );
  assert.deepEqual(repaired, {
    status: "imported",
    forced: true,
  });
  assert.equal(corruptTarget.imports.length, 1);
});

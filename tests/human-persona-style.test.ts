import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runStyleProfileGeneration } from "../src/human-persona-style.js";
import type {
  StyleProfileCompileRequest,
  StyleProfileCompileResult,
  StyleProfileCurateRequest,
  StyleProfileCurateResult,
  StyleProfilePort,
} from "../src/human-persona-style.js";
import { MessageStore } from "../src/store.js";

class FakeStyleProfilePort implements StyleProfilePort {
  compileCalls = 0;
  curateCalls = 0;

  async compileProfile(
    _request: StyleProfileCompileRequest,
  ): Promise<StyleProfileCompileResult> {
    this.compileCalls += 1;
    return {
      profileText: "коротко, по делу",
      model: "fake-model",
      providerId: "fake-provider",
    };
  }

  async curateExamples(
    request: StyleProfileCurateRequest,
  ): Promise<StyleProfileCurateResult> {
    this.curateCalls += 1;
    return {
      selectedMessageIds: request.candidates.map(
        (message) => message.messageId,
      ),
      model: "fake-model",
      providerId: "fake-provider",
    };
  }
}

function makeStore(t: TestContext): MessageStore {
  const dir = mkdtempSync(join(tmpdir(), "human-persona-style-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new MessageStore(join(dir, "messages.sqlite"));
  t.after(() => store.close());
  return store;
}

function seedTargetMessages(store: MessageStore): void {
  store.upsertMessages(
    { chatId: "c1", requested: "c1", kind: "Cached", isForum: false },
    [
      {
        id: 0,
        chatId: "c1",
        messageId: 1,
        text: "ну ок го",
        senderId: "u1",
        senderName: "Вова",
        date: "2026-01-01T00:00:00Z",
      },
      {
        id: 0,
        chatId: "c1",
        messageId: 2,
        text: "не, давай завтра",
        senderId: "u1",
        senderName: "Вова",
        date: "2026-01-01T00:01:00Z",
      },
      {
        id: 0,
        chatId: "c1",
        messageId: 3,
        text: "сообщение другого участника",
        senderId: "u2",
        senderName: "Другой",
        date: "2026-01-01T00:02:00Z",
      },
    ],
  );
}

test("dry-run reports unchanged and never calls the port", async (t) => {
  const store = makeStore(t);
  seedTargetMessages(store);
  const port = new FakeStyleProfilePort();

  const report = await runStyleProfileGeneration({
    store,
    personaId: "p1",
    chatId: "c1",
    targetUserKey: "u1",
    consentBasis: "confirmed_by_owner",
    apply: false,
    port,
  });

  assert.equal(report.status, "unchanged");
  assert.equal(report.mode, "dry_run");
  assert.equal(port.compileCalls, 0);
  assert.equal(port.curateCalls, 0);
  assert.equal(store.getHumanPersonaStyleProfile("p1", "u1"), undefined);
});

test("apply generates a profile from only the target's own messages, verbatim examples", async (t) => {
  const store = makeStore(t);
  seedTargetMessages(store);
  const port = new FakeStyleProfilePort();

  const report = await runStyleProfileGeneration({
    store,
    personaId: "p1",
    chatId: "c1",
    targetUserKey: "u1",
    consentBasis: "confirmed_by_owner",
    apply: true,
    port,
  });

  assert.equal(report.status, "generated");
  assert.equal(report.sourceCount, 2);
  assert.equal(port.compileCalls, 1);
  assert.equal(port.curateCalls, 1);

  const stored = store.getHumanPersonaStyleProfile("p1", "u1");
  assert.ok(stored);
  assert.equal(stored.profileText, "коротко, по делу");
  assert.equal(stored.consentBasis, "confirmed_by_owner");
  assert.deepEqual([...stored.exampleMessages].sort(), [
    "не, давай завтра",
    "ну ок го",
  ]);
});

test("re-running apply with an unchanged source hash is idempotent and skips the port", async (t) => {
  const store = makeStore(t);
  seedTargetMessages(store);
  const port = new FakeStyleProfilePort();

  await runStyleProfileGeneration({
    store,
    personaId: "p1",
    chatId: "c1",
    targetUserKey: "u1",
    consentBasis: "confirmed_by_owner",
    apply: true,
    port,
  });
  const second = await runStyleProfileGeneration({
    store,
    personaId: "p1",
    chatId: "c1",
    targetUserKey: "u1",
    consentBasis: "confirmed_by_owner",
    apply: true,
    port,
  });

  assert.equal(second.status, "unchanged");
  assert.equal(port.compileCalls, 1);
  assert.equal(port.curateCalls, 1);
});

test("a target with no messages in the chat is reported without calling the port", async (t) => {
  const store = makeStore(t);
  seedTargetMessages(store);
  const port = new FakeStyleProfilePort();

  const report = await runStyleProfileGeneration({
    store,
    personaId: "p1",
    chatId: "c1",
    targetUserKey: "does-not-exist",
    consentBasis: "confirmed_by_owner",
    apply: true,
    port,
  });

  assert.equal(report.status, "no_source_messages");
  assert.equal(port.compileCalls, 0);
  assert.equal(
    store.getHumanPersonaStyleProfile("p1", "does-not-exist"),
    undefined,
  );
});

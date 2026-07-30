import assert from "node:assert/strict";
import {
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MessageStore } from "../src/store.js";
import { emptyMessageChanges } from "./support/state-import-assertions.js";
import {
  CHAT_ID,
  IMPORT_SCRIPT,
  createLegacySource,
  fileHash,
  importFailureState,
  plainRows,
  quickCheck,
  runScript,
  scalar,
  withTempDirectory,
} from "./support/state-scripts.js";

test("python-state import rejects non-empty canonical conflicts without overwriting target state", () => {
  withTempDirectory((directory) => {
    const sourcePath = join(directory, "legacy-conflict.sqlite");
    const targetPath = join(directory, "unified-conflict.sqlite");
    createLegacySource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source
      .prepare(
        `UPDATE live_msg
         SET reply_to = 77, is_bot = 1
         WHERE message_id = 101`,
      )
      .run();
    source.close();

    const store = new MessageStore(targetPath);
    store.upsertMessages(
      {
        chatId: CHAT_ID,
        requested: CHAT_ID,
        kind: "Test",
      },
      [
        {
          chatId: CHAT_ID,
          messageId: 101,
          date: "2001-01-01T00:00:00.000Z",
          senderId: "99",
          senderName: "Canonical sender",
          text: "canonical text",
          replyToMessageId: 88,
          topicId: 888,
          rawJson: '{"canonical":"raw"}',
          deletedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    );
    store.close();
    const before = new DatabaseSync(targetPath);
    before
      .prepare(
        `UPDATE messages
         SET updated_at = '2000-01-01 00:00:00'
         WHERE chat_id = ? AND message_id = 101`,
      )
      .run(CHAT_ID);
    before.close();

    const rejected = runScript(IMPORT_SCRIPT, [
      "--source",
      sourcePath,
      "--target",
      targetPath,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.notEqual(rejected.status, 0);
    const failure = JSON.parse(rejected.stderr) as {
      phase: string;
      targetMayBePartiallyModified: boolean;
      messageMerge: unknown;
      error: { code: string };
    };
    assert.equal(failure.phase, "apply");
    assert.equal(failure.targetMayBePartiallyModified, true);
    assert.equal(failure.error.code, "canonical_message_conflict");
    assert.deepEqual(failure.messageMerge, {
      inserts: 0,
      overlaps: 1,
      fills: emptyMessageChanges(),
      conflicts: {
        messages: 1,
        total: 4,
        date: 0,
        senderId: 1,
        senderName: 1,
        text: 1,
        replyToMessageId: 1,
      },
    });
    assert.doesNotMatch(
      rejected.stderr,
      /Canonical sender|canonical text|legacy hello/u,
    );

    const target = new DatabaseSync(targetPath, { readOnly: true });
    try {
      assert.deepEqual(
        plainRows(
          target
            .prepare(
              `SELECT date, sender_id, sender_name, text,
                      reply_to_message_id, topic_id, raw_json, deleted_at,
                      updated_at
               FROM messages
               WHERE chat_id = ? AND message_id = 101`,
            )
            .all(CHAT_ID),
        ),
        [
          {
            date: "2001-01-01T00:00:00.000Z",
            sender_id: "99",
            sender_name: "Canonical sender",
            text: "canonical text",
            reply_to_message_id: 88,
            topic_id: 888,
            raw_json: '{"canonical":"raw"}',
            deleted_at: "2026-07-29T00:00:00.000Z",
            updated_at: "2000-01-01 00:00:00",
          },
        ],
      );
      assert.equal(scalar(target, "SELECT count(*) FROM chat_day_digests"), 0);
      assert.equal(
        scalar(target, "SELECT count(*) FROM chat_digest_rollups"),
        0,
      );
      assert.deepEqual(quickCheck(target), ["ok"]);
    } finally {
      target.close();
    }
  });
});

test("python-state import still rejects a human message date conflict", () => {
  withTempDirectory((directory) => {
    const sourcePath = join(directory, "legacy-human-date.sqlite");
    const targetPath = join(directory, "unified-human-date.sqlite");
    createLegacySource(sourcePath);

    const store = new MessageStore(targetPath);
    store.upsertMessages(
      {
        chatId: CHAT_ID,
        requested: CHAT_ID,
        kind: "Test",
      },
      [
        {
          chatId: CHAT_ID,
          messageId: 101,
          date: "2001-01-01T00:00:00.000Z",
          senderId: "42",
          senderName: "Alice",
          text: "legacy hello",
          rawJson: '{"canonical":"raw"}',
        },
      ],
    );
    store.close();

    const rejected = runScript(IMPORT_SCRIPT, [
      "--source",
      sourcePath,
      "--target",
      targetPath,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.notEqual(rejected.status, 0);
    const failure = JSON.parse(rejected.stderr) as {
      messageMerge: unknown;
      error: { code: string };
    };
    assert.equal(failure.error.code, "canonical_message_conflict");
    assert.deepEqual(failure.messageMerge, {
      inserts: 0,
      overlaps: 1,
      fills: emptyMessageChanges(),
      conflicts: {
        ...emptyMessageChanges(),
        messages: 1,
        total: 1,
        date: 1,
      },
    });
  });
});

test("python-state import rejects corrupt or unrelated sources and an unrelated existing target before writing", () => {
  withTempDirectory((directory) => {
    const corruptSource = join(directory, "corrupt.sqlite");
    const corruptTarget = join(directory, "must-not-exist.sqlite");
    writeFileSync(corruptSource, "this is not sqlite");
    const corrupt = runScript(IMPORT_SCRIPT, [
      "--source",
      corruptSource,
      "--target",
      corruptTarget,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.notEqual(corrupt.status, 0);
    assert.equal(existsSync(corruptTarget), false);

    const unrelatedSource = join(directory, "unrelated-source.sqlite");
    const unrelated = new DatabaseSync(unrelatedSource);
    unrelated.exec("CREATE TABLE unrelated (value TEXT)");
    unrelated.close();
    const unrelatedTarget = join(directory, "also-must-not-exist.sqlite");
    const rejectedSource = runScript(IMPORT_SCRIPT, [
      "--source",
      unrelatedSource,
      "--target",
      unrelatedTarget,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.notEqual(rejectedSource.status, 0);
    assert.match(rejectedSource.stderr, /required table live_msg is missing/u);
    assert.deepEqual(importFailureState(rejectedSource.stderr), {
      phase: "inspect",
      targetMayBePartiallyModified: false,
    });
    assert.equal(existsSync(unrelatedTarget), false);

    const validSource = join(directory, "valid-source.sqlite");
    const wrongTarget = join(directory, "wrong-target.sqlite");
    createLegacySource(validSource);
    const wrong = new DatabaseSync(wrongTarget);
    wrong.exec(
      "CREATE TABLE do_not_touch (id INTEGER PRIMARY KEY, value TEXT)",
    );
    wrong
      .prepare("INSERT INTO do_not_touch (id, value) VALUES (1, 'sentinel')")
      .run();
    wrong.close();
    const beforeHash = fileHash(wrongTarget);
    const rejectedTarget = runScript(IMPORT_SCRIPT, [
      "--source",
      validSource,
      "--target",
      wrongTarget,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.notEqual(rejectedTarget.status, 0);
    assert.match(rejectedTarget.stderr, /unsupported|not a telegram-parilka/u);
    assert.deepEqual(importFailureState(rejectedTarget.stderr), {
      phase: "validate",
      targetMayBePartiallyModified: false,
    });
    assert.equal(fileHash(wrongTarget), beforeHash);

    const malformedSource = join(directory, "malformed-source.sqlite");
    const malformedTarget = join(directory, "malformed-target.sqlite");
    createLegacySource(malformedSource);
    const malformed = new DatabaseSync(malformedSource);
    malformed
      .prepare(
        "UPDATE digest_day SET day = '2026-02-30' WHERE day = '2026-01-31'",
      )
      .run();
    malformed.close();
    const rejectedRow = runScript(IMPORT_SCRIPT, [
      "--source",
      malformedSource,
      "--target",
      malformedTarget,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.notEqual(rejectedRow.status, 0);
    assert.match(rejectedRow.stderr, /real Gregorian calendar day/u);
    assert.equal(existsSync(malformedTarget), false);

    const partialSource = join(directory, "partial-source.sqlite");
    const partialTarget = join(directory, "partial-target.sqlite");
    createLegacySource(partialSource);
    const source = new DatabaseSync(partialSource);
    const insert = source.prepare(
      `INSERT INTO live_msg (
         message_id, chat_id, date_unix, sender_id, sender_name,
         text, reply_to, edited_at, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    );
    for (let messageId = 102; messageId <= 601; messageId += 1) {
      insert.run(
        messageId,
        Number(CHAT_ID),
        1_769_644_800 + messageId,
        messageId,
        "migration-test",
        `message ${messageId}`,
        JSON.stringify({ message_id: messageId }),
      );
    }
    source.close();
    const targetStore = new MessageStore(partialTarget);
    targetStore.close();
    const target = new DatabaseSync(partialTarget);
    target.exec(`
      CREATE TRIGGER reject_last_import_message
      BEFORE INSERT ON messages
      WHEN NEW.message_id = 601
      BEGIN
        SELECT RAISE(ABORT, 'planned apply failure');
      END;
    `);
    target.close();

    const partial = runScript(IMPORT_SCRIPT, [
      "--source",
      partialSource,
      "--target",
      partialTarget,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.notEqual(partial.status, 0);
    assert.deepEqual(importFailureState(partial.stderr), {
      phase: "apply",
      targetMayBePartiallyModified: true,
    });
    const partiallyImported = new DatabaseSync(partialTarget, {
      readOnly: true,
    });
    try {
      assert.equal(
        scalar(partiallyImported, "SELECT count(*) FROM messages"),
        500,
      );
    } finally {
      partiallyImported.close();
    }
  });
});

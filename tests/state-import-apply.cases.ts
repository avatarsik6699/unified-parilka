import assert from "node:assert/strict";
import {
  existsSync,
  statSync,
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
  insertSendOutbox,
  parseReport,
  plainRows,
  quickCheck,
  runScript,
  scalar,
  withTempDirectory,
} from "./support/state-scripts.js";

test("python-state import is dry-run by default, applies idempotently, and never imports the legacy outbox", () => {
  withTempDirectory((directory) => {
    const sourcePath = join(directory, "legacy.sqlite");
    const targetPath = join(directory, "unified.sqlite");
    createLegacySource(sourcePath);

    const dryRun = runScript(IMPORT_SCRIPT, [
      "--source",
      sourcePath,
      "--target",
      targetPath,
      "--chat-id",
      CHAT_ID,
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryReport = parseReport(dryRun.stdout);
    assert.equal(dryReport.mode, "dry_run");
    assert.deepEqual(dryReport.source.outboxByStatus, {
      lost_ack: 1,
      reserved: 1,
    });
    assert.equal(existsSync(targetPath), false);

    const firstApply = runScript(IMPORT_SCRIPT, [
      "--source",
      sourcePath,
      "--target",
      targetPath,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.equal(firstApply.status, 0, firstApply.stderr);
    const firstReport = parseReport(firstApply.stdout);
    assert.equal(firstReport.mode, "applied");
    assert.equal(firstReport.target.messagesBefore, 0);
    assert.equal(firstReport.target.messagesAfter, 1);
    assert.equal(statSync(targetPath).mode & 0o077, 0);

    let target = new DatabaseSync(targetPath);
    try {
      assert.equal(scalar(target, "SELECT count(*) FROM messages"), 1);
      assert.equal(
        scalar(target, "SELECT count(*) FROM chat_day_digests"),
        1,
      );
      assert.equal(
        scalar(target, "SELECT count(*) FROM chat_digest_rollups"),
        1,
      );
      assert.equal(
        String(
          target
            .prepare(
              `SELECT text
               FROM chat_digest_rollups
               WHERE chat_id = ? AND kind = 'month' AND period = '2026-01'`,
            )
            .get(CHAT_ID)?.text,
        ),
        "authoritative month rollup",
      );
      assert.equal(scalar(target, "SELECT count(*) FROM send_outbox"), 0);
      target
        .prepare(
          `UPDATE messages
           SET topic_id = 777, deleted_at = '2026-07-30T00:00:00.000Z'
           WHERE chat_id = ? AND message_id = 101`,
        )
        .run(CHAT_ID);
      target
        .prepare(
          `UPDATE chat_day_digests
           SET text = 'newer unified day digest'
           WHERE chat_id = ? AND day = '2026-01-31'`,
        )
        .run(CHAT_ID);
      target
        .prepare(
          `UPDATE chat_digest_rollups
           SET text = 'newer unified month rollup'
           WHERE chat_id = ? AND kind = 'month' AND period = '2026-01'`,
        )
        .run(CHAT_ID);
      insertSendOutbox(target, "existing-unknown", "sending");
    } finally {
      target.close();
    }

    const secondApply = runScript(IMPORT_SCRIPT, [
      "--source",
      sourcePath,
      "--target",
      targetPath,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.equal(secondApply.status, 0, secondApply.stderr);
    const secondReport = parseReport(secondApply.stdout);
    assert.equal(secondReport.target.messagesBefore, 1);
    assert.equal(secondReport.target.messagesAfter, 1);
    assert.equal(secondReport.target.dayDigestWrites, 0);
    assert.equal(secondReport.target.rollupWrites, 0);

    target = new DatabaseSync(targetPath, { readOnly: true });
    try {
      assert.equal(scalar(target, "SELECT count(*) FROM messages"), 1);
      assert.equal(
        scalar(target, "SELECT count(*) FROM chat_day_digests"),
        1,
      );
      assert.equal(
        scalar(target, "SELECT count(*) FROM chat_digest_rollups"),
        1,
      );
      assert.deepEqual(
        plainRows(
          target
            .prepare(
              `SELECT topic_id, deleted_at
               FROM messages
               WHERE chat_id = ? AND message_id = 101`,
            )
            .all(CHAT_ID),
        ),
        [
          {
            topic_id: 777,
            deleted_at: "2026-07-30T00:00:00.000Z",
          },
        ],
      );
      assert.equal(
        String(
          target
            .prepare(
              `SELECT text
               FROM chat_day_digests
               WHERE chat_id = ? AND day = '2026-01-31'`,
            )
            .get(CHAT_ID)?.text,
        ),
        "newer unified day digest",
      );
      assert.equal(
        String(
          target
            .prepare(
              `SELECT text
               FROM chat_digest_rollups
               WHERE chat_id = ? AND kind = 'month' AND period = '2026-01'`,
            )
            .get(CHAT_ID)?.text,
        ),
        "newer unified month rollup",
      );
      assert.deepEqual(
        plainRows(
          target
            .prepare("SELECT id, status FROM send_outbox ORDER BY id")
            .all(),
        ),
        [{ id: "existing-unknown", status: "sending" }],
      );
      assert.deepEqual(quickCheck(target), ["ok"]);
    } finally {
      target.close();
    }
  });
});

test("python-state import fills only missing canonical fields and is idempotent", () => {
  withTempDirectory((directory) => {
    const sourcePath = join(directory, "legacy-fill.sqlite");
    const targetPath = join(directory, "unified-fill.sqlite");
    createLegacySource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source
      .prepare(
        "UPDATE live_msg SET reply_to = 77 WHERE message_id = 101",
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
          text: "",
          topicId: 777,
          rawJson: '{"canonical":true}',
          deletedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    );
    store.close();

    const first = runScript(IMPORT_SCRIPT, [
      "--source",
      sourcePath,
      "--target",
      targetPath,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.equal(first.status, 0, first.stderr);
    const firstReport = parseReport(first.stdout);
    assert.equal(firstReport.target.messageWrites, 1);
    assert.deepEqual(firstReport.target.messageMerge, {
      inserts: 0,
      overlaps: 1,
      fills: {
        messages: 1,
        total: 5,
        date: 1,
        senderId: 1,
        senderName: 1,
        text: 1,
        replyToMessageId: 1,
      },
      conflicts: emptyMessageChanges(),
    });

    let target = new DatabaseSync(targetPath);
    try {
      assert.deepEqual(
        plainRows(
          target
            .prepare(
              `SELECT date, sender_id, sender_name, text,
                      reply_to_message_id, topic_id, raw_json, deleted_at
               FROM messages
               WHERE chat_id = ? AND message_id = 101`,
            )
            .all(CHAT_ID),
        ),
        [
          {
            date: new Date(1_769_644_800_000).toISOString(),
            sender_id: "42",
            sender_name: "Alice",
            text: "legacy hello",
            reply_to_message_id: 77,
            topic_id: 777,
            raw_json: '{"canonical":true}',
            deleted_at: "2026-07-30T00:00:00.000Z",
          },
        ],
      );
      target
        .prepare(
          `UPDATE messages
           SET updated_at = '2000-01-01 00:00:00'
           WHERE chat_id = ? AND message_id = 101`,
        )
        .run(CHAT_ID);
    } finally {
      target.close();
    }

    const second = runScript(IMPORT_SCRIPT, [
      "--source",
      sourcePath,
      "--target",
      targetPath,
      "--chat-id",
      CHAT_ID,
      "--apply",
    ]);
    assert.equal(second.status, 0, second.stderr);
    const secondReport = parseReport(second.stdout);
    assert.equal(secondReport.target.messageWrites, 0);
    assert.deepEqual(secondReport.target.messageMerge, {
      inserts: 0,
      overlaps: 1,
      fills: emptyMessageChanges(),
      conflicts: emptyMessageChanges(),
    });

    target = new DatabaseSync(targetPath, { readOnly: true });
    try {
      assert.equal(
        String(
          target
            .prepare(
              `SELECT updated_at
               FROM messages
               WHERE chat_id = ? AND message_id = 101`,
            )
            .get(CHAT_ID)?.updated_at,
        ),
        "2000-01-01 00:00:00",
      );
      assert.deepEqual(quickCheck(target), ["ok"]);
    } finally {
      target.close();
    }
  });
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MessageStore } from "../src/store.js";
import {
  CHAT_ID,
  MAINTAIN_SCRIPT,
  assertMaintenanceFailure,
  fileHash,
  parseReport,
  quickCheck,
  runScript,
  scalar,
  withTempDirectory,
} from "./support/state-scripts.js";

test("state maintenance rebuilds FTS atomically and resumes embedding membership in bounded batches", () => {
  withTempDirectory((directory) => {
    const dbPath = join(directory, "state.sqlite");
    const store = new MessageStore(dbPath);
    store.upsertMessages(
      {
        chatId: CHAT_ID,
        requested: CHAT_ID,
        kind: "Fake",
      },
      [
        {
          chatId: CHAT_ID,
          messageId: 1,
          senderName: "alice",
          text: "deferred alpha",
        },
        {
          chatId: CHAT_ID,
          messageId: 2,
          senderName: "bob",
          text: "deferred beta",
        },
        {
          chatId: CHAT_ID,
          messageId: 3,
          senderName: "carol",
          text: "deferred gamma",
        },
      ],
    );
    store.close();

    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        UPDATE messages SET updated_at = '2020-01-01 00:00:00';
        DELETE FROM messages_fts;
      `);
      const insertChunk = seed.prepare(
        `INSERT INTO message_embedding_chunks (
           chat_id, start_message_id, end_message_id, message_count,
           text, embedding_namespace, embedding_model,
           embedding_dimensions, embedding, content_hash, dirty_at,
           updated_at
         )
         VALUES (?, ?, ?, 1, ?, 'legacy', 'legacy-model', 2,
                 zeroblob(8), ?, NULL, datetime('now'))`,
      );
      for (let messageId = 1; messageId <= 3; messageId += 1) {
        insertChunk.run(
          CHAT_ID,
          messageId,
          messageId,
          `chunk ${messageId}`,
          `hash-${messageId}`,
        );
      }
      seed.prepare(
        `INSERT INTO maintenance_jobs (
           name, status, reason, details_json, updated_at, completed_at
         )
         VALUES (?, 'pending', 'test rebuild', '{}', datetime('now'), NULL)
         ON CONFLICT(name) DO UPDATE SET
           status = 'pending',
           reason = excluded.reason,
           details_json = excluded.details_json,
           updated_at = excluded.updated_at,
           completed_at = NULL`,
      ).run("messages_fts_rebuild");
      seed.prepare(
        `INSERT INTO maintenance_jobs (
           name, status, reason, details_json, updated_at, completed_at
         )
         VALUES (
           ?, 'pending', 'test backfill',
           '{"targetMaxChunkId":3,"lastChunkId":0,"processedChunks":0,"sourceSnapshotAt":"2026-01-01T00:00:00.000Z"}',
           datetime('now'), NULL
         )
         ON CONFLICT(name) DO UPDATE SET
           status = 'pending',
           reason = excluded.reason,
           details_json = excluded.details_json,
           updated_at = excluded.updated_at,
           completed_at = NULL`,
      ).run("embedding_chunk_membership_backfill");
    } finally {
      seed.close();
    }

    const degraded = new MessageStore(dbPath);
    assert.throws(
      () =>
        degraded.search({
          chatId: CHAT_ID,
          query: "deferred",
          limit: 10,
        }),
      /Keyword search is temporarily unavailable/u,
    );
    degraded.close();

    const dryRun = runScript(MAINTAIN_SCRIPT, [
      "--db",
      dbPath,
      "--deferred-batch-size",
      "1",
      "--deferred-max-batches",
      "1",
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.deepEqual(parseReport(dryRun.stdout).deferredMaintenance, [
      {
        name: "messages_fts_rebuild",
        status: "pending",
        batches: 0,
        processedRows: 0,
        remainingRows: 3,
      },
      {
        name: "embedding_chunk_membership_backfill",
        status: "pending",
        batches: 0,
        processedRows: 0,
        remainingRows: 3,
      },
    ]);

    const firstApply = runScript(MAINTAIN_SCRIPT, [
      "--db",
      dbPath,
      "--deferred-batch-size",
      "1",
      "--deferred-max-batches",
      "1",
      "--apply",
    ]);
    assert.equal(firstApply.status, 0, firstApply.stderr);
    assert.deepEqual(
      parseReport(firstApply.stdout).deferredMaintenance,
      [
        {
          name: "messages_fts_rebuild",
          status: "completed",
          batches: 1,
          processedRows: 3,
          remainingRows: 0,
        },
        {
          name: "embedding_chunk_membership_backfill",
          status: "pending",
          batches: 1,
          processedRows: 1,
          remainingRows: 2,
        },
      ],
    );

    const afterFirst = new MessageStore(dbPath);
    assert.equal(
      afterFirst.search({
        chatId: CHAT_ID,
        query: "deferred",
        limit: 10,
      }).length,
      3,
    );
    assert.equal(
      afterFirst.isMaintenanceJobPending(
        "embedding_chunk_membership_backfill",
      ),
      true,
    );
    afterFirst.upsertMessages(
      {
        chatId: CHAT_ID,
        requested: CHAT_ID,
        kind: "Fake",
      },
      [
        {
          chatId: CHAT_ID,
          messageId: 3,
          senderName: "carol",
          text: "deferred gamma edited during backfill",
        },
      ],
    );
    afterFirst.close();
    let inspect = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        scalar(
          inspect,
          "SELECT count(*) FROM message_embedding_chunk_messages",
        ),
        1,
      );
      assert.equal(
        JSON.parse(
          String(
            inspect
              .prepare(
                `SELECT details_json
                 FROM maintenance_jobs
                 WHERE name = 'embedding_chunk_membership_backfill'`,
              )
              .get()?.details_json,
          ),
        ).lastChunkId,
        1,
      );
      assert.equal(
        scalar(
          inspect,
          `SELECT count(*)
           FROM message_embedding_chunks
           WHERE dirty_at IS NOT NULL`,
        ),
        0,
      );
    } finally {
      inspect.close();
    }

    const secondApply = runScript(MAINTAIN_SCRIPT, [
      "--db",
      dbPath,
      "--deferred-batch-size",
      "1",
      "--deferred-max-batches",
      "10",
      "--apply",
    ]);
    assert.equal(secondApply.status, 0, secondApply.stderr);
    assert.deepEqual(
      parseReport(secondApply.stdout).deferredMaintenance,
      [
        {
          name: "messages_fts_rebuild",
          status: "completed",
          batches: 0,
          processedRows: 0,
          remainingRows: 0,
        },
        {
          name: "embedding_chunk_membership_backfill",
          status: "completed",
          batches: 2,
          processedRows: 2,
          remainingRows: 0,
        },
      ],
    );
    inspect = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        scalar(
          inspect,
          "SELECT count(*) FROM message_embedding_chunk_messages",
        ),
        3,
      );
      assert.equal(
        String(
          inspect
            .prepare(
              `SELECT status
               FROM maintenance_jobs
               WHERE name = 'embedding_chunk_membership_backfill'`,
            )
            .get()?.status,
        ),
        "completed",
      );
      assert.equal(
        scalar(
          inspect,
          `SELECT count(*)
           FROM message_embedding_chunks
           WHERE start_message_id = 3
             AND dirty_at IS NOT NULL`,
        ),
        1,
      );
      assert.deepEqual(quickCheck(inspect), ["ok"]);
    } finally {
      inspect.close();
    }
  });
});

test("failed deferred membership batch rolls back while earlier batches remain resumable", () => {
  withTempDirectory((directory) => {
    const dbPath = join(directory, "state.sqlite");
    const store = new MessageStore(dbPath);
    store.close();
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(`
        INSERT INTO message_embedding_chunks (
          chat_id, start_message_id, end_message_id, message_count,
          text, embedding_namespace, embedding_model,
          embedding_dimensions, embedding, content_hash, dirty_at,
          updated_at
        )
        VALUES
          (
            '${CHAT_ID}', 1, 1, 1, 'valid chunk', 'legacy',
            'legacy-model', 2, zeroblob(8), 'valid', NULL,
            datetime('now')
          ),
          (
            '${CHAT_ID}', 2, 2, 0, 'invalid chunk', 'legacy',
            'legacy-model', 2, zeroblob(8), 'invalid', NULL,
            datetime('now')
          );
        INSERT INTO maintenance_jobs (
          name, status, reason, details_json, updated_at, completed_at
        )
        VALUES (
          'embedding_chunk_membership_backfill', 'pending',
          'test invalid chunk',
          '{"targetMaxChunkId":2,"lastChunkId":0,"processedChunks":0}',
          datetime('now'), NULL
        )
        ON CONFLICT(name) DO UPDATE SET
          status = 'pending',
          reason = excluded.reason,
          details_json = excluded.details_json,
          updated_at = excluded.updated_at,
          completed_at = NULL;
      `);
    } finally {
      seed.close();
    }

    const failed = runScript(MAINTAIN_SCRIPT, [
      "--db",
      dbPath,
      "--deferred-batch-size",
      "1",
      "--apply",
    ]);
    assert.notEqual(failed.status, 0);
    const failure = parseReport(failed.stderr);
    assert.deepEqual(failure, {
      event: "state_maintenance_failed",
      phase: "deferred_embedding_membership",
      completedPhases: [
        "options",
        "open",
        "inspect",
        "retention",
        "deferred_fts",
      ],
      stateMayBePartiallyModified: true,
      retentionMayBeCommitted: true,
      deferredMaintenanceMayBeCommitted: true,
      error: { code: "deferred_embedding_failed" },
    });
    assert.equal("message" in failure.error, false);
    assert.equal(failed.stderr.includes("invalid chunk"), false);
    const inspect = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        scalar(
          inspect,
          "SELECT count(*) FROM message_embedding_chunk_messages",
        ),
        0,
      );
      const job = inspect
        .prepare(
          `SELECT status, details_json
           FROM maintenance_jobs
           WHERE name = 'embedding_chunk_membership_backfill'`,
        )
        .get() as Record<string, unknown>;
      assert.equal(job.status, "pending");
      assert.equal(
        JSON.parse(String(job.details_json)).lastChunkId,
        1,
      );
      assert.equal(
        JSON.parse(String(job.details_json)).processedChunks,
        1,
      );
    } finally {
      inspect.close();
    }
  });
});

test("state maintenance refuses corrupt, unrelated, and future-schema databases without applying retention", () => {
  withTempDirectory((directory) => {
    const corruptPath = join(directory, "corrupt.sqlite");
    writeFileSync(corruptPath, "definitely not sqlite");
    const corruptHash = fileHash(corruptPath);
    const corrupt = runScript(MAINTAIN_SCRIPT, [
      "--db",
      corruptPath,
      "--apply",
    ]);
    assert.notEqual(corrupt.status, 0);
    assert.equal(fileHash(corruptPath), corruptHash);

    const unrelatedPath = join(directory, "unrelated.sqlite");
    const unrelated = new DatabaseSync(unrelatedPath);
    unrelated.exec(
      "PRAGMA user_version = 12; CREATE TABLE unrelated (value TEXT);",
    );
    unrelated.close();
    const unrelatedHash = fileHash(unrelatedPath);
    const rejected = runScript(MAINTAIN_SCRIPT, [
      "--db",
      unrelatedPath,
      "--apply",
    ]);
    assert.notEqual(rejected.status, 0);
    assertMaintenanceFailure(rejected.stderr, {
      phase: "inspect",
      code: "incompatible_schema",
      stateMayBePartiallyModified: false,
    });
    assert.equal(fileHash(unrelatedPath), unrelatedHash);

    const futurePath = join(directory, "future.sqlite");
    const store = new MessageStore(futurePath);
    store.close();
    const future = new DatabaseSync(futurePath);
    future.exec("PRAGMA user_version = 999");
    future.close();
    const futureHash = fileHash(futurePath);
    const futureRejected = runScript(MAINTAIN_SCRIPT, [
      "--db",
      futurePath,
      "--apply",
    ]);
    assert.notEqual(futureRejected.status, 0);
    assertMaintenanceFailure(futureRejected.stderr, {
      phase: "inspect",
      code: "incompatible_schema",
      stateMayBePartiallyModified: false,
    });
    assert.equal(fileHash(futurePath), futureHash);
  });
});

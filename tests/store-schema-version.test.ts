import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import { assertSuitableTarget } from "../src/python-import/sqlite-guards.js";

function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(
    join(tmpdir(), "telegram-store-schema-version-test-"),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}

test("schema version 25 is supported and version 26 is rejected", (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);
  store.close();

  const v25 = new DatabaseSync(dbPath);
  try {
    assert.equal(
      Number(
        (
          v25.prepare("PRAGMA user_version").get() as
            Record<string, unknown> | undefined
        )?.user_version,
      ),
      25,
    );
  } finally {
    v25.close();
  }

  const v26 = new DatabaseSync(dbPath);
  try {
    v26.exec("PRAGMA user_version = 26");
  } finally {
    v26.close();
  }
  assert.throws(
    () => new MessageStore(dbPath),
    /schema version 26 is newer than supported version 25/,
  );
});

test("python import target guard accepts v25 and rejects v26", (t) => {
  const dbPath = tempDbPath(t);
  const v25 = new DatabaseSync(dbPath);
  try {
    v25.exec(`
      CREATE TABLE chats (chat_id TEXT PRIMARY KEY);
      CREATE TABLE messages (chat_id TEXT, message_id INTEGER, text TEXT);
      CREATE TABLE sync_state (chat_id TEXT PRIMARY KEY);
      CREATE TABLE history_jobs (job_id TEXT PRIMARY KEY, status TEXT, started_at TEXT);
      PRAGMA user_version = 25;
    `);
  } finally {
    v25.close();
  }
  assert.doesNotThrow(() => assertSuitableTarget(dbPath));

  const v26 = new DatabaseSync(dbPath);
  try {
    v26.exec("PRAGMA user_version = 26");
  } finally {
    v26.close();
  }
  assert.throws(
    () => assertSuitableTarget(dbPath),
    /Target schema version 26 is unsupported/,
  );
});

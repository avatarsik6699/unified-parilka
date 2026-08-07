import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MessageStore } from "../src/store.js";
import { assertSuitableTarget } from "../src/python-import/sqlite-guards.js";

function tempDbPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "telegram-store-schema-version-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "messages.sqlite");
}

test("schema version 22 is supported and version 23 is rejected", (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);
  store.close();

  const v22 = new DatabaseSync(dbPath);
  try {
    assert.equal(
      Number((v22.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined)?.user_version),
      22,
    );
  } finally {
    v22.close();
  }

  const v23 = new DatabaseSync(dbPath);
  try {
    v23.exec("PRAGMA user_version = 23");
  } finally {
    v23.close();
  }
  assert.throws(
    () => new MessageStore(dbPath),
    /schema version 23 is newer than supported version 22/,
  );
});

test("python import target guard accepts v22 and rejects v23", (t) => {
  const dbPath = tempDbPath(t);
  const v22 = new DatabaseSync(dbPath);
  try {
    v22.exec(`
      CREATE TABLE chats (chat_id TEXT PRIMARY KEY);
      CREATE TABLE messages (chat_id TEXT, message_id INTEGER, text TEXT);
      CREATE TABLE sync_state (chat_id TEXT PRIMARY KEY);
      CREATE TABLE history_jobs (job_id TEXT PRIMARY KEY, status TEXT, started_at TEXT);
      PRAGMA user_version = 22;
    `);
  } finally {
    v22.close();
  }
  assert.doesNotThrow(() => assertSuitableTarget(dbPath));

  const v23 = new DatabaseSync(dbPath);
  try {
    v23.exec("PRAGMA user_version = 23");
  } finally {
    v23.close();
  }
  assert.throws(
    () => assertSuitableTarget(dbPath),
    /Target schema version 23 is unsupported/,
  );
});

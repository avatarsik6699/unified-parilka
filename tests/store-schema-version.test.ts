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

test("schema version 21 is supported and version 22 is rejected", (t) => {
  const dbPath = tempDbPath(t);
  const store = new MessageStore(dbPath);
  store.close();

  const v21 = new DatabaseSync(dbPath);
  try {
    assert.equal(
      Number((v21.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined)?.user_version),
      21,
    );
  } finally {
    v21.close();
  }

  const v22 = new DatabaseSync(dbPath);
  try {
    v22.exec("PRAGMA user_version = 22");
  } finally {
    v22.close();
  }
  assert.throws(
    () => new MessageStore(dbPath),
    /schema version 22 is newer than supported version 21/,
  );
});

test("python import target guard accepts v21 and rejects v22", (t) => {
  const dbPath = tempDbPath(t);
  const v21 = new DatabaseSync(dbPath);
  try {
    v21.exec(`
      CREATE TABLE chats (chat_id TEXT PRIMARY KEY);
      CREATE TABLE messages (chat_id TEXT, message_id INTEGER, text TEXT);
      CREATE TABLE sync_state (chat_id TEXT PRIMARY KEY);
      CREATE TABLE history_jobs (job_id TEXT PRIMARY KEY, status TEXT, started_at TEXT);
      PRAGMA user_version = 21;
    `);
  } finally {
    v21.close();
  }
  assert.doesNotThrow(() => assertSuitableTarget(dbPath));

  const v22 = new DatabaseSync(dbPath);
  try {
    v22.exec("PRAGMA user_version = 22");
  } finally {
    v22.close();
  }
  assert.throws(
    () => assertSuitableTarget(dbPath),
    /Target schema version 22 is unsupported/,
  );
});

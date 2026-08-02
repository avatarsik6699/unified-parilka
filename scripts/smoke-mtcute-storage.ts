import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseTelegramClient,
  SqliteStorage,
  TelegramClient,
} from "@mtcute/node";
import {
  createOwnerManagedNodePlatform,
  destroyDefaultMtcuteClient,
} from "../src/telegram/mtcute/client.js";

const directory = mkdtempSync(
  join(tmpdir(), "parilka-mtcute-storage-"),
);
const base = new BaseTelegramClient({
  apiId: 1,
  apiHash: "0".repeat(32),
  storage: new SqliteStorage(join(directory, "auth.sqlite"), {
    disableWal: true,
  }),
  updates: false,
  disableUpdates: true,
  platform: createOwnerManagedNodePlatform(),
  logLevel: 0,
});
const client = new TelegramClient({
  client: base,
  disableUpdates: true,
});

try {
  await client.prepare();
  assert.equal(await base.mt.storage.dcs.fetch(), null);
} finally {
  try {
    await destroyDefaultMtcuteClient(client, base);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    nodeAbi: process.versions.modules,
    storage: "fresh_unpopulated",
    shutdown: "clean",
  })}\n`,
);

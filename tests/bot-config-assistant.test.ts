import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  MAX_ASSISTANT_CHATS,
  selectAssistantChats,
} from "../src/bot-config/assistant.js";
import { loadBotDefinitionsFromEnv } from "../src/bot-config/load.js";

function fixtureDir(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "bot-agi-bot-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writePersona(directory: string, name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

function writeConfig(
  directory: string,
  entries: readonly Record<string, unknown>[],
): string {
  const path = join(directory, "bots.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

function loadChats(configPath: string) {
  const definitions = loadBotDefinitionsFromEnv({
    BOT_BOTS_CONFIG_PATH: configPath,
  });
  return selectAssistantChats(definitions.entries, definitions.configPath);
}

test("loads and validates well-formed assistant entries, reading persona prose from its own file", (t) => {
  const directory = fixtureDir(t);
  const personaA = writePersona(directory, "a.md", "# Кто ты\nПерсона A.");
  const personaB = writePersona(directory, "b.md", "# Кто ты\nПерсона B.");
  const configPath = writeConfig(directory, [
    {
      role: "assistant",
      chatId: "-1001",
      chatTitle: "Chat A",
      personaPromptPath: personaA,
    },
    {
      role: "assistant",
      chatId: "-1002",
      chatTitle: "Chat B",
      personaPromptPath: personaB,
      approximateMemberCount: 42,
    },
  ]);

  const chats = loadChats(configPath);

  assert.equal(chats.length, 2);
  assert.deepEqual(chats[0], {
    allowedChatId: "-1001",
    chatTitle: "Chat A",
    personaPrompt: "# Кто ты\nПерсона A.",
  });
  assert.deepEqual(chats[1], {
    allowedChatId: "-1002",
    chatTitle: "Chat B",
    personaPrompt: "# Кто ты\nПерсона B.",
    approximateMemberCount: 42,
  });
});

test("ignores human-persona entries when selecting assistant chats", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "p.md", "# Кто ты\nПерсона.");
  const configPath = writeConfig(directory, [
    {
      role: "assistant",
      chatId: "-1001",
      chatTitle: "Chat A",
      personaPromptPath: persona,
    },
    {
      role: "human-persona",
      personaId: "wife",
      chatId: "-1002",
      chatTitle: "Family",
      targetUserKey: "u1",
      approvalChatId: "-1003",
    },
  ]);

  const chats = loadChats(configPath);

  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.allowedChatId, "-1001");
});

test("rejects more than MAX_ASSISTANT_CHATS entries", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "p.md", "# Кто ты\nОдна персона.");
  const entries = Array.from({ length: MAX_ASSISTANT_CHATS + 1 }, (_, i) => ({
    role: "assistant",
    chatId: `-${1000 + i}`,
    chatTitle: `Chat ${i}`,
    personaPromptPath: persona,
  }));
  const configPath = writeConfig(directory, entries);

  assert.throws(() => loadChats(configPath), /between 1 and 5/u);
});

test("rejects zero assistant entries", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, []);

  assert.throws(() => loadChats(configPath), /between 1 and 5/u);
});

test("rejects a duplicate chatId across assistant entries", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "p.md", "# Кто ты\nПерсона.");
  const configPath = writeConfig(directory, [
    {
      role: "assistant",
      chatId: "-1001",
      chatTitle: "Chat A",
      personaPromptPath: persona,
    },
    {
      role: "assistant",
      chatId: "-1001",
      chatTitle: "Chat A again",
      personaPromptPath: persona,
    },
  ]);

  assert.throws(() => loadChats(configPath), /more than once/u);
});

test("rejects a chatId that is not a negative Telegram integer", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "p.md", "# Кто ты\nПерсона.");
  const configPath = writeConfig(directory, [
    {
      role: "assistant",
      chatId: "1001",
      chatTitle: "Chat A",
      personaPromptPath: persona,
    },
  ]);

  assert.throws(() => loadChats(configPath), /negative Telegram id/u);
});

test("rejects a personaPromptPath that does not point to an existing file", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, [
    {
      role: "assistant",
      chatId: "-1001",
      chatTitle: "Chat A",
      personaPromptPath: join(directory, "missing.md"),
    },
  ]);

  assert.throws(() => loadChats(configPath), /existing regular file/u);
});

test("rejects an empty persona prompt file", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "empty.md", "   ");
  const configPath = writeConfig(directory, [
    {
      role: "assistant",
      chatId: "-1001",
      chatTitle: "Chat A",
      personaPromptPath: persona,
    },
  ]);

  assert.throws(() => loadChats(configPath), /personaPrompt must contain/u);
});

test("rejects malformed JSON and a config file that is not an array of the expected shape", (t) => {
  const directory = fixtureDir(t);
  const malformedPath = join(directory, "malformed.json");
  writeFileSync(malformedPath, "{not valid json");
  assert.throws(() => loadChats(malformedPath), /not valid JSON/u);

  const wrongShapePath = writeConfig(directory, [
    { role: "assistant", chatId: "-1001" } as unknown as Record<
      string,
      unknown
    >,
  ]);
  assert.throws(() => loadChats(wrongShapePath), /does not match/u);

  const unknownRolePath = writeConfig(directory, [
    { role: "ghost", chatId: "-1001" } as unknown as Record<string, unknown>,
  ]);
  assert.throws(() => loadChats(unknownRolePath), /does not match/u);
});

test("requires BOT_BOTS_CONFIG_PATH to be set", () => {
  assert.throws(
    () => loadBotDefinitionsFromEnv({}),
    /BOT_BOTS_CONFIG_PATH is required/u,
  );
});

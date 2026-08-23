import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  loadAssistantChatsFromEnv,
  MAX_ASSISTANT_CHATS,
} from "../src/bot-daemon/multi-chat-config.js";

function fixtureDir(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "bot-agi-multi-chat-"));
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
  const path = join(directory, "multi-chat.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

test("loads and validates a well-formed multi-chat config, reading persona prose from its own file", (t) => {
  const directory = fixtureDir(t);
  const personaA = writePersona(directory, "a.md", "# Кто ты\nПерсона A.");
  const personaB = writePersona(directory, "b.md", "# Кто ты\nПерсона B.");
  const configPath = writeConfig(directory, [
    { chatId: "-1001", chatTitle: "Chat A", personaPromptPath: personaA },
    {
      chatId: "-1002",
      chatTitle: "Chat B",
      personaPromptPath: personaB,
      approximateMemberCount: 42,
    },
  ]);

  const chats = loadAssistantChatsFromEnv({
    BOT_MULTI_CHAT_CONFIG_PATH: configPath,
  });

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

test("rejects more than MAX_ASSISTANT_CHATS entries", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "p.md", "# Кто ты\nОдна персона.");
  const entries = Array.from({ length: MAX_ASSISTANT_CHATS + 1 }, (_, i) => ({
    chatId: `-${1000 + i}`,
    chatTitle: `Chat ${i}`,
    personaPromptPath: persona,
  }));
  const configPath = writeConfig(directory, entries);

  assert.throws(
    () => loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: configPath }),
    /between 1 and 5 chats/u,
  );
});

test("rejects an empty chat list", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, []);

  assert.throws(
    () => loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: configPath }),
    /between 1 and 5 chats/u,
  );
});

test("rejects a duplicate chatId across entries", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "p.md", "# Кто ты\nПерсона.");
  const configPath = writeConfig(directory, [
    { chatId: "-1001", chatTitle: "Chat A", personaPromptPath: persona },
    { chatId: "-1001", chatTitle: "Chat A again", personaPromptPath: persona },
  ]);

  assert.throws(
    () => loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: configPath }),
    /more than once/u,
  );
});

test("rejects a chatId that is not a negative Telegram integer", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "p.md", "# Кто ты\nПерсона.");
  const configPath = writeConfig(directory, [
    { chatId: "1001", chatTitle: "Chat A", personaPromptPath: persona },
  ]);

  assert.throws(
    () => loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: configPath }),
    /negative Telegram id/u,
  );
});

test("rejects a personaPromptPath that does not point to an existing file", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, [
    {
      chatId: "-1001",
      chatTitle: "Chat A",
      personaPromptPath: join(directory, "missing.md"),
    },
  ]);

  assert.throws(
    () => loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: configPath }),
    /existing regular file/u,
  );
});

test("rejects an empty persona prompt file", (t) => {
  const directory = fixtureDir(t);
  const persona = writePersona(directory, "empty.md", "   ");
  const configPath = writeConfig(directory, [
    { chatId: "-1001", chatTitle: "Chat A", personaPromptPath: persona },
  ]);

  assert.throws(
    () => loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: configPath }),
    /personaPrompt must contain/u,
  );
});

test("rejects malformed JSON and a config file that is not an array of the expected shape", (t) => {
  const directory = fixtureDir(t);
  const malformedPath = join(directory, "malformed.json");
  writeFileSync(malformedPath, "{not valid json");
  assert.throws(
    () =>
      loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: malformedPath }),
    /not valid JSON/u,
  );

  const wrongShapePath = writeConfig(directory, [
    { chatId: "-1001" } as unknown as Record<string, unknown>,
  ]);
  assert.throws(
    () =>
      loadAssistantChatsFromEnv({ BOT_MULTI_CHAT_CONFIG_PATH: wrongShapePath }),
    /does not match the expected/u,
  );
});

test("requires BOT_MULTI_CHAT_CONFIG_PATH to be set", () => {
  assert.throws(
    () => loadAssistantChatsFromEnv({}),
    /BOT_MULTI_CHAT_CONFIG_PATH is required/u,
  );
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { selectAssistantChats } from "../src/bot-config/assistant.js";
import { selectHumanPersona } from "../src/bot-config/human-persona.js";
import { loadBotDefinitionsFromEnv } from "../src/bot-config/load.js";

function fixtureDir(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "bot-agi-bot-config-hp-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeConfig(
  directory: string,
  entries: readonly Record<string, unknown>[],
): string {
  const path = join(directory, "bots.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

function loadHumanPersona(configPath: string) {
  const definitions = loadBotDefinitionsFromEnv({
    BOT_BOTS_CONFIG_PATH: configPath,
  });
  return selectHumanPersona(definitions.entries, definitions.configPath);
}

const BASE_ENTRY = {
  role: "human-persona",
  personaId: "wife",
  chatId: "-1002",
  chatTitle: "Family",
  targetUserKey: "u1",
  approvalChatId: "-1003",
} as const;

test("returns undefined when no human-persona entry is present", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, []);
  assert.equal(loadHumanPersona(configPath), undefined);
});

test("loads a well-formed human-persona entry with defaulted heuristics and approval mode", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, [BASE_ENTRY]);

  const selected = loadHumanPersona(configPath);

  assert.deepEqual(selected, {
    trigger: {
      personaId: "wife",
      chatId: "-1002",
      chatTitle: "Family",
      targetUserKey: "u1",
      autonomyMode: "approval",
      heuristics: {
        activeHourStartMoscow: 9,
        activeHourEndMoscow: 23,
        minSilenceMs: 20 * 60_000,
        maxInitiationsPerWindow: 3,
        windowMs: 24 * 60 * 60_000,
      },
    },
    approvalChatId: "-1003",
  });
});

test("respects explicit overrides for autonomy mode and heuristics", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, [
    {
      ...BASE_ENTRY,
      autonomyMode: "auto",
      activeHourStart: 8,
      activeHourEnd: 22,
      minSilenceMs: 60_000,
      maxInitiationsPerWindow: 7,
      windowMs: 3_600_000,
    },
  ]);

  const selected = loadHumanPersona(configPath);

  assert.equal(selected?.trigger.autonomyMode, "auto");
  assert.deepEqual(selected?.trigger.heuristics, {
    activeHourStartMoscow: 8,
    activeHourEndMoscow: 22,
    minSilenceMs: 60_000,
    maxInitiationsPerWindow: 7,
    windowMs: 3_600_000,
  });
});

test("rejects more than one human-persona entry", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, [
    BASE_ENTRY,
    { ...BASE_ENTRY, personaId: "husband" },
  ]);

  assert.throws(() => loadHumanPersona(configPath), /only a single/u);
});

test("rejects an out-of-range heuristic field at schema level", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, [
    { ...BASE_ENTRY, activeHourStart: 99 },
  ]);

  assert.throws(() => loadHumanPersona(configPath), /does not match/u);
});

test("rejects a chatId that is not a negative Telegram integer", (t) => {
  const directory = fixtureDir(t);
  const configPath = writeConfig(directory, [
    { ...BASE_ENTRY, approvalChatId: "1003" },
  ]);

  assert.throws(() => loadHumanPersona(configPath), /negative Telegram id/u);
});

test("a mixed file resolves both roles independently", (t) => {
  const directory = fixtureDir(t);
  const personaPath = join(directory, "persona.md");
  writeFileSync(personaPath, "# Кто ты\nАссистент.");
  const configPath = writeConfig(directory, [
    {
      role: "assistant",
      chatId: "-1001",
      chatTitle: "Chat A",
      personaPromptPath: personaPath,
    },
    BASE_ENTRY,
  ]);

  const definitions = loadBotDefinitionsFromEnv({
    BOT_BOTS_CONFIG_PATH: configPath,
  });
  const chats = selectAssistantChats(
    definitions.entries,
    definitions.configPath,
  );
  const humanPersona = selectHumanPersona(
    definitions.entries,
    definitions.configPath,
  );

  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.allowedChatId, "-1001");
  assert.equal(humanPersona?.trigger.personaId, "wife");
  assert.equal(humanPersona?.approvalChatId, "-1003");
});

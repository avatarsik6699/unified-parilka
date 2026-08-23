import { readFileSync } from "node:fs";
import {
  existingAbsoluteFile,
  requiredPlain,
} from "../bot/runtime-config/env-rules.js";
import type { BotRuntimeEnvironment } from "../bot/runtime-config.js";
import { botDefinitionsFileSchema, type BotDefinitionEntry } from "./schema.js";

export const BOT_BOTS_CONFIG_PATH_ENV_VAR = "BOT_BOTS_CONFIG_PATH";

export interface LoadedBotDefinitions {
  configPath: string;
  entries: readonly BotDefinitionEntry[];
}

/**
 * Reads `BOT_BOTS_CONFIG_PATH`: a JSON array mixing `role: "assistant"` and
 * `role: "human-persona"` entries (ADR 0007). Throws when the variable is
 * unset -- callers that treat the human-persona role as optional (`bot-agi-
 * sync`) must check `env.BOT_BOTS_CONFIG_PATH` themselves before calling
 * this, the same way the old `BOT_HUMAN_PERSONA_*` scalars gated silently
 * on absence rather than failing sync startup.
 */
export function loadBotDefinitionsFromEnv(
  env: BotRuntimeEnvironment,
): LoadedBotDefinitions {
  const configPath = existingAbsoluteFile(
    requiredPlain(env, BOT_BOTS_CONFIG_PATH_ENV_VAR),
    BOT_BOTS_CONFIG_PATH_ENV_VAR,
  );

  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${BOT_BOTS_CONFIG_PATH_ENV_VAR} file "${configPath}".`,
      { cause: error },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${BOT_BOTS_CONFIG_PATH_ENV_VAR} file "${configPath}" is not valid JSON.`,
      { cause: error },
    );
  }

  const result = botDefinitionsFileSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `${BOT_BOTS_CONFIG_PATH_ENV_VAR} file "${configPath}" does not match ` +
        `the expected array of bot definitions: ` +
        result.error.issues
          .map(
            (issue) =>
              `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
          )
          .join("; "),
    );
  }

  return { configPath, entries: result.data };
}

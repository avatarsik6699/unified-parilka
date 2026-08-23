import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { HumanPersonaConsentBasis } from "../store.js";

export interface CliOptions {
  apply: boolean;
  personaId: string;
  chatId: string;
  targetUserKey: string;
  consentBasis: HumanPersonaConsentBasis;
  dbPath: string;
  modelConfigPath?: string;
}

export class CliConfigError extends Error {
  readonly name = "CliConfigError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ALLOWED_FLAGS = new Set([
  "--persona-id",
  "--chat",
  "--target-user",
  "--consent-basis",
  "--db",
  "--model-config",
]);

export function parseOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (!ALLOWED_FLAGS.has(argument)) {
      throw new CliConfigError(
        "unknown_argument",
        `Unknown argument: ${argument}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliConfigError(
        "missing_argument_value",
        `${argument} requires a value.`,
      );
    }
    if (values.has(argument)) {
      throw new CliConfigError(
        "duplicate_argument",
        `${argument} may be provided only once.`,
      );
    }
    values.set(argument, value);
    index += 1;
  }

  const personaId = requireNonEmpty(
    values.get("--persona-id") ?? env.BOT_HUMAN_PERSONA_ID,
    "--persona-id",
    "persona_id",
  );
  const chatId = requireNonEmpty(
    values.get("--chat") ?? env.BOT_HUMAN_PERSONA_CHAT_ID,
    "--chat",
    "chat_id",
  );
  const targetUserKey = requireNonEmpty(
    values.get("--target-user") ?? env.BOT_HUMAN_PERSONA_TARGET_USER,
    "--target-user",
    "target_user",
  );
  const consentBasis = requireConsentBasis(
    values.get("--consent-basis") ?? env.BOT_HUMAN_PERSONA_CONSENT_BASIS,
  );

  const configuredDb =
    values.get("--db") ?? env.BOT_DB_PATH ?? env.TELEGRAM_DB_PATH;
  if (!configuredDb) {
    throw new CliConfigError(
      "missing_db",
      "Set --db, BOT_DB_PATH, or TELEGRAM_DB_PATH.",
    );
  }
  const dbPath = existingAbsoluteFile(configuredDb, "style-profile database");
  assertSingleLinkDatabase(dbPath);

  const configuredModel =
    values.get("--model-config") ?? env.BOT_MODEL_CONFIG_PATH;
  const modelConfigPath = configuredModel
    ? existingAbsoluteFile(configuredModel, "model router config")
    : undefined;
  if (apply && !modelConfigPath) {
    throw new CliConfigError(
      "missing_model_config",
      "Apply mode requires --model-config or BOT_MODEL_CONFIG_PATH.",
    );
  }

  return {
    apply,
    personaId,
    chatId,
    targetUserKey,
    consentBasis,
    dbPath,
    modelConfigPath,
  };
}

function requireNonEmpty(
  value: string | undefined,
  flag: string,
  name: string,
): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new CliConfigError(
      `missing_${name}`,
      `${flag} must be set to a non-empty value of at most 256 characters.`,
    );
  }
  return trimmed;
}

function requireConsentBasis(
  value: string | undefined,
): HumanPersonaConsentBasis {
  if (value === "confirmed_by_owner" || value === "self") {
    return value;
  }
  throw new CliConfigError(
    "missing_consent_basis",
    "--consent-basis must be exactly 'confirmed_by_owner' or 'self'; this records why the target's history may be analyzed and cannot be defaulted.",
  );
}

function existingAbsoluteFile(value: string, name: string): string {
  const expanded = expandHome(value);
  if (!isAbsolute(expanded)) {
    throw new CliConfigError(
      "relative_path",
      `${name} path must be absolute: ${value}`,
    );
  }
  const resolved = resolve(expanded);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new CliConfigError(
      "missing_path",
      `${name} does not exist: ${resolved}`,
    );
  }
  if (!stat.isFile()) {
    throw new CliConfigError(
      "not_a_file",
      `${name} must be a regular file: ${resolved}`,
    );
  }
  return realpathSync(resolved);
}

function expandHome(value: string): string {
  return value.startsWith("~") ? value.replace(/^~/, homedir()) : value;
}

function assertSingleLinkDatabase(path: string): void {
  const stat = lstatSync(path);
  if (stat.nlink !== 1) {
    throw new CliConfigError(
      "hardlink_database",
      "Style-profile database path must not have hardlink aliases.",
    );
  }
}

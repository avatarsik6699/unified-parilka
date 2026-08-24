import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface CliOptions {
  apply: boolean;
  chatId: string;
  dbPath: string;
  botToken?: string;
  modelConfigPath?: string;
  searxngEndpoint: string;
  firecrawlEndpoint: string;
  seenStorePath: string;
  maxItems: number;
  modelTotalTimeoutMs?: number;
  modelCandidateTimeoutMs?: number;
}

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
    const allowed = new Set([
      "--chat",
      "--db",
      "--bot-token",
      "--model-config",
      "--searxng-endpoint",
      "--firecrawl-endpoint",
      "--seen-store",
      "--max-items",
      "--model-total-timeout-ms",
      "--model-candidate-timeout-ms",
    ]);
    if (!allowed.has(argument)) {
      throw new NewsBriefCliConfigError(
        "unknown_argument",
        `Unknown argument: ${argument}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new NewsBriefCliConfigError(
        "missing_argument_value",
        `${argument} requires a value.`,
      );
    }
    if (values.has(argument)) {
      throw new NewsBriefCliConfigError(
        "duplicate_argument",
        `${argument} may be provided only once.`,
      );
    }
    values.set(argument, value);
    index += 1;
  }

  const chatId = telegramChatId(
    values.get("--chat") ??
      env.BOT_NEWS_BRIEF_CHAT_ID ??
      onlyAllowedChat(env.TELEGRAM_ALLOWED_CHAT_IDS),
  );
  assertMatchesAllowlist(chatId, env.TELEGRAM_ALLOWED_CHAT_IDS);

  const configuredDb =
    values.get("--db") ??
    env.BOT_NEWS_BRIEF_DB_PATH ??
    env.BOT_DB_PATH ??
    env.TELEGRAM_DB_PATH;
  if (!configuredDb) {
    throw new NewsBriefCliConfigError(
      "missing_db",
      "Set --db, BOT_NEWS_BRIEF_DB_PATH, BOT_DB_PATH, or TELEGRAM_DB_PATH.",
    );
  }
  const dbPath = existingAbsoluteFile(configuredDb, "news-brief database");
  assertSingleLinkDatabase(dbPath);
  assertSharedDatabaseIdentity(dbPath, env);

  const botToken = values.get("--bot-token") ?? env.BOT_TOKEN;
  if (apply && !botToken) {
    throw new NewsBriefCliConfigError(
      "missing_bot_token",
      "Apply mode requires --bot-token or BOT_TOKEN.",
    );
  }

  const configuredModel =
    values.get("--model-config") ??
    env.BOT_NEWS_BRIEF_MODEL_CONFIG_PATH ??
    env.BOT_MODEL_CONFIG_PATH;
  const modelConfigPath = configuredModel
    ? existingAbsoluteFile(configuredModel, "model router config")
    : undefined;
  if (apply && !modelConfigPath) {
    throw new NewsBriefCliConfigError(
      "missing_model_config",
      "Apply mode requires --model-config, BOT_NEWS_BRIEF_MODEL_CONFIG_PATH, or BOT_MODEL_CONFIG_PATH.",
    );
  }

  const seenStorePath =
    values.get("--seen-store") ??
    env.BOT_NEWS_BRIEF_SEEN_STORE_PATH ??
    join(dirname(dbPath), "news-brief-seen.json");

  const options: CliOptions = {
    apply,
    chatId,
    dbPath,
    botToken,
    modelConfigPath,
    searxngEndpoint:
      values.get("--searxng-endpoint") ??
      env.BOT_SEARXNG_ENDPOINT ??
      "http://127.0.0.1:8080",
    firecrawlEndpoint:
      values.get("--firecrawl-endpoint") ??
      env.BOT_FIRECRAWL_ENDPOINT ??
      "http://127.0.0.1:3002",
    seenStorePath,
    maxItems:
      integerOption(
        values.get("--max-items") ?? env.BOT_NEWS_BRIEF_MAX_ITEMS,
        "max items",
        1,
        10,
      ) ?? 6,
    modelTotalTimeoutMs: integerOption(
      values.get("--model-total-timeout-ms") ??
        env.BOT_NEWS_BRIEF_MODEL_TOTAL_TIMEOUT_MS,
      "model total timeout",
      1_000,
      10 * 60_000,
    ),
    modelCandidateTimeoutMs: integerOption(
      values.get("--model-candidate-timeout-ms") ??
        env.BOT_NEWS_BRIEF_MODEL_CANDIDATE_TIMEOUT_MS,
      "model candidate timeout",
      500,
      10 * 60_000,
    ),
  };

  return options;
}

function telegramChatId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^-\d{5,20}$/u.test(normalized)) {
    throw new NewsBriefCliConfigError(
      "invalid_chat",
      "News-brief chat id must be one negative Telegram chat id.",
    );
  }
  return normalized;
}

function onlyAllowedChat(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const chats = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chats.length !== 1) {
    throw new NewsBriefCliConfigError(
      "invalid_allowlist",
      "TELEGRAM_ALLOWED_CHAT_IDS must contain exactly one chat for news-brief generation.",
    );
  }
  return chats[0];
}

function assertMatchesAllowlist(
  chatId: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const allowed = telegramChatId(onlyAllowedChat(value));
  if (allowed !== chatId) {
    throw new NewsBriefCliConfigError(
      "chat_not_allowlisted",
      "News-brief chat id does not match TELEGRAM_ALLOWED_CHAT_IDS.",
    );
  }
}

function existingAbsoluteFile(value: string, name: string): string {
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) {
    throw new NewsBriefCliConfigError(
      "path_not_absolute",
      `${name} path must be absolute.`,
    );
  }
  const path = realpathSync(resolve(expanded));
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new NewsBriefCliConfigError(
      "path_not_file",
      `${name} path must name a regular file.`,
    );
  }
  return path;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function assertSharedDatabaseIdentity(
  selectedPath: string,
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const [name, value] of [
    ["BOT_DB_PATH", env.BOT_DB_PATH],
    ["TELEGRAM_DB_PATH", env.TELEGRAM_DB_PATH],
  ] as const) {
    if (!value) {
      continue;
    }
    const configured = existingAbsoluteFile(value, name);
    const selected = statSync(selectedPath);
    const candidate = statSync(configured);
    if (selectedPath !== configured) {
      throw new NewsBriefCliConfigError(
        "database_path_mismatch",
        `${name} must resolve to the same canonical pathname as the selected shared database; a different hardlink path is unsafe with SQLite WAL.`,
      );
    }
    if (selected.dev !== candidate.dev || selected.ino !== candidate.ino) {
      throw new NewsBriefCliConfigError(
        "database_identity_mismatch",
        `${name} does not identify the selected shared database.`,
      );
    }
  }
}

function assertSingleLinkDatabase(path: string): void {
  if (statSync(path).nlink !== 1) {
    throw new NewsBriefCliConfigError(
      "database_has_hardlinks",
      "News-brief database must not have hardlink aliases; use its one canonical pathname.",
    );
  }
}

function integerOption(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value.trim())) {
    throw new NewsBriefCliConfigError(
      "invalid_integer",
      `${name} must be an integer.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new NewsBriefCliConfigError(
      "integer_out_of_range",
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

export class NewsBriefCliConfigError extends Error {
  readonly name = "NewsBriefCliConfigError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

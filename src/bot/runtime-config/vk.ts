import type { BotRuntimeConfig, BotRuntimeEnvironment } from "./contracts.js";
import { integer } from "./env-rules.js";

const DEFAULT_API_VERSION = "5.199";
const MAX_GROUP_TOKEN_CHARS = 512;
const DEFAULT_HISTORY_BACKFILL_LIMIT = 1_000;

/**
 * Off by default: VK is an opt-in second transport. An absent/blank
 * BOT_VK_GROUP_TOKEN means the process never constructs a VK client and
 * `config/bots.json` must not contain a `transport: "vk"` entry (enforced
 * in `validateBotRuntimeRelationships`, mirroring the news-brief-trigger
 * presence-gated pattern).
 */
export function optionalVkConfig(
  env: BotRuntimeEnvironment,
): Pick<BotRuntimeConfig, "vk"> | Record<never, never> {
  const groupToken = env.BOT_VK_GROUP_TOKEN?.trim();
  if (!groupToken) {
    return {};
  }
  if (
    groupToken.length > MAX_GROUP_TOKEN_CHARS ||
    !/^[\x21-\x7e]+$/u.test(groupToken)
  ) {
    throw new Error(
      `BOT_VK_GROUP_TOKEN must be a non-empty safe HTTP header value no longer than ${String(MAX_GROUP_TOKEN_CHARS)} characters.`,
    );
  }
  if (env.BOT_VK_GROUP_ID === undefined) {
    throw new Error(
      "BOT_VK_GROUP_ID is required when BOT_VK_GROUP_TOKEN is set.",
    );
  }
  const groupId = integer(
    env.BOT_VK_GROUP_ID,
    "BOT_VK_GROUP_ID",
    0,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const apiVersion = env.BOT_VK_API_VERSION?.trim() || DEFAULT_API_VERSION;
  if (!/^\d{1,2}\.\d{1,4}$/u.test(apiVersion)) {
    throw new Error('BOT_VK_API_VERSION must look like "5.199".');
  }
  const userToken = env.BOT_VK_USER_TOKEN?.trim();
  if (
    userToken !== undefined &&
    (userToken.length > MAX_GROUP_TOKEN_CHARS ||
      !/^[\x21-\x7e]+$/u.test(userToken))
  ) {
    throw new Error(
      `BOT_VK_USER_TOKEN must be a non-empty safe HTTP header value no longer than ${String(MAX_GROUP_TOKEN_CHARS)} characters.`,
    );
  }
  const historyBackfillLimit = integer(
    env.BOT_VK_HISTORY_BACKFILL_LIMIT,
    "BOT_VK_HISTORY_BACKFILL_LIMIT",
    DEFAULT_HISTORY_BACKFILL_LIMIT,
    0,
    100_000,
  );
  return {
    vk: {
      groupToken,
      groupId,
      apiVersion,
      historyBackfillLimit,
      ...(userToken ? { userToken } : {}),
    },
  };
}

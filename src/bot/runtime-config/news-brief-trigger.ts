import type { BotRuntimeConfig, BotRuntimeEnvironment } from "./contracts.js";
import { absolutePath, telegramId } from "./env-rules.js";

/**
 * Off by default: an absent/blank BOT_NEWS_BRIEF_TRIGGER_USER_ID means
 * nobody can trigger an early news-brief run from chat -- only the
 * scheduled `bot-agi-news-brief.timer`, if separately enabled, ever runs it.
 */
export function optionalNewsBriefTriggerConfig(
  env: BotRuntimeEnvironment,
): Pick<BotRuntimeConfig, "newsBriefTrigger"> | Record<never, never> {
  const raw = env.BOT_NEWS_BRIEF_TRIGGER_USER_ID?.trim();
  if (!raw) {
    return {};
  }
  const triggerUserId = telegramId(
    raw,
    "BOT_NEWS_BRIEF_TRIGGER_USER_ID",
    "positive",
  );
  const seenStorePath = env.BOT_NEWS_BRIEF_SEEN_STORE_PATH?.trim();
  return {
    newsBriefTrigger: {
      triggerUserId,
      ...(seenStorePath
        ? {
            seenStorePath: absolutePath(
              seenStorePath,
              "BOT_NEWS_BRIEF_SEEN_STORE_PATH",
            ),
          }
        : {}),
    },
  };
}

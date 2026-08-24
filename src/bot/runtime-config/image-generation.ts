import type { BotRuntimeConfig, BotRuntimeEnvironment } from "./contracts.js";
import { booleanFlag, integer } from "./env-rules.js";
import { requireHttpsBaseUrl } from "../web-tools/url-validation.js";

const DEFAULT_ENDPOINT = "https://api.runware.ai/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PER_TURN = 1;
const DEFAULT_MAX_PER_CHAT_PER_DAY = 20;

/**
 * Off by default: the feature only activates when the operator explicitly
 * sets BOT_IMAGE_GENERATION_ENABLED=true and provides RUNWARE_API_KEY. This
 * keeps a cost-incurring, platform-ToS-adjacent capability opt-in rather
 * than silently available whenever a key happens to be present.
 */
export function optionalImageGenerationConfig(
  env: BotRuntimeEnvironment,
): Pick<BotRuntimeConfig, "imageGeneration"> | Record<never, never> {
  const enabled = booleanFlag(
    env.BOT_IMAGE_GENERATION_ENABLED,
    "BOT_IMAGE_GENERATION_ENABLED",
    false,
  );
  if (!enabled) {
    return {};
  }
  const apiKey = env.RUNWARE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "RUNWARE_API_KEY is required when BOT_IMAGE_GENERATION_ENABLED=true.",
    );
  }
  return {
    imageGeneration: {
      provider: "runware",
      apiKey,
      endpoint: requireHttpsBaseUrl(
        env.BOT_IMAGE_GENERATION_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
      ),
      timeoutMs: integer(
        env.BOT_IMAGE_GENERATION_TIMEOUT_MS,
        "BOT_IMAGE_GENERATION_TIMEOUT_MS",
        DEFAULT_TIMEOUT_MS,
        1_000,
        5 * 60_000,
      ),
      nsfwAllowed: booleanFlag(
        env.BOT_IMAGE_GENERATION_NSFW_ALLOWED,
        "BOT_IMAGE_GENERATION_NSFW_ALLOWED",
        false,
      ),
      maxImagesPerTurn: integer(
        env.BOT_IMAGE_GENERATION_MAX_PER_TURN,
        "BOT_IMAGE_GENERATION_MAX_PER_TURN",
        DEFAULT_MAX_PER_TURN,
        1,
        10,
      ),
      maxImagesPerChatPerDay: integer(
        env.BOT_IMAGE_GENERATION_MAX_PER_CHAT_PER_DAY,
        "BOT_IMAGE_GENERATION_MAX_PER_CHAT_PER_DAY",
        DEFAULT_MAX_PER_CHAT_PER_DAY,
        1,
        500,
      ),
    },
  };
}

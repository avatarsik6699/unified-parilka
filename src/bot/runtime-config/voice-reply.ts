import type { BotRuntimeConfig, BotRuntimeEnvironment } from "./contracts.js";
import { booleanFlag, integer } from "./env-rules.js";
import { requireHttpsBaseUrl } from "../web-tools/url-validation.js";

const DEFAULT_ENDPOINT = "https://api.runware.ai/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PER_TURN = 1;
const DEFAULT_MAX_PER_CHAT_PER_DAY = 20;

/**
 * Off by default, mirroring `optionalImageGenerationConfig`: the feature
 * only activates when the operator explicitly sets
 * BOT_VOICE_REPLY_ENABLED=true and provides RUNWARE_API_KEY -- the same
 * Runware key used for image generation, since both are the same provider
 * account, but each feature stays independently opt-in.
 */
export function optionalVoiceReplyConfig(
  env: BotRuntimeEnvironment,
): Pick<BotRuntimeConfig, "voiceReply"> | Record<never, never> {
  const enabled = booleanFlag(
    env.BOT_VOICE_REPLY_ENABLED,
    "BOT_VOICE_REPLY_ENABLED",
    false,
  );
  if (!enabled) {
    return {};
  }
  const apiKey = env.RUNWARE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "RUNWARE_API_KEY is required when BOT_VOICE_REPLY_ENABLED=true.",
    );
  }
  return {
    voiceReply: {
      provider: "runware",
      apiKey,
      endpoint: requireHttpsBaseUrl(
        env.BOT_VOICE_REPLY_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
      ),
      timeoutMs: integer(
        env.BOT_VOICE_REPLY_TIMEOUT_MS,
        "BOT_VOICE_REPLY_TIMEOUT_MS",
        DEFAULT_TIMEOUT_MS,
        1_000,
        5 * 60_000,
      ),
      maxRepliesPerTurn: integer(
        env.BOT_VOICE_REPLY_MAX_PER_TURN,
        "BOT_VOICE_REPLY_MAX_PER_TURN",
        DEFAULT_MAX_PER_TURN,
        1,
        10,
      ),
      maxRepliesPerChatPerDay: integer(
        env.BOT_VOICE_REPLY_MAX_PER_CHAT_PER_DAY,
        "BOT_VOICE_REPLY_MAX_PER_CHAT_PER_DAY",
        DEFAULT_MAX_PER_CHAT_PER_DAY,
        1,
        500,
      ),
    },
  };
}

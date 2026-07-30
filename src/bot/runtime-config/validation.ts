import type {
  BotRuntimeConfig,
  BotRuntimeEnvironment,
} from "./contracts.js";

const SHUTDOWN_CLOSE_GRACE_MS = 5_000;

export function assertBotTokenShape(token: string): void {
  if (!/^\d{1,16}:[A-Za-z0-9_-]{20,}$/u.test(token)) {
    throw new Error(
      "PARILKA_BOT_TOKEN has an invalid Bot API token shape.",
    );
  }
}

export function assertExclusivePoller(
  env: BotRuntimeEnvironment,
): void {
  if (env.PARILKA_BOT_EXCLUSIVE_POLLER?.trim() !== "true") {
    throw new Error(
      "PARILKA_BOT_EXCLUSIVE_POLLER must be exactly true after every other getUpdates poller for this token has been stopped.",
    );
  }
}

export function validateBotRuntimeRelationships(
  config: Readonly<BotRuntimeConfig>,
): void {
  if (config.pollBackoffMaxMs < config.pollBackoffInitialMs) {
    throw new Error(
      "PARILKA_BOT_POLL_BACKOFF_MAX_MS must be greater than or equal to PARILKA_BOT_POLL_BACKOFF_INITIAL_MS.",
    );
  }
  if (
    config.shutdownTimeoutMs <
    config.turnTimeoutMs +
      config.publishTimeoutMs +
      SHUTDOWN_CLOSE_GRACE_MS
  ) {
    throw new Error(
      "PARILKA_BOT_SHUTDOWN_TIMEOUT_MS must cover PARILKA_BOT_TURN_TIMEOUT_MS + PARILKA_BOT_PUBLISH_TIMEOUT_MS + 5000ms close grace.",
    );
  }
}

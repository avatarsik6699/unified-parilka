import { safeBotRuntimeConfig } from "../bot/runtime-config.js";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import type { ProductionBotDaemon } from "./contracts.js";
import { runBotDaemonLifecycle } from "./lifecycle.js";
import { createProductionBotDaemon } from "./production.js";

export async function main(): Promise<void> {
  let logger: ReturnType<typeof createLogger> | undefined;
  let deployment: ProductionBotDaemon | undefined;
  try {
    logger = createLogger({ service: "bot" });
    deployment = createProductionBotDaemon({ logger });
    logger.info({
      event: "bot.runtime.configured",
      config: safeBotRuntimeConfig(deployment.config),
      vectorEnabled: deployment.vectorEnabled,
      webSearchEnabled: deployment.webSearchEnabled,
    });
    const drain = await runBotDaemonLifecycle(deployment);
    if (!drain.drained) {
      logger.error({
        event: "bot.runtime.ungraceful_exit",
        activeWorkers: drain.activeWorkers,
      });
      process.exitCode = 1;
    }
  } catch (error) {
    if (logger) {
      logger.error({
        event: "bot.runtime.fatal",
        failure: safeError(error),
      });
    } else {
      process.stderr.write(
        '{"service":"bot","event":"bot.runtime.logger_init_failed","level":"error"}\n',
      );
    }
    process.exitCode = 1;
  } finally {
    try {
      deployment?.close();
    } finally {
      try {
        logger?.flush();
      } catch {
        // Telemetry failure cannot hide the exit code or keep SQLite open.
      }
    }
  }
}

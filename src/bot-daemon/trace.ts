import type { TurnCoordinatorOptions } from "../bot/turn-coordinator.js";
import type { JsonEventLogger } from "../bot/worker.js";

export function coordinatorTraceOptions(
  logger: JsonEventLogger | undefined,
): Pick<TurnCoordinatorOptions, "onTrace"> | Record<never, never> {
  if (!logger) {
    return {};
  }
  return {
    onTrace(event) {
      logger.info(event);
    },
  };
}

export function safeDaemonLog(
  logger: JsonEventLogger | undefined,
  level: "info" | "warn" | "error",
  record: Readonly<Record<string, unknown>>,
): void {
  try {
    logger?.[level](record);
  } catch {
    // Telemetry cannot control signal delivery, shutdown, or store ownership.
  }
}

import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  type BotTurnWorkerOptions,
  type JsonEventLogger,
  type WorkerScheduler,
} from "./contracts.js";
import {
  boundedInteger,
  requireNonEmpty,
} from "./helpers.js";
import { SYSTEM_SCHEDULER } from "./timers.js";

export interface BotTurnWorkerSettings {
  workerId: string;
  allowedChatId: string;
  mode: "live" | "shadow";
  leaseMs: number;
  heartbeatMs: number;
  turnTimeoutMs: number;
  publishTimeoutMs: number;
  logger: JsonEventLogger | undefined;
  scheduler: WorkerScheduler;
  now: () => number;
}

export function resolveBotTurnWorkerSettings(
  options: BotTurnWorkerOptions,
): BotTurnWorkerSettings {
  const workerId = requireNonEmpty(options.workerId, "workerId");
  const allowedChatId = requireNonEmpty(
    options.allowedChatId,
    "allowedChatId",
  );
  const mode = options.mode;
  const leaseMs = boundedInteger(
    options.leaseMs ?? DEFAULT_LEASE_MS,
    100,
    15 * 60_000,
    "leaseMs",
  );
  const defaultHeartbeatMs = Math.min(
    DEFAULT_HEARTBEAT_MS,
    Math.max(10, Math.floor(leaseMs / 3)),
  );
  const heartbeatMs = boundedInteger(
    options.heartbeatMs ?? defaultHeartbeatMs,
    10,
    leaseMs - 1,
    "heartbeatMs",
  );
  return {
    workerId,
    allowedChatId,
    mode,
    leaseMs,
    heartbeatMs,
    turnTimeoutMs: boundedInteger(
      options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      100,
      15 * 60_000,
      "turnTimeoutMs",
    ),
    publishTimeoutMs: boundedInteger(
      options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
      100,
      5 * 60_000,
      "publishTimeoutMs",
    ),
    logger: options.logger,
    scheduler: options.scheduler ?? SYSTEM_SCHEDULER,
    now: options.now ?? Date.now,
  };
}

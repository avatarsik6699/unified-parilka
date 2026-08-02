#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createLogger } from "./observability/logger.js";
import { safeError } from "./observability/redaction.js";
import {
  runSyncDaemon,
  runSyncOnce,
} from "./sync/daemon-runner.js";

export { assertExclusiveMtprotoOwner } from "./telegram/exclusive-owner.js";
export {
  classifyDaemonErrors,
  computeDaemonDelayMs,
  destroyTelegramBestEffort,
  disconnectTelegramBestEffort,
  recordDaemonOutcome,
  shouldStopDaemonForErrors,
  syncErrors,
} from "./sync/daemon-policy.js";
export {
  EmbeddingCadenceRunner,
  indexEmbeddings,
  type EmbeddingCadenceOptions,
  type EmbeddingCadenceSnapshot,
  type EmbeddingIndexReport,
} from "./sync/embedding-cadence.js";

const logger = createLogger({ service: "sync" });

const once = process.argv.includes("--once");
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.once("uncaughtException", (error) => {
    try {
      logger.fatal({ event: "sync.runtime.uncaught", failure: safeError(error) });
      logger.flush();
    } catch { /* last-resort handler must not throw */ }
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    try {
      logger.fatal({ event: "sync.runtime.unhandled_rejection", failure: safeError(reason) });
      logger.flush();
    } catch { /* last-resort handler must not throw */ }
    process.exit(1);
  });

  (once ? runSyncOnce() : runSyncDaemon())
    .then(() => {
      if (!once) {
        terminateDaemonProcess(0);
      }
    })
    .catch((error) => {
      logger.error({
        event: "sync.fatal",
        failure: safeError(error),
      });
      if (!once) {
        terminateDaemonProcess(1);
      }
      process.exitCode = 1;
    });
}

/**
 * mtcute 0.31 can leave completed RPC timeout handles referenced after its
 * client and SQLite storage have both been destroyed. At this point the
 * runner has already emitted sync.shutdown_completed, so forcing the daemon
 * process boundary is safe and avoids a roughly two-minute systemd stop.
 */
function terminateDaemonProcess(exitCode: number): never {
  logger.flush();
  process.exit(exitCode);
}

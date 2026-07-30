import { loadConfig } from "../config.js";
import { normalizeError, type NormalizedError } from "../errors.js";
import { stringify } from "../json.js";
import { LoopbackMcpServer } from "../mcp-loopback.js";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import { MessageStore } from "../store.js";
import { assertExclusiveMtprotoOwner } from "../telegram/exclusive-owner.js";
import { createTelegramGateway } from "../telegram/gateway-factory.js";
import type { TelegramGateway } from "../telegram/types.js";
import { TelegramTools } from "../tools.js";
import { VectorRag } from "../vector-rag.js";
import type { SyncOnceResult } from "./contracts.js";
import {
  classifyDaemonErrors,
  computeDaemonDelayMs,
  destroyTelegramBestEffort,
  recordDaemonOutcome,
  recordDaemonStarted,
  stopOnPermanentDaemonErrors,
  summarizeSyncResult,
  syncErrors,
} from "./daemon-policy.js";
import {
  EmbeddingCadenceRunner,
  type EmbeddingCadenceSnapshot,
} from "./embedding-cadence.js";
import { HistorySyncer } from "./history-syncer.js";
import { SerializedHistorySyncer } from "./serialized.js";

const logger = createLogger({ service: "sync" });

export async function runSyncOnce(): Promise<void> {
  assertExclusiveMtprotoOwner();
  const config = loadConfig();
  const store = new MessageStore(config.storage.dbPath);
  let telegram: TelegramGateway | undefined;
  try {
    telegram = await createTelegramGateway(config);
    const syncer = new HistorySyncer(config, telegram, store);
    const result = await syncer.syncOnce();
    process.stdout.write(`${stringify({ ok: true, result })}\n`);
  } finally {
    if (telegram) {
      await destroyTelegramBestEffort(telegram);
    }
    store.close();
  }
}

export async function runSyncDaemon(): Promise<void> {
  assertExclusiveMtprotoOwner();
  const config = loadConfig();
  const store = new MessageStore(config.storage.dbPath);
  let telegram: TelegramGateway | undefined;
  try {
    telegram = await createTelegramGateway(config);
  } catch (error) {
    store.close();
    throw error;
  }

  const shutdown = new AbortController();
  const syncer = new SerializedHistorySyncer(
    new HistorySyncer(
      config,
      telegram,
      store,
      undefined,
      shutdown.signal,
    ),
  );
  const vectorRag = new VectorRag(config, store);
  const embeddingCadence = new EmbeddingCadenceRunner(
    vectorRag,
    {
      intervalMs: config.embeddings.tickIntervalMs,
      budgetMs: config.embeddings.tickBudgetMs,
      retryMaxMs: config.embeddings.retryMaxMs,
      shutdownSignal: shutdown.signal,
      onReport(report) {
        logger[report?.failure ? "warn" : "info"]({
          event: report?.failure
            ? "embeddings.tick_degraded"
            : "embeddings.tick_completed",
          report,
        });
      },
    },
  );
  const mcp = new LoopbackMcpServer({
    registry: new TelegramTools(
      config,
      telegram,
      store,
      syncer,
    ),
    onError(error) {
      logger.error({
        event: "mcp.loopback.request_failed",
        failure: normalizeError(error),
      });
    },
  });
  const intervalMs = Math.max(5_000, config.sync.intervalMs);
  const requestShutdown = (signal: NodeJS.Signals): void => {
    logger.info({ event: "sync.shutdown_requested", signal });
    shutdown.abort();
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  let backoffMs = 0;

  try {
    const mcpUrl = await mcp.start();
    logger.info({
      event: "sync.started",
      intervalMs,
      transport: config.telegram.transport,
      mcpEndpoint: mcpUrl.href,
      embeddingIntervalMs: config.embeddings.tickIntervalMs,
      embeddingBudgetMs: config.embeddings.tickBudgetMs,
    });
    while (!shutdown.signal.aborted) {
      const started = Date.now();
      let coreErrors: NormalizedError[] = [];
      let result: SyncOnceResult | undefined;
      let tickError: NormalizedError | undefined;
      let embeddings: EmbeddingCadenceSnapshot =
        embeddingCadence.snapshot();
      recordDaemonStarted(store);

      try {
        result = await syncer.syncOnce();
        throwIfDaemonAborted(shutdown.signal);
        coreErrors = syncErrors(result);
        embeddings = embeddingCadence.offer(result.chat);
      } catch (error) {
        if (shutdown.signal.aborted) {
          break;
        }
        tickError = normalizeError(error);
        coreErrors = [tickError];
      }

      const embeddingFailure =
        embeddingCadence.healthFailure();
      const errorPolicy = classifyDaemonErrors(
        coreErrors,
        embeddingFailure,
      );
      recordDaemonOutcome(store, errorPolicy.healthErrors);
      logTick({
        started,
        tickError,
        coreErrors,
        healthErrors: errorPolicy.healthErrors,
        result,
        embeddings,
        store,
      });

      // Only core Telegram failures can stop or back off the history owner.
      // Optional embedding health is still reflected in daemon status.
      stopOnPermanentDaemonErrors(errorPolicy.stopErrors);
      if (shutdown.signal.aborted) {
        break;
      }
      const delay = computeDaemonDelayMs({
        intervalMs,
        elapsedMs: Date.now() - started,
        errors: errorPolicy.delayErrors,
        previousBackoffMs: backoffMs,
        backoffInitialMs:
          config.sync.transientBackoffInitialMs,
        backoffMaxMs: config.sync.transientBackoffMaxMs,
        retryAfterMaxMs:
          config.sync.transientBackoffMaxMs,
      });
      backoffMs = delay.nextBackoffMs;
      if (delay.reason !== "interval") {
        logger.warn({ event: "sync.backoff", ...delay });
      }
      await abortableSleep(delay.delayMs, shutdown.signal);
    }
  } finally {
    const shutdownStartedAtMs = Date.now();
    let shutdownDegraded = false;
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    shutdown.abort();
    let stageStartedAtMs = Date.now();
    await embeddingCadence.settle().catch((error) => {
      shutdownDegraded = true;
      logger.warn({
        event: "embeddings.shutdown_failed",
        failure: safeError(error),
      });
    });
    logShutdownStage(
      "embeddings",
      stageStartedAtMs,
      shutdownStartedAtMs,
    );
    stageStartedAtMs = Date.now();
    try {
      await mcp.close();
    } catch (error) {
      shutdownDegraded = true;
      logger.error({
        event: "mcp.loopback.shutdown_failed",
        failure: safeError(error),
      });
    }
    logShutdownStage("mcp", stageStartedAtMs, shutdownStartedAtMs);
    stageStartedAtMs = Date.now();
    const telegramFailure =
      await destroyTelegramBestEffort(telegram);
    shutdownDegraded ||= telegramFailure !== undefined;
    logShutdownStage(
      "telegram",
      stageStartedAtMs,
      shutdownStartedAtMs,
    );
    stageStartedAtMs = Date.now();
    store.close();
    logShutdownStage(
      "storage",
      stageStartedAtMs,
      shutdownStartedAtMs,
    );
    logger[shutdownDegraded ? "warn" : "info"]({
      event: "sync.shutdown_completed",
      status: shutdownDegraded ? "degraded" : "ok",
      durationMs: Math.max(0, Date.now() - shutdownStartedAtMs),
    });
  }
}

function logShutdownStage(
  stage: "embeddings" | "mcp" | "telegram" | "storage",
  startedAtMs: number,
  shutdownStartedAtMs: number,
): void {
  logger.info({
    event: "sync.shutdown_stage_completed",
    stage,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    totalDurationMs: Math.max(
      0,
      Date.now() - shutdownStartedAtMs,
    ),
  });
}

function logTick(params: {
  started: number;
  tickError?: NormalizedError;
  coreErrors: NormalizedError[];
  healthErrors: NormalizedError[];
  result?: SyncOnceResult;
  embeddings: EmbeddingCadenceSnapshot;
  store: MessageStore;
}): void {
  const payload = {
    durationMs: Math.max(0, Date.now() - params.started),
    recent: summarizeSyncResult(params.result?.recent),
    backfill: summarizeSyncResult(params.result?.backfill),
    embeddings: params.embeddings,
    coreErrors:
      params.coreErrors.length > 0
        ? params.coreErrors
        : undefined,
    healthErrors:
      params.healthErrors.length > 0
        ? params.healthErrors
        : undefined,
    daemonStatus: params.store.getDaemonStatus(),
  };
  if (params.tickError) {
    logger.error({
      event: "sync.tick_failed",
      failure: params.tickError,
      ...payload,
    });
    return;
  }
  logger[params.healthErrors.length > 0 ? "warn" : "info"]({
    event:
      params.healthErrors.length > 0
        ? "sync.tick_degraded"
        : "sync.tick_completed",
    ...payload,
  });
}

async function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, Math.max(0, delayMs));
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function throwIfDaemonAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Sync daemon was aborted.", "AbortError");
  }
}

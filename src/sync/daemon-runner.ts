import { loadConfig } from "../config.js";
import { normalizeError, type NormalizedError } from "../errors.js";
import {
  AiSdkTriggerDecisionPort,
  loadHumanPersonaTriggerConfigFromEnv,
  runHumanPersonaRegenerate,
  runHumanPersonaTriggerTick,
  type HumanPersonaTriggerTickReport,
} from "../human-persona-trigger.js";
import {
  runHumanPersonaSendTick,
  type HumanPersonaSendTickReport,
} from "../human-persona-send.js";
import { stringify } from "../json.js";
import { LoopbackMcpServer } from "../mcp-loopback.js";
import { createLogger } from "../observability/logger.js";
import { safeError } from "../observability/redaction.js";
import { ModelRouter } from "../providers/model-router.js";
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
  findPermanentDaemonError,
  recordDaemonOutcome,
  recordDaemonStarted,
  summarizeSyncResult,
  syncErrors,
  waitForDaemonShutdown,
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
    new HistorySyncer(config, telegram, store, undefined, shutdown.signal),
  );
  const vectorRag = new VectorRag(config, store);
  const embeddingCadence = new EmbeddingCadenceRunner(vectorRag, {
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
  });
  const mcp = new LoopbackMcpServer({
    registry: new TelegramTools(config, telegram, store, syncer),
    onError(error) {
      logger.error({
        event: "mcp.loopback.request_failed",
        failure: normalizeError(error),
      });
    },
  });
  const { trigger: humanPersonaTrigger, send: humanPersonaSend } =
    buildHumanPersonaRunners(store, telegram, process.env);
  const intervalMs = Math.max(5_000, config.sync.intervalMs);
  const requestShutdown = (signal: NodeJS.Signals): void => {
    logger.info({ event: "sync.shutdown_requested", signal });
    shutdown.abort();
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

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
    await runSyncDaemonLoop({
      signal: shutdown.signal,
      store,
      intervalMs,
      backoffInitialMs: config.sync.transientBackoffInitialMs,
      backoffMaxMs: config.sync.transientBackoffMaxMs,
      retryAfterMaxMs: config.sync.transientBackoffMaxMs,
      tick: () => syncer.syncOnce(),
      embeddings: embeddingCadence,
      humanPersonaTrigger,
      humanPersonaSend,
    });
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
    logShutdownStage("embeddings", stageStartedAtMs, shutdownStartedAtMs);
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
    const telegramFailure = await destroyTelegramBestEffort(telegram);
    shutdownDegraded ||= telegramFailure !== undefined;
    logShutdownStage("telegram", stageStartedAtMs, shutdownStartedAtMs);
    stageStartedAtMs = Date.now();
    store.close();
    logShutdownStage("storage", stageStartedAtMs, shutdownStartedAtMs);
    logger[shutdownDegraded ? "warn" : "info"]({
      event: "sync.shutdown_completed",
      status: shutdownDegraded ? "degraded" : "ok",
      durationMs: Math.max(0, Date.now() - shutdownStartedAtMs),
    });
  }
}

/**
 * The three embedding interactions the daemon loop needs. `EmbeddingCadenceRunner`
 * satisfies this structurally, and tests may substitute an inert port.
 */
export interface DaemonEmbeddingPort {
  snapshot(): EmbeddingCadenceSnapshot;
  offer(chatId: string | undefined): EmbeddingCadenceSnapshot;
  healthFailure(): NormalizedError | undefined;
}

export type SyncDaemonLoopExit =
  { reason: "shutdown" } | { reason: "cache_only"; failure: NormalizedError };

export interface SyncDaemonLoopOptions {
  signal: AbortSignal;
  store: MessageStore;
  intervalMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  retryAfterMaxMs: number;
  tick: () => Promise<SyncOnceResult>;
  embeddings: DaemonEmbeddingPort;
  /**
   * Optional human-persona trigger evaluation (plan Фаза 4e/5 Шаг 4),
   * undefined when no persona is configured. Runs best-effort after a
   * successful sync tick: a failure here is logged and never affects sync
   * backoff/exit, the same isolation `DaemonEmbeddingPort` already has.
   */
  humanPersonaTrigger?: {
    run: () => Promise<HumanPersonaTriggerTickReport>;
  };
  /** Plan Фаза 4c/4d/5 Шаг 6: same best-effort isolation as `humanPersonaTrigger`. */
  humanPersonaSend?: {
    run: () => Promise<HumanPersonaSendTickReport>;
  };
}

/**
 * One automatic sync-tick state machine: record started, tick, record outcome,
 * then either back off for the next tick, exit on shutdown, or transition to
 * cache-only degraded mode after a non-retryable core Telegram auth failure.
 */
export async function runSyncDaemonLoop(
  options: SyncDaemonLoopOptions,
): Promise<SyncDaemonLoopExit> {
  let backoffMs = 0;
  while (!options.signal.aborted) {
    const started = Date.now();
    let coreErrors: NormalizedError[] = [];
    let result: SyncOnceResult | undefined;
    let tickError: NormalizedError | undefined;
    let embeddings = options.embeddings.snapshot();
    recordDaemonStarted(options.store);

    try {
      result = await options.tick();
      throwIfDaemonAborted(options.signal);
      coreErrors = syncErrors(result);
      embeddings = options.embeddings.offer(result.chat);
    } catch (error) {
      if (options.signal.aborted) {
        return { reason: "shutdown" };
      }
      tickError = normalizeError(error);
      coreErrors = [tickError];
    }

    if (options.humanPersonaTrigger && !tickError) {
      try {
        const report = await options.humanPersonaTrigger.run();
        logger[report.status === "failed" ? "warn" : "info"]({
          event: "human_persona_trigger.tick_completed",
          report,
        });
      } catch (error) {
        logger.warn({
          event: "human_persona_trigger.tick_failed",
          failure: safeError(error),
        });
      }
    }

    // Unlike the trigger, sending an already-decided proposal needs
    // nothing from this tick's sync result, so it runs even after a
    // failed tick.
    if (options.humanPersonaSend) {
      try {
        const report = await options.humanPersonaSend.run();
        logger[
          report.status === "send_failed" ||
          report.status === "regenerate_failed"
            ? "warn"
            : "info"
        ]({
          event: "human_persona_send.tick_completed",
          report,
        });
      } catch (error) {
        logger.warn({
          event: "human_persona_send.tick_failed",
          failure: safeError(error),
        });
      }
    }

    const embeddingFailure = options.embeddings.healthFailure();
    const errorPolicy = classifyDaemonErrors(coreErrors, embeddingFailure);
    recordDaemonOutcome(options.store, errorPolicy.healthErrors);
    logTick({
      started,
      tickError,
      coreErrors,
      healthErrors: errorPolicy.healthErrors,
      result,
      embeddings,
      store: options.store,
    });

    // Only core Telegram failures can stop automatic sync attempts or back
    // the loop off; optional embedding health stays visible in daemon status.
    // A non-retryable auth failure (e.g. AUTH_KEY_UNREGISTERED) ends automatic
    // sync attempts, but the process must survive in cache-only mode: cached
    // SQLite reads remain available, while explicit MCP-triggered sync calls
    // may still fail independently until the session is repaired.
    const permanentError = findPermanentDaemonError(errorPolicy.stopErrors);
    if (permanentError) {
      logger.error({
        event: "sync.cache_only_started",
        failure: permanentError,
        daemonStatus: options.store.getDaemonStatus(),
        message:
          "Automatic daemon sync attempts stopped; cache-only SQLite reads " +
          "remain available. Explicit MCP-triggered syncs may still fail " +
          "until the session is repaired.",
      });
      await waitForDaemonShutdown(options.signal);
      return { reason: "cache_only", failure: permanentError };
    }
    if (options.signal.aborted) {
      return { reason: "shutdown" };
    }
    const delay = computeDaemonDelayMs({
      intervalMs: options.intervalMs,
      elapsedMs: Date.now() - started,
      errors: errorPolicy.delayErrors,
      previousBackoffMs: backoffMs,
      backoffInitialMs: options.backoffInitialMs,
      backoffMaxMs: options.backoffMaxMs,
      retryAfterMaxMs: options.retryAfterMaxMs,
    });
    backoffMs = delay.nextBackoffMs;
    if (delay.reason !== "interval") {
      logger.warn({ event: "sync.backoff", ...delay });
    }
    await abortableSleep(delay.delayMs, options.signal);
  }
  return { reason: "shutdown" };
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
    totalDurationMs: Math.max(0, Date.now() - shutdownStartedAtMs),
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
    coreErrors: params.coreErrors.length > 0 ? params.coreErrors : undefined,
    healthErrors:
      params.healthErrors.length > 0 ? params.healthErrors : undefined,
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

/**
 * Builds the optional trigger and send runners passed to
 * `runSyncDaemonLoop` (plan Фаза 4e/4d/5 Шаг 4/6). Both return undefined
 * whenever no persona is configured or no model router path is set — this
 * is an opt-in feature (see `human-persona-trigger/config.ts`), so a
 * missing/broken model config disables it rather than failing sync
 * startup. They share one config/port: the send-tick's "regenerate" path
 * is the same LLM decision call the trigger-engine itself uses, just
 * ungated (see `runHumanPersonaRegenerate`).
 */
function buildHumanPersonaRunners(
  store: MessageStore,
  telegram: TelegramGateway,
  env: Readonly<Record<string, string | undefined>>,
): {
  trigger: SyncDaemonLoopOptions["humanPersonaTrigger"];
  send: SyncDaemonLoopOptions["humanPersonaSend"];
} {
  const config = loadHumanPersonaTriggerConfigFromEnv(env);
  if (!config) {
    return { trigger: undefined, send: undefined };
  }
  const modelConfigPath = env.BOT_MODEL_CONFIG_PATH;
  if (!modelConfigPath) {
    logger.warn({
      event: "human_persona_trigger.disabled",
      reason: "missing_model_config_path",
    });
    return { trigger: undefined, send: undefined };
  }
  try {
    const router = ModelRouter.fromFile(modelConfigPath, { env });
    const port = new AiSdkTriggerDecisionPort(router);
    const claimedBy = `sync:${process.pid}`;
    return {
      trigger: {
        run: () => runHumanPersonaTriggerTick({ store, config, port }),
      },
      send: {
        run: () =>
          runHumanPersonaSendTick({
            store,
            telegram: { sendMessage: (params) => telegram.sendMessage(params) },
            regenerate: {
              regenerate: () =>
                runHumanPersonaRegenerate({ store, config, port }),
            },
            personaId: config.personaId,
            claimedBy,
          }),
      },
    };
  } catch (error) {
    logger.warn({
      event: "human_persona_trigger.disabled",
      reason: "model_router_construction_failed",
      failure: safeError(error),
    });
    return { trigger: undefined, send: undefined };
  }
}

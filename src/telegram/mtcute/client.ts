import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  BaseTelegramClient,
  networkMiddlewares,
  NodePlatform,
  SqliteStorage,
  TelegramClient,
} from "@mtcute/node";
import { validateMtcuteTransportConfig } from "./config.js";
import type {
  MtcuteClientPort,
  MtcuteTransportConfig,
} from "./contracts.js";

// Public mtcute logger levels define OFF as zero in the pinned 0.31 API.
const MTCUTE_LOG_OFF = 0;

export async function createDefaultMtcuteClient(
  config: Readonly<MtcuteTransportConfig>,
): Promise<MtcuteClientPort> {
  const base = createMtcuteBaseClient(config);
  const raw = new TelegramClient({ client: base, disableUpdates: true });
  const bounded = raw.withParams({
    timeout: config.requestTimeoutMs,
    maxRetryCount: config.requestMaxRetries,
    floodSleepThreshold: config.floodWaitMaxMs,
  });

  return {
    // `raw` owns high-level peer/ref-message state in the same storage
    // provider. Bypassing it leaves its cleanup hook alive and can make final
    // BaseTelegramClient.destroy() race an already-closed SQLite connection.
    connect: () => raw.connect(),
    disconnect: () => raw.disconnect(),
    destroy: () => destroyDefaultMtcuteClient(raw, base),
    async getPeer(peer, refresh) {
      const input = await bounded.resolvePeer(peer, refresh);
      return bounded.getPeer(input);
    },
    getHistory: (peer, params) => bounded.getHistory(peer, params),
    getMessages: (peer, ids) => bounded.getMessages(peer, ids),
    sendText: (peer, text, params) =>
      bounded.sendText(peer, text, params),
  };
}

/**
 * Final process shutdown must not wait for mtcute's graceful network
 * disconnect timeout. Flush high-level caches and auth storage first, then
 * let the base client abort transports and release the SQLite driver.
 */
export async function destroyDefaultMtcuteClient(
  raw: TelegramClient,
  base: BaseTelegramClient,
): Promise<void> {
  try {
    await raw.storage.close();
    base.timers.destroy();
    base.updates?.stopLoop();
    await base.storage.close();
    await base.mt.storage.save();
  } finally {
    await base.mt.destroy();
  }
}

export function createMtcuteBaseClient(
  config: Readonly<MtcuteTransportConfig>,
): BaseTelegramClient {
  const validated = validateMtcuteTransportConfig(config);
  ensurePrivateStorageFile(validated.authStoragePath);
  return new BaseTelegramClient({
    apiId: validated.apiId,
    apiHash: validated.apiHash,
    storage: new SqliteStorage(validated.authStoragePath, {
      disableWal: true,
    }),
    updates: false,
    disableUpdates: true,
    platform: createOwnerManagedNodePlatform(),
    logLevel: MTCUTE_LOG_OFF,
    reconnectionStrategy: boundedReconnectionStrategy(validated),
    network: {
      middlewares: networkMiddlewares.basic({
        floodWaiter: {
          maxWait: validated.floodWaitMaxMs,
          maxRetries: validated.requestMaxRetries,
          store: true,
          minStoredWait: 0,
          onBeforeWait: () => undefined,
        },
        internalErrors: {
          maxRetries: validated.requestMaxRetries,
          waitTime: validated.requestRetryDelayMs / 1_000,
        },
      }),
    },
  });
}

/**
 * The daemon runner owns SIGINT/SIGTERM so it can await the complete shutdown
 * sequence. mtcute's default Node hook handles those signals synchronously,
 * closes SQLite before the runner reaches the client, and then re-sends the
 * signal. Keep only natural-process-exit cleanup for the library.
 */
export function createOwnerManagedNodePlatform(): NodePlatform {
  const platform = new NodePlatform();
  platform.beforeExit = (cleanup) => {
    let active = true;
    const handler = (): void => {
      if (active) {
        cleanup();
      }
    };
    process.once("beforeExit", handler);
    return () => {
      active = false;
      process.off("beforeExit", handler);
    };
  };
  return platform;
}

function boundedReconnectionStrategy(
  config: Readonly<MtcuteTransportConfig>,
): (state: {
  readonly previousWait: number | null;
  readonly consequentFails: number;
  readonly lastError: Error | null;
}) => number | false {
  const attemptsByState = new WeakMap<object, number>();
  return (state) => {
    const failures =
      state.previousWait === null
        ? 1
        : (attemptsByState.get(state) ?? 1) + 1;
    attemptsByState.set(state, failures);
    if (failures >= config.connectionMaxAttempts) {
      return false;
    }
    const exponent = Math.max(0, failures - 1);
    return Math.min(
      config.connectionRetryMaxMs,
      config.connectionRetryInitialMs * 2 ** exponent,
    );
  };
}

function ensurePrivateStorageFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "a", 0o600);
  closeSync(descriptor);
  chmodSync(path, 0o600);
}

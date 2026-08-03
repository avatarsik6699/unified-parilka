import type {
  MtcuteClientFactory,
  MtcuteClientPort,
  MtcuteTransportConfig,
} from "./contracts.js";
import { MtcuteTransportError } from "./errors.js";
import { withTimeout } from "./timeout.js";

const processOwners = new WeakMap<
  MtcuteClientFactory,
  MtcuteProcessClientOwner
>();

export function getMtcuteProcessOwner(
  factory: MtcuteClientFactory,
): MtcuteProcessClientOwner {
  const existing = processOwners.get(factory);
  if (existing) {
    return existing;
  }
  const owner = new MtcuteProcessClientOwner(factory);
  processOwners.set(factory, owner);
  return owner;
}

/**
 * The only lifecycle owner for a given client factory in this process.
 * Facades may share it; they must never create parallel MTProto clients.
 */
export class MtcuteProcessClientOwner {
  private config: Readonly<MtcuteTransportConfig> | undefined;
  private clientPromise: Promise<MtcuteClientPort> | undefined;
  private connectPromise: Promise<void> | undefined;
  /** Tracks the real client.connect() even when its timeout wrapper settles. */
  private rawConnectPromise: Promise<void> | undefined;
  private pendingConnectCleanup: Promise<void> | undefined;
  private disconnectPromise: Promise<void> | undefined;
  private destroyPromise: Promise<void> | undefined;
  private connected = false;
  private needsDisconnect = false;
  private destroyed = false;

  constructor(private readonly factory: MtcuteClientFactory) {}

  async getConnected(
    config: Readonly<MtcuteTransportConfig>,
  ): Promise<MtcuteClientPort> {
    if (this.destroyed) {
      throw new MtcuteTransportError(
        "client_destroyed",
        "internal",
        false,
        "The process-wide mtcute client has already been destroyed.",
      );
    }
    this.bindConfig(config);
    const client = await this.getOrCreate(config);
    if (this.destroyed) {
      throw new MtcuteTransportError(
        "client_destroyed",
        "internal",
        false,
        "The process-wide mtcute client has already been destroyed.",
      );
    }
    await this.waitForPendingConnectCleanup();
    if (this.disconnectPromise) {
      await this.disconnectPromise;
    }
    if (!this.connected) {
      await this.connect(client, config);
    }
    return client;
  }

  async disconnect(): Promise<void> {
    if (!this.clientPromise) {
      return;
    }
    if (this.destroyed) {
      await this.destroyPromise;
      return;
    }
    const client = await this.clientPromise;
    await this.ensureDisconnected(client);
  }

  async destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise;
    }
    this.destroyed = true;
    if (!this.clientPromise) {
      return;
    }
    const clientPromise = this.clientPromise;
    this.destroyPromise = (async () => {
      const client = await clientPromise;
      let cleanupError: unknown;
      try {
        await this.ensureDisconnected(client, false);
      } catch (error) {
        cleanupError = error;
      }
      try {
        await client.destroy();
      } catch (error) {
        if (cleanupError !== undefined) {
          throw new AggregateError(
            [cleanupError, error],
            "The mtcute client failed during disconnect and destroy.",
          );
        }
        throw error;
      } finally {
        this.connected = false;
        this.needsDisconnect = false;
      }
      if (cleanupError !== undefined) {
        throw cleanupError;
      }
    })();
    await this.destroyPromise;
  }

  private connect(
    client: MtcuteClientPort,
    config: Readonly<MtcuteTransportConfig>,
  ): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    let operation: Promise<void>;
    operation = this.connectOnce(client, config).finally(() => {
      if (this.connectPromise === operation) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = operation;
    return operation;
  }

  private async connectOnce(
    client: MtcuteClientPort,
    config: Readonly<MtcuteTransportConfig>,
  ): Promise<void> {
    await this.waitForPendingConnectCleanup();
    this.assertNotDestroyed();
    if (this.disconnectPromise) {
      await this.disconnectPromise;
    }
    if (this.needsDisconnect) {
      await this.ensureDisconnected(client);
    }
    this.assertNotDestroyed();
    this.needsDisconnect = true;
    const rawConnectPromise = Promise.resolve().then(() => client.connect());
    this.rawConnectPromise = rawConnectPromise;
    void rawConnectPromise.then(
      () => this.clearRawConnectPromise(rawConnectPromise),
      () => this.clearRawConnectPromise(rawConnectPromise),
    );
    return withTimeout(
      rawConnectPromise,
      config.connectionTimeoutMs,
      "The mtcute connection attempt timed out.",
    )
      .then(() => {
        if (!this.destroyed) {
          this.connected = true;
        }
      })
      .catch((error: unknown) => {
        this.connected = false;
        this.scheduleConnectCleanup(client);
        throw error;
      });
  }

  private async ensureDisconnected(
    client: MtcuteClientPort,
    waitForRawConnect = true,
  ): Promise<void> {
    if (this.disconnectPromise) {
      return this.disconnectPromise;
    }
    this.disconnectPromise = (async () => {
      if (waitForRawConnect) {
        await this.waitForRawConnect();
      }
      if (this.needsDisconnect) {
        this.connected = false;
        await client.disconnect();
        this.needsDisconnect = false;
      }
    })().finally(() => {
      this.disconnectPromise = undefined;
    });
    await this.disconnectPromise;
  }

  private async waitForRawConnect(): Promise<void> {
    const rawConnectPromise = this.rawConnectPromise;
    if (!rawConnectPromise) {
      return;
    }
    try {
      await rawConnectPromise;
    } catch {
      // The connection operation reports its original error to its caller.
    }
    this.clearRawConnectPromise(rawConnectPromise);
  }

  private scheduleConnectCleanup(client: MtcuteClientPort): void {
    if (this.pendingConnectCleanup) {
      return;
    }
    const cleanup = this.ensureDisconnected(client, false);
    this.pendingConnectCleanup = cleanup;
    void cleanup.then(
      () => this.clearPendingConnectCleanup(cleanup),
      () => this.clearPendingConnectCleanup(cleanup),
    );
  }

  private async waitForPendingConnectCleanup(): Promise<void> {
    const cleanup = this.pendingConnectCleanup;
    if (cleanup) {
      await cleanup;
    }
  }

  private clearRawConnectPromise(promise: Promise<void>): void {
    if (this.rawConnectPromise === promise) {
      this.rawConnectPromise = undefined;
    }
  }

  private clearPendingConnectCleanup(promise: Promise<void>): void {
    if (this.pendingConnectCleanup === promise) {
      this.pendingConnectCleanup = undefined;
    }
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new MtcuteTransportError(
        "client_destroyed",
        "internal",
        false,
        "The process-wide mtcute client has already been destroyed.",
      );
    }
  }

  private bindConfig(config: Readonly<MtcuteTransportConfig>): void {
    if (!this.config) {
      this.config = config;
      return;
    }
    if (!hasSameClientConfig(this.config, config)) {
      throw new MtcuteTransportError(
        "client_owner_conflict",
        "validation",
        false,
        "The process-wide mtcute client is already bound to different client settings.",
      );
    }
  }

  private getOrCreate(
    config: Readonly<MtcuteTransportConfig>,
  ): Promise<MtcuteClientPort> {
    if (!this.clientPromise) {
      this.clientPromise = Promise.resolve(this.factory(config));
    }
    return this.clientPromise;
  }
}

function hasSameClientConfig(
  left: Readonly<MtcuteTransportConfig>,
  right: Readonly<MtcuteTransportConfig>,
): boolean {
  return (
    left.apiId === right.apiId &&
    left.apiHash === right.apiHash &&
    left.authStoragePath === right.authStoragePath &&
    left.connectionMaxAttempts === right.connectionMaxAttempts &&
    left.connectionTimeoutMs === right.connectionTimeoutMs &&
    left.connectionRetryInitialMs === right.connectionRetryInitialMs &&
    left.connectionRetryMaxMs === right.connectionRetryMaxMs &&
    left.requestTimeoutMs === right.requestTimeoutMs &&
    left.requestMaxRetries === right.requestMaxRetries &&
    left.requestRetryDelayMs === right.requestRetryDelayMs &&
    left.floodWaitMaxMs === right.floodWaitMaxMs
  );
}

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
    if (this.disconnectPromise) {
      await this.disconnectPromise;
    }
    if (!this.connected) {
      await this.connect(client, config);
    }
    return client;
  }

  async disconnect(): Promise<void> {
    if (!this.clientPromise || this.destroyed) {
      return;
    }
    if (this.disconnectPromise) {
      return this.disconnectPromise;
    }
    const clientPromise = this.clientPromise;
    this.disconnectPromise = (async () => {
      const client = await clientPromise;
      if (this.connectPromise) {
        try {
          await this.connectPromise;
        } catch {
          // The failed connect path already attempted cleanup.
        }
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
      if (this.connectPromise) {
        try {
          await this.connectPromise;
        } catch {
          // destroy() must still release a client whose connect() failed.
        }
      }
      await client.destroy();
      this.connected = false;
      this.needsDisconnect = false;
    })();
    await this.destroyPromise;
  }

  private async connect(
    client: MtcuteClientPort,
    config: Readonly<MtcuteTransportConfig>,
  ): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (this.needsDisconnect) {
      await client.disconnect();
      this.needsDisconnect = false;
    }
    this.needsDisconnect = true;
    this.connectPromise = withTimeout(
      client.connect(),
      config.connectionTimeoutMs,
      "The mtcute connection attempt timed out.",
    )
      .then(() => {
        this.connected = true;
      })
      .catch(async (error: unknown) => {
        this.connected = false;
        try {
          await client.disconnect();
          this.needsDisconnect = false;
        } catch {
          // A later disconnect()/destroy() still owns final cleanup.
        }
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });
    await this.connectPromise;
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

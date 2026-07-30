import type {
  ChatInfo,
  TelegramGateway,
  TelegramHistoryMessage,
} from "../types.js";
import { createDefaultMtcuteClient } from "./client.js";
import { validateMtcuteTransportConfig } from "./config.js";
import type {
  MtcuteClientFactory,
  MtcuteClientPort,
  MtcuteHistoryRequest,
  MtcuteSendRequest,
  MtcuteTransportConfig,
  ResolvedMtcuteChat,
} from "./contracts.js";
import { MtcuteTransportError } from "./errors.js";
import { MtcuteHistoryAdapter } from "./history-adapter.js";
import { MtcutePeerResolver } from "./peer-resolver.js";
import {
  getMtcuteProcessOwner,
  type MtcuteProcessClientOwner,
} from "./process-owner.js";
import { MtcuteSendAdapter } from "./send-adapter.js";

/**
 * Application-facing facade over the single process-owned mtcute client.
 */
export class MtcuteTelegramService implements TelegramGateway {
  private readonly config: Readonly<MtcuteTransportConfig>;
  private readonly owner: MtcuteProcessClientOwner;
  private readonly peers: MtcutePeerResolver;
  private readonly history: MtcuteHistoryAdapter;
  private readonly sender: MtcuteSendAdapter;

  constructor(
    config: MtcuteTransportConfig,
    clientFactory: MtcuteClientFactory = createDefaultMtcuteClient,
  ) {
    this.config = validateMtcuteTransportConfig(config);
    this.owner = getMtcuteProcessOwner(clientFactory);
    const getClient = () => this.getClient();
    this.peers = new MtcutePeerResolver(this.config, getClient);
    this.history = new MtcuteHistoryAdapter(
      this.config,
      this.peers,
      getClient,
    );
    this.sender = new MtcuteSendAdapter(this.peers, getClient);
  }

  get isConfigured(): boolean {
    return this.config.apiId > 0 && this.config.apiHash.length > 0;
  }

  async getClient(): Promise<MtcuteClientPort> {
    if (!this.isConfigured) {
      throw new MtcuteTransportError(
        "not_configured",
        "auth",
        false,
        "Telegram API credentials are required before using the mtcute transport.",
      );
    }
    try {
      return await this.owner.getConnected(this.config);
    } catch (error) {
      if (error instanceof MtcuteTransportError) {
        throw error;
      }
      throw new MtcuteTransportError(
        "connection_failed",
        "internal",
        true,
        "The mtcute client could not connect.",
        error,
      );
    }
  }

  assertChatAllowed(chat: string): void {
    this.peers.assertAllowed(chat);
  }

  resolveChat(
    chat?: string,
    refresh = false,
  ): Promise<ResolvedMtcuteChat> {
    return this.peers.resolve(chat, refresh);
  }

  getMessages(
    params: MtcuteHistoryRequest,
  ): Promise<{ chat: ChatInfo; messages: TelegramHistoryMessage[] }> {
    return this.history.getMessages(params);
  }

  iterateMessages(
    params: Omit<MtcuteHistoryRequest, "ids">,
  ): Promise<{
    chat: ChatInfo;
    messages: AsyncIterable<TelegramHistoryMessage>;
  }> {
    return this.history.iterateMessages(params);
  }

  sendMessage(
    params: MtcuteSendRequest,
  ): Promise<{ id: number; chat: ChatInfo }> {
    return this.sender.sendMessage(params);
  }

  disconnect(): Promise<void> {
    return this.owner.disconnect();
  }

  async destroy(): Promise<void> {
    this.peers.clear();
    await this.owner.destroy();
  }
}

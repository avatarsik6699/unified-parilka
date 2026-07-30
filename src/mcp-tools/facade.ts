import type { AppConfig } from "../config.js";
import { ToolError } from "../errors.js";
import type { MessageStore } from "../store.js";
import {
  HistorySyncer,
  type HistorySyncPort,
} from "../sync-engine.js";
import type {
  ChatInfo,
  TelegramGateway,
} from "../telegram/types.js";
import { SendThrottler } from "../throttler.js";
import { VectorRag } from "../vector-rag.js";
import type {
  TelegramToolContext,
  ToolCallOptions,
  ToolContent,
  ToolDef,
} from "./contracts.js";
import { listToolDefinitions } from "./definitions.js";
import { callTelegramTool } from "./registry.js";
import { SendApprovalRegistry } from "./send-approval.js";

export class TelegramTools {
  private readonly context: TelegramToolRuntime;

  constructor(
    config: AppConfig,
    telegram: TelegramGateway,
    store: MessageStore,
    syncer?: HistorySyncPort,
  ) {
    this.context = new TelegramToolRuntime(
      config,
      telegram,
      store,
      syncer,
    );
  }

  listTools(): ToolDef[] {
    return listToolDefinitions();
  }

  async callTool(
    name: string,
    rawArgs: unknown,
    options: ToolCallOptions = {},
  ): Promise<ToolContent> {
    return callTelegramTool(
      this.context,
      name,
      rawArgs,
      options,
    );
  }
}

class TelegramToolRuntime implements TelegramToolContext {
  readonly throttler: SendThrottler;
  readonly syncer: HistorySyncPort;
  readonly vectorRag: VectorRag;
  readonly approvals: SendApprovalRegistry;

  constructor(
    readonly config: AppConfig,
    readonly telegram: TelegramGateway,
    readonly store: MessageStore,
    syncer?: HistorySyncPort,
  ) {
    this.throttler = new SendThrottler(config, store);
    this.syncer =
      syncer ?? new HistorySyncer(config, telegram, store);
    this.vectorRag = new VectorRag(config, store);
    this.approvals = new SendApprovalRegistry(
      config.safety.liveSendApprovalTtlMs,
    );
  }

  cacheChat(chat?: string): ChatInfo {
    const chatId =
      chat?.trim() || this.config.telegram.defaultChatId;
    const cached = this.store.resolveCachedChat(chatId);
    if (cached) {
      this.telegram.assertChatAllowed(cached.chatId);
      return cached;
    }
    this.telegram.assertChatAllowed(chatId);
    if (chatId.startsWith("@")) {
      throw new ToolError({
        category: "peer",
        retryable: false,
        message: `Unknown cached chat alias ${chatId}. Call resolve_chat or sync_history for this username once, then retry the cache-only tool.`,
      });
    }
    return {
      chatId,
      requested: chatId,
      kind: "Cached",
    };
  }
}

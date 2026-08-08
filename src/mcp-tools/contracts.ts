import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { MessageStore } from "../store.js";
import type { TelegramGateway } from "../telegram/types.js";
import type { SendThrottler } from "../throttler.js";
import type { HistorySyncPort } from "../sync-engine.js";
import type { VectorRag } from "../vector-rag.js";
import type { SendApprovalRegistry } from "./send-approval.js";
import type { BotReadTools } from "../bot/read-tools.js";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolContent = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ToolCallOptions = {
  signal?: AbortSignal;
};

export interface TelegramToolContext {
  readonly config: AppConfig;
  readonly telegram: TelegramGateway;
  readonly store: MessageStore;
  readonly throttler: SendThrottler;
  readonly syncer: HistorySyncPort;
  readonly vectorRag: VectorRag;
  readonly approvals: SendApprovalRegistry;
  readonly botReadTools: BotReadTools;
  cacheChat(chat?: string): import("../telegram/types.js").ChatInfo;
}

export const emptySchema = z.object({}).strict();
export const chatSchema = z
  .object({ chat: z.string().optional() })
  .strict();
export const limitSchema = z.number().int().positive();

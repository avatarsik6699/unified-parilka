import type {
  HumanPersonaAutonomyMode,
  StoredChatMemory,
  StoredHumanPersonaProposal,
  StoredHumanPersonaStyleProfile,
  StoredHumanPersonaTriggerState,
  StoredMessage,
} from "../store.js";

export interface HumanPersonaTriggerHeuristicConfig {
  /** Moscow local hour, inclusive. Only non-wrapping ranges are supported (start < end). */
  activeHourStartMoscow: number;
  /** Moscow local hour, exclusive. */
  activeHourEndMoscow: number;
  minSilenceMs: number;
  maxInitiationsPerWindow: number;
  windowMs: number;
}

export interface HumanPersonaTriggerRuntimeConfig {
  personaId: string;
  chatId: string;
  chatTitle: string;
  targetUserKey: string;
  autonomyMode: HumanPersonaAutonomyMode;
  heuristics: HumanPersonaTriggerHeuristicConfig;
}

export interface HumanPersonaTriggerStore {
  getHumanPersonaTriggerState(
    personaId: string,
    chatId: string,
  ): StoredHumanPersonaTriggerState | undefined;
  recordHumanPersonaTriggerCheck(
    personaId: string,
    chatId: string,
    nowMs?: number,
  ): void;
  recordHumanPersonaInitiation(
    personaId: string,
    chatId: string,
    windowStartMs: number,
    nowMs?: number,
  ): void;
  createHumanPersonaProposal(params: {
    id: string;
    personaId: string;
    chatId: string;
    proposedText: string;
    autonomyMode: HumanPersonaAutonomyMode;
    nowMs?: number;
  }): StoredHumanPersonaProposal;
  getHumanPersonaStyleProfile(
    personaId: string,
    targetUserKey: string,
  ): StoredHumanPersonaStyleProfile | undefined;
  getHistory(params: {
    chatId: string;
    limit: number;
    order?: "asc" | "desc";
  }): StoredMessage[];
  getChatMemory(chatId: string): StoredChatMemory | undefined;
}

export interface HumanPersonaTriggerDecisionRequest {
  personaId: string;
  chatId: string;
  systemPrompt: string;
  recentMessagesText: string;
  maxOutputChars: number;
  signal: AbortSignal;
}

export interface HumanPersonaTriggerDecisionResult {
  shouldSend: boolean;
  text?: string;
  model: string;
  providerId: string;
}

export interface HumanPersonaTriggerPort {
  decide(
    request: HumanPersonaTriggerDecisionRequest,
  ): Promise<HumanPersonaTriggerDecisionResult>;
}

export type HumanPersonaTriggerTickStatus =
  "gated" | "no_history" | "no_message" | "proposed" | "failed";

export interface HumanPersonaTriggerTickReport {
  status: HumanPersonaTriggerTickStatus;
  reason?: string;
  proposalId?: string;
  error?: { name: string; code: string };
}

export interface HumanPersonaTriggerTickOptions {
  store: HumanPersonaTriggerStore;
  config: HumanPersonaTriggerRuntimeConfig;
  port: HumanPersonaTriggerPort;
  now?: () => Date;
  historyLimit?: number;
  itemTimeoutMs?: number;
  maxOutputChars?: number;
}

import type {
  StoredAssistantCuriosityTriggerState,
  StoredChatMemory,
  StoredMessage,
} from "../store.js";

export interface AssistantCuriosityHeuristicConfig {
  /** Moscow local hour, inclusive. Only non-wrapping ranges are supported (start < end). */
  activeHourStartMoscow: number;
  /** Moscow local hour, exclusive. */
  activeHourEndMoscow: number;
  /** Scale for the quiet-probability curve, not a hard cutoff -- see heuristics.ts. */
  minSilenceMs: number;
  minSilenceSinceOwnQuestionMs: number;
  maxInitiationsPerWindow: number;
  windowMs: number;
  pendingAnswerGraceMs: number;
  /** Floor probability of proceeding to the LLM decision on any given check. */
  baseAskProbability: number;
  /** Ceiling probability of proceeding to the LLM decision on any given check. */
  maxAskProbability: number;
}

export interface AssistantCuriosityRuntimeConfig {
  chatId: string;
  chatTitle: string;
  personaPrompt: string;
  botDisplayName: string;
  heuristics: AssistantCuriosityHeuristicConfig;
}

export interface AssistantCuriosityStore {
  getAssistantCuriosityTriggerState(
    chatId: string,
  ): StoredAssistantCuriosityTriggerState | undefined;
  recordAssistantCuriosityTriggerCheck(chatId: string, nowMs?: number): void;
  recordAssistantCuriosityInitiation(params: {
    chatId: string;
    windowStartMs: number;
    askedMessageId: number;
    nowMs?: number;
  }): void;
  recordAssistantCuriosityTopic(
    chatId: string,
    topicSummary: string,
    nowMs?: number,
  ): void;
  getRecentAssistantCuriosityTopics(chatId: string, limit?: number): string[];
  getHistory(params: {
    chatId: string;
    limit: number;
    order?: "asc" | "desc";
  }): StoredMessage[];
  getChatMemory(chatId: string): StoredChatMemory | undefined;
}

export interface AssistantCuriosityDecisionRequest {
  chatId: string;
  systemPrompt: string;
  recentMessagesText: string;
  avoidTopicsText: string;
  maxOutputChars: number;
  signal: AbortSignal;
}

export interface AssistantCuriosityDecisionResult {
  shouldAsk: boolean;
  text?: string;
  topicSummary?: string;
  model: string;
  providerId: string;
}

export interface AssistantCuriosityPort {
  decide(
    request: AssistantCuriosityDecisionRequest,
  ): Promise<AssistantCuriosityDecisionResult>;
}

export interface AssistantCuriositySendResult {
  messageId: number;
}

export interface AssistantCuriositySendPort {
  sendMessage(
    chatId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<AssistantCuriositySendResult>;
}

export type AssistantCuriosityTickStatus =
  "gated" | "no_history" | "no_message" | "asked" | "failed";

export interface AssistantCuriosityTickReport {
  status: AssistantCuriosityTickStatus;
  reason?: string;
  /** The quiet-probability that was rolled against, present whenever the gate reached that check. */
  probability?: number;
  messageId?: number;
  error?: { name: string; code: string };
}

export interface AssistantCuriosityTickOptions {
  store: AssistantCuriosityStore;
  config: AssistantCuriosityRuntimeConfig;
  port: AssistantCuriosityPort;
  send: AssistantCuriositySendPort;
  now?: () => Date;
  historyLimit?: number;
  itemTimeoutMs?: number;
  maxOutputChars?: number;
  /** Injectable for tests; defaults to `Math.random`. */
  random?: () => number;
}

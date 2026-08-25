import type {
  HumanPersonaProposalStatus,
  MessageStore,
  BotUpdateFailureResult,
  BotUpdateIngestResult,
  StoredBotTurn,
  StoredBotUpdate,
  StoredHumanPersonaProposal,
  StoredMessage,
} from "../../store.js";
import type { ChatInfo } from "../../telegram/types.js";
import type { TelegramUpdateOptions } from "../telegram-update.js";
import type { TurnCoordinator } from "../turn-coordinator.js";
import type { JsonEventLogger } from "../worker.js";

export const MAX_BOT_WORKER_CONCURRENCY = 3;

export interface BotRuntimeStore {
  getBotUpdate(updateId: number): StoredBotUpdate | undefined;
  getBotTurnByTrigger(
    chatId: string,
    triggerMessageId: number,
  ): StoredBotTurn | undefined;
  ingestBotUpdate(
    params: Parameters<MessageStore["ingestBotUpdate"]>[0],
  ): BotUpdateIngestResult;
  recordBotUpdateFailure(
    params: Parameters<MessageStore["recordBotUpdateFailure"]>[0],
  ): BotUpdateFailureResult;
  /** Human-persona approval workflow (plan Фаза 4d/5 Шаг 5). */
  getHumanPersonaProposal(id: string): StoredHumanPersonaProposal | undefined;
  recordHumanPersonaProposalDecision(
    id: string,
    status: Extract<
      HumanPersonaProposalStatus,
      "approved" | "rejected" | "regenerate_requested" | "edited"
    >,
    finalText: string | undefined,
  ): boolean;
  getClaimedHumanPersonaProposalByApprovalMessage(
    approvalChatId: string,
    approvalMessageId: number,
  ): StoredHumanPersonaProposal | undefined;
  /** Assistant curiosity trigger: marks a pending question answered on a matching reply. */
  recordAssistantCuriosityAnswerIfMatches(
    chatId: string,
    replyToMessageId: number,
  ): boolean;
}

export interface OwnSendStore {
  getCachedChat(chatId: string): ChatInfo | undefined;
  upsertMessages(chat: ChatInfo, messages: StoredMessage[]): number;
}

export interface BotWorkNotifier {
  notify(): void;
}

/**
 * Host-code-enforced privileged trigger for an early news-brief run --
 * `tryTrigger` decides purely from the already-parsed sender id/text, never
 * from a model/prompt-level instruction, and never sees an unaddressed
 * message. Returning `true` means the message was consumed: it must not
 * also be routed into a normal model turn.
 */
export interface NewsBriefTriggerPort {
  tryTrigger(message: {
    chatId: string;
    messageId: number;
    senderId: string | undefined;
    text: string;
  }): boolean;
}

export type BotUpdateProcessingResult =
  | {
      acknowledged: true;
      ackUpdateId: number;
      disposition:
        | "ingested"
        | "recovered"
        | "duplicate"
        | "dead_letter"
        | "human_persona_decision";
      turnReserved: boolean;
      routed: boolean;
    }
  | { acknowledged: false; updateId: number; disposition: "poison_retry" };

export interface BotUpdateProcessorOptions {
  store: BotRuntimeStore;
  /**
   * One `TurnCoordinator` per assistant-role chat (Фаза 7, native multi-
   * chat) -- coordinators must not be shared across chats: `routeMessage`
   * folds an incoming message into every active turn with no chat filter,
   * so sharing one instance would leak chat B's messages into chat A's
   * in-flight turn. Keyed by the chat's normalized Telegram id.
   */
  coordinators: ReadonlyMap<string, TurnCoordinator>;
  workNotifier: BotWorkNotifier;
  telegram: TelegramUpdateOptions;
  triggerCooldownMs?: number;
  updateMaxAttempts?: number;
  logger?: JsonEventLogger;
  now?: () => number;
  newsBriefTrigger?: NewsBriefTriggerPort;
}

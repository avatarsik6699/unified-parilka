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
}

export interface OwnSendStore {
  getCachedChat(chatId: string): ChatInfo | undefined;
  upsertMessages(chat: ChatInfo, messages: StoredMessage[]): number;
}

export interface BotWorkNotifier {
  notify(): void;
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
  coordinator: TurnCoordinator;
  workNotifier: BotWorkNotifier;
  telegram: TelegramUpdateOptions;
  triggerCooldownMs?: number;
  updateMaxAttempts?: number;
  logger?: JsonEventLogger;
  now?: () => number;
}

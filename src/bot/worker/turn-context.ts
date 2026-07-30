import type {
  MessageStore,
  StoredBotTurn,
  StoredMessage,
} from "../../store.js";
import type {
  FoldBatch,
  TurnBoundary,
  TurnCoordinator,
} from "../turn-coordinator.js";
import type { QuoteEvidence } from "../output-guards.js";
import {
  BOT_CONTEXT_MESSAGES,
  BOT_REPLAY_MESSAGES,
} from "./contracts.js";
import {
  durableMessageId,
  WorkerProtocolError,
} from "./helpers.js";

export interface LoadedBotTurn {
  trigger: StoredMessage;
  context: StoredMessage[];
  replay: StoredMessage[];
}

export function loadBotTurn(
  store: MessageStore,
  turn: StoredBotTurn,
): LoadedBotTurn | undefined {
  const trigger = store.getMessagesByIds({
    chatId: turn.chatId,
    messageIds: [turn.triggerMessageId],
  })[0];
  if (!trigger) {
    return undefined;
  }
  const previous = store
    .getHistory({
      chatId: turn.chatId,
      beforeId: turn.triggerMessageId,
      limit: BOT_CONTEXT_MESSAGES,
      order: "desc",
    })
    .reverse();
  const replay = store.getHistory({
    chatId: turn.chatId,
    afterId: turn.triggerMessageId,
    limit: BOT_REPLAY_MESSAGES,
    order: "asc",
  });
  return {
    trigger,
    context: [...previous, trigger],
    replay,
  };
}

export function seedBotTurnReplay(
  coordinator: TurnCoordinator,
  coordinatorTurnId: string,
  replay: readonly StoredMessage[],
): void {
  const seeded = coordinator.seedTurnReplay(
    coordinatorTurnId,
    replay.map((message) => ({
      messageId: durableMessageId(message),
      senderId: message.senderId ?? "unknown",
      ...(message.senderName == null
        ? {}
        : { senderName: message.senderName }),
      text: message.text,
    })),
  );
  if (seeded.status === "not_found") {
    throw new WorkerProtocolError("coordinator_turn_missing");
  }
}

export function createTurnFoldCollector(
  coordinator: TurnCoordinator,
  coordinatorTurnId: string,
): {
  drainedEvidence: QuoteEvidence[];
  foldedAllowedMentions: string[];
  drainFold: (boundary: TurnBoundary) => FoldBatch;
} {
  const drainedEvidence: QuoteEvidence[] = [];
  const foldedAllowedMentions: string[] = [];
  const drainFold = (boundary: TurnBoundary): FoldBatch => {
    const result = coordinator.drainAtBoundary(
      coordinatorTurnId,
      boundary,
    );
    if (result.status === "not_found") {
      throw new WorkerProtocolError("coordinator_turn_missing");
    }
    for (const message of result.fold.messages) {
      if (message.text.trim()) {
        drainedEvidence.push({
          speaker: message.senderName ?? message.senderId,
          text: message.text,
        });
      }
      if (
        message.route === "owner_follow_up" &&
        message.senderName
      ) {
        foldedAllowedMentions.push(message.senderName);
      }
    }
    return result.fold;
  };
  return {
    drainedEvidence,
    foldedAllowedMentions,
    drainFold,
  };
}

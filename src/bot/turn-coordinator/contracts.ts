export type TurnBoundary = "model" | "tool";
export type MessageRoute = "owner_follow_up" | "ambient";
export type CapacityPolicy = "refuse" | "queue";

export interface TurnCoordinatorOptions {
  maxActiveTurns: number;
  capacityPolicy?: CapacityPolicy;
  maxFoldMessages?: number;
  maxFoldChars?: number;
  maxSeenMessageIds?: number;
  onTrace?: (event: TurnTraceEvent) => void;
}

export interface StartTurnInput {
  turnId: string;
  ownerSenderId: string;
}

export interface TurnMessageInput {
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
}

export interface TurnSnapshot {
  turnId: string;
  ownerSenderId: string;
  startWatermark: number;
  queuedMessages: number;
}

export type StartTurnResult =
  | {
      accepted: true;
      status: "started";
      turn: TurnSnapshot;
    }
  | {
      accepted: false;
      status: "queue" | "refused";
      reason: "max_active_turns";
      turnId: string;
      maxActiveTurns: number;
      activeTurnIds: string[];
    }
  | {
      accepted: false;
      status: "refused";
      reason: "duplicate_turn_id";
      turnId: string;
      maxActiveTurns: number;
      activeTurnIds: string[];
    };

export type RouteMessageResult =
  | {
      status: "routed";
      messageId: string;
      watermark: number;
      deliveredToTurnIds: string[];
    }
  | {
      status: "duplicate";
      messageId: string;
      watermark: number;
      deliveredToTurnIds: [];
    };

export type SeedTurnReplayResult =
  | {
      status: "seeded";
      turnId: string;
      addedMessageIds: string[];
      duplicateMessageIds: string[];
    }
  | {
      status: "not_found";
      turnId: string;
      addedMessageIds: [];
      duplicateMessageIds: [];
    };

export interface FoldedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  watermark: number;
  route: MessageRoute;
  truncated: boolean;
}

export interface FoldBatch {
  turnId: string;
  boundary: TurnBoundary;
  messages: FoldedMessage[];
  ownerFollowUps: FoldedMessage[];
  ambient: FoldedMessage[];
  totalChars: number;
  remainingMessages: number;
}

export type DrainTurnResult =
  | {
      status: "drained";
      fold: FoldBatch;
    }
  | {
      status: "not_found";
      turnId: string;
      boundary: TurnBoundary;
    };

export type CompleteTurnResult =
  | {
      status: "completed";
      turnId: string;
      discardedMessages: number;
    }
  | {
      status: "not_found";
      turnId: string;
    };

export type TurnTraceEvent =
  | {
      event: "turn.started";
      turnId: string;
      ownerSenderId: string;
      startWatermark: number;
    }
  | {
      event: "turn.admission_rejected";
      turnId: string;
      reason: "max_active_turns" | "duplicate_turn_id";
      disposition: "queue" | "refused";
      activeTurnCount: number;
    }
  | {
      event: "turn.message_routed";
      turnId: string;
      messageId: string;
      watermark: number;
      route: MessageRoute;
    }
  | {
      event: "turn.fold_drained";
      turnId: string;
      boundary: TurnBoundary;
      messageCount: number;
      totalChars: number;
      remainingMessages: number;
    }
  | {
      event: "turn.completed";
      turnId: string;
      discardedMessages: number;
    };

export interface RoutedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  watermark: number;
  route: MessageRoute;
}

export interface ActiveTurn {
  turnId: string;
  ownerSenderId: string;
  startWatermark: number;
  queue: RoutedMessage[];
}

import type {
  ActiveTurn,
  CapacityPolicy,
  CompleteTurnResult,
  DrainTurnResult,
  MessageRoute,
  RouteMessageResult,
  SeedTurnReplayResult,
  StartTurnInput,
  StartTurnResult,
  TurnBoundary,
  TurnCoordinatorOptions,
  TurnMessageInput,
  TurnSnapshot,
  TurnTraceEvent,
} from "./contracts.js";
import { drainTurnQueue, snapshotTurn } from "./folding.js";
import {
  requireNonEmpty,
  validateCoordinatorOptions,
} from "./validation.js";

/**
 * Coordinates overlapping turns without sharing pending-message state.
 */
export class TurnCoordinator {
  readonly #maxActiveTurns: number;
  readonly #capacityPolicy: CapacityPolicy;
  readonly #maxFoldMessages: number;
  readonly #maxFoldChars: number;
  readonly #maxSeenMessageIds: number;
  readonly #onTrace: ((event: TurnTraceEvent) => void) | undefined;
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #seenMessageWatermarks = new Map<string, number>();
  #watermark = 0;

  constructor(options: TurnCoordinatorOptions) {
    const validated = validateCoordinatorOptions(options);
    this.#maxActiveTurns = validated.maxActiveTurns;
    this.#capacityPolicy = validated.capacityPolicy;
    this.#maxFoldMessages = validated.maxFoldMessages;
    this.#maxFoldChars = validated.maxFoldChars;
    this.#maxSeenMessageIds = validated.maxSeenMessageIds;
    this.#onTrace = validated.onTrace;
  }

  get activeTurnCount(): number {
    return this.#activeTurns.size;
  }

  get availableTurnSlots(): number {
    return Math.max(0, this.#maxActiveTurns - this.#activeTurns.size);
  }

  get watermark(): number {
    return this.#watermark;
  }

  startTurn(input: StartTurnInput): StartTurnResult {
    requireNonEmpty(input.turnId, "turnId");
    requireNonEmpty(input.ownerSenderId, "ownerSenderId");

    if (this.#activeTurns.has(input.turnId)) {
      const activeTurnIds = this.activeTurnIds();
      this.#trace({
        event: "turn.admission_rejected",
        turnId: input.turnId,
        reason: "duplicate_turn_id",
        disposition: "refused",
        activeTurnCount: activeTurnIds.length,
      });
      return {
        accepted: false,
        status: "refused",
        reason: "duplicate_turn_id",
        turnId: input.turnId,
        maxActiveTurns: this.#maxActiveTurns,
        activeTurnIds,
      };
    }

    if (this.#activeTurns.size >= this.#maxActiveTurns) {
      const activeTurnIds = this.activeTurnIds();
      const status =
        this.#capacityPolicy === "queue"
          ? ("queue" as const)
          : ("refused" as const);
      this.#trace({
        event: "turn.admission_rejected",
        turnId: input.turnId,
        reason: "max_active_turns",
        disposition: status,
        activeTurnCount: activeTurnIds.length,
      });
      return {
        accepted: false,
        status,
        reason: "max_active_turns",
        turnId: input.turnId,
        maxActiveTurns: this.#maxActiveTurns,
        activeTurnIds,
      };
    }

    const turn: ActiveTurn = {
      turnId: input.turnId,
      ownerSenderId: input.ownerSenderId,
      startWatermark: this.#watermark,
      queue: [],
    };
    this.#activeTurns.set(turn.turnId, turn);
    this.#trace({
      event: "turn.started",
      turnId: turn.turnId,
      ownerSenderId: turn.ownerSenderId,
      startWatermark: turn.startWatermark,
    });
    return {
      accepted: true,
      status: "started",
      turn: snapshotTurn(turn),
    };
  }

  routeMessage(input: TurnMessageInput): RouteMessageResult {
    requireNonEmpty(input.messageId, "messageId");
    requireNonEmpty(input.senderId, "senderId");

    const seenWatermark =
      this.#seenMessageWatermarks.get(input.messageId);
    if (seenWatermark !== undefined) {
      return {
        status: "duplicate",
        messageId: input.messageId,
        watermark: seenWatermark,
        deliveredToTurnIds: [],
      };
    }

    const watermark = this.#rememberMessage(input.messageId);
    const deliveredToTurnIds: string[] = [];
    for (const turn of this.#activeTurns.values()) {
      if (turn.startWatermark >= watermark) {
        continue;
      }
      const route: MessageRoute =
        input.senderId === turn.ownerSenderId
          ? "owner_follow_up"
          : "ambient";
      turn.queue.push({
        messageId: input.messageId,
        senderId: input.senderId,
        ...(input.senderName === undefined
          ? {}
          : { senderName: input.senderName }),
        text: input.text,
        watermark,
        route,
      });
      deliveredToTurnIds.push(turn.turnId);
      this.#trace({
        event: "turn.message_routed",
        turnId: turn.turnId,
        messageId: input.messageId,
        watermark,
        route,
      });
    }
    return {
      status: "routed",
      messageId: input.messageId,
      watermark,
      deliveredToTurnIds,
    };
  }

  seedTurnReplay(
    turnId: string,
    messages: readonly TurnMessageInput[],
  ): SeedTurnReplayResult {
    requireNonEmpty(turnId, "turnId");
    const turn = this.#activeTurns.get(turnId);
    if (!turn) {
      return {
        status: "not_found",
        turnId,
        addedMessageIds: [],
        duplicateMessageIds: [],
      };
    }

    const queuedIds = new Set(
      turn.queue.map((message) => message.messageId),
    );
    const addedMessageIds: string[] = [];
    const duplicateMessageIds: string[] = [];
    for (const input of messages) {
      requireNonEmpty(input.messageId, "messageId");
      requireNonEmpty(input.senderId, "senderId");
      if (queuedIds.has(input.messageId)) {
        duplicateMessageIds.push(input.messageId);
        continue;
      }

      const watermark =
        this.#seenMessageWatermarks.get(input.messageId) ??
        this.#rememberMessage(input.messageId);
      const route: MessageRoute =
        input.senderId === turn.ownerSenderId
          ? "owner_follow_up"
          : "ambient";
      turn.queue.push({
        messageId: input.messageId,
        senderId: input.senderId,
        ...(input.senderName === undefined
          ? {}
          : { senderName: input.senderName }),
        text: input.text,
        watermark,
        route,
      });
      queuedIds.add(input.messageId);
      addedMessageIds.push(input.messageId);
      this.#trace({
        event: "turn.message_routed",
        turnId,
        messageId: input.messageId,
        watermark,
        route,
      });
    }
    return {
      status: "seeded",
      turnId,
      addedMessageIds,
      duplicateMessageIds,
    };
  }

  drainAtBoundary(
    turnId: string,
    boundary: TurnBoundary,
  ): DrainTurnResult {
    requireNonEmpty(turnId, "turnId");
    const turn = this.#activeTurns.get(turnId);
    if (!turn) {
      return { status: "not_found", turnId, boundary };
    }
    const fold = drainTurnQueue(
      turn,
      boundary,
      this.#maxFoldMessages,
      this.#maxFoldChars,
    );
    this.#trace({
      event: "turn.fold_drained",
      turnId,
      boundary,
      messageCount: fold.messages.length,
      totalChars: fold.totalChars,
      remainingMessages: fold.remainingMessages,
    });
    return { status: "drained", fold };
  }

  completeTurn(turnId: string): CompleteTurnResult {
    requireNonEmpty(turnId, "turnId");
    const turn = this.#activeTurns.get(turnId);
    if (!turn) {
      return { status: "not_found", turnId };
    }
    const discardedMessages = turn.queue.length;
    this.#activeTurns.delete(turnId);
    this.#trace({
      event: "turn.completed",
      turnId,
      discardedMessages,
    });
    return { status: "completed", turnId, discardedMessages };
  }

  getTurn(turnId: string): TurnSnapshot | undefined {
    const turn = this.#activeTurns.get(turnId);
    return turn ? snapshotTurn(turn) : undefined;
  }

  listTurns(): TurnSnapshot[] {
    return [...this.#activeTurns.values()].map(snapshotTurn);
  }

  private activeTurnIds(): string[] {
    return [...this.#activeTurns.keys()];
  }

  #trace(event: TurnTraceEvent): void {
    try {
      this.#onTrace?.(event);
    } catch {
      // Observability must not affect turn routing or completion.
    }
  }

  #rememberMessage(messageId: string): number {
    const watermark = ++this.#watermark;
    this.#seenMessageWatermarks.set(messageId, watermark);
    if (
      this.#seenMessageWatermarks.size >
      this.#maxSeenMessageIds
    ) {
      const oldestMessageId =
        this.#seenMessageWatermarks.keys().next().value as
          | string
          | undefined;
      if (oldestMessageId !== undefined) {
        this.#seenMessageWatermarks.delete(oldestMessageId);
      }
    }
    return watermark;
  }
}

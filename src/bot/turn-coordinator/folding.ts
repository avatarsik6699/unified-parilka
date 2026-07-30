import type {
  ActiveTurn,
  FoldBatch,
  FoldedMessage,
  TurnBoundary,
  TurnSnapshot,
} from "./contracts.js";

export function snapshotTurn(turn: ActiveTurn): TurnSnapshot {
  return {
    turnId: turn.turnId,
    ownerSenderId: turn.ownerSenderId,
    startWatermark: turn.startWatermark,
    queuedMessages: turn.queue.length,
  };
}

export function drainTurnQueue(
  turn: ActiveTurn,
  boundary: TurnBoundary,
  maxFoldMessages: number,
  maxFoldChars: number,
): FoldBatch {
  const messages: FoldedMessage[] = [];
  let totalChars = 0;
  let consumedMessages = 0;

  for (const queued of turn.queue) {
    if (messages.length >= maxFoldMessages) {
      break;
    }
    const remainingChars = maxFoldChars - totalChars;
    if (remainingChars <= 0) {
      break;
    }
    const clipped = clipCodePoints(queued.text, remainingChars);
    messages.push({
      ...queued,
      text: clipped.text,
      truncated: clipped.truncated,
    });
    totalChars += clipped.chars;
    consumedMessages += 1;
  }

  if (consumedMessages > 0) {
    turn.queue.splice(0, consumedMessages);
  }
  return {
    turnId: turn.turnId,
    boundary,
    messages,
    ownerFollowUps: messages.filter(
      (message) => message.route === "owner_follow_up",
    ),
    ambient: messages.filter(
      (message) => message.route === "ambient",
    ),
    totalChars,
    remainingMessages: turn.queue.length,
  };
}

function clipCodePoints(
  text: string,
  maxChars: number,
): { text: string; chars: number; truncated: boolean } {
  const codePoints = [...text];
  if (codePoints.length <= maxChars) {
    return { text, chars: codePoints.length, truncated: false };
  }
  return {
    text: codePoints.slice(0, maxChars).join(""),
    chars: maxChars,
    truncated: true,
  };
}

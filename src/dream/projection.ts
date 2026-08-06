import { createHash } from "node:crypto";
import type { StoredMessage } from "../store.js";
import type { DreamInteraction, DreamWindow } from "./selector.js";

const DEFAULT_MAX_INPUT_CHARS = 120_000;

export type DreamProjectionRow = {
  messageId: number;
  date?: string;
  senderId?: string;
  senderName?: string;
  text: string;
  replyToMessageId?: number;
  authorRole: "user" | "assistant" | "unknown";
  isOwnTurn: boolean;
  markers?: ("trigger" | "answer")[];
};

export interface ProjectDreamDayOptions {
  botSenderId: string;
  maxInputChars?: number;
}

export interface DreamDayProjection {
  sourceText: string;
  sourceHash: string;
  interactionCount: number;
  firstMessageId?: number;
  lastMessageId?: number;
  /** True when the day had to be split into multiple whole-window batches. */
  batched: boolean;
  batches: DreamBatchProjection[];
}

export interface DreamBatchProjection {
  sourceText: string;
  sourceHash: string;
  interactionCount: number;
  /** Authoritative source id taken from an actual trigger/answer message. */
  sourceMessageId: number;
  firstMessageId: number;
  lastMessageId: number;
}

/**
 * Project a day's interactions into deterministic role-aware NDJSON and split
 * the result into batches if the combined text exceeds maxInputChars.
 *
 * Each batch keeps whole merged windows; `batched` reports whether the day was
 * split into several whole-window batches. No window is ever truncated, split,
 * or dropped, so no truncation metadata exists.
 */
export function projectDreamDay(
  interactions: DreamInteraction[],
  options: ProjectDreamDayOptions,
): DreamDayProjection {
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const windows = interactions.map((interaction) => interaction.window);
  const fullText = renderWindows(windows, options.botSenderId);
  const fullHash = sha256(fullText);
  const totalInteractionCount = interactions.reduce(
    (sum, interaction) => sum + interaction.rawInteractionCount,
    0,
  );
  const firstMessageId = windows[0]?.messages[0]?.messageId;
  const lastMessageId = windows[windows.length - 1]?.messages[
    windows[windows.length - 1]!.messages.length - 1
  ]?.messageId;

  if (fullText.length <= maxInputChars || windows.length <= 1) {
    const sourceMessageId = deriveBatchSourceMessageId(interactions);
    return {
      sourceText: fullText,
      sourceHash: fullHash,
      interactionCount: totalInteractionCount,
      firstMessageId,
      lastMessageId,
      batched: false,
      batches: [
        {
          sourceText: fullText,
          sourceHash: fullHash,
          interactionCount: totalInteractionCount,
          sourceMessageId,
          firstMessageId: firstMessageId ?? 0,
          lastMessageId: lastMessageId ?? 0,
        },
      ],
    };
  }

  // Split by whole windows. Batching whole merged windows is not truncation.
  const batches: DreamBatchProjection[] = [];
  let currentInteractions: DreamInteraction[] = [];
  let currentText = "";
  for (const interaction of interactions) {
    const rendered = renderWindow(interaction.window, options.botSenderId);
    const separator = currentText.length > 0 ? "\n" : "";
    if (
      currentText.length + separator.length + rendered.length > maxInputChars &&
      currentInteractions.length > 0
    ) {
      batches.push(buildBatch(currentInteractions, options.botSenderId));
      currentInteractions = [interaction];
      currentText = rendered;
    } else {
      currentInteractions.push(interaction);
      currentText += separator + rendered;
    }
  }
  if (currentInteractions.length > 0) {
    batches.push(buildBatch(currentInteractions, options.botSenderId));
  }

  return {
    sourceText: fullText,
    sourceHash: fullHash,
    interactionCount: totalInteractionCount,
    firstMessageId,
    lastMessageId,
    batched: true,
    batches,
  };
}

function buildBatch(
  interactions: DreamInteraction[],
  botSenderId: string,
): DreamBatchProjection {
  const windows = interactions.map((interaction) => interaction.window);
  const text = renderWindows(windows, botSenderId);
  const firstMessageId = windows[0]!.messages[0]!.messageId;
  const lastMessageId = windows[windows.length - 1]!.messages[
    windows[windows.length - 1]!.messages.length - 1
  ]!.messageId;
  return {
    sourceText: text,
    sourceHash: sha256(text),
    interactionCount: interactions.reduce(
      (sum, interaction) => sum + interaction.rawInteractionCount,
      0,
    ),
    sourceMessageId: deriveBatchSourceMessageId(interactions),
    firstMessageId,
    lastMessageId,
  };
}

function deriveBatchSourceMessageId(interactions: DreamInteraction[]): number {
  const first = interactions[0];
  if (!first) {
    return 0;
  }
  if (first.triggerMessageIds.length > 0) {
    return first.triggerMessageIds[0]!;
  }
  if (first.answerMessageIds.length > 0) {
    return first.answerMessageIds[0]!;
  }
  return first.window.messages[0]?.messageId ?? 0;
}

function renderWindows(windows: DreamWindow[], botSenderId: string): string {
  return windows
    .map((window) => renderWindow(window, botSenderId))
    .join("\n");
}

function renderWindow(window: DreamWindow, botSenderId: string): string {
  const rows: DreamProjectionRow[] = window.messages.map((message, index) =>
    messageToRow(message, botSenderId, window, index),
  );
  return rows
    .map((row) => JSON.stringify(row, Object.keys(row).sort()))
    .join("\n");
}

function messageToRow(
  message: StoredMessage,
  botSenderId: string,
  window: DreamWindow,
  index: number,
): DreamProjectionRow {
  const isOwnTurn = message.senderId === botSenderId;
  const authorRole: DreamProjectionRow["authorRole"] = isOwnTurn
    ? "assistant"
    : message.senderId != null
      ? "user"
      : "unknown";
  const markers: ("trigger" | "answer")[] = [];
  if (window.triggerIndices.includes(index)) {
    markers.push("trigger");
  }
  if (window.answerIndices.includes(index)) {
    markers.push("answer");
  }
  const row: DreamProjectionRow = {
    messageId: message.messageId,
    date: message.date,
    senderId: message.senderId,
    senderName: message.senderName,
    text: (message.text ?? "").replace(/\s+/gu, " ").trim(),
    replyToMessageId: message.replyToMessageId,
    authorRole,
    isOwnTurn,
  };
  if (markers.length > 0) {
    row.markers = markers;
  }
  return row;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

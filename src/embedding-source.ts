import { createHash } from "node:crypto";
import type { StoredMessage } from "./storage/types.js";

const TRUNCATION_MARKER = " [truncated]";

/**
 * Canonical text sent to an embedding provider for one cached message.
 *
 * Keep this formatter pure: storage re-renders the same source inside its
 * commit transaction to reject vectors produced from stale message rows.
 */
export function formatEmbeddingMessage(message: StoredMessage): string {
  const sender = message.senderName || message.senderId || "unknown";
  const date = message.date ?? "no-date";
  const text = message.text.replace(/\s+/gu, " ").trim();
  return `[${message.messageId} ${date}] ${sender}: ${text}`;
}

export function formatEmbeddingMessageForChunk(
  message: StoredMessage,
  maxChars: number,
): string {
  assertEmbeddingChunkMaxChars(maxChars);
  const formatted = formatEmbeddingMessage(message);
  if (formatted.length <= maxChars) {
    return formatted;
  }
  if (maxChars <= TRUNCATION_MARKER.length) {
    return formatted.slice(0, maxChars);
  }
  return `${formatted.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export function renderEmbeddingChunkSource(
  messages: readonly StoredMessage[],
  maxChars: number,
): string {
  assertEmbeddingChunkMaxChars(maxChars);
  return messages
    .map((message) => formatEmbeddingMessageForChunk(message, maxChars))
    .join("\n");
}

export function fingerprintEmbeddingSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function embeddingSourceEquals(
  left: string,
  right: string,
): boolean {
  return Buffer.from(left, "utf8").equals(Buffer.from(right, "utf8"));
}

export function embeddingMessageSourceChanged(
  previous: StoredMessage,
  next: StoredMessage,
): boolean {
  return (
    previous.deletedAt !== next.deletedAt ||
    !embeddingSourceEquals(
      formatEmbeddingMessage(previous),
      formatEmbeddingMessage(next),
    )
  );
}

export function assertEmbeddingChunkMaxChars(maxChars: number): void {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1_000_000) {
    throw new Error(
      "chunkMaxChars must be a positive safe integer no greater than 1000000.",
    );
  }
}

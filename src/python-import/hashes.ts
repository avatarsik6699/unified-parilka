import { createHash } from "node:crypto";
import type { StoredMessage } from "../store.js";

export function updateMessageHash(
  hash: ReturnType<typeof createHash>,
  message: StoredMessage,
): void {
  hash.update(
    JSON.stringify([
      message.chatId,
      message.messageId,
      message.date,
      message.senderId,
      message.senderName,
      message.text,
      message.replyToMessageId,
    ]),
  );
  hash.update("\n");
}

export function digestHash(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

import { randomInt } from "node:crypto";
import { APIError, APIErrorCode, type VK } from "vk-io";
import {
  splitTelegramText,
  TELEGRAM_TEXT_LIMIT_UTF16,
} from "../telegram-publication.js";
import type {
  BotTurnPublisher,
  TelegramPublishRequest,
  TelegramPublisherResult,
} from "../worker.js";
import { peerIdFromVkChatId } from "../../vk/types.js";

type PublisherFailure = Extract<
  TelegramPublisherResult,
  { ok: false }
>["error"];

const RETRYABLE_VK_CODES: ReadonlySet<number> = new Set([
  APIErrorCode.TOO_MANY,
  APIErrorCode.FLOOD,
]);

/**
 * VK's `messages.send` -- same message-length limit as Telegram (4096 UTF-16
 * code units, confirmed via dev.vk.com), so the existing chunk splitter is
 * reused rather than duplicated. VK has no Telegram-style native "rich
 * message"/entity API, so `rich` publications degrade to plain text (visible
 * markdown syntax is an accepted v1 limitation, not a bug); `photo`/`voice`
 * degrade to their caption as plain text -- VK media upload (a multi-step
 * `vk.upload` flow) is out of scope for v1.
 */
export class VkBotTurnPublisher implements BotTurnPublisher {
  readonly #vk: VK;

  constructor(vk: VK) {
    this.#vk = vk;
  }

  async publish(
    request: TelegramPublishRequest,
  ): Promise<TelegramPublisherResult> {
    const peerId = peerIdFromVkChatId(request.chatId);
    if (peerId === undefined) {
      return failure(0, { kind: "unknown", code: "INVALID_VK_CHAT_ID" });
    }
    const plainText =
      request.publication.mode === "photo" ||
      request.publication.mode === "voice"
        ? request.publication.caption
        : request.publication.plainText;
    if (typeof plainText !== "string" || plainText.length === 0) {
      return failure(0, { kind: "unknown", code: "INVALID_PUBLISH_REQUEST" });
    }
    return this.#publishPlain(request, peerId, plainText);
  }

  async #publishPlain(
    request: TelegramPublishRequest,
    peerId: number,
    plainText: string,
  ): Promise<TelegramPublisherResult> {
    const chunks = splitTelegramText(plainText, TELEGRAM_TEXT_LIMIT_UTF16);
    let chunksSent = 0;
    let firstMessageId: number | undefined;

    for (const chunk of chunks) {
      if (request.signal.aborted) {
        return ambiguousOrPartialFailure(chunksSent, {
          kind: "timeout",
          code: "ABORTED",
        });
      }

      let response: unknown;
      try {
        // No `reply_to`: VK rejects it ("cannot reply this message",
        // error_code 100) for the conversation_message_id we have -- VK's
        // own message-identity gaps for community-received messages (see
        // vkSyntheticUpdateId) make reply-threading unreliable here.
        // Replies land as plain new messages in the beседа instead.
        response = await this.#vk.api.messages.send({
          peer_id: peerId,
          message: chunk,
          random_id: randomInt(-2_147_483_648, 2_147_483_647),
        });
      } catch (error) {
        return classifyThrownFailure(error, request.signal, chunksSent);
      }

      const messageId = readVkMessageId(response);
      if (messageId === undefined) {
        return ambiguousOrPartialFailure(chunksSent, {
          kind: "unknown",
          code: "MALFORMED_SUCCESS_RESPONSE",
        });
      }
      chunksSent += 1;
      firstMessageId ??= messageId;
    }

    return {
      ok: true,
      chunksSent,
      ...(firstMessageId === undefined
        ? {}
        : { telegramMessageId: firstMessageId }),
    };
  }
}

function classifyThrownFailure(
  error: unknown,
  signal: AbortSignal,
  chunksSent: number,
): TelegramPublisherResult {
  if (error instanceof APIError) {
    return ambiguousOrPartialFailure(chunksSent, {
      kind: "telegram_rejected",
      code: `VK_${String(error.code)}`,
      retryable: RETRYABLE_VK_CODES.has(Number(error.code)),
    });
  }
  return ambiguousOrPartialFailure(
    chunksSent,
    classifyTransportFailure(error, signal),
  );
}

function classifyTransportFailure(
  error: unknown,
  signal: AbortSignal,
): PublisherFailure {
  if (signal.aborted) {
    return { kind: "timeout", code: "ABORTED" };
  }
  const marker = readErrorMarker(error);
  if (marker.name === "AbortError" || marker.name === "TimeoutError") {
    return {
      kind: "timeout",
      code: marker.name === "AbortError" ? "ABORTED" : "TIMEOUT",
    };
  }
  return { kind: "unknown", code: "UNKNOWN_ERROR" };
}

function ambiguousOrPartialFailure(
  chunksSent: number,
  error: PublisherFailure,
): TelegramPublisherResult {
  return chunksSent > 0
    ? failure(chunksSent, { kind: "unknown", code: "PARTIAL_DELIVERY" })
    : failure(0, error);
}

function failure(
  chunksSent: number,
  error: PublisherFailure,
): TelegramPublisherResult {
  return { ok: false, chunksSent, error };
}

function readVkMessageId(value: unknown): number | undefined {
  // A single-peer `messages.send` resolves to a bare message_id number --
  // confirmed empirically that this is 0 on a real successful send (VK's
  // own message-identity gaps strike again, see vkSyntheticUpdateId), so
  // 0 is accepted as a valid (if uninformative) acknowledgment, not treated
  // as a malformed response.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function readErrorMarker(value: unknown): { name?: string } {
  if (value === null || typeof value !== "object") {
    return {};
  }
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? { name } : {};
}

import type { Api } from "grammy";
import type { ChatInfo } from "../../telegram-client.js";
import type { StoredMessage } from "../../store.js";
import { GrammyBotTurnPublisher, type GrammyBotApiPort } from "../grammy-publisher.js";
import type { BotRuntimeConfig } from "../runtime-config.js";
import type { OwnSendStore } from "./contracts.js";
import type { BotApiLongPollerOptions, GrammyLongPollingApiPort } from "./long-poller.js";
import { asRecord, botApiDate, BotRuntimeProtocolError, normalizeExpectedUsername, positiveSafeInteger, positiveTelegramId, stringifyUpdate, telegramId } from "./helpers.js";

export function createGrammyLongPollingApi(
  api: Pick<Api, "getMe" | "deleteWebhook" | "getUpdates">,
): GrammyLongPollingApiPort {
  return {
    getMe: (signal) =>
      api.getMe(
        signal as unknown as Parameters<Api["getMe"]>[0],
      ),
    deleteWebhook: (options, signal) =>
      api.deleteWebhook(
        options,
        signal as unknown as Parameters<Api["deleteWebhook"]>[1],
      ),
    getUpdates: (options, signal) =>
      api.getUpdates(
        options,
        signal as unknown as Parameters<Api["getUpdates"]>[1],
      ),
  };
}

export interface DurableGrammyPublisherOptions {
  store: OwnSendStore;
  botId: string;
  botUsername: string;
}

/**
 * Wraps the real send operation so every acknowledged bot message is inserted
 * into the shared corpus before control returns to BotTurnWorker. A recording
 * failure happens after network dispatch and therefore becomes lost_ack, never
 * an automatic resend.
 */
export function createDurableGrammyBotTurnPublisher(
  api: Pick<Api, "sendMessage">,
  options: DurableGrammyPublisherOptions,
): GrammyBotTurnPublisher {
  const botId = positiveTelegramId(options.botId, "botId");
  const botUsername = normalizeExpectedUsername(options.botUsername);
  const port: GrammyBotApiPort = {
    async sendMessage(chatId, text, sendOptions, signal) {
      const response = await api.sendMessage(
        chatId,
        text,
        sendOptions as unknown as Parameters<Api["sendMessage"]>[2],
        signal as unknown as Parameters<Api["sendMessage"]>[3],
      );
      recordOwnSend(options.store, {
        response,
        requestedChatId: chatId,
        text,
        replyToMessageId: sendOptions.reply_parameters.message_id,
        botId,
        botUsername,
      });
      return response;
    },
  };
  return new GrammyBotTurnPublisher(port);
}

export function botRuntimeOptionsFromConfig(
  config: Readonly<BotRuntimeConfig>,
): Pick<
  BotApiLongPollerOptions,
  | "expectedBotId"
  | "expectedBotUsername"
  | "initialOffset"
  | "pollTimeoutSec"
  | "pollLimit"
  | "backoffInitialMs"
  | "backoffMaxMs"
> {
  return {
    expectedBotId: config.botId,
    expectedBotUsername: config.botUsername,
    ...(config.initialOffset === undefined
      ? {}
      : { initialOffset: config.initialOffset }),
    pollTimeoutSec: config.pollTimeoutSec,
    pollLimit: config.pollLimit,
    backoffInitialMs: config.pollBackoffInitialMs,
    backoffMaxMs: config.pollBackoffMaxMs,
  };
}

function recordOwnSend(
  store: OwnSendStore,
  input: {
    response: unknown;
    requestedChatId: string;
    text: string;
    replyToMessageId: number;
    botId: string;
    botUsername: string;
  },
): void {
  const response = asRecord(input.response);
  const messageId = positiveSafeInteger(response?.message_id);
  const responseChat = asRecord(response?.chat);
  const responseChatId = telegramId(responseChat?.id);
  if (
    !response ||
    messageId === undefined ||
    responseChatId === undefined ||
    responseChatId !== input.requestedChatId
  ) {
    throw new BotRuntimeProtocolError("OWN_SEND_RESPONSE_MALFORMED");
  }
  const responseSenderId = telegramId(asRecord(response.from)?.id);
  if (
    responseSenderId !== undefined &&
    responseSenderId !== input.botId
  ) {
    throw new BotRuntimeProtocolError("OWN_SEND_IDENTITY_MISMATCH");
  }

  const cachedChat = store.getCachedChat(input.requestedChatId);
  const chat: ChatInfo =
    cachedChat ?? {
      chatId: input.requestedChatId,
      requested: input.requestedChatId,
      kind:
        typeof responseChat?.type === "string"
          ? responseChat.type
          : "unknown",
      ...(typeof responseChat?.title === "string"
        ? { title: responseChat.title }
        : {}),
      ...(typeof responseChat?.username === "string"
        ? { username: responseChat.username }
        : {}),
    };
  const date = botApiDate(response.date);
  const rawJson = stringifyUpdate(response);
  store.upsertMessages(chat, [
    {
      chatId: input.requestedChatId,
      messageId,
      ...(date === undefined ? {} : { date }),
      senderId: input.botId,
      senderName: input.botUsername,
      text: input.text,
      replyToMessageId: input.replyToMessageId,
      ...(rawJson === undefined ? {} : { rawJson }),
    },
  ]);
}

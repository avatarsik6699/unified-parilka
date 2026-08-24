import type { Api } from "grammy";
import type { NewsBriefTelegramApi } from "./send.js";

/** Adapts a raw grammy `Api` into the narrow `NewsBriefTelegramApi` port -- shared by the CLI and the live-bot privileged trigger. */
export function grammyNewsBriefApi(
  api: Pick<Api, "sendMessage">,
): NewsBriefTelegramApi {
  return {
    async sendMessage(chatId, text, other) {
      const sent = await api.sendMessage(
        chatId,
        text,
        other as Parameters<Api["sendMessage"]>[2],
      );
      return { message_id: sent.message_id };
    },
  };
}

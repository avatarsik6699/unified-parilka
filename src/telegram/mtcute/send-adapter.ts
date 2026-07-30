import { md, thtml } from "@mtcute/node";
import type { ChatInfo } from "../types.js";
import type {
  GetMtcuteClient,
  MtcuteOutboundText,
  MtcuteSendRequest,
} from "./contracts.js";
import {
  MtcuteTransportError,
  unsupportedMtcuteMessage,
} from "./errors.js";
import type { MtcutePeerResolver } from "./peer-resolver.js";
import {
  setIfDefined,
  validateOptionalRequestInteger,
} from "./request-utils.js";

export class MtcuteSendAdapter {
  constructor(
    private readonly peers: MtcutePeerResolver,
    private readonly getClient: GetMtcuteClient,
  ) {}

  async sendMessage(
    params: MtcuteSendRequest,
  ): Promise<{ id: number; chat: ChatInfo }> {
    validateSendRequest(params);
    const resolved = await this.peers.resolve(params.chat);
    const client = await this.getClient();

    if (params.replyToMessageId != null) {
      const [replyTarget] = await client.getMessages(
        resolved.input,
        params.replyToMessageId,
      );
      if (!replyTarget || replyTarget.id !== params.replyToMessageId) {
        throw new MtcuteTransportError(
          "reply_target_not_found",
          "reply",
          false,
          `Reply target ${params.replyToMessageId} was not found in the resolved chat.`,
        );
      }
    }

    const sendParams: {
      replyTo?: number;
      threadId?: number;
      silent?: boolean;
      disableWebPreview?: boolean;
    } = {};
    setIfDefined(sendParams, "replyTo", params.replyToMessageId);
    setIfDefined(sendParams, "threadId", params.topicId);
    setIfDefined(sendParams, "silent", params.silent);
    if (params.linkPreview != null) {
      sendParams.disableWebPreview = !params.linkPreview;
    }

    const sent = await client.sendText(
      resolved.input,
      parseOutboundText(params.text, params.parseMode),
      sendParams,
    );
    if (!Number.isSafeInteger(sent.id) || sent.id <= 0) {
      throw unsupportedMtcuteMessage("Sent message has an invalid ID.");
    }
    return { id: sent.id, chat: resolved.info };
  }
}

function validateSendRequest(params: MtcuteSendRequest): void {
  if (typeof params.text !== "string" || params.text.length === 0) {
    throw new MtcuteTransportError(
      "invalid_request",
      "validation",
      false,
      "Message text must be non-empty.",
    );
  }
  validateOptionalRequestInteger(
    "replyToMessageId",
    params.replyToMessageId,
    1,
  );
  validateOptionalRequestInteger("topicId", params.topicId, 1);
  if (
    params.parseMode != null &&
    !["none", "html", "markdown"].includes(params.parseMode)
  ) {
    throw new MtcuteTransportError(
      "invalid_request",
      "validation",
      false,
      "parseMode must be none, html, or markdown.",
    );
  }
}

function parseOutboundText(
  text: string,
  parseMode: MtcuteSendRequest["parseMode"],
): MtcuteOutboundText {
  if (parseMode === "html") {
    return thtml(text);
  }
  if (parseMode === "markdown") {
    return md(text);
  }
  return text;
}

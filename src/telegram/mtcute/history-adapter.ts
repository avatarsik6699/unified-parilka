import type {
  ChatInfo,
  TelegramHistoryMessage,
} from "../types.js";
import type {
  GetMtcuteClient,
  MtcuteClientPort,
  MtcuteHistoryOffset,
  MtcuteHistoryRequest,
  MtcuteTransportConfig,
} from "./contracts.js";
import { MtcuteTransportError } from "./errors.js";
import { normalizeMtcuteMessage } from "./message-normalizer.js";
import type { MtcutePeerResolver } from "./peer-resolver.js";
import {
  validateOptionalRequestInteger,
  validateRequestInteger,
} from "./request-utils.js";

export class MtcuteHistoryAdapter {
  constructor(
    private readonly config: Readonly<MtcuteTransportConfig>,
    private readonly peers: MtcutePeerResolver,
    private readonly getClient: GetMtcuteClient,
  ) {}

  async getMessages(
    params: MtcuteHistoryRequest,
  ): Promise<{ chat: ChatInfo; messages: TelegramHistoryMessage[] }> {
    validateHistoryRequest(params, this.config.maxHistoryMessages);
    const resolved = await this.peers.resolve(params.chat);
    const client = await this.getClient();

    if (params.ids != null) {
      const requestedIds = normalizeMessageIds(params.ids).slice(
        0,
        params.limit,
      );
      const messages = await this.getMessagesById(
        client,
        resolved.input,
        requestedIds,
      );
      return { chat: resolved.info, messages };
    }

    const messages: TelegramHistoryMessage[] = [];
    for await (const message of this.paginate(
      client,
      resolved.input,
      params,
    )) {
      messages.push(message);
    }
    return { chat: resolved.info, messages };
  }

  async iterateMessages(
    params: Omit<MtcuteHistoryRequest, "ids">,
  ): Promise<{
    chat: ChatInfo;
    messages: AsyncIterable<TelegramHistoryMessage>;
  }> {
    validateHistoryRequest(params, this.config.maxHistoryMessages);
    const resolved = await this.peers.resolve(params.chat);
    const client = await this.getClient();
    return {
      chat: resolved.info,
      messages: this.paginate(client, resolved.input, params),
    };
  }

  private async getMessagesById(
    client: MtcuteClientPort,
    peer: number,
    requestedIds: readonly number[],
  ): Promise<TelegramHistoryMessage[]> {
    const messages: TelegramHistoryMessage[] = [];
    for (
      let start = 0;
      start < requestedIds.length;
      start += this.config.historyPageSize
    ) {
      const chunk = requestedIds.slice(
        start,
        start + this.config.historyPageSize,
      );
      const page = await client.getMessages(peer, chunk);
      for (const message of page) {
        if (message) {
          messages.push(normalizeMtcuteMessage(message));
        }
      }
    }
    return messages;
  }

  private async *paginate(
    client: MtcuteClientPort,
    peer: number,
    params: Omit<MtcuteHistoryRequest, "ids">,
  ): AsyncIterable<TelegramHistoryMessage> {
    let remaining = params.limit;
    let offset =
      params.offsetId != null && params.offsetId > 0
        ? { id: params.offsetId, date: 0 }
        : undefined;
    const visitedOffsets = new Set<string>();

    while (remaining > 0) {
      const pageLimit = Math.min(this.config.historyPageSize, remaining);
      const page = await client.getHistory(peer, {
        limit: pageLimit,
        ...(offset ? { offset } : {}),
        ...(params.minId != null && params.minId > 0
          ? { minId: params.minId }
          : {}),
        ...(params.maxId != null && params.maxId > 0
          ? { maxId: params.maxId }
          : {}),
      });
      if (page.length === 0) {
        return;
      }

      for (const message of page) {
        if (remaining === 0) {
          return;
        }
        yield normalizeMtcuteMessage(message);
        remaining -= 1;
      }

      if (remaining === 0 || !page.next) {
        return;
      }
      validateHistoryOffset(page.next);
      const nextKey = `${page.next.id}:${page.next.date}`;
      const currentKey = offset ? `${offset.id}:${offset.date}` : undefined;
      if (nextKey === currentKey || visitedOffsets.has(nextKey)) {
        throw new MtcuteTransportError(
          "pagination_stalled",
          "internal",
          false,
          "mtcute history pagination returned a repeated offset.",
        );
      }
      visitedOffsets.add(nextKey);
      offset = page.next;
    }
  }
}

function validateHistoryRequest(
  params: MtcuteHistoryRequest | Omit<MtcuteHistoryRequest, "ids">,
  maximum: number,
): void {
  validateRequestInteger("limit", params.limit, 0, maximum);
  validateOptionalRequestInteger("offsetId", params.offsetId, 0);
  validateOptionalRequestInteger("minId", params.minId, 0);
  validateOptionalRequestInteger("maxId", params.maxId, 0);
  if ("ids" in params && params.ids != null) {
    normalizeMessageIds(params.ids);
  }
}

function normalizeMessageIds(ids: number | number[]): number[] {
  const normalized = Array.isArray(ids) ? ids : [ids];
  for (const id of normalized) {
    validateRequestInteger("message ID", id, 1, Number.MAX_SAFE_INTEGER);
  }
  return [...normalized];
}

function validateHistoryOffset(offset: MtcuteHistoryOffset): void {
  if (
    !Number.isSafeInteger(offset.id) ||
    offset.id < 0 ||
    !Number.isSafeInteger(offset.date) ||
    offset.date < 0
  ) {
    throw new MtcuteTransportError(
      "pagination_stalled",
      "internal",
      false,
      "mtcute history pagination returned an invalid offset.",
    );
  }
}

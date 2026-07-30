import type { ChatInfo, TelegramHistoryMessage, TelegramService } from "../src/telegram-client.js";

import type {
  ChatInfo,
  TelegramHistoryMessage,
} from "../../src/telegram-client.js";

export const CHAT: ChatInfo = {
  chatId: "-1001",
  requested: "-1001",
  kind: "Fake",
};

export class FakeTelegram {
  readonly requests: Array<{ limit: number; offsetId?: number; minId?: number; waitTime?: number }> = [];
  throwAfterTotal: number | undefined;
  private yieldedTotal = 0;

  constructor(private readonly ids: number[]) {}

  get yieldedCount(): number {
    return this.yieldedTotal;
  }

  async resolveChat(): Promise<{ info: ChatInfo }> {
    return { info: CHAT };
  }

  async iterateMessages(params: {
    limit: number;
    offsetId?: number;
    minId?: number;
    waitTime?: number;
  }): Promise<{ chat: ChatInfo; messages: AsyncIterable<TelegramHistoryMessage> }> {
    this.requests.push(params);
    const minId = params.minId ?? 0;
    const offsetId = params.offsetId ?? 0;
    const page = this.ids
      .filter((id) => id > minId)
      .filter((id) => offsetId <= 0 || id < offsetId)
      .sort((left, right) => right - left)
      .slice(0, params.limit);
    const self = this;

    return {
      chat: CHAT,
      messages: (async function* () {
        for (const id of page) {
          if (self.throwAfterTotal != null && self.yieldedTotal >= self.throwAfterTotal) {
            throw new Error("simulated iterator failure");
          }
          self.yieldedTotal += 1;
          yield telegramMessage(id);
        }
      })(),
    };
  }

  async getMessages(params: {
    ids?: number | number[];
  }): Promise<{ chat: ChatInfo; messages: TelegramHistoryMessage[] }> {
    const ids = Array.isArray(params.ids) ? params.ids : params.ids == null ? [] : [params.ids];
    return {
      chat: CHAT,
      messages: ids
        .filter((id) => this.ids.includes(id))
        .map(telegramMessage),
    };
  }
}

export function telegramMessage(
  id: number,
): TelegramHistoryMessage {
  return {
    messageId: id,
    text: `message ${id}`,
    sentAt: new Date((1_800_000_000 + id) * 1_000).toISOString(),
    isTopicMessage: false,
    isOutgoing: false,
    isService: false,
    isChannelPost: false,
  };
}

export class HangingTelegram {
  readonly requests: Array<{ limit: number; offsetId?: number; minId?: number; waitTime?: number }> = [];
  closed = false;

  async resolveChat(): Promise<{ info: ChatInfo }> {
    return { info: CHAT };
  }

  async iterateMessages(params: {
    limit: number;
    offsetId?: number;
    minId?: number;
    waitTime?: number;
  }): Promise<{ chat: ChatInfo; messages: AsyncIterable<Record<string, unknown>> }> {
    this.requests.push(params);
    const self = this;
    return {
      chat: CHAT,
      messages: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => new Promise<IteratorResult<Record<string, unknown>>>(() => undefined),
            return: async () => {
              self.closed = true;
              return { done: true, value: undefined as unknown as Record<string, unknown> };
            },
          };
        },
      },
    };
  }
}

export class HangingHistoryRequestTelegram {
  requests = 0;

  async resolveChat(): Promise<{ info: ChatInfo }> {
    return { info: CHAT };
  }

  async iterateMessages(): Promise<{
    chat: ChatInfo;
    messages: AsyncIterable<Record<string, unknown>>;
  }> {
    this.requests += 1;
    return await new Promise(() => undefined);
  }
}

export class HangingReconciliationTelegram extends FakeTelegram {
  readonly reconciliationStarted: Promise<void>;
  private markReconciliationStarted!: () => void;

  constructor() {
    super([]);
    this.reconciliationStarted = new Promise<void>((resolve) => {
      this.markReconciliationStarted = resolve;
    });
  }

  override async getMessages(): Promise<{
    chat: ChatInfo;
    messages: TelegramHistoryMessage[];
  }> {
    this.markReconciliationStarted();
    return await new Promise(() => undefined);
  }
}

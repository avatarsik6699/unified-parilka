import {
  convertToGramjsSession,
  convertToTelethonSession,
} from "@mtcute/convert";
import {
  MtcuteTelegramService,
  MtcuteTransportError,
  type MtcuteClientFactory,
  type MtcuteClientPort,
  type MtcuteHistoryOffset,
  type MtcuteHistoryPage,
  type MtcuteMessageSource,
  type MtcuteOutboundText,
  type MtcutePeerSource,
  type MtcuteTransportConfig,
} from "../../src/telegram/mtcute-client.js";
import type { MtcuteSessionImportTarget } from "../../src/telegram/session-import.js";

export const CHAT_ID = -1_001_234_567_890;

export const CHAT_PEER: MtcutePeerSource = {
  type: "chat",
  id: CHAT_ID,
  displayName: "Parilka",
  title: "Parilka",
  username: "parilka_chat",
  chatType: "supergroup",
  isForum: true,
  isBanned: false,
  permissions: { canSendMessages: true },
  defaultPermissions: { canSendMessages: true },
};

const USER_PEER: MtcutePeerSource = {
  type: "user",
  id: 42,
  displayName: "Alice Example",
  username: "alice",
  isBot: false,
  isDeleted: false,
};

type HistoryCall = {
  peer: number;
  params: {
    limit: number;
    offset?: MtcuteHistoryOffset;
    minId?: number;
    maxId?: number;
  };
};

type SendCall = {
  peer: number;
  text: MtcuteOutboundText;
  params: {
    replyTo?: number;
    threadId?: number;
    silent?: boolean;
    disableWebPreview?: boolean;
  };
};

export class FakeMtcuteClient implements MtcuteClientPort {
  connectCalls = 0;
  disconnectCalls = 0;
  destroyCalls = 0;
  readonly peerCalls: Array<{
    peer: string | number;
    refresh?: boolean;
  }> = [];
  readonly historyCalls: HistoryCall[] = [];
  readonly directMessageCalls: Array<{
    peer: number;
    ids: number | number[];
  }> = [];
  readonly sendCalls: SendCall[] = [];

  peer: MtcutePeerSource = CHAT_PEER;
  historyHandler: (
    call: HistoryCall,
  ) => Promise<MtcuteHistoryPage> = async () => historyPage([]);
  directMessagesHandler: (
    peer: number,
    ids: number | number[],
  ) => Promise<ReadonlyArray<MtcuteMessageSource | null>> = async (
    _peer,
    ids,
  ) => {
    const requested = Array.isArray(ids) ? ids : [ids];
    return requested.map((id) => message(id));
  };
  sendHandler: (
    call: SendCall,
  ) => Promise<MtcuteMessageSource> = async () => message(999);

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
  }

  async getPeer(
    peer: string | number,
    refresh?: boolean,
  ): Promise<MtcutePeerSource> {
    this.peerCalls.push({ peer, refresh });
    return this.peer;
  }

  async getHistory(
    peer: number,
    params: HistoryCall["params"],
  ): Promise<MtcuteHistoryPage> {
    const call = { peer, params };
    this.historyCalls.push(call);
    return this.historyHandler(call);
  }

  async getMessages(
    peer: number,
    ids: number | number[],
  ): Promise<ReadonlyArray<MtcuteMessageSource | null>> {
    this.directMessageCalls.push({
      peer,
      ids: Array.isArray(ids) ? [...ids] : ids,
    });
    return this.directMessagesHandler(peer, ids);
  }

  async sendText(
    peer: number,
    text: MtcuteOutboundText,
    params: SendCall["params"],
  ): Promise<MtcuteMessageSource> {
    const call = { peer, text, params: { ...params } };
    this.sendCalls.push(call);
    return this.sendHandler(call);
  }
}

export class FakeSessionTarget implements MtcuteSessionImportTarget {
  readonly imports: Array<{
    authKeyLength: number;
    force?: boolean;
  }> = [];

  constructor(
    private authorized = false,
    private authKeyLength = 256,
  ) {}

  readonly mt = {
    storage: {
      dcs: {
        fetch: async (): Promise<{ main: { id: number } }> => ({
          main: { id: 2 },
        }),
      },
      provider: {
        authKeys: {
          get: async (_dcId: number): Promise<Uint8Array | null> =>
            this.authorized
              ? new Uint8Array(this.authKeyLength)
              : null,
        },
      },
    },
  };

  async prepare(): Promise<void> {}

  async importSession(
    session: Parameters<MtcuteSessionImportTarget["importSession"]>[0],
    force?: boolean,
  ): Promise<void> {
    this.imports.push({
      authKeyLength: session.authKey.byteLength,
      force,
    });
    this.authorized = true;
    this.authKeyLength = session.authKey.byteLength;
  }
}

export function config(
  overrides: Partial<MtcuteTransportConfig> = {},
): MtcuteTransportConfig {
  return {
    apiId: 12345,
    apiHash: "test-api-hash",
    authStoragePath: "/tmp/parilka-mtcute-test/auth.sqlite",
    applicationDbPath:
      "/tmp/parilka-mtcute-test/application.sqlite",
    defaultChatId: String(CHAT_ID),
    allowedChatIds: [String(CHAT_ID)],
    requireAllowlistedChat: true,
    historyPageSize: 100,
    maxHistoryMessages: 1_000,
    connectionMaxAttempts: 5,
    connectionTimeoutMs: 30_000,
    connectionRetryInitialMs: 250,
    connectionRetryMaxMs: 4_000,
    requestTimeoutMs: 30_000,
    requestMaxRetries: 2,
    requestRetryDelayMs: 250,
    floodWaitMaxMs: 10_000,
    ...overrides,
  };
}

export function harness(
  fake: FakeMtcuteClient,
  overrides: Partial<MtcuteTransportConfig> = {},
): {
  service: MtcuteTelegramService;
  factory: MtcuteClientFactory;
} {
  const factory: MtcuteClientFactory = () => fake;
  return {
    service: new MtcuteTelegramService(config(overrides), factory),
    factory,
  };
}

export function message(
  id: number,
  overrides: Partial<MtcuteMessageSource> = {},
): MtcuteMessageSource {
  return {
    id,
    text: `message ${id}`,
    date: new Date(
      `2026-07-30T10:${String(id % 60).padStart(2, "0")}:00.000Z`,
    ),
    editDate: null,
    sender: USER_PEER,
    replyToMessage: null,
    isTopicMessage: false,
    isOutgoing: false,
    isService: false,
    isChannelPost: false,
    ...overrides,
  };
}

export function historyPage(
  messages: MtcuteMessageSource[],
  next?: MtcuteHistoryOffset,
): MtcuteHistoryPage {
  return Object.assign([...messages], {
    total: messages.length,
    ...(next ? { next } : {}),
  });
}

export function errorWithCode(
  code: MtcuteTransportError["code"],
): (error: unknown) => boolean {
  return (error) =>
    error instanceof MtcuteTransportError &&
    error.code === code;
}

export function validGramjsStringSession(): string {
  return convertToGramjsSession(stringSessionData());
}

export function validTelethonStringSession(): string {
  return convertToTelethonSession(stringSessionData());
}

function stringSessionData() {
  const dc = {
    id: 2,
    ipAddress: "149.154.167.50",
    port: 443,
    ipv6: false,
    testMode: false,
  };
  return {
    version: 3,
    primaryDcs: {
      main: dc,
      media: dc,
    },
    self: null,
    authKey: new Uint8Array(256).fill(7),
  };
}

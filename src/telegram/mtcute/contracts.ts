import { thtml } from "@mtcute/node";
import type {
  ChatInfo,
  TelegramHistoryRequest,
  TelegramSendRequest,
} from "../types.js";

export interface MtcuteTransportConfig {
  apiId: number;
  apiHash: string;
  authStoragePath: string;
  applicationDbPath: string;
  defaultChatId: string;
  allowedChatIds: readonly string[];
  requireAllowlistedChat: boolean;
  historyPageSize: number;
  maxHistoryMessages: number;
  connectionMaxAttempts: number;
  connectionTimeoutMs: number;
  connectionRetryInitialMs: number;
  connectionRetryMaxMs: number;
  requestTimeoutMs: number;
  requestMaxRetries: number;
  requestRetryDelayMs: number;
  floodWaitMaxMs: number;
}

export type MtcutePeerSource =
  | {
      readonly type: "user";
      readonly id: number;
      readonly displayName: string;
      readonly username: string | null;
      readonly isBot: boolean;
      readonly isDeleted: boolean;
    }
  | {
      readonly type: "chat";
      readonly id: number;
      readonly displayName: string;
      readonly title: string;
      readonly username: string | null;
      readonly chatType:
        | "group"
        | "supergroup"
        | "channel"
        | "gigagroup"
        | "monoforum"
        | "community";
      readonly isForum: boolean;
      readonly isBanned: boolean;
      readonly permissions: { readonly canSendMessages: boolean } | null;
      readonly defaultPermissions: {
        readonly canSendMessages: boolean;
      } | null;
    };

export type MtcuteMessageSource = {
  readonly id: number;
  readonly text: string;
  readonly date: Date;
  readonly editDate: Date | null;
  readonly sender: MtcutePeerSource;
  readonly replyToMessage: {
    readonly id: number | null;
    readonly threadId: number | null;
    readonly isForumTopic: boolean;
  } | null;
  readonly isTopicMessage: boolean;
  readonly isOutgoing: boolean;
  readonly isService: boolean;
  readonly isChannelPost: boolean;
};

export type MtcuteHistoryOffset = {
  readonly id: number;
  readonly date: number;
};

export type MtcuteHistoryPage = ReadonlyArray<MtcuteMessageSource> & {
  readonly total?: number;
  readonly next?: MtcuteHistoryOffset;
};

export type MtcuteOutboundText = string | ReturnType<typeof thtml>;

export interface MtcuteClientPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  destroy(): Promise<void>;
  getPeer(peer: string | number, refresh?: boolean): Promise<MtcutePeerSource>;
  getHistory(
    peer: number,
    params: {
      limit: number;
      offset?: MtcuteHistoryOffset;
      minId?: number;
      maxId?: number;
    },
  ): Promise<MtcuteHistoryPage>;
  getMessages(
    peer: number,
    ids: number | number[],
  ): Promise<ReadonlyArray<MtcuteMessageSource | null>>;
  sendText(
    peer: number,
    text: MtcuteOutboundText,
    params: {
      replyTo?: number;
      threadId?: number;
      silent?: boolean;
      disableWebPreview?: boolean;
    },
  ): Promise<MtcuteMessageSource>;
}

export type MtcuteClientFactory = (
  config: Readonly<MtcuteTransportConfig>,
) => MtcuteClientPort | PromiseLike<MtcuteClientPort>;

export type MtcuteHistoryRequest = TelegramHistoryRequest;
export type MtcuteSendRequest = TelegramSendRequest;

export type ResolvedMtcuteChat = {
  input: number;
  peer: MtcutePeerSource;
  info: ChatInfo;
};

export type GetMtcuteClient = () => Promise<MtcuteClientPort>;

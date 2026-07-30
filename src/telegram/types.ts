export type ChatInfo = {
  chatId: string;
  requested: string;
  title?: string;
  username?: string;
  kind: string;
  canSendMessages?: boolean;
  isForum?: boolean;
};

export type TelegramMessageSender = {
  id?: string;
  kind: string;
  displayName?: string;
  username?: string;
};

/**
 * Canonical application-facing message shape. Transport-specific message
 * classes and Date objects must not cross this boundary.
 */
export type TelegramHistoryMessage = {
  messageId: number;
  text: string;
  sentAt?: string;
  editedAt?: string;
  sender?: TelegramMessageSender;
  replyToMessageId?: number;
  topicId?: number;
  isTopicMessage: boolean;
  isOutgoing: boolean;
  isService: boolean;
  isChannelPost: boolean;
  metadata?: {
    groupedId?: string;
    views?: number;
    forwards?: number;
  };
};

export type ResolvedTelegramChat = {
  info: ChatInfo;
};

export type TelegramHistoryRequest = {
  chat?: string;
  limit: number;
  offsetId?: number;
  minId?: number;
  maxId?: number;
  ids?: number | number[];
};

export type TelegramSendRequest = {
  chat?: string;
  text: string;
  replyToMessageId?: number;
  topicId?: number;
  parseMode?: "none" | "html" | "markdown";
  linkPreview?: boolean;
  silent?: boolean;
};

export interface TelegramGateway {
  readonly isConfigured: boolean;
  assertChatAllowed(chat: string): void;
  resolveChat(
    chat?: string,
    refresh?: boolean,
  ): Promise<ResolvedTelegramChat>;
  getMessages(params: TelegramHistoryRequest): Promise<{
    chat: ChatInfo;
    messages: TelegramHistoryMessage[];
  }>;
  iterateMessages(
    params: Omit<TelegramHistoryRequest, "ids">,
  ): Promise<{
    chat: ChatInfo;
    messages: AsyncIterable<TelegramHistoryMessage>;
  }>;
  sendMessage(params: TelegramSendRequest): Promise<{
    id?: number;
    chat: ChatInfo;
  }>;
  disconnect(): Promise<void>;
  destroy(): Promise<void>;
}

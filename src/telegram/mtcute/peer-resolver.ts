import type { ChatInfo } from "../types.js";
import { normalizeMtcuteChatRef } from "./config.js";
import type {
  GetMtcuteClient,
  MtcutePeerSource,
  MtcuteTransportConfig,
  ResolvedMtcuteChat,
} from "./contracts.js";
import {
  MtcuteTransportError,
  unsupportedMtcuteMessage,
} from "./errors.js";

export class MtcutePeerResolver {
  private readonly cache = new Map<string, ResolvedMtcuteChat>();
  private readonly allowedChats: ReadonlySet<string>;

  constructor(
    private readonly config: Readonly<MtcuteTransportConfig>,
    private readonly getClient: GetMtcuteClient,
  ) {
    this.allowedChats = new Set(
      config.allowedChatIds.map((entry) => normalizeMtcuteChatRef(entry)),
    );
  }

  assertAllowed(chat: string): void {
    if (!this.config.requireAllowlistedChat) {
      return;
    }
    if (!this.allowedChats.has(normalizeMtcuteChatRef(chat))) {
      throw new MtcuteTransportError(
        "chat_not_allowed",
        "permission",
        false,
        `Chat ${chat} is not allowlisted.`,
      );
    }
  }

  async resolve(
    chat?: string,
    refresh = false,
  ): Promise<ResolvedMtcuteChat> {
    const requested = chat?.trim() || this.config.defaultChatId;
    this.assertAllowed(requested);
    const cacheKey = normalizeMtcuteChatRef(requested);
    const cached = this.cache.get(cacheKey);
    if (!refresh && cached) {
      return cached;
    }

    const client = await this.getClient();
    const peer = await client.getPeer(coerceMtcutePeer(requested), refresh);
    const info = peerToChatInfo(peer, requested);
    this.assertAllowed(info.chatId);
    const resolved = { input: peer.id, peer, info };
    this.cacheResolvedChat(cacheKey, resolved);
    return resolved;
  }

  clear(): void {
    this.cache.clear();
  }

  private cacheResolvedChat(
    requestedKey: string,
    resolved: ResolvedMtcuteChat,
  ): void {
    this.cache.set(requestedKey, resolved);
    this.cache.set(normalizeMtcuteChatRef(resolved.info.chatId), resolved);
    if (resolved.info.username) {
      this.cache.set(
        normalizeMtcuteChatRef(`@${resolved.info.username}`),
        resolved,
      );
    }
  }
}

function peerToChatInfo(
  peer: MtcutePeerSource,
  requested: string,
): ChatInfo {
  if (!Number.isSafeInteger(peer.id)) {
    throw unsupportedMtcuteMessage(
      "Resolved Telegram peer has an invalid ID.",
    );
  }
  if (peer.type === "user") {
    return {
      chatId: String(peer.id),
      requested,
      title: peer.displayName || undefined,
      username: peer.username || undefined,
      kind: peer.isBot ? "bot" : "user",
      canSendMessages: !peer.isDeleted,
      isForum: false,
    };
  }
  const permission =
    peer.permissions?.canSendMessages ??
    peer.defaultPermissions?.canSendMessages;
  return {
    chatId: String(peer.id),
    requested,
    title: peer.title || peer.displayName || undefined,
    username: peer.username || undefined,
    kind: peer.chatType,
    canSendMessages:
      permission == null ? !peer.isBanned : !peer.isBanned && permission,
    isForum: peer.isForum,
  };
}

function coerceMtcutePeer(chat: string): string | number {
  const trimmed = chat.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return trimmed;
  }
  const numeric = Number(trimmed);
  if (!Number.isSafeInteger(numeric)) {
    throw new MtcuteTransportError(
      "invalid_request",
      "peer",
      false,
      "Numeric Telegram peer IDs must fit in JavaScript's safe integer range.",
    );
  }
  return numeric;
}

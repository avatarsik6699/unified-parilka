/**
 * VK peer_id offset for multi-user chats (besedy): `peer_id = chat_id +
 * 2_000_000_000` (confirmed via dev.vk.com/en/reference/objects/conversation).
 * Our own `chatId` strings namespace this as `vk:<peer_id>` so they cannot
 * collide with Telegram's numeric chat ids in the shared storage columns.
 */
export const VK_CHAT_PEER_ID_OFFSET = 2_000_000_000;

export interface VkAuthConfig {
  /** Community (group) access token, `messages` scope. */
  groupToken: string;
  /** Numeric VK community id (positive), not the peer_id namespacing prefix. */
  groupId: number;
  apiVersion: string;
}

/** `vk:<peer_id>` chatId helpers, kept in one place to avoid drift with the
 * config-side validator (`src/bot/runtime-config/env-rules.ts`'s `vkPeerId`). */
export function vkChatId(peerId: number): string {
  return `vk:${String(peerId)}`;
}

export function peerIdFromVkChatId(chatId: string): number | undefined {
  const match = /^vk:(\d+)$/u.exec(chatId);
  if (!match) {
    return undefined;
  }
  const peerId = Number(match[1]);
  return Number.isSafeInteger(peerId) && peerId > 0 ? peerId : undefined;
}

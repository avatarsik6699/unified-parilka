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

/**
 * VK's `message.id` (the field this codebase originally assumed was a
 * global, monotonic-per-community counter, mirroring Telegram's
 * `update_id`) is 0 for messages delivered to a community's Long Poll --
 * confirmed empirically against production traffic, not documented on
 * dev.vk.com. `conversation_message_id` is the field that's actually
 * populated and monotonic, but only *within* one peer_id's conversation,
 * not globally -- so it can't be used alone as `bot_updates.update_id`
 * without colliding across different beседы. This encodes the
 * (peer_id, conversation_message_id) pair into one JavaScript-safe
 * integer: peer_id stays near 2_000_000_000 + a small per-community chat
 * counter, so multiplying by 1_000_000 and adding conversationMessageId
 * (headroom to 999_999 messages in a single beседа) stays well under
 * Number.MAX_SAFE_INTEGER (~9.007e15).
 */
const VK_UPDATE_ID_CONVERSATION_MULTIPLIER = 1_000_000;

export function vkSyntheticUpdateId(
  peerId: number,
  conversationMessageId: number,
): number | undefined {
  if (
    !Number.isSafeInteger(peerId) ||
    peerId <= 0 ||
    !Number.isSafeInteger(conversationMessageId) ||
    conversationMessageId <= 0 ||
    conversationMessageId >= VK_UPDATE_ID_CONVERSATION_MULTIPLIER
  ) {
    return undefined;
  }
  const synthesized =
    peerId * VK_UPDATE_ID_CONVERSATION_MULTIPLIER + conversationMessageId;
  return Number.isSafeInteger(synthesized) ? synthesized : undefined;
}

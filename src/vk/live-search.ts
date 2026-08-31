import type { VK } from "vk-io";
import type {
  VkSearchHit,
  VkLiveSearchProvider,
} from "../bot/read-tools/contracts.js";

const MAX_RESULTS = 20;

/**
 * Direct, on-demand search of one беседа's *full* VK-side history via
 * `messages.search` -- confirmed directly against the live API that a
 * personal account's token can search a beседа's whole history this way,
 * unlike `messages.getHistory` (used by `history-backfill.ts`'s bounded
 * page-backward walk), which only reaches whatever `BOT_VK_HISTORY_
 * BACKFILL_LIMIT` has paged in locally. This lets the bot answer "search
 * for X in this chat" even when X predates local backfill, mirroring what
 * the VK client's own in-chat search does.
 *
 * `peerId` is fixed at construction (composition.ts binds one instance per
 * VK chat, from that chat's own `vkHistoryPeerId`) and is never a
 * model-supplied argument -- the same chat-isolation contract every other
 * read tool already holds.
 */
export function createVkLiveSearchProvider(
  vk: VK,
  peerId: number,
): VkLiveSearchProvider {
  return {
    async search(request) {
      const count = Math.min(request.limit ?? MAX_RESULTS, MAX_RESULTS);
      const response = await vk.api.messages.search({
        q: request.query,
        peer_id: peerId,
        count,
      });
      const items = Array.isArray((response as { items?: unknown }).items)
        ? (response as { items: unknown[] }).items
        : [];
      const hits = items
        .map(readSearchHit)
        .filter((hit): hit is VkSearchHit => hit !== undefined);
      return { hits };
    },
  };
}

function readSearchHit(value: unknown): VkSearchHit | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const conversationMessageId = record.conversation_message_id;
  const fromId = record.from_id;
  const text = record.text;
  if (
    typeof conversationMessageId !== "number" ||
    !Number.isSafeInteger(conversationMessageId) ||
    conversationMessageId <= 0 ||
    typeof fromId !== "number" ||
    !Number.isSafeInteger(fromId) ||
    typeof text !== "string" ||
    text.trim().length === 0
  ) {
    return undefined;
  }
  const date = typeof record.date === "number" ? record.date : undefined;
  return {
    messageId: conversationMessageId,
    fromId: String(fromId),
    text,
    ...(date === undefined ? {} : { date: vkDate(date) }),
  };
}

function vkDate(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  try {
    return new Date(seconds * 1_000).toISOString();
  } catch {
    return undefined;
  }
}

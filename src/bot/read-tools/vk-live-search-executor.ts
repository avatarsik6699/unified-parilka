import type { StoredMessage } from "../../store.js";
import type { BotReadToolSuccess, VkLiveSearchProvider } from "./contracts.js";
import { chatEvidence, success, ReadToolExecutionError } from "./payload.js";
import { callVkLiveSearchProvider } from "./timeouts.js";
import type { VkSearchHistoryArgs } from "./schemas.js";

/**
 * Executes `vk_search_history`: a live, on-demand search of one VK
 * беседа's full server-side history, bound to exactly one chat (the
 * provider is pre-configured with this chat's own `vkHistoryPeerId` at
 * composition time -- the model never supplies a chat/peer identifier
 * itself). See `src/vk/live-search.ts`.
 */
export async function executeVkSearchHistory(
  provider: VkLiveSearchProvider | undefined,
  chatId: string,
  args: VkSearchHistoryArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  botSenderId?: string,
): Promise<BotReadToolSuccess> {
  if (!provider) {
    throw new ReadToolExecutionError(
      "provider_unavailable",
      false,
      "VK history search is not configured for this chat.",
    );
  }
  const response = await callVkLiveSearchProvider({
    provider,
    query: args.query,
    limit: args.limit,
    timeoutMs,
    externalSignal,
  });
  const messages: StoredMessage[] = response.hits.map((hit) => ({
    chatId,
    messageId: hit.messageId,
    senderId: hit.fromId,
    text: hit.text,
    ...(hit.date === undefined ? {} : { date: hit.date }),
  }));
  const evidence = chatEvidence(messages, chatId, botSenderId);
  return success(
    "vk_search_history",
    evidence.length === 0 ? "empty" : "done",
    {
      query: args.query,
      limit: args.limit,
      returnedCount: evidence.length,
    },
    evidence,
  );
}

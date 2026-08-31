import { VK } from "vk-io";
import type { VkAuthConfig } from "./types.js";

/**
 * Thin wrapper: no business logic, just a configured `VK` instance. Kept
 * separate from `long-poll-loop.ts` so composition/production code can
 * construct it once and share it between the send adapter and the poller,
 * mirroring how grammy's `Api` is constructed once in `bot-daemon/
 * production.ts` and reused by every adapter in `runtime/grammy-adapters.ts`.
 */
export function createVkClient(auth: VkAuthConfig): VK {
  return new VK({
    token: auth.groupToken,
    apiVersion: auth.apiVersion,
    pollingGroupId: auth.groupId,
  });
}

/**
 * A community (group) access token cannot call `messages.getHistory` -- VK
 * returns `[15] Access denied` regardless of scope, confirmed directly
 * against the live API (see `src/vk/history-backfill.ts`). Reading a
 * beседа's history requires a personal VK account's own token instead, same
 * relationship Telegram has between its Bot API token and the MTProto user
 * session `bot-agi-sync` uses for full history sync. No `pollingGroupId`:
 * this client only ever makes bounded REST calls, never starts Long Poll.
 */
export function createVkUserClient(userToken: string, apiVersion: string): VK {
  return new VK({ token: userToken, apiVersion });
}

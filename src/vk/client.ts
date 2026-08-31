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

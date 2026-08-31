import type { VK } from "vk-io";

/** `users.get`'s documented max ids per call (dev.vk.com/en/method/users.get). */
const MAX_USERS_GET_BATCH = 1000;

export interface VkResolvedUser {
  id: number;
  firstName: string;
  lastName: string;
}

export function formatVkDisplayName(user: {
  firstName: string;
  lastName: string;
}): string {
  return [user.firstName, user.lastName]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * Process-local `sender_id -> display name` cache. No persistence: VK ids
 * are stable, so a cold cache after a restart just means the first message
 * per unseen sender stays unresolved until the next enrichment tick --
 * the same v1 degradation already accepted elsewhere in this VK integration
 * (see `VkHistoryBackfillLoop`'s doc comment for the precedent).
 */
export class VkSenderNameCache {
  readonly #names = new Map<string, string>();

  get(senderId: string): string | undefined {
    return this.#names.get(senderId);
  }

  /**
   * Resolves any not-yet-cached, positive (personal-account) sender ids via
   * `users.get`, batched to its documented limit. Negative ids are VK
   * community/group senders -- `users.get` can't resolve those (would need
   * `groups.getById`), so they are skipped, not treated as an error.
   *
   * Best-effort: a failed batch is logged nowhere here and simply leaves
   * those ids unresolved for the next tick, matching this VK integration's
   * existing "never throw into the ingest/enrichment hot path" convention.
   */
  async resolveMany(vk: VK, senderIds: readonly string[]): Promise<void> {
    const unresolved = [...new Set(senderIds)].filter((id) => {
      if (this.#names.has(id)) {
        return false;
      }
      const numeric = Number(id);
      return Number.isSafeInteger(numeric) && numeric > 0;
    });
    for (
      let index = 0;
      index < unresolved.length;
      index += MAX_USERS_GET_BATCH
    ) {
      const chunk = unresolved.slice(index, index + MAX_USERS_GET_BATCH);
      try {
        const response = await vk.api.users.get({ user_ids: chunk });
        for (const raw of Array.isArray(response) ? response : []) {
          const user = readVkUser(raw);
          if (user !== undefined) {
            this.#names.set(String(user.id), formatVkDisplayName(user));
          }
        }
      } catch {
        // Best-effort: this chunk's ids simply stay unresolved.
      }
    }
  }
}

function readVkUser(value: unknown): VkResolvedUser | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return undefined;
  }
  return {
    id,
    firstName: typeof record.first_name === "string" ? record.first_name : "",
    lastName: typeof record.last_name === "string" ? record.last_name : "",
  };
}

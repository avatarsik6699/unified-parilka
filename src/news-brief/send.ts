import { createHash, randomUUID } from "node:crypto";
import type { MessageStore } from "../store.js";
import type { ChatInfo } from "../telegram/types.js";
import type { NewsBriefSendResult } from "./types.js";

const NEWS_BRIEF_USER_KEY = "news-brief";

export interface NewsBriefTelegramApi {
  sendMessage(
    chatId: string,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
}

export interface NewsBriefThrottleOptions {
  maxAgeMs: number;
  userCooldownMs: number;
  maxPendingPerUserPerChat: number;
  maxQueuePerChat: number;
}

export interface SendNewsBriefOptions {
  store: MessageStore;
  api: NewsBriefTelegramApi;
  chatId: string;
  text: string;
  /** Calendar day key (e.g. "2026-08-24") this brief belongs to -- the dedupe key, so a same-day re-run cannot double-post. */
  dayKey: string;
  apply: boolean;
  throttle: NewsBriefThrottleOptions;
  nowMs?: number;
}

/**
 * Sends exactly one news-brief message, reusing the shared send-outbox's
 * dedupe/audit bookkeeping (`reserveSend`/`markSendSending`/`markSendSent`)
 * directly rather than the full in-memory `SendThrottler` -- a oneshot CLI
 * sends synchronously and never needs the throttler's queue/backoff machinery.
 */
export async function sendNewsBrief(
  options: SendNewsBriefOptions,
): Promise<NewsBriefSendResult> {
  if (!options.apply) {
    return { outcome: "skipped_dry_run" };
  }
  const nowMs = options.nowMs ?? Date.now();
  const reservation = options.store.reserveSend({
    outboxId: `news_brief_${randomUUID()}`,
    dedupeKey: `news-brief:${options.dayKey}`,
    payloadHash: createHash("sha256").update(options.text).digest("hex"),
    chatId: options.chatId,
    userKey: NEWS_BRIEF_USER_KEY,
    nowMs,
    maxAgeMs: options.throttle.maxAgeMs,
    userCooldownMs: options.throttle.userCooldownMs,
    maxPendingPerUserPerChat: options.throttle.maxPendingPerUserPerChat,
    maxQueuePerChat: options.throttle.maxQueuePerChat,
  });

  if (reservation.kind === "duplicate_sent") {
    return {
      outcome: "duplicate",
      ...(reservation.telegramMessageId === undefined
        ? {}
        : { telegramMessageId: reservation.telegramMessageId }),
    };
  }

  if (!options.store.markSendSending(reservation.outboxId)) {
    throw new Error("news-brief outbox row was no longer in queued state");
  }
  try {
    const sent = await options.api.sendMessage(options.chatId, options.text, {
      link_preview_options: { is_disabled: true },
    });
    if (!options.store.markSendSent(reservation.outboxId, sent.message_id)) {
      throw new Error("news-brief send completed but audit update failed");
    }
    ensureChatCached(options.store, options.chatId);
    return { outcome: "sent", telegramMessageId: sent.message_id };
  } catch (error) {
    // Once dispatch starts, a rejected promise cannot prove Telegram did not
    // accept the message -- mark delivery unknown, same as SendThrottler.
    options.store.markSendDeliveryUnknown(reservation.outboxId, nowMs);
    throw error;
  }
}

function ensureChatCached(store: MessageStore, chatId: string): void {
  if (store.getCachedChat(chatId) !== undefined) {
    return;
  }
  const chat: ChatInfo = {
    chatId,
    requested: chatId,
    kind: "NewsBriefTarget",
  };
  store.upsertChat(chat);
}

import { dayStartInstant } from "../digest/calendar.js";
import { nextCalendarDay } from "../digest/calendar.js";
import type { StoredMessage } from "../store.js";

const DEFAULT_BEFORE_TRIGGER = 8;
const DEFAULT_AFTER_ANSWER = 30;
const CHUNK_PAGE_SIZE = 1_000;
const CANDIDATE_PAGE_SIZE = 1_000;
const THROUGH_ANSWER_PAGE_SIZE = 1_000;

export interface DreamSelectorStore {
  getMessagesByDateRange(params: {
    chatId: string;
    startInclusive: string;
    endExclusive: string;
    afterMessageId?: number;
    limit?: number;
  }): StoredMessage[];
  getMessagesByIds(params: {
    chatId: string;
    messageIds: number[];
  }): StoredMessage[];
  getHistory(params: {
    chatId: string;
    limit: number;
    beforeId?: number;
    afterId?: number;
    order?: "asc" | "desc";
    includeDeleted?: boolean;
  }): StoredMessage[];
}

export interface DreamInteraction {
  /** Human message(s) the bot answered in this merged window. */
  triggerMessageIds: number[];
  /** Ordered bot answer chunks (usually one, possibly several). */
  answerMessageIds: number[];
  /**
   * Actual interaction count before overlap merge. A merged window may cover
   * several originally separate bot replies, each counting as one interaction.
   */
  rawInteractionCount: number;
  /** Merged context window: before trigger, all live messages through last chunk, after answer. */
  window: DreamWindow;
}

export interface DreamWindow {
  messages: StoredMessage[];
  /** Indices of human trigger messages inside `messages`. */
  triggerIndices: number[];
  /** Indices of bot answer chunk messages inside `messages`. */
  answerIndices: number[];
}

export interface SelectDreamInteractionsOptions {
  beforeTrigger?: number;
  afterAnswer?: number;
}

/**
 * Select real bot-reply interactions for a calendar day.
 *
 * Source constraints:
 *  - only live (non-deleted) messages are considered;
 *  - candidate bot answers are messages whose own date is inside the target
 *    Moscow day, whose sender_id equals botSenderId and whose reply_to_message_id
 *    points at a live human trigger inside the same chat;
 *  - a candidate is a FIRST chunk when the immediate previous live message is
 *    not a bot message with the same reply target; otherwise it is a
 *    continuation of an interaction anchored in another day and is skipped;
 *  - consecutive live bot chunks sharing the same trigger are grouped into one
 *    answer;
 *  - each interaction includes the 8 live messages immediately before the
 *    trigger, every live cached message from the trigger through the last answer
 *    chunk, and the 30 live messages after the last chunk — all by global live
 *    row order, not message_id arithmetic;
 *  - overlapping windows are merged and deduplicated by global order, preserving
 *    every trigger and answer marker.
 *
 * If the trigger for a cached bot answer is missing, deleted, from the bot
 * itself, or otherwise invalid, the interaction is rejected and reported via
 * the `incomplete` list.
 */
export function selectDreamInteractions(
  store: DreamSelectorStore,
  chatId: string,
  day: string,
  botSenderId: string,
  options: SelectDreamInteractionsOptions = {},
): {
  interactions: DreamInteraction[];
  incomplete: { answerMessageId: number; reason: string }[];
} {
  const startInclusive = dayStartInstant(day);
  const endExclusive = dayStartInstant(nextCalendarDay(day));
  const candidates = collectCandidatesInRange(store, {
    chatId,
    startInclusive,
    endExclusive,
  });

  const beforeTrigger = options.beforeTrigger ?? DEFAULT_BEFORE_TRIGGER;
  const afterAnswer = options.afterAnswer ?? DEFAULT_AFTER_ANSWER;
  const incomplete: { answerMessageId: number; reason: string }[] = [];
  const rawInteractions: DreamInteraction[] = [];

  for (const candidate of candidates) {
    if (candidate.senderId !== botSenderId || candidate.replyToMessageId == null) {
      continue;
    }

    const previousLive = store.getHistory({
      chatId,
      beforeId: candidate.messageId,
      limit: 1,
      order: "desc",
      includeDeleted: false,
    })[0];

    if (
      previousLive !== undefined &&
      previousLive.senderId === botSenderId &&
      previousLive.replyToMessageId === candidate.replyToMessageId
    ) {
      // Continuation of an interaction whose first chunk belongs to another day.
      continue;
    }

    const triggerMessageId = candidate.replyToMessageId;
    const trigger = store.getMessagesByIds({
      chatId,
      messageIds: [triggerMessageId],
    })[0];

    if (!trigger) {
      incomplete.push({
        answerMessageId: candidate.messageId,
        reason: "missing_trigger",
      });
      continue;
    }
    if (trigger.deletedAt !== undefined) {
      incomplete.push({
        answerMessageId: candidate.messageId,
        reason: "deleted_trigger",
      });
      continue;
    }
    if (trigger.senderId === undefined || trigger.senderId === botSenderId) {
      incomplete.push({
        answerMessageId: candidate.messageId,
        reason: "invalid_trigger_sender",
      });
      continue;
    }

    const answerIds = collectConsecutiveAnswerChunks(
      store,
      chatId,
      candidate.messageId,
      triggerMessageId,
      botSenderId,
    );
    const lastAnswerId = answerIds[answerIds.length - 1]!;

    const beforeTriggerMessages = store.getHistory({
      chatId,
      beforeId: triggerMessageId,
      limit: beforeTrigger,
      order: "desc",
      includeDeleted: false,
    }).reverse();

    // Include every live cached message from the trigger through the last bot
    // chunk, preserving global message_id order. This captures arbitrary live
    // messages interleaved between trigger and answer chunks.
    const throughAnswerMessages = collectThroughAnswerRange(
      store,
      chatId,
      triggerMessageId,
      lastAnswerId,
    );

    const afterAnswerMessages = store.getHistory({
      chatId,
      afterId: lastAnswerId,
      limit: afterAnswer,
      order: "asc",
      includeDeleted: false,
    });

    const windowMessages = mergeMessageRanges([
      beforeTriggerMessages,
      throughAnswerMessages,
      afterAnswerMessages,
    ]);

    const triggerIndices = windowMessages
      .map((message, index) =>
        message.messageId === triggerMessageId ? index : -1,
      )
      .filter((index) => index >= 0);
    const answerIndices = answerIds
      .map((id) => windowMessages.findIndex((message) => message.messageId === id))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);

    rawInteractions.push({
      triggerMessageIds: [triggerMessageId],
      answerMessageIds: answerIds,
      rawInteractionCount: 1,
      window: {
        messages: windowMessages,
        triggerIndices,
        answerIndices,
      },
    });
  }

  return { interactions: mergeOverlappingWindows(rawInteractions), incomplete };
}

function collectCandidatesInRange(
  store: DreamSelectorStore,
  params: {
    chatId: string;
    startInclusive: string;
    endExclusive: string;
  },
): StoredMessage[] {
  const candidates: StoredMessage[] = [];
  let afterMessageId: number | undefined;
  while (true) {
    const page = store.getMessagesByDateRange({
      ...params,
      afterMessageId,
      limit: CANDIDATE_PAGE_SIZE,
    });
    if (page.length === 0) {
      return candidates;
    }
    candidates.push(...page);
    if (page.length < CANDIDATE_PAGE_SIZE) {
      return candidates;
    }
    const lastId = page[page.length - 1]!.messageId;
    if (afterMessageId !== undefined && lastId <= afterMessageId) {
      // Defensive: keyset must advance to avoid an infinite loop.
      return candidates;
    }
    afterMessageId = lastId;
  }
}

function collectConsecutiveAnswerChunks(
  store: DreamSelectorStore,
  chatId: string,
  firstAnswerId: number,
  triggerMessageId: number,
  botSenderId: string,
): number[] {
  const answerIds: number[] = [firstAnswerId];
  let cursor = firstAnswerId;
  while (true) {
    const page = store.getHistory({
      chatId,
      afterId: cursor,
      limit: CHUNK_PAGE_SIZE,
      order: "asc",
      includeDeleted: false,
    });
    let advanced = false;
    for (const message of page) {
      if (
        message.senderId === botSenderId &&
        message.replyToMessageId === triggerMessageId
      ) {
        answerIds.push(message.messageId);
        cursor = message.messageId;
        advanced = true;
      } else {
        return answerIds;
      }
    }
    if (!advanced || page.length < CHUNK_PAGE_SIZE) {
      return answerIds;
    }
  }
}

function collectThroughAnswerRange(
  store: DreamSelectorStore,
  chatId: string,
  triggerMessageId: number,
  lastAnswerId: number,
): StoredMessage[] {
  const messages: StoredMessage[] = [];
  let cursor = triggerMessageId - 1;
  while (true) {
    const page = store.getHistory({
      chatId,
      afterId: cursor,
      beforeId: lastAnswerId + 1,
      limit: THROUGH_ANSWER_PAGE_SIZE,
      order: "asc",
      includeDeleted: false,
    });
    if (page.length === 0) {
      return messages;
    }
    const lastId = page[page.length - 1]!.messageId;
    if (lastId <= cursor) {
      // Defensive: keyset must strictly advance to avoid an infinite loop.
      return messages;
    }
    messages.push(...page);
    cursor = lastId;
    if (lastId >= lastAnswerId) {
      return messages;
    }
  }
}

function mergeOverlappingWindows(
  interactions: DreamInteraction[],
): DreamInteraction[] {
  if (interactions.length === 0) {
    return [];
  }
  const sorted = [...interactions].sort(
    (a, b) => a.window.messages[0]!.messageId - b.window.messages[0]!.messageId,
  );
  const merged: DreamInteraction[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    const lastEnd = last.window.messages[last.window.messages.length - 1]!.messageId;
    const currentStart = current.window.messages[0]!.messageId;
    if (currentStart <= lastEnd) {
      const allMessages = mergeMessageRanges([
        last.window.messages,
        current.window.messages,
      ]);
      const triggerMessageIds = [
        ...new Set([...last.triggerMessageIds, ...current.triggerMessageIds]),
      ].sort((a, b) => a - b);
      const answerMessageIds = [
        ...new Set([...last.answerMessageIds, ...current.answerMessageIds]),
      ].sort((a, b) => a - b);
      const rawInteractionCount =
        last.rawInteractionCount + current.rawInteractionCount;
      const triggerIndices = triggerMessageIds
        .map((id) => allMessages.findIndex((message) => message.messageId === id))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b);
      const answerIndices = answerMessageIds
        .map((id) => allMessages.findIndex((message) => message.messageId === id))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b);
      merged[merged.length - 1] = {
        triggerMessageIds,
        answerMessageIds,
        rawInteractionCount,
        window: {
          messages: allMessages,
          triggerIndices,
          answerIndices,
        },
      };
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function mergeMessageRanges(ranges: StoredMessage[][]): StoredMessage[] {
  const byId = new Map<number, StoredMessage>();
  for (const range of ranges) {
    for (const message of range) {
      byId.set(message.messageId, message);
    }
  }
  return [...byId.values()].sort((a, b) => a.messageId - b.messageId);
}

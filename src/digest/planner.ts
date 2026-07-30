import type {
  StoredDayDigest,
  StoredMessage,
} from "../store.js";
import { nextCalendarDay } from "./calendar.js";
import {
  groupDayDigestsByIsoWeek,
  hashDaySource,
  hashHistoricalDayPrefix,
  messagesForDay,
  type WeeklyDigestGroup,
} from "./source.js";
import {
  DAY_DIGEST_PROMPT_VERSION,
  DIGEST_STALE_MESSAGE_THRESHOLD,
  type DigestStore,
} from "./types.js";

export type DayCandidateReason =
  | "missing"
  | "manual_all"
  | "prompt_changed"
  | "source_changed";

export interface DayCandidateAnalysis {
  sourceHash: string;
  sourceCurrent: boolean;
  historicalPrefixCurrent?: boolean;
  appendedAfterStoredEnd?: number;
  reason?: DayCandidateReason;
}

/**
 * The 25-message grace window is valid only for a provable pure append.
 *
 * A stored digest was generated from every message up to its endMessageId.
 * Re-hashing that exact historical prefix therefore detects edits, deletions,
 * and backfills without waiting for new IDs. Only an identical prefix may use
 * the append threshold.
 */
export function analyzeDayCandidate(params: {
  all: boolean;
  chatId: string;
  day: string;
  messages: readonly StoredMessage[];
  stored?: StoredDayDigest;
}): DayCandidateAnalysis {
  const sourceHash = hashDaySource(
    params.chatId,
    params.day,
    params.messages,
  );
  if (!params.stored) {
    return {
      sourceHash,
      sourceCurrent: false,
      reason: params.all ? "manual_all" : "missing",
    };
  }
  const stored = params.stored;

  const appendedAfterStoredEnd = params.messages.reduce(
    (count, message) =>
      count +
      (message.messageId > stored.endMessageId ? 1 : 0),
    0,
  );
  const sourceCurrent = stored.sourceHash === sourceHash;
  const historicalPrefixCurrent =
    stored.sourceHash ===
    hashHistoricalDayPrefix(
      params.chatId,
      params.day,
      params.messages,
      stored.endMessageId,
    );

  let reason: DayCandidateReason | undefined;
  if (params.all) {
    reason = "manual_all";
  } else if (stored.promptVersion !== DAY_DIGEST_PROMPT_VERSION) {
    reason = "prompt_changed";
  } else if (sourceCurrent) {
    reason = undefined;
  } else if (!historicalPrefixCurrent) {
    reason = "source_changed";
  } else if (
    appendedAfterStoredEnd >= DIGEST_STALE_MESSAGE_THRESHOLD
  ) {
    reason = "source_changed";
  }

  return {
    sourceHash,
    sourceCurrent,
    historicalPrefixCurrent,
    appendedAfterStoredEnd,
    reason,
  };
}

export function currentWeeklyGroup(
  store: DigestStore,
  chatId: string,
  period: string,
  lastEligibleDay: string,
): WeeklyDigestGroup | undefined {
  return groupDayDigestsByIsoWeek(
    store
      .listDayDigests(chatId)
      .filter(
        (digest) =>
          digest.day <= lastEligibleDay &&
          digest.promptVersion === DAY_DIGEST_PROMPT_VERSION,
      ),
  ).find((group) => group.period === period);
}

export function weeklyGroupSourcesAreCurrent(
  store: DigestStore,
  chatId: string,
  group: WeeklyDigestGroup,
  lastEligibleDay: string,
): boolean {
  const digests = new Map(
    group.digests.map((digest) => [digest.day, digest] as const),
  );
  for (
    let day = group.dayFrom;
    day <= group.dayTo && day <= lastEligibleDay;
    day = nextCalendarDay(day)
  ) {
    const messages = messagesForDay(store, chatId, day);
    const digest = digests.get(day);
    if (messages.length === 0) {
      if (digest) {
        return false;
      }
      continue;
    }
    if (
      !digest ||
      digest.promptVersion !== DAY_DIGEST_PROMPT_VERSION ||
      digest.sourceHash !== hashDaySource(chatId, day, messages)
    ) {
      return false;
    }
  }
  return true;
}

export function invalidateStaleDayDigests(
  store: DigestStore,
  chatId: string,
  group: WeeklyDigestGroup,
): number {
  let invalidated = 0;
  for (const digest of group.digests) {
    const messages = messagesForDay(store, chatId, digest.day);
    const currentHash =
      messages.length === 0
        ? undefined
        : hashDaySource(chatId, digest.day, messages);
    if (
      digest.promptVersion === DAY_DIGEST_PROMPT_VERSION &&
      digest.sourceHash === currentHash
    ) {
      continue;
    }
    if (store.deleteDayDigest({ chatId, day: digest.day }).dayDeleted) {
      invalidated += 1;
    }
  }
  return invalidated;
}

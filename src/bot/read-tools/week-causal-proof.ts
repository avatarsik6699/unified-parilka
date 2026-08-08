import { hashWeekSource } from "../../digest/source.js";
import type {
  MessageStore,
  StoredDigestRollup,
} from "../../store.js";
import type { CachedDigest, DigestCacheQuery } from "./contracts.js";

/**
 * Bounded day-digest window for a single weekly rollup proof. A week spans
 * at most seven days, so any rollup whose period holds more rows than this
 * bound can never match its day count and is rejected.
 */
const MAX_PROOF_DAY_DIGESTS = 100;

/**
 * A week rollup is built from day digests, not from raw messages. Under an
 * application-owned sourceMessageId it is returned only when its exact source
 * is still provable below the cutoff: the stored sourceHash exists, the
 * current day digests of the rollup's own period match the rollup day count
 * and re-derive that sourceHash, and every underlying digest ends strictly
 * below the cutoff. Anything unproven falls back to the causal-safe day
 * digests so a stale summary can never leak the trigger or newer messages.
 */
export function causalSafeWeeks(
  weeks: readonly StoredDigestRollup[],
  params: DigestCacheQuery,
  store: MessageStore,
): StoredDigestRollup[] {
  const sourceMessageId = params.sourceMessageId;
  if (sourceMessageId === undefined) {
    return [...weeks];
  }
  const safe: StoredDigestRollup[] = [];
  for (const week of weeks) {
    if (weekSourceProvenBelow(week, sourceMessageId, store)) {
      safe.push(week);
    }
  }
  return safe;
}

/**
 * Combined causal selection for a weekly-preferring read under an
 * application-owned sourceMessageId: provably safe weekly rollups win and
 * fill the row limit first; the remaining slots take the NEWEST uncovered
 * safe day digests, so days of unsafe or still-partial weeks survive while
 * slots remain and older days never displace newer ones. Returns undefined
 * when no week is provable, so the caller falls back to plain day digests.
 * The merged result keeps deterministic chronological ordering and never
 * exceeds MAX_PROOF_DAY_DIGESTS rows.
 */
export function selectCausalDigests(
  weeks: readonly StoredDigestRollup[],
  params: DigestCacheQuery,
  store: MessageStore,
): CachedDigest[] | undefined {
  if (params.sourceMessageId === undefined) {
    return undefined;
  }
  const safeWeeks = causalSafeWeeks(weeks, params, store);
  if (safeWeeks.length === 0) {
    return undefined;
  }
  const coveredBySafeWeek = (day: string): boolean =>
    safeWeeks.some(
      (week) => day >= week.dayFrom && day <= week.dayTo,
    );
  const weekDigests = safeWeeks
    .slice(0, MAX_PROOF_DAY_DIGESTS)
    .map(toWeekDigest);
  const remainingSlots = Math.max(
    0,
    MAX_PROOF_DAY_DIGESTS - weekDigests.length,
  );
  const dayDigests = store
    .getDayDigests({
      chatId: params.chatId,
      dayFrom: params.dayFrom,
      dayTo: params.dayTo,
      limit: MAX_PROOF_DAY_DIGESTS,
    })
    .filter(
      (digest) =>
        digest.endMessageId < params.sourceMessageId! &&
        !coveredBySafeWeek(digest.day),
    )
    .sort((left, right) => right.day.localeCompare(left.day))
    .slice(0, remainingSlots)
    .map(toDayDigest);
  return [...weekDigests, ...dayDigests].sort(compareCausalDigests);
}

/**
 * Total deterministic order for the merged causal digest rows, without any
 * text content: dayFrom ASC, dayTo ASC, weeks before days, period ASC, then
 * numeric message-id bounds. Equal tuples keep their stable input order, so
 * the result never depends on comparator inconsistency.
 */
function compareCausalDigests(
  left: CachedDigest,
  right: CachedDigest,
): number {
  const byFrom = left.dayFrom.localeCompare(right.dayFrom);
  if (byFrom !== 0) {
    return byFrom;
  }
  const byTo = left.dayTo.localeCompare(right.dayTo);
  if (byTo !== 0) {
    return byTo;
  }
  if (left.kind !== right.kind) {
    return left.kind === "week" ? -1 : 1;
  }
  const byPeriod = left.period.localeCompare(right.period);
  if (byPeriod !== 0) {
    return byPeriod;
  }
  const leftEnd = left.endMessageId ?? -1;
  const rightEnd = right.endMessageId ?? -1;
  if (leftEnd !== rightEnd) {
    return leftEnd < rightEnd ? -1 : 1;
  }
  const leftStart = left.startMessageId ?? -1;
  const rightStart = right.startMessageId ?? -1;
  if (leftStart !== rightStart) {
    return leftStart < rightStart ? -1 : 1;
  }
  return 0;
}

function toWeekDigest(week: StoredDigestRollup): CachedDigest {
  return {
    kind: "week",
    period: week.period,
    dayFrom: week.dayFrom,
    dayTo: week.dayTo,
    text: week.text,
  };
}

function toDayDigest(digest: {
  day: string;
  startMessageId: number;
  endMessageId: number;
  text: string;
}): CachedDigest {
  return {
    kind: "day",
    period: digest.day,
    dayFrom: digest.day,
    dayTo: digest.day,
    text: digest.text,
    startMessageId: digest.startMessageId,
    endMessageId: digest.endMessageId,
  };
}

function weekSourceProvenBelow(
  week: StoredDigestRollup,
  sourceMessageId: number,
  store: MessageStore,
): boolean {
  if (week.sourceHash === undefined) {
    return false;
  }
  const dayDigests = store
    .getDayDigests({
      chatId: week.chatId,
      dayFrom: week.dayFrom,
      dayTo: week.dayTo,
      limit: MAX_PROOF_DAY_DIGESTS,
    })
    .sort((left, right) => left.day.localeCompare(right.day));
  if (dayDigests.length !== week.dayCount) {
    return false;
  }
  if (
    dayDigests.some((digest) => digest.endMessageId >= sourceMessageId)
  ) {
    return false;
  }
  return (
    hashWeekSource(week.chatId, {
      period: week.period,
      dayFrom: week.dayFrom,
      dayTo: week.dayTo,
      digests: dayDigests,
    }) === week.sourceHash
  );
}

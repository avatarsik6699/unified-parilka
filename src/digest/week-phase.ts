import type { IsoWeekRange } from "./calendar.js";
import type { DayPhaseResult } from "./day-phase.js";
import {
  failedItem,
  isSourceChangedDuringGeneration,
  summarizeBounded,
  validNow,
  type DigestGenerationRuntime,
} from "./generation-support.js";
import {
  currentWeeklyGroup,
  invalidateStaleDayDigests,
  weeklyGroupSourcesAreCurrent,
} from "./planner.js";
import {
  groupDayDigestsByIsoWeek,
  hashWeekSource,
  renderWeekSource,
  type WeeklyDigestGroup,
} from "./source.js";
import {
  DAY_DIGEST_PROMPT_VERSION,
  DigestGenerationError,
  WEEK_DIGEST_PROMPT_VERSION,
  type DigestPhaseReport,
} from "./types.js";

export async function runWeekPhase(params: {
  runtime: DigestGenerationRuntime;
  lastEligibleDay: string;
  dayPhase: DayPhaseResult;
  weeks: DigestPhaseReport;
}): Promise<void> {
  const { runtime, lastEligibleDay, dayPhase, weeks } = params;
  const dayDigests = runtime.store
    .listDayDigests(runtime.chatId)
    .filter(
      (digest) =>
        digest.day <= lastEligibleDay &&
        digest.promptVersion === DAY_DIGEST_PROMPT_VERSION &&
        dayPhase.expectedDayHashes.get(digest.day) ===
          digest.sourceHash,
    );
  const groupsByPeriod = new Map(
    groupDayDigestsByIsoWeek(dayDigests).map(
      (group) => [group.period, group] as const,
    ),
  );
  const periods = new Set([
    ...groupsByPeriod.keys(),
    ...dayPhase.blockedWeeks.keys(),
    ...dayPhase.failedWeeks.keys(),
    ...dayPhase.deferredWeeks.keys(),
    ...dayPhase.orphanedWeeks.keys(),
  ]);
  const orderedPeriods = [...periods].sort();
  if (runtime.apply) {
    orderedPeriods.reverse();
  }

  for (const period of orderedPeriods) {
    const group = groupsByPeriod.get(period);
    const range =
      group ??
      dayPhase.blockedWeeks.get(period) ??
      dayPhase.failedWeeks.get(period) ??
      dayPhase.deferredWeeks.get(period) ??
      dayPhase.orphanedWeeks.get(period);
    if (!range) {
      throw new Error("Digest week range disappeared.");
    }
    await processWeek({
      runtime,
      lastEligibleDay,
      dayPhase,
      weeks,
      period,
      group,
      range,
    });
  }
}

async function processWeek(params: {
  runtime: DigestGenerationRuntime;
  lastEligibleDay: string;
  dayPhase: DayPhaseResult;
  weeks: DigestPhaseReport;
  period: string;
  group?: WeeklyDigestGroup;
  range: IsoWeekRange;
}): Promise<void> {
  const {
    runtime,
    lastEligibleDay,
    dayPhase,
    weeks,
    period,
    group,
    range,
  } = params;
  const { store, chatId, apply, all } = runtime;
  weeks.scanned += 1;
  const stored = store
    .getDigestRollups({
      chatId,
      kind: "week",
      dayFrom: range.dayFrom,
      dayTo: range.dayTo,
      limit: 8,
    })
    .find((digest) => digest.period === period);

  if (dayPhase.blockedWeeks.has(period)) {
    const invalidated =
      apply &&
      store.deleteDigestRollup({
        chatId,
        kind: "week",
        period,
      });
    if (invalidated) {
      weeks.invalidated += 1;
    } else {
      weeks.skipped += 1;
    }
    weeks.items.push({
      kind: "week",
      period,
      status: invalidated ? "invalidated" : "blocked",
      reason: "day_incomplete",
      sourceCount: group?.digests.length ?? 0,
    });
    return;
  }

  if (dayPhase.failedWeeks.has(period)) {
    weeks.skipped += 1;
    weeks.items.push({
      kind: "week",
      period,
      status: "blocked",
      reason: "generation_failed",
      sourceCount: group?.digests.length ?? 0,
    });
    return;
  }

  if (dayPhase.deferredWeeks.has(period)) {
    weeks.deferred += 1;
    weeks.items.push({
      kind: "week",
      period,
      status: "deferred",
      reason: "run_limit",
      sourceCount: group?.digests.length ?? 0,
    });
    return;
  }

  if (!group) {
    processMissingWeek({
      runtime,
      dayPhase,
      weeks,
      period,
      hasStoredDigest: stored !== undefined,
    });
    return;
  }

  if (
    !weeklyGroupSourcesAreCurrent(
      store,
      chatId,
      group,
      lastEligibleDay,
    )
  ) {
    if (apply) {
      dayPhase.days.invalidated += invalidateStaleDayDigests(
        store,
        chatId,
        group,
      );
    }
    const invalidated =
      apply &&
      store.deleteDigestRollup({
        chatId,
        kind: "week",
        period,
      });
    if (invalidated) {
      weeks.invalidated += 1;
    } else {
      weeks.skipped += 1;
    }
    weeks.items.push({
      kind: "week",
      period,
      status: invalidated ? "invalidated" : "blocked",
      reason: "day_incomplete",
      sourceCount: group.digests.length,
    });
    return;
  }

  const sourceHash = hashWeekSource(chatId, group);
  const reason = all
    ? "manual_all"
    : !stored
      ? "missing"
      : stored.promptVersion !== WEEK_DIGEST_PROMPT_VERSION
        ? "prompt_changed"
        : stored.sourceHash !== sourceHash
          ? "source_changed"
          : undefined;

  if (!reason) {
    weeks.unchanged += 1;
    weeks.items.push({
      kind: "week",
      period,
      status: "unchanged",
      reason: "source_current",
      sourceCount: group.digests.length,
      sourceHash,
    });
    return;
  }

  weeks.candidates += 1;
  if (!apply) {
    weeks.planned += 1;
    weeks.items.push({
      kind: "week",
      period,
      status: "planned",
      reason,
      sourceCount: group.digests.length,
      sourceHash,
    });
    return;
  }
  if (
    weeks.providerCalls >=
    runtime.maxWeekGenerationsPerRun
  ) {
    weeks.deferred += 1;
    weeks.items.push({
      kind: "week",
      period,
      status: "deferred",
      reason: "run_limit",
      sourceCount: group.digests.length,
      sourceHash,
    });
    return;
  }

  try {
    const sourceText = renderWeekSource(
      group.digests,
      runtime.maxInputChars,
    );
    weeks.providerCalls += 1;
    const summary = await summarizeBounded(
      runtime.summaryPort!,
      {
        kind: "week",
        period,
        dayFrom: group.dayFrom,
        dayTo: group.dayTo,
        sourceText,
        sourceCount: group.digests.length,
        maxOutputChars: runtime.maxOutputChars,
      },
      runtime.itemTimeoutMs,
    );
    const committed = store.commitDigestRollupIfCurrent(
      {
        chatId,
        kind: "week",
        period,
        dayFrom: group.dayFrom,
        dayTo: group.dayTo,
        dayCount: group.digests.length,
        text: summary.text,
        promptVersion: WEEK_DIGEST_PROMPT_VERSION,
        model: summary.model,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        sourceHash,
        createdAtMs: validNow(runtime.now).getTime(),
      },
      () => {
        const currentGroup = currentWeeklyGroup(
          store,
          chatId,
          period,
          lastEligibleDay,
        );
        return (
          currentGroup !== undefined &&
          hashWeekSource(chatId, currentGroup) === sourceHash &&
          weeklyGroupSourcesAreCurrent(
            store,
            chatId,
            currentGroup,
            lastEligibleDay,
          )
        );
      },
    );
    if (!committed) {
      const currentGroup = currentWeeklyGroup(
        store,
        chatId,
        period,
        lastEligibleDay,
      );
      if (currentGroup) {
        dayPhase.days.invalidated += invalidateStaleDayDigests(
          store,
          chatId,
          currentGroup,
        );
      }
      throw new DigestGenerationError(
        "source_changed_during_generation",
        "Weekly digest source changed while its summary was being generated.",
      );
    }
    weeks.generated += 1;
    weeks.items.push({
      kind: "week",
      period,
      status: "generated",
      reason,
      sourceCount: group.digests.length,
      sourceHash,
      model: summary.model,
      providerId: summary.providerId,
      fallbackCount: summary.fallbackCount ?? 0,
    });
  } catch (error) {
    if (stored && isSourceChangedDuringGeneration(error)) {
      store.deleteDigestRollup({
        chatId,
        kind: "week",
        period,
      });
    }
    weeks.failed += 1;
    weeks.items.push(
      failedItem("week", period, group.digests.length, error),
    );
  }
}

function processMissingWeek(params: {
  runtime: DigestGenerationRuntime;
  dayPhase: DayPhaseResult;
  weeks: DigestPhaseReport;
  period: string;
  hasStoredDigest: boolean;
}): void {
  const {
    runtime,
    dayPhase,
    weeks,
    period,
    hasStoredDigest,
  } = params;
  if (!runtime.apply) {
    if (hasStoredDigest) {
      weeks.candidates += 1;
      weeks.planned += 1;
    } else {
      weeks.skipped += 1;
    }
    weeks.items.push({
      kind: "week",
      period,
      status: hasStoredDigest ? "planned" : "blocked",
      reason: "source_deleted",
      sourceCount: 0,
    });
    return;
  }

  const deleted =
    (hasStoredDigest &&
      runtime.store.deleteDigestRollup({
        chatId: runtime.chatId,
        kind: "week",
        period,
      })) ||
    dayPhase.invalidatedOrphanWeeks.has(period);
  if (deleted) {
    weeks.invalidated += 1;
  } else {
    weeks.skipped += 1;
  }
  weeks.items.push({
    kind: "week",
    period,
    status: deleted ? "invalidated" : "blocked",
    reason: "source_deleted",
    sourceCount: 0,
  });
}

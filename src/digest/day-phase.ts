import {
  calendarDayInTimeZone,
  isoWeekForDay,
  minCalendarDay,
  previousCalendarDay,
  validDate,
  type IsoWeekRange,
} from "./calendar.js";
import {
  failedItem,
  isSourceChangedDuringGeneration,
  summarizeBounded,
  validNow,
  type DigestGenerationRuntime,
} from "./generation-support.js";
import { analyzeDayCandidate } from "./planner.js";
import {
  hashDaySource,
  messageIdBounds,
  messagesForDay,
  renderDaySource,
} from "./source.js";
import {
  DAY_DIGEST_PROMPT_VERSION,
  DigestGenerationError,
  type DigestPhaseReport,
} from "./types.js";

export interface DayPhaseResult {
  days: DigestPhaseReport;
  expectedDayHashes: Map<string, string>;
  blockedWeeks: Map<string, IsoWeekRange>;
  failedWeeks: Map<string, IsoWeekRange>;
  deferredWeeks: Map<string, IsoWeekRange>;
  orphanedWeeks: Map<string, IsoWeekRange>;
  invalidatedOrphanWeeks: Set<string>;
}

export async function runDayPhase(
  runtime: DigestGenerationRuntime,
  today: string,
  lastEligibleDay: string,
  days: DigestPhaseReport,
): Promise<DayPhaseResult> {
  const {
    store,
    chatId,
    apply,
    all,
    summaryPort,
    maxInputChars,
    maxOutputChars,
    itemTimeoutMs,
  } = runtime;
  const expectedDayHashes = new Map<string, string>();
  const blockedWeeks = new Map<string, IsoWeekRange>();
  const failedWeeks = new Map<string, IsoWeekRange>();
  const deferredWeeks = new Map<string, IsoWeekRange>();
  const orphanedWeeks = new Map<string, IsoWeekRange>();
  const invalidatedOrphanWeeks = new Set<string>();
  const bounds = store.getDigestMessageDateBounds(chatId);
  const storedDaysAtStart = store.listDayDigests(chatId);

  if (bounds) {
    const firstDay = calendarDayInTimeZone(
      validDate(bounds.firstDate, "first digest message date"),
    );
    const boundedLastDay = calendarDayInTimeZone(
      validDate(bounds.lastDate, "last digest message date"),
    );
    const lastDay = all
      ? minCalendarDay(boundedLastDay, today)
      : minCalendarDay(boundedLastDay, previousCalendarDay(today));

    if (!all && boundedLastDay >= today) {
      recordCurrentDaySkip(runtime, today, days);
    }

    if (firstDay <= lastDay) {
      for (
        let day = lastDay;
        day >= firstDay;
        day = previousCalendarDay(day)
      ) {
        await processDay({
          runtime,
          day,
          days,
          expectedDayHashes,
          blockedWeeks,
          failedWeeks,
          deferredWeeks,
        });
      }
    }
  }

  invalidateOrphanedDays({
    runtime,
    storedDaysAtStart,
    lastEligibleDay,
    expectedDayHashes,
    orphanedWeeks,
    invalidatedOrphanWeeks,
    days,
  });

  return {
    days,
    expectedDayHashes,
    blockedWeeks,
    failedWeeks,
    deferredWeeks,
    orphanedWeeks,
    invalidatedOrphanWeeks,
  };
}

function recordCurrentDaySkip(
  runtime: DigestGenerationRuntime,
  today: string,
  days: DigestPhaseReport,
): void {
  const currentMessages = messagesForDay(
    runtime.store,
    runtime.chatId,
    today,
  );
  if (currentMessages.length === 0) {
    return;
  }
  days.scanned += 1;
  days.skipped += 1;
  days.items.push({
    kind: "day",
    period: today,
    status: "skipped_current",
    reason: "current_day_incomplete",
    sourceCount: currentMessages.length,
  });
}

async function processDay(params: {
  runtime: DigestGenerationRuntime;
  day: string;
  days: DigestPhaseReport;
  expectedDayHashes: Map<string, string>;
  blockedWeeks: Map<string, IsoWeekRange>;
  failedWeeks: Map<string, IsoWeekRange>;
  deferredWeeks: Map<string, IsoWeekRange>;
}): Promise<void> {
  const {
    runtime,
    day,
    days,
    expectedDayHashes,
    blockedWeeks,
    failedWeeks,
    deferredWeeks,
  } = params;
  const { store, chatId, apply } = runtime;
  const messages = messagesForDay(store, chatId, day);
  if (messages.length === 0) {
    return;
  }

  days.scanned += 1;
  const week = isoWeekForDay(day);
  const stored = store.getDayDigests({
    chatId,
    dayFrom: day,
    dayTo: day,
    limit: 1,
  })[0];
  const analysis = analyzeDayCandidate({
    all: runtime.all,
    chatId,
    day,
    messages,
    stored,
  });
  expectedDayHashes.set(day, analysis.sourceHash);

  if (!analysis.reason) {
    if (!analysis.sourceCurrent) {
      blockedWeeks.set(week.period, week);
    }
    days.unchanged += 1;
    days.items.push({
      kind: "day",
      period: day,
      status: "unchanged",
      reason: analysis.sourceCurrent
        ? "source_current"
        : "append_threshold_not_met",
      sourceCount: messages.length,
      ...(analysis.appendedAfterStoredEnd === undefined
        ? {}
        : {
            appendedAfterStoredEnd:
              analysis.appendedAfterStoredEnd,
          }),
      sourceHash: analysis.sourceHash,
    });
    return;
  }

  days.candidates += 1;
  if (!apply) {
    blockedWeeks.set(week.period, week);
    days.planned += 1;
    days.items.push({
      kind: "day",
      period: day,
      status: "planned",
      reason: analysis.reason,
      sourceCount: messages.length,
      ...(analysis.appendedAfterStoredEnd === undefined
        ? {}
        : {
            appendedAfterStoredEnd:
              analysis.appendedAfterStoredEnd,
          }),
      sourceHash: analysis.sourceHash,
    });
    return;
  }
  if (
    days.providerCalls >=
    runtime.maxDayGenerationsPerRun
  ) {
    deferredWeeks.set(week.period, week);
    days.deferred += 1;
    days.items.push({
      kind: "day",
      period: day,
      status: "deferred",
      reason: "run_limit",
      sourceCount: messages.length,
      ...(analysis.appendedAfterStoredEnd === undefined
        ? {}
        : {
            appendedAfterStoredEnd:
              analysis.appendedAfterStoredEnd,
          }),
      sourceHash: analysis.sourceHash,
    });
    return;
  }

  try {
    const sourceText = renderDaySource(
      messages,
      runtime.maxInputChars,
    );
    days.providerCalls += 1;
    const summary = await summarizeBounded(
      runtime.summaryPort!,
      {
        kind: "day",
        period: day,
        dayFrom: day,
        dayTo: day,
        sourceText,
        sourceCount: messages.length,
        maxOutputChars: runtime.maxOutputChars,
      },
      runtime.itemTimeoutMs,
    );
    const messageIdRange = messageIdBounds(messages);
    const committed = store.commitDayDigestIfCurrent(
      {
        chatId,
        day,
        startMessageId: messageIdRange.start,
        endMessageId: messageIdRange.end,
        messageCount: messages.length,
        text: summary.text,
        promptVersion: DAY_DIGEST_PROMPT_VERSION,
        model: summary.model,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        sourceHash: analysis.sourceHash,
        createdAtMs: validNow(runtime.now).getTime(),
      },
      () => {
        const currentMessages = messagesForDay(store, chatId, day);
        return (
          currentMessages.length > 0 &&
          hashDaySource(chatId, day, currentMessages) ===
            analysis.sourceHash
        );
      },
    );
    if (!committed) {
      throw new DigestGenerationError(
        "source_changed_during_generation",
        "Day digest source changed while its summary was being generated.",
      );
    }
    days.generated += 1;
    days.items.push({
      kind: "day",
      period: day,
      status: "generated",
      reason: analysis.reason,
      sourceCount: messages.length,
      ...(analysis.appendedAfterStoredEnd === undefined
        ? {}
        : {
            appendedAfterStoredEnd:
              analysis.appendedAfterStoredEnd,
          }),
      sourceHash: analysis.sourceHash,
      model: summary.model,
      providerId: summary.providerId,
      fallbackCount: summary.fallbackCount ?? 0,
    });
  } catch (error) {
    if (stored && !isSourceChangedDuringGeneration(error)) {
      // A provider/timeout/input failure must not turn a recoverable
      // regeneration backlog into data loss. Keep the previous digest and
      // its dependent rollup readable until a later run can replace them.
      failedWeeks.set(week.period, week);
    } else {
      blockedWeeks.set(week.period, week);
    }
    if (stored && isSourceChangedDuringGeneration(error)) {
      const invalidation = store.deleteDayDigest({ chatId, day });
      if (invalidation.dayDeleted) {
        days.invalidated += 1;
      }
    }
    days.failed += 1;
    days.items.push(
      failedItem("day", day, messages.length, error),
    );
  }
}

function invalidateOrphanedDays(params: {
  runtime: DigestGenerationRuntime;
  storedDaysAtStart: ReturnType<
    DigestGenerationRuntime["store"]["listDayDigests"]
  >;
  lastEligibleDay: string;
  expectedDayHashes: Map<string, string>;
  orphanedWeeks: Map<string, IsoWeekRange>;
  invalidatedOrphanWeeks: Set<string>;
  days: DigestPhaseReport;
}): void {
  const {
    runtime,
    storedDaysAtStart,
    lastEligibleDay,
    expectedDayHashes,
    orphanedWeeks,
    invalidatedOrphanWeeks,
    days,
  } = params;
  for (const stored of storedDaysAtStart) {
    if (
      stored.day > lastEligibleDay ||
      expectedDayHashes.has(stored.day)
    ) {
      continue;
    }
    const week = isoWeekForDay(stored.day);
    orphanedWeeks.set(week.period, week);
    days.scanned += 1;
    days.candidates += 1;
    if (!runtime.apply) {
      days.planned += 1;
      days.items.push({
        kind: "day",
        period: stored.day,
        status: "planned",
        reason: "source_deleted",
        sourceCount: 0,
      });
      continue;
    }
    const invalidation = runtime.store.deleteDayDigest({
      chatId: runtime.chatId,
      day: stored.day,
    });
    if (invalidation.dayDeleted) {
      days.invalidated += 1;
    }
    if (invalidation.weekRollupsDeleted > 0) {
      invalidatedOrphanWeeks.add(week.period);
    }
    days.items.push({
      kind: "day",
      period: stored.day,
      status: "invalidated",
      reason: "source_deleted",
      sourceCount: 0,
    });
  }
}

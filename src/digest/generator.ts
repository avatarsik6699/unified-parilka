import {
  calendarDayInTimeZone,
  previousCalendarDay,
} from "./calendar.js";
import { runDayPhase } from "./day-phase.js";
import {
  emptyPhaseReport,
  normalizeGenerationOptions,
  validNow,
} from "./generation-support.js";
import {
  DIGEST_STALE_MESSAGE_THRESHOLD,
  DIGEST_TIME_ZONE,
  type DigestGenerationOptions,
  type DigestGenerationReport,
} from "./types.js";
import { runWeekPhase } from "./week-phase.js";

export async function runDigestGeneration(
  options: DigestGenerationOptions,
): Promise<DigestGenerationReport> {
  const runtime = normalizeGenerationOptions(options);
  const started = validNow(runtime.now);
  const startedAt = started.toISOString();
  const today = calendarDayInTimeZone(started);
  const lastEligibleDay = runtime.all
    ? today
    : previousCalendarDay(today);
  const days = emptyPhaseReport();
  const weeks = emptyPhaseReport();

  const dayPhase = await runDayPhase(
    runtime,
    today,
    lastEligibleDay,
    days,
  );
  await runWeekPhase({
    runtime,
    lastEligibleDay,
    dayPhase,
    weeks,
  });

  return {
    mode: runtime.apply ? "applied" : "dry_run",
    chatId: runtime.chatId,
    timeZone: DIGEST_TIME_ZONE,
    staleMessageThreshold: DIGEST_STALE_MESSAGE_THRESHOLD,
    options: {
      all: runtime.all,
      maxDayGenerationsPerRun:
        runtime.maxDayGenerationsPerRun,
      maxWeekGenerationsPerRun:
        runtime.maxWeekGenerationsPerRun,
    },
    startedAt,
    finishedAt: validNow(runtime.now).toISOString(),
    days,
    weeks,
  };
}

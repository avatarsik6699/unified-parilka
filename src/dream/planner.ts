import {
  calendarDayInTimeZone,
  nextCalendarDay,
  previousCalendarDay,
} from "../digest/calendar.js";
import { DIGEST_TIME_ZONE } from "../digest/types.js";
import type {
  DreamDayStatus,
  StoredDreamDay,
  UpsertDreamDayInput,
} from "../store.js";

const BOOTSTRAP_COMPLETED_DAYS = 7;

export interface DreamPlannerStore {
  listDreamDays(params: {
    chatId: string;
    limit?: number;
    status?: DreamDayStatus;
  }): StoredDreamDay[];
  upsertDreamDay(input: UpsertDreamDayInput): StoredDreamDay;
}

export interface DreamPlannerOptions {
  now?: () => Date;
  timeZone?: string;
}

export type PlannedDreamJob = {
  day: string;
  status: DreamDayStatus;
  previousAttempts: number;
};

/**
 * Idempotent bootstrap: if the chat has no dream day rows, seed exactly seven
 * pending calendar days ending yesterday. This avoids re-opening the entire
 * history backlog when the old semantic watermark was stuck far behind.
 */
export function seedDreamDaysIfEmpty(
  store: DreamPlannerStore,
  chatId: string,
  options: DreamPlannerOptions = {},
): string[] {
  const existing = store.listDreamDays({ chatId, limit: 1 });
  if (existing.length > 0) {
    return [];
  }
  const now = options.now?.() ?? new Date();
  const yesterday = previousCalendarDayWithOffset(
    calendarDayInTimeZone(now, options.timeZone),
  );
  const floor = previousCalendarDayWithOffset(yesterday, BOOTSTRAP_COMPLETED_DAYS - 1);
  const seeded: string[] = [];
  let candidate = floor;
  while (candidate <= yesterday) {
    store.upsertDreamDay({
      chatId,
      day: candidate,
      status: "pending",
      interactionCount: 0,
      attempts: 0,
      createdAtMs: now.getTime(),
      updatedAtMs: now.getTime(),
    });
    seeded.push(candidate);
    candidate = nextCalendarDay(candidate);
  }
  return seeded;
}

/**
 * Plan the next set of day jobs oldest-first:
 *  - retry any failed or still-running jobs first;
 *  - then add all missing calendar days from the day after the newest
 *    scheduled day through yesterday, but never before the bootstrap floor.
 *
 * Failed/running jobs are never skipped; completed days are never inserted
 * before the bootstrap floor.
 */
export function planDreamDayJobs(
  store: DreamPlannerStore,
  chatId: string,
  options: DreamPlannerOptions = {},
): PlannedDreamJob[] {
  const now = options.now?.() ?? new Date();
  const today = calendarDayInTimeZone(now, options.timeZone);
  const yesterday = previousCalendarDayWithOffset(today);
  const floor = previousCalendarDayWithOffset(today, BOOTSTRAP_COMPLETED_DAYS);
  const all = store.listDreamDays({ chatId, limit: 1_000 });
  const byDay = new Map(all.map((row) => [row.day, row]));
  const maxScheduledDay = all.length === 0
    ? floor
    : all.reduce((max, row) => (row.day > max ? row.day : max), all[0]!.day);

  const jobs: PlannedDreamJob[] = [];

  // Retry oldest failed/running/pending first.
  for (const row of all) {
    if (row.status === "failed" || row.status === "running" || row.status === "pending") {
      jobs.push({
        day: row.day,
        status: row.status,
        previousAttempts: row.attempts,
      });
    }
  }

  // Add missing pending days after maxScheduledDay up to yesterday,
  // clamped to the bootstrap floor so we never reopen ancient history.
  let candidate = nextCalendarDay(maxScheduledDay);
  if (candidate < floor) {
    candidate = floor;
  }
  while (candidate <= yesterday) {
    if (!byDay.has(candidate)) {
      store.upsertDreamDay({
        chatId,
        day: candidate,
        status: "pending",
        interactionCount: 0,
        attempts: 0,
        createdAtMs: now.getTime(),
        updatedAtMs: now.getTime(),
      });
    }
    jobs.push({ day: candidate, status: "pending", previousAttempts: 0 });
    candidate = nextCalendarDay(candidate);
  }

  // Deduplicate and order.
  const seen = new Set<string>();
  return jobs
    .filter((job) => {
      if (seen.has(job.day)) {
        return false;
      }
      seen.add(job.day);
      return true;
    })
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Helper for tests: compute the bootstrap floor (today - 7) in the configured
 * time zone.
 */
export function dreamBootstrapFloor(
  now: Date,
  timeZone = DIGEST_TIME_ZONE,
): string {
  return previousCalendarDayWithOffset(
    calendarDayInTimeZone(now, timeZone),
    BOOTSTRAP_COMPLETED_DAYS,
  );
}

/**
 * Helper for tests: compute yesterday in the configured time zone.
 */
export function dreamYesterday(
  now: Date,
  timeZone = DIGEST_TIME_ZONE,
): string {
  return previousCalendarDayWithOffset(calendarDayInTimeZone(now, timeZone));
}

function previousCalendarDayWithOffset(day: string, offset = 1): string {
  let result = day;
  for (let i = 0; i < offset; i += 1) {
    result = result > "0001-01-01" ? previousCalendarDay(result) : result;
  }
  return result;
}

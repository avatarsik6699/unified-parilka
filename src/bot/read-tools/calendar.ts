import type { LocalDayRange } from "./contracts.js";

export const DEFAULT_TIME_ZONE = "Europe/Moscow";

export function calendarDayRange(
  rawDayFrom: string,
  rawDayTo = rawDayFrom,
  timeZone = DEFAULT_TIME_ZONE,
): LocalDayRange {
  const parsedFrom = parseCalendarDay(rawDayFrom);
  const parsedTo = parseCalendarDay(rawDayTo);
  assertTimeZone(timeZone);
  if (!parsedFrom || !parsedTo) {
    throw new TypeError("Dates must be real calendar days in YYYY-MM-DD format.");
  }

  const reversedInput = parsedTo.ordinal < parsedFrom.ordinal;
  const from = reversedInput ? parsedTo : parsedFrom;
  const to = reversedInput ? parsedFrom : parsedTo;
  const dayAfterTo = calendarDayFromOrdinal(to.ordinal + 86_400_000);

  return {
    dayFrom: from.iso,
    dayTo: to.iso,
    dayCount: Math.round((to.ordinal - from.ordinal) / 86_400_000) + 1,
    timeZone,
    startInclusive: new Date(zonedMidnightEpoch(from, timeZone)).toISOString(),
    endExclusive: new Date(
      zonedMidnightEpoch(dayAfterTo, timeZone),
    ).toISOString(),
    reversedInput,
  };
}

interface CalendarDay {
  iso: string;
  year: number;
  month: number;
  day: number;
  ordinal: number;
}

export function isCalendarDay(value: string): boolean {
  return parseCalendarDay(value) !== undefined;
}

function parseCalendarDay(value: string): CalendarDay | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  const ordinal = Date.UTC(year, month - 1, day);
  const date = new Date(ordinal);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { iso: value, year, month, day, ordinal };
}

function calendarDayFromOrdinal(ordinal: number): CalendarDay {
  const date = new Date(ordinal);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return {
    iso: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    month,
    day,
    ordinal,
  };
}

function zonedMidnightEpoch(day: CalendarDay, timeZone: string): number {
  const wallClockAsUtc = day.ordinal;
  let instant = wallClockAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = wallClockAsUtc - timeZoneOffsetMs(instant, timeZone);
    if (next === instant) {
      return next;
    }
    instant = next;
  }
  return instant;
}

function timeZoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(epochMs));
  const label = parts.find((part) => part.type === "timeZoneName")?.value;
  if (label === "GMT") {
    return 0;
  }
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(label ?? "");
  if (!match) {
    throw new TypeError(`Cannot determine UTC offset for time zone ${timeZone}.`);
  }
  const direction = match[1] === "+" ? 1 : -1;
  return direction * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new TypeError(`Invalid IANA time zone: ${timeZone}`);
  }
}

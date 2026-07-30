import { DIGEST_TIME_ZONE } from "./types.js";

const DAY_MS = 86_400_000;

export interface IsoWeekRange {
  period: string;
  dayFrom: string;
  dayTo: string;
}

export function calendarDayInTimeZone(
  date: Date,
  timeZone = DIGEST_TIME_ZONE,
): string {
  const parts = zonedParts(date, timeZone);
  return calendarLabel(parts.year, parts.month, parts.day);
}

export function dayStartInstant(
  day: string,
  timeZone = DIGEST_TIME_ZONE,
): string {
  const { year, month, dayOfMonth } = parseCalendarDay(day);
  const desired = Date.UTC(year, month - 1, dayOfMonth);
  let candidate = desired;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const parts = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const difference = represented - desired;
    if (difference === 0) {
      return new Date(candidate).toISOString();
    }
    candidate -= difference;
  }
  const final = zonedParts(new Date(candidate), timeZone);
  if (
    calendarLabel(final.year, final.month, final.day) !== day ||
    final.hour !== 0 ||
    final.minute !== 0 ||
    final.second !== 0
  ) {
    throw new Error(
      `Could not resolve calendar-day boundary ${day} in ${timeZone}.`,
    );
  }
  return new Date(candidate).toISOString();
}

export function nextCalendarDay(day: string): string {
  const { year, month, dayOfMonth } = parseCalendarDay(day);
  return new Date(
    Date.UTC(year, month - 1, dayOfMonth + 1),
  ).toISOString().slice(0, 10);
}

export function previousCalendarDay(day: string): string {
  const { year, month, dayOfMonth } = parseCalendarDay(day);
  return new Date(
    Date.UTC(year, month - 1, dayOfMonth - 1),
  ).toISOString().slice(0, 10);
}

export function isoWeekForDay(day: string): IsoWeekRange {
  const { year, month, dayOfMonth } = parseCalendarDay(day);
  const ordinal = Date.UTC(year, month - 1, dayOfMonth);
  const weekday = (new Date(ordinal).getUTCDay() + 6) % 7;
  const monday = ordinal - weekday * DAY_MS;
  const thursday = monday + 3 * DAY_MS;
  const weekYear = new Date(thursday).getUTCFullYear();
  const januaryFourth = Date.UTC(weekYear, 0, 4);
  const januaryFourthWeekday =
    (new Date(januaryFourth).getUTCDay() + 6) % 7;
  const firstMonday = januaryFourth - januaryFourthWeekday * DAY_MS;
  const weekNumber =
    Math.floor((monday - firstMonday) / (7 * DAY_MS)) + 1;
  return {
    period: `${weekYear}-W${String(weekNumber).padStart(2, "0")}`,
    dayFrom: new Date(monday).toISOString().slice(0, 10),
    dayTo: new Date(monday + 6 * DAY_MS).toISOString().slice(0, 10),
  };
}

export function minCalendarDay(
  left: string,
  right: string,
): string {
  return left <= right ? left : right;
}

export function validDate(value: string, name: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} is invalid.`);
  }
  return date;
}

function parseCalendarDay(day: string): {
  year: number;
  month: number;
  dayOfMonth: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) {
    throw new Error("Calendar day must use YYYY-MM-DD.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  const normalized = new Date(
    Date.UTC(year, month - 1, dayOfMonth),
  );
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + 1 !== month ||
    normalized.getUTCDate() !== dayOfMonth
  ) {
    throw new Error("Calendar day must be a real Gregorian date.");
  }
  return { year, month, dayOfMonth };
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timeZone: string): ZonedParts {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

function calendarLabel(
  year: number,
  month: number,
  day: number,
): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

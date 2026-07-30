import type {
  StoredMessage,
  UpsertDayDigestInput,
  UpsertDigestRollupInput,
} from "../store.js";
import type { SqlRow } from "./contracts.js";
import { digestHash } from "./hashes.js";

export interface LegacyStoredMessage extends StoredMessage {
  /**
   * The legacy bot synthesized dates for its own outgoing messages after
   * sendMessage returned. Those values are observations, not Telegram dates.
   */
  legacyDateSource: "telegram" | "local_send_observation";
}

export function legacyLiveMessage(
  row: SqlRow,
  expectedChatId: string,
): LegacyStoredMessage {
  const chatId = String(row.chat_id);
  if (chatId !== expectedChatId) {
    throw new Error(
      `Source live_msg contains chat_id ${chatId}; expected ${expectedChatId}. Refusing a cross-chat import.`,
    );
  }
  const messageId = positiveInteger(row.message_id, "live_msg.message_id");
  const dateUnix = nonNegativeInteger(row.date_unix, "live_msg.date_unix");
  const rawJson = requireString(row.raw_json, "live_msg.raw_json");
  return {
    chatId,
    messageId,
    date: new Date(
      unixSecondsToMs(dateUnix, "live_msg.date_unix"),
    ).toISOString(),
    senderId:
      row.sender_id == null ? undefined : String(row.sender_id),
    senderName:
      row.sender_name == null ? undefined : String(row.sender_name),
    text: requireText(row.text, "live_msg.text"),
    replyToMessageId:
      row.reply_to == null
        ? undefined
        : positiveInteger(row.reply_to, "live_msg.reply_to"),
    rawJson,
    legacyDateSource:
      legacyBoolean(row.is_bot, "live_msg.is_bot")
        ? "local_send_observation"
        : "telegram",
  };
}

export function normalizeDayDigest(
  row: SqlRow,
  chatId: string,
): UpsertDayDigestInput {
  const day = requireCalendarDay(row.day, "digest_day.day");
  const text = requireBoundedString(
    row.text,
    "digest_day.text",
    1_000_000,
  );
  const promptVersion = requireBoundedString(
    row.prompt_version,
    "digest_day.prompt_version",
    128,
  );
  const startMessageId = positiveInteger(
    row.start_msg_id,
    "digest_day.start_msg_id",
  );
  const endMessageId = positiveInteger(
    row.end_msg_id,
    "digest_day.end_msg_id",
  );
  if (endMessageId < startMessageId) {
    throw new Error(
      "digest_day.end_msg_id must be greater than or equal to start_msg_id.",
    );
  }
  return {
    chatId,
    day,
    startMessageId,
    endMessageId,
    messageCount: positiveInteger(row.n_msgs, "digest_day.n_msgs"),
    text,
    promptVersion,
    model: optionalBoundedString(
      row.model,
      "digest_day.model",
      256,
    ),
    inputTokens: optionalNonNegativeInteger(
      row.in_tokens,
      "digest_day.in_tokens",
    ),
    outputTokens: optionalNonNegativeInteger(
      row.out_tokens,
      "digest_day.out_tokens",
    ),
    sourceHash: digestHash({
      day,
      startMessageId,
      endMessageId,
      text,
      promptVersion,
    }),
    createdAtMs: unixSecondsToMs(
      row.created_at,
      "digest_day.created_at",
    ),
  };
}

export function normalizeRollup(
  row: SqlRow,
  chatId: string,
): UpsertDigestRollupInput {
  const kind = row.kind;
  if (kind !== "week" && kind !== "month") {
    throw new Error(`Unsupported digest_roll.kind: ${String(kind)}`);
  }
  const period = requireBoundedString(
    row.period,
    "digest_roll.period",
    32,
  );
  const dayFrom = requireCalendarDay(
    row.day_from,
    "digest_roll.day_from",
  );
  const dayTo = requireCalendarDay(row.day_to, "digest_roll.day_to");
  if (dayTo < dayFrom) {
    throw new Error(
      "digest_roll.day_to must be greater than or equal to day_from.",
    );
  }
  const text = requireBoundedString(
    row.text,
    "digest_roll.text",
    1_000_000,
  );
  const promptVersion = requireBoundedString(
    row.prompt_version,
    "digest_roll.prompt_version",
    128,
  );
  return {
    chatId,
    kind,
    period,
    dayFrom,
    dayTo,
    dayCount: positiveInteger(row.n_days, "digest_roll.n_days"),
    text,
    promptVersion,
    sourceHash: digestHash({
      kind,
      period,
      dayFrom,
      dayTo,
      text,
      promptVersion,
    }),
    createdAtMs: unixSecondsToMs(
      row.created_at,
      "digest_roll.created_at",
    ),
  };
}

export function normalizeLegacyMonth(
  row: SqlRow,
  chatId: string,
): UpsertDigestRollupInput {
  const period = requireCalendarMonth(row.month);
  const dayFrom = `${period}-01`;
  const dayTo = lastCalendarDayOfMonth(period);
  const text = requireBoundedString(
    row.text,
    "digest_month.text",
    1_000_000,
  );
  const promptVersion = requireBoundedString(
    row.prompt_version,
    "digest_month.prompt_version",
    128,
  );
  return {
    chatId,
    kind: "month",
    period,
    dayFrom,
    dayTo,
    dayCount: positiveInteger(row.n_days, "digest_month.n_days"),
    text,
    promptVersion,
    sourceHash: digestHash({
      kind: "month",
      period,
      dayFrom,
      dayTo,
      text,
      promptVersion,
    }),
    createdAtMs: unixSecondsToMs(
      row.created_at,
      "digest_month.created_at",
    ),
  };
}


function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return number;
}

function legacyBoolean(value: unknown, field: string): boolean {
  const number = Number(value);
  if (number !== 0 && number !== 1) {
    throw new Error(`${field} must be 0 or 1.`);
  }
  return number === 1;
}

export function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return number;
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | undefined {
  return value == null ? undefined : nonNegativeInteger(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be text.`);
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  const text = requireString(value, field);
  if (text.length > maximumLength) {
    throw new Error(
      `${field} must be at most ${maximumLength} characters.`,
    );
  }
  return text;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return requireBoundedString(value, field, maximumLength);
}

function requireCalendarDay(value: unknown, field: string): string {
  const day = requireString(value, field);
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  ) {
    throw new Error(`${field} must be a real Gregorian calendar day.`);
  }
  return day;
}

function requireCalendarMonth(value: unknown): string {
  const month = requireString(value, "digest_month.month");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) {
    throw new Error("digest_month.month must be YYYY-MM.");
  }
  return month;
}

function lastCalendarDayOfMonth(month: string): string {
  const [year, rawMonth] = month.split("-");
  const nextMonth = new Date(
    Date.UTC(Number(year), Number(rawMonth), 1),
  );
  nextMonth.setUTCDate(0);
  return nextMonth.toISOString().slice(0, 10);
}

function unixSecondsToMs(value: unknown, field: string): number {
  const seconds = nonNegativeInteger(value, field);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`${field} is outside the supported timestamp range.`);
  }
  return milliseconds;
}

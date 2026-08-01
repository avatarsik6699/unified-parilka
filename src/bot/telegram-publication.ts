/** Telegram's documented classic `sendMessage` UTF-16 text payload limit. */
export const TELEGRAM_TEXT_LIMIT_UTF16 = 4_096;

/** Telegram's documented native Rich Message UTF-8 payload limit. */
export const TELEGRAM_RICH_TEXT_LIMIT_UTF8 = 32_768;

/**
 * The exact model result that crosses the Telegram send boundary.
 *
 * This is deliberately a transport contract, not a content policy: model
 * text is neither inspected nor rewritten here. Model replies within the
 * native Rich Message limit use the rich path; local audio and replies beyond
 * that limit use the classic plain path, which the publisher splits losslessly.
 */
export type TelegramPublication =
  | {
      mode: "rich";
      markdown: string;
      plainText: string;
      maxChunkUtf16: number;
    }
  | {
      mode: "plain";
      plainText: string;
      maxChunkUtf16: number;
    };

export function createTelegramPublication(
  text: string,
  responseOrigin?: "local_audio",
): TelegramPublication {
  if (
    responseOrigin === "local_audio" ||
    utf8Length(text) > TELEGRAM_RICH_TEXT_LIMIT_UTF8
  ) {
    return {
      mode: "plain",
      plainText: text,
      maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
    };
  }
  return {
    mode: "rich",
    markdown: text,
    plainText: text,
    maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
  };
}

export function utf16Length(text: string): number {
  return text.length;
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Splits losslessly without cutting a UTF-16 surrogate pair. Paragraph, line,
 * and space boundaries are preferred before a scalar-safe hard cut.
 */
export function splitTelegramText(
  text: string,
  limit = TELEGRAM_TEXT_LIMIT_UTF16,
): string[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 2 ||
    limit > TELEGRAM_TEXT_LIMIT_UTF16
  ) {
    throw new RangeError(
      `Telegram text limit must be an integer between 2 and ${TELEGRAM_TEXT_LIMIT_UTF16}.`,
    );
  }
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = safeUtf16End(text, start, limit);
    if (hardEnd >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    const preferredEnd = preferredBreak(text, start, hardEnd);
    const end = preferredEnd > start ? preferredEnd : hardEnd;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function safeUtf16End(text: string, start: number, limit: number): number {
  let end = Math.min(text.length, start + limit);
  if (
    end < text.length &&
    end > start &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1;
  }
  if (end === start) {
    throw new RangeError(
      "Unable to fit one Unicode scalar into the Telegram chunk limit.",
    );
  }
  return end;
}

function preferredBreak(
  text: string,
  start: number,
  hardEnd: number,
): number {
  const paragraph = text.lastIndexOf("\n\n", hardEnd - 2);
  if (paragraph >= start) {
    return paragraph + 2;
  }
  const line = text.lastIndexOf("\n", hardEnd - 1);
  if (line >= start) {
    return line + 1;
  }
  const space = text.lastIndexOf(" ", hardEnd - 1);
  if (space >= start) {
    return space + 1;
  }
  return hardEnd;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

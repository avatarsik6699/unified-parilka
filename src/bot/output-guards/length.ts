import { TELEGRAM_TEXT_LIMIT_UTF16 } from "./contracts.js";

export function utf16Length(text: string): number {
  return text.length;
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

export function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (!isLowSurrogate(text.charCodeAt(index + 1))) {
        return true;
      }
      index += 1;
    } else if (isLowSurrogate(code)) {
      return true;
    }
  }
  return false;
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

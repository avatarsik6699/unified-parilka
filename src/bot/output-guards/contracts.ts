export const TELEGRAM_TEXT_LIMIT_UTF16 = 4_096;
export const DEFAULT_MAX_MENTIONS = 2;
export const DEFAULT_MIN_QUOTE_CHARACTERS = 12;

export interface QuoteEvidence {
  speaker: string;
  text: string;
}

/**
 * Only a fully accumulated final model result may cross the send boundary.
 */
export interface FinalModelOutput {
  kind: "final";
  text: string;
}

export interface OutputGuardPolicy {
  evidence?: readonly QuoteEvidence[];
  allowedMentions?: readonly string[];
  maxMentions?: number;
  maxChunkUtf16?: number;
  minQuoteCharacters?: number;
}

export type OutputRejectionCode =
  | "invalid_policy"
  | "invalid_unicode"
  | "empty_after_sanitization"
  | "unsafe_control_markup"
  | "unauthorized_mention"
  | "mass_mentions"
  | "quote_speaker_mismatch"
  | "unsafe_rich_text";

export interface OutputGuardRejection {
  code: OutputRejectionCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface OutputGuardReport {
  removedHiddenBlocks: number;
  removedServiceArtifacts: number;
  verifiedQuotes: number;
  mentions: readonly string[];
}

/**
 * A single Telegram-ready chunk with pre-computed entities. The publisher
 * sends `text` + `entities` without any `parse_mode`.
 */
export interface GuardedChunk {
  text: string;
  entities: readonly import("../rich-text.js").TelegramEntity[];
}

export type OutputGuardResult =
  | {
      ok: true;
      disposition: "skip";
      text: "SKIP";
      chunks: readonly [];
      report: OutputGuardReport;
    }
  | {
      ok: true;
      disposition: "send";
      text: string;
      chunks: readonly GuardedChunk[];
      report: OutputGuardReport;
    }
  | OutputGuardRejected;

export type OutputGuardRejected = {
  ok: false;
  rejection: OutputGuardRejection;
};

export function rejectOutput(
  code: OutputRejectionCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): OutputGuardRejected {
  return {
    ok: false,
    rejection: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

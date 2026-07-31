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
  | "quote_speaker_mismatch";

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
 * The narrow rich/plain publication contract that crosses the send boundary.
 *
 * - `rich` carries the safe, byte-for-byte original Markdown plus the
 *   canonical visible plain text and the validated fallback split bound;
 * - `plain` carries the canonical visible plain text and the validated split
 *   bound for the classic fallback. Model HTML, media, blocks or raw entity
 *   chunks never enter it.
 */
export type GuardedTelegramPublication =
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

export type OutputGuardResult =
  | {
      ok: true;
      disposition: "skip";
      text: "SKIP";
      report: OutputGuardReport;
    }
  | {
      ok: true;
      disposition: "send";
      text: string;
      publication: GuardedTelegramPublication;
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

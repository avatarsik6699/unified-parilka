import {
  rejectOutput,
  type OutputGuardRejected,
} from "./contracts.js";

const TELEGRAM_MENTION_PATTERN =
  /(?<![\p{L}\p{N}_])@([A-Za-z][A-Za-z0-9_]{4,31})/gu;

export type MentionValidation =
  | { ok: true; mentions: string[] }
  | OutputGuardRejected;

export function validateMentions(
  text: string,
  allowedMentions: readonly string[],
  maxMentions: number,
): MentionValidation {
  const allowed = new Set(
    allowedMentions
      .map(normalizeMention)
      .filter((value) => value.length > 0),
  );
  // The publisher sends plain text without parse_mode. Backticks therefore
  // do not suppress Telegram's server-side @username entity detection, so
  // validation must cover the exact text crossing the publish boundary.
  const mentions = [...text.matchAll(TELEGRAM_MENTION_PATTERN)].map(
    (match) => match[1],
  );
  const unauthorized = mentions.filter(
    (mention) => !allowed.has(normalizeMention(mention)),
  );
  if (unauthorized.length > 0) {
    return rejectOutput(
      "unauthorized_mention",
      "The final output contains Telegram mentions not authorized for this turn.",
      {
        mentions: [
          ...new Set(
            unauthorized.map((mention) => `@${mention}`),
          ),
        ],
      },
    );
  }
  const uniqueMentions = [
    ...new Map(
      mentions.map((mention) => [
        normalizeMention(mention),
        `@${mention}`,
      ]),
    ).values(),
  ];
  if (uniqueMentions.length > maxMentions) {
    return rejectOutput(
      "mass_mentions",
      "The final output exceeds the per-message Telegram mention budget.",
      {
        count: uniqueMentions.length,
        maxMentions,
        mentions: uniqueMentions,
      },
    );
  }
  return { ok: true, mentions: uniqueMentions };
}

function normalizeMention(mention: string): string {
  return mention.trim().replace(/^@/u, "").toLowerCase();
}

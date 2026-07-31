const TELEGRAM_MENTION_PATTERN = /@([A-Za-z0-9_]{3,32})/gu;

export type VisibleMentionValidation =
  | { ok: true; mentions: string[] }
  | {
      ok: false;
      code: "unauthorized_mention" | "mass_mentions";
      count?: number;
    };

/**
 * Validates mentions on the canonical visible plain text. This runs AFTER the
 * Markdown projection to close the `@foo**bar**` → `@foobar` bypass where a
 * mention only materialises once formatting is removed.
 */
export function validateVisibleMentions(
  text: string,
  allowedUsernames: ReadonlySet<string>,
  maxMentions: number,
): VisibleMentionValidation {
  const seen = new Map<string, string>();
  for (
    let match = TELEGRAM_MENTION_PATTERN.exec(text);
    match;
    match = TELEGRAM_MENTION_PATTERN.exec(text)
  ) {
    const username = match[1]!;
    const lower = username.toLowerCase();
    if (!allowedUsernames.has(lower)) {
      return { ok: false, code: "unauthorized_mention" };
    }
    seen.set(lower, `@${username}`);
  }
  if (seen.size > maxMentions) {
    return { ok: false, code: "mass_mentions", count: seen.size };
  }
  return { ok: true, mentions: [...seen.values()] };
}

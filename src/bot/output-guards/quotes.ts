import {
  rejectOutput,
  type OutputGuardRejected,
  type QuoteEvidence,
} from "./contracts.js";

const QUOTE_PATTERN = /«([^»]+)»|“([^”]+)”|"([^"\n]+)"/gu;

export type QuoteValidation =
  | { ok: true; verified: number }
  | OutputGuardRejected;

export function validateQuotes(
  text: string,
  evidence: readonly QuoteEvidence[],
  minQuoteCharacters: number,
): QuoteValidation {
  const normalizedEvidence = evidence
    .map((item) => ({
      speaker: normalizeSpeaker(item.speaker),
      displaySpeaker: item.speaker,
      text: normalizeText(item.text),
    }))
    .filter((item) => item.speaker && item.text);
  const knownSpeakers = new Set(
    normalizedEvidence.map((item) => item.speaker),
  );
  let verified = 0;
  QUOTE_PATTERN.lastIndex = 0;

  for (
    let match = QUOTE_PATTERN.exec(text);
    match;
    match = QUOTE_PATTERN.exec(text)
  ) {
    const quote = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (Array.from(quote).length < minQuoteCharacters) {
      continue;
    }
    const normalizedQuote = normalizeText(quote);
    const owners = new Set(
      normalizedEvidence
        .filter((item) => item.text.includes(normalizedQuote))
        .map((item) => item.speaker),
    );
    const attribution = attributedSpeaker(
      text,
      match.index,
      match.index + match[0].length,
      knownSpeakers,
    );

    if (attribution) {
      const attributedEvidence = normalizedEvidence.filter(
        (item) => item.speaker === attribution.normalized,
      );
      if (
        !attributedEvidence.some((item) =>
          item.text.includes(normalizedQuote),
        )
      ) {
        return rejectOutput(
          "quote_speaker_mismatch",
          "A verbatim quote is not present in evidence belonging to its attributed speaker.",
          {
            quote,
            attributedSpeaker: attribution.display,
            evidenceSpeakers: [
              ...new Set(
                normalizedEvidence
                  .filter((item) =>
                    item.text.includes(normalizedQuote),
                  )
                  .map((item) => item.displaySpeaker),
              ),
            ],
          },
        );
      }
      verified += 1;
      continue;
    }

    if (owners.size === 0) {
      // A quote absent from structured evidence is not a delivery or security
      // risk. Only an attributed quote that contradicts its named speaker is
      // rejected (quote_speaker_mismatch above). Unverified quotes pass
      // through uncounted.
      continue;
    }
    verified += 1;
  }
  return { ok: true, verified };
}

function attributedSpeaker(
  text: string,
  quoteStart: number,
  quoteEnd: number,
  knownSpeakers: ReadonlySet<string>,
): { display: string; normalized: string } | undefined {
  const lineStart =
    text.lastIndexOf("\n", Math.max(0, quoteStart - 1)) + 1;
  const lineEndIndex = text.indexOf("\n", quoteEnd);
  const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
  const prefix = text.slice(lineStart, quoteStart).trim();
  const suffix = text.slice(quoteEnd, lineEnd).trim();

  const spokenPrefix = prefix.match(
    /(?:как\s+)?(?:сказал(?:а|и)?|писал(?:а|и)?|написал(?:а|и)?)\s+(@?[\p{L}\p{N}_.-]+(?:[ \t]+[\p{L}\p{N}_.-]+){0,3})\s*:\s*$/iu,
  );
  const plainPrefix = prefix.match(
    /^[@*_\s]*(@?[\p{L}\p{N}_.-]+(?:[ \t]+[\p{L}\p{N}_.-]+){0,3})[*_\s]*:\s*$/u,
  );
  const suffixMatch = suffix.match(
    /^[,;]?\s*[—-]\s*(?:(?:сказал(?:а|и)?|писал(?:а|и)?|написал(?:а|и)?)\s+)?(@?[\p{L}\p{N}_.-]+(?:[ \t]+[\p{L}\p{N}_.-]+){0,3})/iu,
  );
  const candidate =
    spokenPrefix?.[1] ?? plainPrefix?.[1] ?? suffixMatch?.[1];
  if (candidate) {
    return {
      display: candidate.trim(),
      normalized: normalizeSpeaker(candidate),
    };
  }

  for (const speaker of knownSpeakers) {
    const normalizedPrefix = normalizeSpeaker(
      prefix.replace(/[:—\-*_]+$/gu, ""),
    );
    if (normalizedPrefix.endsWith(speaker)) {
      return { display: speaker, normalized: speaker };
    }
  }
  return undefined;
}

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeSpeaker(speaker: string): string {
  return normalizeText(speaker)
    .replace(/[*_`]/gu, "")
    .replace(/^@/u, "")
    .replace(/[.,:;!?—-]+$/gu, "")
    .trim();
}

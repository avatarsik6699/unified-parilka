import {
  DEFAULT_MAX_MENTIONS,
  DEFAULT_MIN_QUOTE_CHARACTERS,
  TELEGRAM_TEXT_LIMIT_UTF16,
  rejectOutput,
  type FinalModelOutput,
  type GuardedTelegramPublication,
  type OutputGuardPolicy,
  type OutputGuardRejected,
  type OutputGuardResult,
} from "./contracts.js";
import {
  cleanArtifactWhitespace,
  hasDanglingHiddenTag,
  stripHiddenReasoning,
  stripServiceArtifacts,
} from "./format.js";
import {
  hasUnpairedSurrogate,
} from "./length.js";
import { validateVisibleMentions } from "./mentions.js";
import { validateQuotes } from "./quotes.js";
import { preflightRichMarkdown } from "../rich-markdown.js";

type ValidatedPolicy =
  | {
      ok: true;
      maxMentions: number;
      maxChunkUtf16: number;
      minQuoteCharacters: number;
    }
  | OutputGuardRejected;

/**
 * Pure final boundary between model generation and Telegram send. Recognized
 * control artifacts are removed; unsafe social claims reject the whole output.
 * The safe original Markdown is either admitted unchanged as a native rich
 * publication or the whole message degrades to canonical plain text.
 */
export function guardFinalTelegramOutput(
  output: FinalModelOutput,
  policy: OutputGuardPolicy = {},
): OutputGuardResult {
  const validated = validatePolicy(policy);
  if (!validated.ok) {
    return validated;
  }

  const hidden = stripHiddenReasoning(output.text);
  const service = stripServiceArtifacts(hidden.text);
  const text = cleanArtifactWhitespace(service.text);
  const reportBase = {
    removedHiddenBlocks: hidden.removed,
    removedServiceArtifacts: service.removed,
  };

  if (hasDanglingHiddenTag(text)) {
    return rejectOutput(
      "unsafe_control_markup",
      "Unrecognized hidden-reasoning markup remained after sanitization.",
    );
  }
  if (text === "SKIP") {
    return {
      ok: true,
      disposition: "skip",
      text: "SKIP",
      report: {
        ...reportBase,
        verifiedQuotes: 0,
        mentions: [],
      },
    };
  }
  if (!text) {
    return rejectOutput(
      "empty_after_sanitization",
      "The final output contained no publishable text after removing control artifacts.",
    );
  }
  if (hasUnpairedSurrogate(text)) {
    return rejectOutput(
      "invalid_unicode",
      "The final output contains an unpaired UTF-16 surrogate and cannot be sent safely.",
    );
  }

  // The preflight never rewrites safe Markdown: rich mode keeps the original
  // bytes and the visible plain projection is built from the bounded AST.
  const preflight = preflightRichMarkdown(text);
  const visibleText = preflight.plainText;

  if (!visibleText.trim()) {
    return rejectOutput(
      "empty_after_sanitization",
      "The final output contained no visible text after Markdown projection.",
    );
  }

  // Validate mentions on the VISIBLE text (after Markdown stripping) to close
  // the @foo**bar** → @foobar bypass where a mention only materialises after
  // formatting is removed.
  const allowedSet = new Set(
    (policy.allowedMentions ?? []).map((m) => m.toLowerCase()),
  );
  const mentionCheck = validateVisibleMentions(
    visibleText,
    allowedSet,
    validated.maxMentions,
  );
  if (!mentionCheck.ok) {
    return rejectOutput(
      mentionCheck.code,
      mentionCheck.code === "unauthorized_mention"
        ? "The visible text contains an unauthorized mention."
        : "The visible text contains too many distinct mentions.",
      mentionCheck.count !== undefined
        ? { count: mentionCheck.count }
        : undefined,
    );
  }

  const quoteCheck = validateQuotes(
    visibleText,
    policy.evidence ?? [],
    validated.minQuoteCharacters,
  );
  if (!quoteCheck.ok) {
    return quoteCheck;
  }

  const publication: GuardedTelegramPublication = preflight.ok
    ? {
        mode: "rich",
        markdown: preflight.markdown,
        plainText: visibleText,
        maxChunkUtf16: validated.maxChunkUtf16,
      }
    : {
        mode: "plain",
        plainText: visibleText,
        maxChunkUtf16: validated.maxChunkUtf16,
      };

  return {
    ok: true,
    disposition: "send",
    text: visibleText,
    publication,
    report: {
      ...reportBase,
      verifiedQuotes: quoteCheck.verified,
      mentions: mentionCheck.ok ? mentionCheck.mentions : [],
    },
  };
}

function validatePolicy(policy: OutputGuardPolicy): ValidatedPolicy {
  const maxMentions = policy.maxMentions ?? DEFAULT_MAX_MENTIONS;
  const maxChunkUtf16 =
    policy.maxChunkUtf16 ?? TELEGRAM_TEXT_LIMIT_UTF16;
  const minQuoteCharacters =
    policy.minQuoteCharacters ?? DEFAULT_MIN_QUOTE_CHARACTERS;

  if (
    !Number.isSafeInteger(maxMentions) ||
    maxMentions < 0 ||
    maxMentions > 20
  ) {
    return rejectOutput(
      "invalid_policy",
      "maxMentions must be an integer between 0 and 20.",
    );
  }
  if (
    !Number.isSafeInteger(maxChunkUtf16) ||
    maxChunkUtf16 < 2 ||
    maxChunkUtf16 > TELEGRAM_TEXT_LIMIT_UTF16
  ) {
    return rejectOutput(
      "invalid_policy",
      `maxChunkUtf16 must be between 2 and ${TELEGRAM_TEXT_LIMIT_UTF16}.`,
    );
  }
  if (
    !Number.isSafeInteger(minQuoteCharacters) ||
    minQuoteCharacters < 1 ||
    minQuoteCharacters > 1_000
  ) {
    return rejectOutput(
      "invalid_policy",
      "minQuoteCharacters must be an integer between 1 and 1000.",
    );
  }
  return {
    ok: true,
    maxMentions,
    maxChunkUtf16,
    minQuoteCharacters,
  };
}

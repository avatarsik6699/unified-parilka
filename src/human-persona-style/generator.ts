import { hashStyleSource, renderStyleSource } from "./source.js";
import {
  MAX_STYLE_EXAMPLE_MESSAGES,
  StyleProfileGenerationError,
  type StyleProfileGenerationOptions,
  type StyleProfileGenerationReport,
} from "./types.js";

const DEFAULT_MAX_INPUT_CHARS = 160_000;
const DEFAULT_MAX_OUTPUT_CHARS = 4_000;
const DEFAULT_ITEM_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_EXAMPLES = MAX_STYLE_EXAMPLE_MESSAGES;

/**
 * Runs the style-profile pipeline for one (persona, chat, target person)
 * (plan Фаза 4f/5 Шаг 2). Regenerates only when the target's message
 * history hash has changed since the stored profile — mirrors Digest's
 * source-hash invalidation, without its day/week rollup machinery: a style
 * profile is one artifact per (persona, target), not a per-day series.
 */
export async function runStyleProfileGeneration(
  options: StyleProfileGenerationOptions,
): Promise<StyleProfileGenerationReport> {
  const apply = options.apply === true;
  if (apply && !options.port) {
    throw new Error("port is required in apply mode.");
  }
  const now = options.now ?? (() => new Date());
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const itemTimeoutMs = options.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
  const maxExamples = options.maxExamples ?? DEFAULT_MAX_EXAMPLES;
  const startedAt = validNow(now).toISOString();

  const base = {
    mode: (apply ? "applied" : "dry_run") as "applied" | "dry_run",
    personaId: options.personaId,
    chatId: options.chatId,
    targetUserKey: options.targetUserKey,
    startedAt,
  };

  const messages = options.store.getHumanPersonaStyleSourceMessages(
    options.chatId,
    options.targetUserKey,
  );
  if (messages.length === 0) {
    return {
      ...base,
      status: "no_source_messages",
      sourceCount: 0,
      finishedAt: validNow(now).toISOString(),
    };
  }

  const sourceHash = hashStyleSource(
    options.personaId,
    options.targetUserKey,
    messages,
  );
  const existing = options.store.getHumanPersonaStyleProfile(
    options.personaId,
    options.targetUserKey,
  );
  if (existing?.sourceHash === sourceHash) {
    return {
      ...base,
      status: "unchanged",
      sourceCount: messages.length,
      sourceHash,
      finishedAt: validNow(now).toISOString(),
    };
  }

  if (!apply) {
    return {
      ...base,
      status: "unchanged",
      sourceCount: messages.length,
      sourceHash,
      finishedAt: validNow(now).toISOString(),
    };
  }

  try {
    const sourceText = renderStyleSource(messages, maxInputChars);
    const signal = AbortSignal.timeout(itemTimeoutMs);
    const compiled = await options.port!.compileProfile({
      personaId: options.personaId,
      targetUserKey: options.targetUserKey,
      sourceText,
      sourceCount: messages.length,
      maxOutputChars,
      signal,
    });
    const curated = await options.port!.curateExamples({
      personaId: options.personaId,
      targetUserKey: options.targetUserKey,
      candidates: messages,
      maxExamples,
      signal,
    });
    const byId = new Map(
      messages.map((message) => [message.messageId, message]),
    );
    const exampleMessages = curated.selectedMessageIds
      .map((id) => byId.get(id)?.text)
      .filter((text): text is string => typeof text === "string")
      .slice(0, maxExamples);

    options.store.upsertHumanPersonaStyleProfile({
      personaId: options.personaId,
      targetUserKey: options.targetUserKey,
      profileText: compiled.profileText,
      exampleMessages,
      sourceHash,
      consentBasis: options.consentBasis,
      model: compiled.model,
      provider: compiled.providerId,
    });

    return {
      ...base,
      status: "generated",
      sourceCount: messages.length,
      sourceHash,
      exampleCount: exampleMessages.length,
      model: compiled.model,
      providerId: compiled.providerId,
      finishedAt: validNow(now).toISOString(),
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      sourceCount: messages.length,
      sourceHash,
      error: safeErrorIdentity(error),
      finishedAt: validNow(now).toISOString(),
    };
  }
}

function validNow(now: () => Date): Date {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new StyleProfileGenerationError(
      "invalid_clock",
      "Clock returned an invalid date.",
    );
  }
  return date;
}

function safeErrorIdentity(error: unknown): { name: string; code: string } {
  if (error instanceof StyleProfileGenerationError) {
    return { name: error.name, code: error.code };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown };
    return {
      name:
        typeof candidate.name === "string"
          ? candidate.name.slice(0, 80)
          : "Error",
      code:
        typeof candidate.code === "string" || typeof candidate.code === "number"
          ? String(candidate.code).slice(0, 80)
          : "style_profile_generation_failed",
    };
  }
  return { name: "NonError", code: "style_profile_generation_failed" };
}

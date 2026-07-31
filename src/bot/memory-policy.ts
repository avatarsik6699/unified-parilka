/**
 * Only the addressed user's authoritative trigger may expose write tools.
 * Folded messages, search output, existing memory and a loaded skill never
 * influence this gate, so untrusted text cannot persist itself.
 */
const NEGATED_WRITE_REQUEST = /(?:не\s+(?:надо\s+|нужно\s+)?|don't\s+|do\s+not\s+)(?:запомни|сохрани|запиши|добавь|обнови|создай|remember|save|update|create)/iu;

const DIRECT_WRITE_REQUEST = /(?:запомни|(?:сохрани|запиши|добавь|обнови)\s+(?:это\s+)?(?:в\s+)?(?:памят\p{L}*|урок\p{L}*|навык\p{L}*|на\s+будущее)|(?:создай|обнови)\s+(?:чатовый\s+)?навык\p{L}*|remember(?:\s+this)?|(?:save|update)\s+(?:this\s+)?(?:memory|lesson|skill)|create\s+(?:a\s+)?skill)/iu;

export function botMemoryWriteAllowedForText(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || NEGATED_WRITE_REQUEST.test(normalized)) {
    return false;
  }
  return DIRECT_WRITE_REQUEST.test(normalized);
}

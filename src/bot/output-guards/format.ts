import { mapOutsideMarkdownCode } from "./markdown.js";

const HIDDEN_TAG_PATTERN =
  /<\s*(\/?)\s*(think|thinking|analysis|reasoning)\b[^>]*>/giu;
const DANGLING_HIDDEN_TAG_PATTERN =
  /<\s*\/?\s*(?:think|thinking|analysis|reasoning)\b/iu;
const MODEL_SENTINEL_PATTERN =
  /<\|(?:assistant|end|endoftext|eot_id|final|im_end|im_start)\|>/giu;
const FINAL_WRAPPER_PATTERN = /<\s*\/?\s*final\s*>/giu;
const INTERNAL_ORDINAL_PATTERN =
  /(?<![\p{L}\p{N}_])(?:сообщени[ияей]|msg|message)\s*#?\s*\d{3,}/giu;
const STRUCTURED_TOOL_TAIL_PATTERN =
  /\n{1,2}\s*(?:tool_calls?|function_calls?)\s*[:=]\s*(?:\[[\s\S]*|\{[\s\S]*)$/iu;

export function stripHiddenReasoning(
  text: string,
): { text: string; removed: number } {
  let output = "";
  let cursor = 0;
  let depth = 0;
  let removed = 0;
  HIDDEN_TAG_PATTERN.lastIndex = 0;

  for (
    let match = HIDDEN_TAG_PATTERN.exec(text);
    match;
    match = HIDDEN_TAG_PATTERN.exec(text)
  ) {
    if (depth === 0) {
      output += text.slice(cursor, match.index);
    }
    const closing = match[1] === "/";
    if (closing) {
      if (depth > 0) {
        depth -= 1;
      } else {
        removed += 1;
      }
    } else {
      if (depth === 0) {
        removed += 1;
      }
      depth += 1;
    }
    cursor = match.index + match[0].length;
  }
  if (depth === 0) {
    output += text.slice(cursor);
  }

  const danglingIndex = output.search(DANGLING_HIDDEN_TAG_PATTERN);
  if (danglingIndex >= 0) {
    output = output.slice(0, danglingIndex);
    removed += 1;
  }
  return { text: output, removed };
}

export function stripServiceArtifacts(
  source: string,
): { text: string; removed: number } {
  let text = source;
  let removed = 0;
  const replace = (pattern: RegExp, value = ""): void => {
    text = mapOutsideMarkdownCode(text, (segment) => {
      pattern.lastIndex = 0;
      return segment.replace(pattern, () => {
        removed += 1;
        return value;
      });
    });
  };

  replace(MODEL_SENTINEL_PATTERN);
  replace(FINAL_WRAPPER_PATTERN);
  replace(INTERNAL_ORDINAL_PATTERN);
  replace(STRUCTURED_TOOL_TAIL_PATTERN);
  return { text, removed };
}

export function cleanArtifactWhitespace(text: string): string {
  return mapOutsideMarkdownCode(text, (segment) =>
    segment
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+([,.;:!?])/gu, "$1")
      .replace(/\n{3,}/gu, "\n\n"),
  ).trim();
}

export function hasDanglingHiddenTag(text: string): boolean {
  return DANGLING_HIDDEN_TAG_PATTERN.test(text);
}

const MARKDOWN_CODE_PATTERN =
  /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*`/gu;

export function mapOutsideMarkdownCode(
  text: string,
  transform: (segment: string) => string,
): string {
  const spans = markdownCodeSpans(text);
  if (spans.length === 0) {
    return transform(text);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(transform(text.slice(cursor, span.start)));
    parts.push(text.slice(span.start, span.end));
    cursor = span.end;
  }
  parts.push(transform(text.slice(cursor)));
  return parts.join("");
}

function markdownCodeSpans(
  text: string,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  MARKDOWN_CODE_PATTERN.lastIndex = 0;
  for (
    let match = MARKDOWN_CODE_PATTERN.exec(text);
    match;
    match = MARKDOWN_CODE_PATTERN.exec(text)
  ) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return spans;
}

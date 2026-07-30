/**
 * Allowlisted Markdown → Telegram entity renderer.
 *
 * Parses a bounded Markdown subset (bold, italic, strike, inline/fenced code,
 * blockquote, safe HTTP(S) links) into visible plain text plus explicit
 * Telegram MessageEntity objects. The model text is never passed through
 * `parse_mode`; all entities are computed locally.
 *
 * Security invariants:
 * - Raw HTML tags are stripped from the visible text.
 * - `tg://`, `javascript:`, credential-bearing and non-HTTP(S) links are
 *   rejected (the link text is kept, the URL is dropped).
 * - Link previews are always disabled by the publisher.
 * - The visible plain text is validated for mentions AFTER Markdown stripping,
 *   closing the `@foo**bar**` → `@foobar` bypass.
 * - Text and entity offsets are cut on UTF-16 boundaries.
 */

export interface TelegramEntity {
  type:
    | "bold"
    | "italic"
    | "strikethrough"
    | "code"
    | "pre"
    | "text_link"
    | "blockquote";
  offset: number;
  length: number;
  url?: string;
}

export interface RichTextRenderResult {
  ok: true;
  text: string;
  entities: readonly TelegramEntity[];
}

export interface RichTextRenderFailure {
  ok: false;
  code: "unsafe_link" | "raw_html" | "empty";
  plainText: string;
}

export type RichTextRenderOutput = RichTextRenderResult | RichTextRenderFailure;

const SAFE_URL_PATTERN = /^https:\/\/[^\s<>"{}|\\^`]+$/iu;
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/gu;
const MAX_ENTITY_COUNT = 256;
const MAX_TEXT_LENGTH = 100_000;

interface InlineNode {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

/**
 * Renders model Markdown into plain text + Telegram entities.
 *
 * Returns a failure with the stripped plain text when unsafe content is
 * detected, so the caller can fall back to plain delivery.
 */
export function renderRichTelegramText(
  markdown: string,
): RichTextRenderOutput {
  if (markdown.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      code: "empty",
      plainText: markdown.slice(0, MAX_TEXT_LENGTH),
    };
  }

  const stripped = stripRawHtml(markdown);
  if (stripped !== markdown && HTML_TAG_PATTERN.test(markdown)) {
    HTML_TAG_PATTERN.lastIndex = 0;
    return {
      ok: false,
      code: "raw_html",
      plainText: stripped,
    };
  }
  HTML_TAG_PATTERN.lastIndex = 0;

  const blocks = splitFencedCode(stripped);
  const allNodes: InlineNode[] = [];
  const blockquoteRanges: Array<{ start: number; end: number }> = [];
  let charCursor = 0;

  for (const block of blocks) {
    if (block.kind === "fenced") {
      allNodes.push({ text: block.content, code: true });
      charCursor += block.content.length;
      continue;
    }
    const lines = block.content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      const isBlockquote = /^>\s?/u.test(line);
      const lineContent = isBlockquote ? line.replace(/^>\s?/u, "") : line;
      const lineStart = charCursor;

      if (lineIndex > 0 || block !== blocks[0]) {
        allNodes.push({ text: "\n" });
        charCursor += 1;
      }

      const inlineNodes = parseInline(lineContent);
      for (const node of inlineNodes) {
        if (node.link !== undefined && !isSafeUrl(node.link)) {
          return {
            ok: false,
            code: "unsafe_link",
            plainText: stripToPlainText(stripped),
          };
        }
        allNodes.push(node);
        charCursor += node.text.length;
      }

      if (isBlockquote) {
        blockquoteRanges.push({
          start: lineStart,
          end: charCursor,
        });
      }
    }
  }

  const text = allNodes.map((node) => node.text).join("");
  if (!text.trim()) {
    return { ok: false, code: "empty", plainText: "" };
  }

  const entities = buildEntities(allNodes, blockquoteRanges);
  if (entities.length > MAX_ENTITY_COUNT) {
    return {
      ok: false,
      code: "raw_html",
      plainText: stripToPlainText(text),
    };
  }

  return { ok: true, text, entities };
}

/**
 * Validates that the visible plain text does not contain unauthorized
 * mentions. This runs AFTER Markdown stripping to close the `@foo**bar**`
 * bypass where a mention only materialises after formatting is removed.
 */
export function visibleTextHasMention(
  text: string,
  allowedUsernames: ReadonlySet<string>,
  maxMentions: number,
): { ok: true; mentions: string[] } | { ok: false; code: "unauthorized_mention" | "mass_mentions"; count?: number } {
  const mentionPattern = /@([A-Za-z0-9_]{3,32})/gu;
  const seen = new Map<string, string>();
  for (
    let match = mentionPattern.exec(text);
    match;
    match = mentionPattern.exec(text)
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

/**
 * Splits text and entities into Telegram-safe chunks respecting UTF-16
 * boundaries and entity offsets. Entities that span a chunk boundary are
 * clipped to the chunk.
 */
export function chunkRichText(
  text: string,
  entities: readonly TelegramEntity[],
  maxUtf16PerChunk: number,
): Array<{ text: string; entities: readonly TelegramEntity[] }> {
  if (utf16Length(text) <= maxUtf16PerChunk) {
    return [{ text, entities }];
  }

  const chunks: Array<{ text: string; entities: readonly TelegramEntity[] }> = [];
  let offset = 0;

  while (offset < text.length) {
    let end = findUtf16Boundary(text, offset, maxUtf16PerChunk);
    if (end <= offset) {
      end = Math.min(offset + maxUtf16PerChunk, text.length);
    }
    // Try to break at a newline for readability.
    const newlineIndex = text.lastIndexOf("\n", end);
    if (newlineIndex > offset + maxUtf16PerChunk / 2) {
      end = newlineIndex + 1;
    }

    const chunkText = text.slice(offset, end);
    const chunkUtf16Start = utf16Length(text.slice(0, offset));
    const chunkUtf16Len = utf16Length(chunkText);
    const chunkEntities = clipEntities(
      entities,
      chunkUtf16Start,
      chunkUtf16Len,
    );
    chunks.push({ text: chunkText, entities: chunkEntities });
    offset = end;
  }

  return chunks;
}

function stripRawHtml(text: string): string {
  return text.replace(HTML_TAG_PATTERN, "");
}

function stripToPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, (match) =>
      match.replace(/^```\w*\n?/u, "").replace(/\n?```$/u, ""),
    )
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/^>\s?/gmu, "")
    .replace(HTML_TAG_PATTERN, "");
}

interface CodeBlock {
  kind: "fenced" | "text";
  content: string;
}

function splitFencedCode(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const fencePattern = /```(\w*)\n([\s\S]*?)```/gu;
  let lastIndex = 0;

  for (
    let match = fencePattern.exec(text);
    match;
    match = fencePattern.exec(text)
  ) {
    if (match.index > lastIndex) {
      blocks.push({
        kind: "text",
        content: text.slice(lastIndex, match.index),
      });
    }
    blocks.push({ kind: "fenced", content: match[2] ?? "" });
    lastIndex = fencePattern.lastIndex;
  }

  if (lastIndex < text.length) {
    blocks.push({ kind: "text", content: text.slice(lastIndex) });
  }

  return blocks.length > 0 ? blocks : [{ kind: "text", content: text }];
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Order matters: bold before italic, code before formatting.
  const pattern =
    /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/gu;
  let lastIndex = 0;

  for (
    let match = pattern.exec(text);
    match;
    match = pattern.exec(text)
  ) {
    if (match.index > lastIndex) {
      nodes.push({ text: text.slice(lastIndex, match.index) });
    }

    if (match[1] !== undefined) {
      nodes.push({ text: match[2] ?? "", bold: true });
    } else if (match[3] !== undefined) {
      nodes.push({ text: match[4] ?? "", italic: true });
    } else if (match[5] !== undefined) {
      nodes.push({ text: match[6] ?? "", strike: true });
    } else if (match[7] !== undefined) {
      nodes.push({ text: match[8] ?? "", code: true });
    } else if (match[9] !== undefined) {
      nodes.push({ text: match[10] ?? "", link: match[11] ?? "" });
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push({ text: text.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ text }];
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(tg|javascript|data|file|ftp):/iu.test(trimmed)) {
    return false;
  }
  if (/[:@]/u.test(trimmed) && !SAFE_URL_PATTERN.test(trimmed)) {
    return false;
  }
  return SAFE_URL_PATTERN.test(trimmed);
}

function buildEntities(
  nodes: readonly InlineNode[],
  blockquoteRanges: ReadonlyArray<{ start: number; end: number }>,
): TelegramEntity[] {
  const entities: TelegramEntity[] = [];
  let utf16Offset = 0;

  for (const node of nodes) {
    const utf16Len = utf16Length(node.text);
    if (utf16Len === 0) {
      continue;
    }

    if (node.code) {
      entities.push({ type: "code", offset: utf16Offset, length: utf16Len });
    } else {
      if (node.bold) {
        entities.push({ type: "bold", offset: utf16Offset, length: utf16Len });
      }
      if (node.italic) {
        entities.push({ type: "italic", offset: utf16Offset, length: utf16Len });
      }
      if (node.strike) {
        entities.push({ type: "strikethrough", offset: utf16Offset, length: utf16Len });
      }
      if (node.link !== undefined) {
        entities.push({
          type: "text_link",
          offset: utf16Offset,
          length: utf16Len,
          url: node.link,
        });
      }
    }

    utf16Offset += utf16Len;
  }

  for (const range of blockquoteRanges) {
    const startUtf16 = utf16Length(
      nodes
        .slice(0, nodeIndexAtUtf16(nodes, range.start))
        .map((n) => n.text)
        .join(""),
    );
    const lenUtf16 = range.end - range.start;
    if (lenUtf16 > 0) {
      entities.push({
        type: "blockquote",
        offset: range.start,
        length: lenUtf16,
      });
    }
  }

  return entities.sort((a, b) => a.offset - b.offset || a.length - b.length);
}

function nodeIndexAtUtf16(
  nodes: readonly InlineNode[],
  _utf16Offset: number,
): number {
  let accumulated = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    accumulated += nodes[i]!.text.length;
    if (accumulated >= _utf16Offset) {
      return i + 1;
    }
  }
  return nodes.length;
}

function clipEntities(
  entities: readonly TelegramEntity[],
  chunkUtf16Start: number,
  chunkUtf16Len: number,
): TelegramEntity[] {
  const chunkEnd = chunkUtf16Start + chunkUtf16Len;
  const result: TelegramEntity[] = [];

  for (const entity of entities) {
    const entityEnd = entity.offset + entity.length;
    if (entityEnd <= chunkUtf16Start || entity.offset >= chunkEnd) {
      continue;
    }
    const clippedStart = Math.max(entity.offset, chunkUtf16Start);
    const clippedEnd = Math.min(entityEnd, chunkEnd);
    const clippedLength = clippedEnd - clippedStart;
    if (clippedLength <= 0) {
      continue;
    }
    result.push({
      ...entity,
      offset: clippedStart - chunkUtf16Start,
      length: clippedLength,
    });
  }

  return result;
}

function utf16Length(text: string): number {
  return text.length;
}

function findUtf16Boundary(
  text: string,
  start: number,
  maxUtf16: number,
): number {
  let end = Math.min(start + maxUtf16, text.length);
  // Do not split a surrogate pair.
  if (end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
  }
  return end;
}

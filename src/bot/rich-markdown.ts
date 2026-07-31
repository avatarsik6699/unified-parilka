/**
 * Bounded Rich Markdown preflight.
 *
 * The final Telegram payload is native Rich Markdown sent via
 * `sendRichMessage`; Telegram is the renderer. This module does not render,
 * serialize arbitrary Markdown. It parses a bounded AST with the supported
 * unified/remark stack and either admits the original Markdown (with the one
 * Telegram-specific table-delimiter canonicalization below) or proves the
 * whole message must go plain.
 */

import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import type { Nodes, Root } from "mdast";

/** Math nodes produced by remark-math are not part of the mdast union. */
type RichAstNode = Nodes | { type: "math" | "inlineMath"; value: string };

export const RICH_MESSAGE_MAX_CODE_POINTS = 32_768;
export const RICH_MESSAGE_MAX_DEPTH = 16;
export const RICH_MESSAGE_MAX_NODES = 2_000;
export const RICH_MESSAGE_MAX_BLOCKS = 500;
export const RICH_MESSAGE_MAX_TABLE_COLUMNS = 20;

export type RichMarkdownPreflightReason =
  | "raw_html"
  | "media"
  | "unsafe_link"
  | "unsupported_syntax"
  | "malformed"
  | "invalid_bounds";

export type RichMarkdownPreflight =
  | { ok: true; markdown: string; plainText: string }
  | {
      ok: false;
      plainText: string;
      reason: RichMarkdownPreflightReason;
    };

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath);

const UNCLOSED_FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})[^\n]*$/u;
const UNCLOSED_FENCE_CLOSE_PATTERN = /^ {0,3}(`+|~+)[ \t]*$/u;
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/gu;

/**
 * Preflights model Markdown for the native rich path.
 *
 * Safe input keeps its original `markdown` except that GFM table delimiter
 * cells shorter than three dashes are widened for Telegram's parser. On any
 * violation the whole message degrades to plain mode; the `plainText`
 * projection is always complete enough for guards, storage and the classic
 * fallback.
 */
export function preflightRichMarkdown(
  markdown: string,
): RichMarkdownPreflight {
  // Do not construct an unbounded mdast tree merely to decide that this input
  // cannot use the native path. Keep the literal source for the classic
  // no-parse-mode fallback.
  if (codePointLengthExceeds(markdown, RICH_MESSAGE_MAX_CODE_POINTS)) {
    return { ok: false, plainText: markdown, reason: "invalid_bounds" };
  }

  let tree: Root;
  try {
    tree = parser.parse(markdown);
  } catch {
    return { ok: false, plainText: markdown, reason: "malformed" };
  }

  const state: WalkState = {
    plainText: "",
    violations: new Set(),
    nodeCount: 0,
    blockCount: 0,
  };
  walkBlocks(tree.children, state, 1);

  const unclosedFence = hasUnclosedFence(markdown);

  const reason = firstViolation(state.violations, unclosedFence);
  if (reason !== undefined) {
    return { ok: false, plainText: state.plainText, reason };
  }
  return {
    ok: true,
    markdown: canonicalizeTelegramTableDelimiters(markdown, tree),
    plainText: state.plainText,
  };
}

interface WalkState {
  plainText: string;
  violations: Set<RichMarkdownPreflightReason>;
  nodeCount: number;
  blockCount: number;
}

function walkBlocks(
  nodes: readonly Nodes[],
  state: WalkState,
  depth: number,
): void {
  for (let index = 0; index < nodes.length; index += 1) {
    if (index > 0) {
      state.plainText += "\n";
    }
    walk(nodes[index]!, state, depth);
  }
}

function walkInline(
  nodes: readonly Nodes[],
  state: WalkState,
  depth: number,
): void {
  for (const node of nodes) {
    walk(node, state, depth);
  }
}

function walk(node: RichAstNode, state: WalkState, depth: number): void {
  state.nodeCount += 1;
  if (depth > RICH_MESSAGE_MAX_DEPTH) {
    state.violations.add("invalid_bounds");
    return;
  }
  if (state.nodeCount > RICH_MESSAGE_MAX_NODES) {
    state.violations.add("invalid_bounds");
    return;
  }
  if (isTelegramRichBlock(node)) {
    countBlock(state);
  }

  switch (node.type) {
    case "text":
      if (hasUnsupportedTelegramOnlySyntax(node.value)) {
        // Telegram Rich Markdown supports marked/spoiler delimiters that the
        // CommonMark/GFM AST intentionally leaves as text. Sending them rich
        // would make the guard validate a different visible string, so this
        // entire answer degrades to literal plain text until such constructs
        // have an exact, separately reviewed projection.
        state.violations.add("unsupported_syntax");
      }
      state.plainText += node.value;
      return;
    case "inlineCode":
    case "code":
    case "inlineMath":
    case "math":
      state.plainText += node.value;
      return;
    case "html":
      state.violations.add("raw_html");
      HTML_TAG_PATTERN.lastIndex = 0;
      state.plainText += node.value.replace(HTML_TAG_PATTERN, "");
      return;
    case "image":
      state.violations.add("media");
      state.plainText += node.alt ?? "";
      return;
    case "imageReference":
      state.violations.add("media");
      state.plainText += `![${node.label ?? node.identifier}]`;
      return;
    case "link":
      if (!isSafeLinkUrl(node.url)) {
        state.violations.add("unsafe_link");
      }
      walkInline(node.children, state, depth + 1);
      return;
    case "definition":
      if (!isSafeLinkUrl(node.url)) {
        state.violations.add("unsafe_link");
      }
      return;
    case "break":
      state.plainText += "\n";
      return;
    case "footnoteReference":
      state.plainText += `[^${node.identifier}]`;
      return;
    case "paragraph":
      walkInline(node.children, state, depth + 1);
      return;
    case "heading":
      walkInline(node.children, state, depth + 1);
      state.plainText += "\n";
      return;
    case "list":
    case "listItem":
    case "blockquote":
    case "footnoteDefinition":
      walkBlocks(node.children, state, depth + 1);
      return;
    case "table":
      walkTable(node, state, depth);
      return;
    case "thematicBreak":
      state.plainText += "───";
      return;
    default:
      if ("children" in node) {
        walkInline(
          (node as { children: readonly Nodes[] }).children,
          state,
          depth + 1,
        );
      }
  }
}

function walkTable(
  table: Extract<Nodes, { type: "table" }>,
  state: WalkState,
  depth: number,
): void {
  const rows = table.children;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    countBlock(state);
    if (rowIndex > 0) {
      state.plainText += "\n";
    }
    const cells = rows[rowIndex]!.children;
    if (cells.length > RICH_MESSAGE_MAX_TABLE_COLUMNS) {
      state.violations.add("invalid_bounds");
    }
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      if (cellIndex > 0) {
        state.plainText += " | ";
      }
      walkInline(cells[cellIndex]!.children, state, depth + 1);
    }
  }
}

function countBlock(state: WalkState): void {
  state.blockCount += 1;
  if (state.blockCount > RICH_MESSAGE_MAX_BLOCKS) {
    state.violations.add("invalid_bounds");
  }
}

function isTelegramRichBlock(node: RichAstNode): boolean {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "code":
    case "math":
    case "thematicBreak":
    case "list":
    case "listItem":
    case "blockquote":
    case "footnoteDefinition":
    case "table":
      return true;
    default:
      return false;
  }
}

function hasUnsupportedTelegramOnlySyntax(text: string): boolean {
  return text.includes("||") || text.includes("==");
}

/**
 * remark-gfm accepts one or two dashes in a table delimiter cell, while the
 * Telegram Rich Markdown parser only renders the table with three or more.
 * The delimiter row has no visible content, so widening it preserves the
 * message semantics and makes valid GFM tables render consistently in
 * Telegram. Only rows that belong to an AST table can be changed; prose and
 * fenced code are never touched.
 */
function canonicalizeTelegramTableDelimiters(source: string, tree: Root): string {
  const tableStartLines = new Set<number>();
  collectTableStartLines(tree, tableStartLines);
  if (tableStartLines.size === 0) {
    return source;
  }

  const lines = source.split("\n");
  for (const headerLine of tableStartLines) {
    const delimiterLineIndex = headerLine;
    const delimiterLine = lines[delimiterLineIndex];
    if (delimiterLine !== undefined) {
      lines[delimiterLineIndex] = canonicalizeTableDelimiterLine(delimiterLine);
    }
  }
  return lines.join("\n");
}

function collectTableStartLines(
  node: { type: string; position?: { start: { line: number } }; children?: unknown },
  tableStartLines: Set<number>,
): void {
  if (node.type === "table" && node.position !== undefined) {
    tableStartLines.add(node.position.start.line);
  }
  if (!Array.isArray(node.children)) {
    return;
  }
  for (const child of node.children) {
    if (
      typeof child === "object" &&
      child !== null &&
      "type" in child
    ) {
      collectTableStartLines(
        child as {
          type: string;
          position?: { start: { line: number } };
          children?: unknown;
        },
        tableStartLines,
      );
    }
  }
}

function canonicalizeTableDelimiterLine(line: string): string {
  return line
    .split("|")
    .map((cell) => {
      const match = /^(?<before>[ \t]*:?-{1,2})(?<after>:?[ \t]*\r?)$/u.exec(
        cell,
      );
      if (!match?.groups) {
        return cell;
      }

      const before = match.groups.before;
      const dashCount = before.match(/-+/u)?.[0].length ?? 0;
      return `${before.replace(/-+/u, "-".repeat(Math.max(3, dashCount)))}${match.groups.after}`;
    })
    .join("|");
}

function codePointLengthExceeds(text: string, limit: number): boolean {
  let count = 0;
  for (const _ of text) {
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  return false;
}

/**
 * CommonMark only closes a fenced code block with a matching fence line.
 * An unterminated fence is not a valid rich publication even though the AST
 * treats the remainder as one code node, so it is detected explicitly.
 */
function hasUnclosedFence(source: string): boolean {
  let fenceChar = "";
  let fenceLength = 0;
  for (const line of source.split("\n")) {
    if (fenceChar === "") {
      const match = UNCLOSED_FENCE_OPEN_PATTERN.exec(line);
      if (match) {
        fenceChar = match[1]![0]!;
        fenceLength = match[1]!.length;
      }
    } else {
      const match = UNCLOSED_FENCE_CLOSE_PATTERN.exec(line);
      if (
        match &&
        match[1]![0] === fenceChar &&
        match[1]!.length >= fenceLength
      ) {
        fenceChar = "";
      }
    }
  }
  return fenceChar !== "";
}

function isSafeLinkUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

function firstViolation(
  violations: ReadonlySet<RichMarkdownPreflightReason>,
  unclosedFence: boolean,
): RichMarkdownPreflightReason | undefined {
  for (const reason of [
    "raw_html",
    "media",
    "unsafe_link",
    "unsupported_syntax",
  ] as const) {
    if (violations.has(reason)) {
      return reason;
    }
  }
  if (unclosedFence) {
    return "malformed";
  }
  if (violations.has("invalid_bounds")) {
    return "invalid_bounds";
  }
  return undefined;
}

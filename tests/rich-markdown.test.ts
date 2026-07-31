import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RICH_MESSAGE_MAX_BLOCKS,
  RICH_MESSAGE_MAX_CODE_POINTS,
  preflightRichMarkdown,
  type RichMarkdownPreflight,
} from "../src/bot/rich-markdown.js";

const SCREENSHOT_MARKDOWN = [
  "| Метрика | Значение |",
  "| --- | --- |",
  "| Инлайн | $E = mc^2$ |",
  "",
  "Блок:",
  "$$\\int_a^b f(x)\\,dx$$",
].join("\n");

test("screenshot fixture stays byte-for-byte and projects full visible text", () => {
  const result = preflightRichMarkdown(SCREENSHOT_MARKDOWN);
  assert.equal(result.ok, true, `expected rich: ${JSON.stringify(result)}`);
  if (!result.ok) {
    return;
  }
  assert.equal(result.markdown, SCREENSHOT_MARKDOWN);
  assert.match(result.plainText, /Метрика/);
  assert.match(result.plainText, /Значение/);
  assert.match(result.plainText, /Инлайн/);
  assert.match(result.plainText, /E = mc\^2/);
  assert.match(result.plainText, /\\int_a\^b f\(x\)\\,dx/);
});

test("short GFM table delimiters are canonicalized for Telegram", () => {
  const markdown = [
    "| Язык | Год |",
    "| :-- | --: |",
    "| Python | 1991 |",
  ].join("\n");
  const result = preflightRichMarkdown(markdown);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) {
    return;
  }
  assert.equal(
    result.markdown,
    [
      "| Язык | Год |",
      "| :--- | ---: |",
      "| Python | 1991 |",
    ].join("\n"),
  );
  assert.equal(result.plainText, "Язык | Год\nPython | 1991");
});

test("short delimiters in fenced code are never rewritten", () => {
  const markdown = [
    "\`\`\`text",
    "| Язык | Год |",
    "| :-- | --: |",
    "\`\`\`",
  ].join("\n");
  const result = preflightRichMarkdown(markdown);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.markdown, markdown);
  }
});

test("safe https links keep their visible text and the suffix", () => {
  const result = preflightRichMarkdown("до [клик](https://example.com) после");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plainText, "до клик после");
  }
});

test("suffix after an unsafe link is not lost in the plain projection", () => {
  const result = preflightRichMarkdown("до [клик](tg://user?id=1) после");
  assertPlain(result, "unsafe_link");
  assert.equal(result.plainText, "до клик после");
});

test("non-HTTPS schemes and URL credentials are rejected", () => {
  const unsafe = [
    "[x](tg://user?id=1)",
    "[x](mailto:user@example.com)",
    "[x](tel:+123456789)",
    "[x](javascript:alert(1))",
    "[x](data:text/html,hi)",
    "[x](http://example.com)",
    "[x](https://user:pass@example.com)",
    "<tg://user?id=1>",
    "[x][1]\n\n[1]: https://user:pass@example.com",
    "[x][1]\n\n[1]: tg://user?id=1",
  ];
  for (const markdown of unsafe) {
    assertPlain(preflightRichMarkdown(markdown), "unsafe_link", markdown);
  }
});

test("raw html forces whole-message plain mode without losing text", () => {
  const result = preflightRichMarkdown("<b>жирный</b>");
  assertPlain(result, "raw_html");
  assert.equal(result.plainText, "жирный");
  const script = preflightRichMarkdown("<script>alert(1)</script>");
  assertPlain(script, "raw_html");
  assert.equal(script.plainText, "alert(1)");
});

test("image/media markdown forces whole-message plain mode", () => {
  const result = preflightRichMarkdown("смотри ![alt](https://example.com/i.png)");
  assertPlain(result, "media");
  assert.match(result.plainText, /смотри/);
  assert.match(result.plainText, /alt/);
});

test("multiplication is not mistaken for emphasis", () => {
  const result = preflightRichMarkdown("2 * 3 * 4");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plainText, "2 * 3 * 4");
  }
});

test("adjacent strong-emph runs do not style the gap between them", () => {
  const result = preflightRichMarkdown("***a*** and ***b***");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plainText, "a and b");
  }
});

test("list items are projected once and never duplicated", () => {
  const rich = preflightRichMarkdown("* один\n* два");
  assert.equal(rich.ok, true);
  if (rich.ok) {
    assert.equal(rich.plainText, "один\nдва");
  }
  const plain = preflightRichMarkdown("* один\n* [два](tg://user?id=2)");
  assertPlain(plain, "unsafe_link");
  assert.equal(count(plain.plainText, "один"), 1);
  assert.equal(count(plain.plainText, "два"), 1);
});

test("unterminated fence is not a valid rich publication", () => {
  assertPlain(
    preflightRichMarkdown("```ts\nconst x = 1;"),
    "malformed",
  );
  assertPlain(
    preflightRichMarkdown("~~~py\nprint(1)"),
    "malformed",
  );
  const closed = preflightRichMarkdown("```ts\nconst x = 1;\n```");
  assert.equal(closed.ok, true);
});

test("Telegram-only marked and spoiler syntax degrades before it can alter visible mentions", () => {
  for (const markdown of ["@al||ice||", "@al==ice=="]) {
    const result = preflightRichMarkdown(markdown);
    assertPlain(result, "unsupported_syntax", markdown);
    assert.equal(result.plainText, markdown);
  }

  const code = preflightRichMarkdown("```ts\nif (a == b) return true;\n```");
  assert.equal(code.ok, true);
});

test("rich message limits fall back to whole-message plain mode", () => {
  const tooLong = preflightRichMarkdown(
    "x".repeat(RICH_MESSAGE_MAX_CODE_POINTS + 1),
  );
  assertPlain(tooLong, "invalid_bounds");
  assert.equal(tooLong.plainText.length, RICH_MESSAGE_MAX_CODE_POINTS + 1);

  const deepNesting = preflightRichMarkdown(
    `${"*".repeat(30)}x${"*".repeat(30)}`,
  );
  assertPlain(deepNesting, "invalid_bounds");

  const wideTable = [
    "| " + Array.from({ length: 21 }, (_, i) => `c${i}`).join(" | ") + " |",
    "| " + Array.from({ length: 21 }, () => "---").join(" | ") + " |",
  ].join("\n");
  assertPlain(preflightRichMarkdown(wideTable), "invalid_bounds");

  const blockOverflow = Array.from(
    { length: RICH_MESSAGE_MAX_BLOCKS + 1 },
    (_, index) => `абзац ${index + 1}`,
  ).join("\n\n");
  assertPlain(preflightRichMarkdown(blockOverflow), "invalid_bounds");
});

test("native rich constructs pass the preflight", () => {
  const markdown = [
    "# Заголовок",
    "",
    "1. один",
    "2. два",
    "",
    "- [ ] задача",
    "- [x] сделано",
    "",
    "> цитата",
    "> продолжение",
    "",
    "```python",
    "print(1)",
    "```",
    "",
    "~~зачёркнуто~~",
    "---",
  ].join("\n");
  const result = preflightRichMarkdown(markdown);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.markdown, markdown);
    assert.match(result.plainText, /Заголовок/);
    assert.match(result.plainText, /один\nдва/);
    assert.match(result.plainText, /задача\nсделано/);
    assert.match(result.plainText, /цитата\nпродолжение/);
    assert.match(result.plainText, /print\(1\)/);
    assert.match(result.plainText, /зачёркнуто/);
  }
});

test("empty and whitespace-only input is a safe rich no-op", () => {
  const empty = preflightRichMarkdown("");
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.plainText, "");
  }
  const whitespace = preflightRichMarkdown("   ");
  assert.equal(whitespace.ok, true);
});

function assertPlain(
  result: RichMarkdownPreflight,
  reason: Exclude<RichMarkdownPreflight, { ok: true }>["reason"],
  input?: string,
): asserts result is Extract<RichMarkdownPreflight, { ok: false }> {
  assert.equal(result.ok, false, `expected plain mode: ${input ?? ""}`);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, reason, `unexpected reason for ${input ?? ""}`);
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

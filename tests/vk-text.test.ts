import assert from "node:assert/strict";
import { test } from "node:test";
import { renderVkPlainText } from "../src/bot/runtime/vk-text.js";

test("strips headings, keeping the text", () => {
  assert.equal(renderVkPlainText("# Заголовок\nтекст"), "Заголовок\nтекст");
  assert.equal(renderVkPlainText("### H3"), "H3");
});

test("strips bold and italic markers", () => {
  assert.equal(renderVkPlainText("**жирный**"), "жирный");
  assert.equal(renderVkPlainText("__жирный__"), "жирный");
  assert.equal(renderVkPlainText("*курсив*"), "курсив");
  assert.equal(renderVkPlainText("_курсив_"), "курсив");
});

test("strips strikethrough", () => {
  assert.equal(renderVkPlainText("~~зачёркнутый~~"), "зачёркнутый");
});

test("strips inline code backticks", () => {
  assert.equal(renderVkPlainText("вызови `функцию()`"), "вызови функцию()");
});

test("strips fenced code block markers but keeps the code content", () => {
  const input = ["```js", "const x = 1;", "console.log(x);", "```"].join("\n");
  assert.equal(renderVkPlainText(input), "const x = 1;\nconsole.log(x);");
});

test("strips blockquote markers", () => {
  assert.equal(renderVkPlainText("> цитата"), "цитата");
});

test("drops standalone horizontal rule lines", () => {
  assert.equal(renderVkPlainText("до\n---\nпосле"), "до\nпосле");
  assert.equal(renderVkPlainText("до\n***\nпосле"), "до\nпосле");
});

test("converts a markdown link to text plus a bare URL", () => {
  assert.equal(
    renderVkPlainText("см. [документацию](https://example.com/docs)"),
    "см. документацию (https://example.com/docs)",
  );
});

test("strips $$ block-math delimiters, leaving the inner text visible", () => {
  assert.equal(renderVkPlainText("$$E = mc^2$$"), "E = mc^2");
});

test("leaves list bullets and ordinary text untouched", () => {
  const input = "- один\n- два\n1. первый";
  assert.equal(renderVkPlainText(input), input);
});

test("strips the wide-table fallback's forced bold ordinal markers", () => {
  const input = "**1.**\n- Имя: Алиса\n- Роль: admin";
  assert.equal(renderVkPlainText(input), "1.\n- Имя: Алиса\n- Роль: admin");
});

test("handles bold wrapping an italic span in one pass", () => {
  assert.equal(
    renderVkPlainText("**жирный _курсив_ текст**"),
    "жирный курсив текст",
  );
});

test("leaves plain text with no markdown syntax unchanged", () => {
  assert.equal(
    renderVkPlainText("обычное сообщение без разметки"),
    "обычное сообщение без разметки",
  );
});

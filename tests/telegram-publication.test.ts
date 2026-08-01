import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTelegramPublication,
  TELEGRAM_RICH_TEXT_LIMIT_UTF8,
  utf8Length,
} from "../src/bot/telegram-publication.js";

test("keeps a long model reply on the native rich path", () => {
  const text = `# Заголовок\n\n${"длинный абзац ".repeat(500)}`;
  const publication = createTelegramPublication(text);

  assert.ok(utf8Length(text) > 4_096);
  assert.ok(utf8Length(text) <= TELEGRAM_RICH_TEXT_LIMIT_UTF8);
  assert.equal(publication.mode, "rich");
  assert.equal(publication.markdown, text);
});

test("uses classic plain fallback only beyond the rich-message limit", () => {
  const text = "x".repeat(TELEGRAM_RICH_TEXT_LIMIT_UTF8 + 1);
  const publication = createTelegramPublication(text);

  assert.equal(publication.mode, "plain");
  assert.equal(publication.plainText, text);
});

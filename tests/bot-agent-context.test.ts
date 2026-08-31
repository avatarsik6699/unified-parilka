import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTurnMessages } from "../src/bot/agent/context.js";
import { request, storedMessage } from "./support/ai-agent.js";

function textOf(messages: ReturnType<typeof buildTurnMessages>): string {
  const [first] = messages;
  assert.ok(first && typeof first.content === "string");
  return first.content as string;
}

function rowsOf(content: string): Record<string, unknown>[] {
  const match = /<CHAT_DATA_[^>]+>\n([\s\S]*)\n<\/CHAT_DATA_/u.exec(content);
  assert.ok(match, "expected the NDJSON envelope");
  return match![1]!
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test("a reply target outside the recent window is still included and tagged", () => {
  const trigger = storedMessage(200, "а что там было?", "42", "Коля");
  const replyTarget = storedMessage(
    5,
    "старое сообщение вне окна",
    "99",
    "Аня",
  );
  // Ordinary window never includes the old reply target.
  const context = [
    storedMessage(198, "недавняя реплика", "77", "Лена"),
    trigger,
  ];

  const messages = buildTurnMessages(
    request({ trigger, replyTarget, context }),
    "fixed_nonce",
    8_000,
  );

  const rows = rowsOf(textOf(messages));
  const replyRow = rows.find((row) => row.messageId === 5);
  assert.ok(
    replyRow,
    "reply target must be present even though it is outside the window",
  );
  assert.equal(replyRow!.replyTarget, true);
  assert.equal(replyRow!.text, "старое сообщение вне окна");
  const triggerRow = rows.find((row) => row.messageId === 200);
  assert.ok(triggerRow);
  assert.equal(triggerRow!.target, true);
});

test("rows are joined in chronological order even though trigger/reply-target render first", () => {
  const trigger = storedMessage(200, "а что там было?", "42", "Коля");
  const replyTarget = storedMessage(5, "старое сообщение", "99", "Аня");
  const context = [
    storedMessage(150, "средняя реплика", "77", "Лена"),
    trigger,
  ];

  const messages = buildTurnMessages(
    request({ trigger, replyTarget, context }),
    "fixed_nonce",
    8_000,
  );

  const rows = rowsOf(textOf(messages));
  const ids = rows.map((row) => row.messageId);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => (a as number) - (b as number)),
  );
});

test("no reply target means no replyTarget:true row and unchanged trigger-only behavior", () => {
  const trigger = storedMessage(200, "обычный вопрос", "42", "Коля");
  const context = [storedMessage(198, "контекст", "77", "Лена"), trigger];

  const messages = buildTurnMessages(
    request({ trigger, context }),
    "fixed_nonce",
    8_000,
  );

  const rows = rowsOf(textOf(messages));
  assert.equal(
    rows.some((row) => row.replyTarget === true),
    false,
  );
  assert.equal(rows.find((row) => row.messageId === 200)?.target, true);
});

test("an oversized reply-target is truncated to fit instead of being dropped", () => {
  const trigger = storedMessage(200, "а что там было?", "42", "Коля");
  const replyTarget = storedMessage(5, "р".repeat(5_000), "99", "Аня");
  const context = [trigger];

  // A budget comfortable for the short trigger but far too small for the
  // reply-target's full text -- it must still appear, truncated, rather
  // than silently vanish the way an ordinary out-of-budget window row would.
  const messages = buildTurnMessages(
    request({ trigger, replyTarget, context }),
    "fixed_nonce",
    2_000,
  );

  const rows = rowsOf(textOf(messages));
  assert.ok(rows.find((row) => row.messageId === 200 && row.target === true));
  const replyRow = rows.find(
    (row) => row.messageId === 5 && row.replyTarget === true,
  );
  assert.ok(replyRow, "truncated reply-target row must still be present");
  assert.ok((replyRow!.text as string).length < 5_000);
});

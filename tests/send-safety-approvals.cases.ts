import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FakeTelegram,
  callTool,
  makeTools,
} from "./send-safety-fixtures.js";

test("hard dry-run mode cannot be bypassed with dry_run:false", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, { safety: { dryRunDefault: true } });

  const result = await callTool(tools, "send_message", {
    text: "safe preview only",
    dry_run: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.hard_dry_run, true);
  assert.equal(telegram.sends.length, 0);
});

test("hard dry-run wins over approval bypass", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, {
    safety: {
      sendEnabled: true,
      dryRunDefault: true,
      liveSendApprovalBypass: true,
    },
  });

  const result = await callTool(tools, "send_message", {
    text: "bypass still previews",
    dry_run: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.hard_dry_run, true);
  assert.equal(result.send_enabled, true);
  assert.equal(telegram.sends.length, 0);
});

test("send disabled wins over approval bypass", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram, {
    safety: {
      sendEnabled: false,
      dryRunDefault: false,
      liveSendApprovalBypass: true,
    },
  });

  const result = await callTool(tools, "send_message", {
    text: "disabled send stays dry",
    dry_run: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.hard_dry_run, true);
  assert.equal(result.send_enabled, false);
  assert.equal(telegram.sends.length, 0);
});

test("live send rejects without an approval id", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);

  const result = await callTool(tools, "send_message", {
    text: "needs approval",
    dry_run: false,
  });

  assert.equal(result.ok, false);
  assert.equal((result.error as { category: string }).category, "permission");
  assert.match((result.error as { message: string }).message, /approval_id/);
  assert.equal(telegram.sends.length, 0);
});

test("live send rejects when approval metadata does not match", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);
  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "approved text",
    reply_to_message_id: 10,
  });

  assert.equal(preview.ok, true);
  assert.equal(typeof preview.approval_id, "string");

  const mismatchedText = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "changed text",
    reply_to_message_id: 10,
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedText.ok, false);

  const mismatchedChat = await callTool(tools, "send_message", {
    chat: "-1002",
    text: "approved text",
    reply_to_message_id: 10,
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedChat.ok, false);

  const mismatchedReply = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "approved text",
    reply_to_message_id: 11,
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedReply.ok, false);
  assert.equal(telegram.sends.length, 0);
});

test("preview and dry-run include validated reply target metadata", async () => {
  const telegram = new FakeTelegram();
  telegram.replyTexts.set(44, "reply target excerpt");
  const { tools } = makeTools(telegram);

  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "reply with context",
    reply_to_message_id: 44,
  });

  assert.equal(preview.ok, true);
  assert.deepEqual(preview.reply_target, {
    message_id: 44,
    source: "live",
    date: "2023-11-14T22:13:20.000Z",
    sender_id: "42",
    sender_name: "reply_author",
    text_excerpt: "reply target excerpt",
  });
  assert.equal(telegram.getMessageCalls.length, 1);

  const dryRun = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "reply with context",
    reply_to_message_id: 44,
    dry_run: true,
  });

  assert.equal(dryRun.ok, true);
  assert.deepEqual(dryRun.reply_target, {
    message_id: 44,
    source: "cache",
    date: "2023-11-14T22:13:20.000Z",
    sender_id: "42",
    sender_name: "reply_author",
    text_excerpt: "reply target excerpt",
  });
  assert.equal(telegram.getMessageCalls.length, 1);
  assert.equal(telegram.sends.length, 0);
});

test("preview rejects missing reply targets before issuing approval", async () => {
  const telegram = new FakeTelegram();
  telegram.missingMessageIds.add(404);
  const { tools } = makeTools(telegram);

  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "cannot approve missing reply",
    reply_to_message_id: 404,
  });

  assert.equal(preview.ok, false);
  assert.equal((preview.error as { category: string }).category, "reply");
  assert.equal(preview.approval_id, undefined);
  assert.equal(telegram.sends.length, 0);
});

test("invalid reply target fails before approval consumption and outbox reservation", async () => {
  const telegram = new FakeTelegram();
  const { tools, store } = makeTools(telegram, {
    throttle: { userCooldownMs: 60_000 },
  });
  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "reply after validation",
    reply_to_message_id: 77,
  });

  assert.equal(preview.ok, true);
  assert.equal(store.markMessagesDeleted("-1001", [77]), 1);

  const failed = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "reply after validation",
    reply_to_message_id: 77,
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "reply/deleted-target",
  });

  assert.equal(failed.ok, false);
  assert.equal((failed.error as { category: string }).category, "reply");
  assert.equal(store.getSendOutboxByDedupeKey("reply/deleted-target"), undefined);
  assert.equal(telegram.sends.length, 0);

  store.upsertMessages(
    { chatId: "-1001", requested: "-1001", kind: "Fake" },
    [{ chatId: "-1001", messageId: 77, senderName: "restored", text: "restored target" }],
  );
  const sent = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "reply after validation",
    reply_to_message_id: 77,
    dry_run: false,
    approval_id: preview.approval_id,
    dedupe_key: "reply/deleted-target",
  });

  assert.equal(sent.ok, true);
  assert.equal(telegram.sends.length, 1);
  assert.equal(telegram.sends[0]?.replyToMessageId, 77);
});

test("reply_to_message enforces approval lifecycle and admin bypass", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);

  const noApproval = await callTool(tools, "reply_to_message", {
    message_id: 10,
    text: "reply lifecycle",
    dry_run: false,
  });
  assert.equal(noApproval.ok, false);
  assert.equal((noApproval.error as { category: string }).category, "permission");

  const preview = await callTool(tools, "preview_message", {
    text: "reply lifecycle",
    reply_to_message_id: 10,
  });
  const mismatchedReply = await callTool(tools, "reply_to_message", {
    message_id: 11,
    text: "reply lifecycle",
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(mismatchedReply.ok, false);
  assert.equal((mismatchedReply.error as { category: string }).category, "permission");

  const sent = await callTool(tools, "reply_to_message", {
    message_id: 10,
    text: "reply lifecycle",
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(sent.ok, true);

  const replay = await callTool(tools, "reply_to_message", {
    message_id: 10,
    text: "reply lifecycle",
    dry_run: false,
    approval_id: preview.approval_id,
  });
  assert.equal(replay.ok, false);
  assert.equal((replay.error as { category: string }).category, "permission");
  assert.equal(telegram.sends.length, 1);

  const expiredTelegram = new FakeTelegram();
  const { tools: expiredTools } = makeTools(expiredTelegram, {
    safety: { liveSendApprovalTtlMs: 1 },
  });
  const expiredPreview = await callTool(expiredTools, "preview_message", {
    text: "expired reply",
    reply_to_message_id: 12,
  });
  await sleep(5);
  const expired = await callTool(expiredTools, "reply_to_message", {
    message_id: 12,
    text: "expired reply",
    dry_run: false,
    approval_id: expiredPreview.approval_id,
  });
  assert.equal(expired.ok, false);
  assert.equal((expired.error as { category: string }).category, "permission");
  assert.equal(expiredTelegram.sends.length, 0);

  const bypassTelegram = new FakeTelegram();
  const { tools: bypassTools } = makeTools(bypassTelegram, {
    safety: { liveSendApprovalBypass: true },
  });
  const bypass = await callTool(bypassTools, "reply_to_message", {
    message_id: 13,
    text: "bypassed reply approval",
    dry_run: false,
  });
  assert.equal(bypass.ok, true);
  assert.equal(bypassTelegram.sends.length, 1);
});

test("approved live send posts once and consumes the approval", async () => {
  const telegram = new FakeTelegram();
  const { tools } = makeTools(telegram);
  const preview = await callTool(tools, "preview_message", {
    chat: "-1001",
    text: "ship it",
    parse_mode: "html",
    link_preview: false,
    silent: true,
  });

  const sent = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "ship it",
    parse_mode: "html",
    link_preview: false,
    silent: true,
    dry_run: false,
    approval_id: preview.approval_id,
  });

  assert.equal(sent.ok, true);
  assert.equal(sent.dry_run, false);
  assert.deepEqual(sent.sent, {
    id: 9001,
    chat: {
      chatId: "-1001",
      requested: "-1001",
      kind: "Fake",
    },
  });

  const replay = await callTool(tools, "send_message", {
    chat: "-1001",
    text: "ship it",
    parse_mode: "html",
    link_preview: false,
    silent: true,
    dry_run: false,
    approval_id: preview.approval_id,
  });

  assert.equal(replay.ok, false);
  assert.equal(telegram.sends.length, 1);
});


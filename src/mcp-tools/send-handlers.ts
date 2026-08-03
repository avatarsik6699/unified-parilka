import { z } from "zod";
import { ok, ToolError } from "../errors.js";
import type { StoredMessage } from "../store.js";
import { telegramMessageToStored } from "../telegram/message-converter.js";
import type { ChatInfo } from "../telegram/types.js";
import {
  chatSchema,
  type TelegramToolContext,
} from "./contracts.js";
import {
  approvalPayload,
  sendPayloadHash,
} from "./send-approval.js";
import { throwIfToolAborted } from "./response.js";

const SERVER_SEND_USER_KEY = "mcp-server";
const REPLY_TARGET_EXCERPT_CHARS = 240;

type ReplyTargetMetadata = {
  message_id: number;
  source: "cache" | "live";
  date?: string;
  sender_id?: string;
  sender_name?: string;
  text_excerpt?: string;
};

export async function previewMessage(
  context: TelegramToolContext,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      text: z.string().min(1),
      parse_mode: z
        .enum(["none", "html", "markdown"])
        .default("none"),
      reply_to_message_id: z
        .number()
        .int()
        .positive()
        .optional(),
      link_preview: z.boolean().optional(),
      silent: z.boolean().optional(),
    })
    .strict()
    .parse(rawArgs ?? {});
  throwIfToolAborted(signal);
  const resolved = await context.telegram.resolveChat(args.chat);
  throwIfToolAborted(signal);
  context.store.upsertChat(resolved.info);
  const warnings = validateSendText(
    args.text,
    context.config.safety.maxSendChars,
  );
  const replyTarget = await preflightReplyTarget(
    context,
    resolved.info,
    args.reply_to_message_id,
    signal,
  );
  throwIfToolAborted(signal);
  const approval = context.approvals.create(
    approvalPayload({
      chatId: resolved.info.chatId,
      text: args.text,
      parseMode: args.parse_mode,
      replyToMessageId: args.reply_to_message_id,
      linkPreview: args.link_preview,
      silent: args.silent,
    }),
  );
  return ok({
    dry_run: true,
    chat: resolved.info,
    approval_id: approval.id,
    approval_expires_at: new Date(
      approval.expiresAt,
    ).toISOString(),
    text_chars: args.text.length,
    utf8_bytes: Buffer.byteLength(args.text, "utf8"),
    parse_mode: args.parse_mode,
    reply_to_message_id: args.reply_to_message_id,
    reply_target: replyTarget,
    link_preview: args.link_preview,
    silent: args.silent,
    warnings,
  });
}

export async function sendMessage(
  context: TelegramToolContext,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      text: z.string().min(1),
      parse_mode: z
        .enum(["none", "html", "markdown"])
        .default("none"),
      reply_to_message_id: z
        .number()
        .int()
        .positive()
        .optional(),
      link_preview: z.boolean().optional(),
      silent: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      approval_id: z.string().optional(),
      dedupe_key: z.string().max(256).optional(),
    })
    .strict()
    .parse(rawArgs ?? {});
  throwIfToolAborted(signal);
  const resolved = await context.telegram.resolveChat(args.chat);
  throwIfToolAborted(signal);
  context.store.upsertChat(resolved.info);
  const warnings = validateSendText(
    args.text,
    context.config.safety.maxSendChars,
  );
  if (
    warnings.some((warning) => warning.severity === "error")
  ) {
    throw new ToolError({
      category: "formatting",
      retryable: false,
      message: warnings
        .map((warning) => warning.message)
        .join("; "),
    });
  }
  const replyTarget = await preflightReplyTarget(
    context,
    resolved.info,
    args.reply_to_message_id,
    signal,
  );

  const hardDryRun =
    context.config.safety.dryRunDefault ||
    !context.config.safety.sendEnabled;
  throwIfToolAborted(signal);
  const dryRun = hardDryRun || args.dry_run === true;
  if (dryRun) {
    return ok({
      dry_run: true,
      hard_dry_run: hardDryRun,
      send_enabled: context.config.safety.sendEnabled,
      chat: resolved.info,
      reply_to_message_id: args.reply_to_message_id,
      reply_target: replyTarget,
      text_chars: args.text.length,
      utf8_bytes: Buffer.byteLength(args.text, "utf8"),
      warnings,
    });
  }

  const payload = approvalPayload({
    chatId: resolved.info.chatId,
    text: args.text,
    parseMode: args.parse_mode,
    replyToMessageId: args.reply_to_message_id,
    linkPreview: args.link_preview,
    silent: args.silent,
  });
  if (!context.config.safety.liveSendApprovalBypass) {
    context.approvals.consume(args.approval_id, payload);
  }

  const sent = await context.throttler.run({
    chatId: resolved.info.chatId,
    dedupeKey: args.dedupe_key,
    payloadHash: sendPayloadHash(payload),
    replyToMessageId: args.reply_to_message_id,
    userKey: SERVER_SEND_USER_KEY,
    action: () => {
      throwIfToolAborted(signal);
      return context.telegram.sendMessage({
        chat: resolved.info.chatId,
        text: args.text,
        replyToMessageId: args.reply_to_message_id,
        parseMode: args.parse_mode,
        linkPreview: args.link_preview,
        silent: args.silent,
      });
    },
  });
  return ok({ dry_run: false, sent, warnings });
}

export async function replyToMessage(
  context: TelegramToolContext,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const args = chatSchema
    .extend({
      message_id: z.number().int().positive(),
      text: z.string().min(1),
      parse_mode: z
        .enum(["none", "html", "markdown"])
        .default("none"),
      link_preview: z.boolean().optional(),
      silent: z.boolean().optional(),
      dry_run: z.boolean().optional(),
      approval_id: z.string().optional(),
      dedupe_key: z.string().max(256).optional(),
    })
    .strict()
    .parse(rawArgs ?? {});
  throwIfToolAborted(signal);
  return sendMessage(context, {
    chat: args.chat,
    text: args.text,
    parse_mode: args.parse_mode,
    reply_to_message_id: args.message_id,
    link_preview: args.link_preview,
    silent: args.silent,
    dry_run: args.dry_run,
    approval_id: args.approval_id,
    dedupe_key: args.dedupe_key,
  }, signal);
}

async function preflightReplyTarget(
  context: TelegramToolContext,
  chat: ChatInfo,
  replyToMessageId: number | undefined,
  signal?: AbortSignal,
): Promise<ReplyTargetMetadata | undefined> {
  throwIfToolAborted(signal);
  if (replyToMessageId == null) {
    return undefined;
  }

  const cached = context.store.getMessagesByIds({
    chatId: chat.chatId,
    messageIds: [replyToMessageId],
  })[0];
  if (cached) {
    if (cached.deletedAt) {
      throw replyTargetError(
        chat.chatId,
        replyToMessageId,
        "Reply target is deleted in the local cache.",
      );
    }
    return replyTargetMetadata(cached, "cache");
  }

  const live = await context.telegram.getMessages({
    chat: chat.chatId,
    ids: replyToMessageId,
    limit: 1,
  });
  throwIfToolAborted(signal);
  context.store.upsertChat(live.chat);
  const liveMessage = live.messages.find(
    (message) => message.messageId === replyToMessageId,
  );
  const stored =
    liveMessage == null
      ? undefined
      : telegramMessageToStored(live.chat, liveMessage);
  if (!stored || stored.messageId !== replyToMessageId) {
    throw replyTargetError(
      chat.chatId,
      replyToMessageId,
      "Reply target was not found by a bounded Telegram lookup.",
    );
  }

  context.store.upsertMessages(live.chat, [stored]);
  return replyTargetMetadata(stored, "live");
}

function validateSendText(
  text: string,
  maxChars: number,
): Array<{
  severity: "warning" | "error";
  message: string;
}> {
  const warnings: Array<{
    severity: "warning" | "error";
    message: string;
  }> = [];
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.length > maxChars) {
    warnings.push({
      severity: "error",
      message: `Message has ${text.length} chars; max is ${maxChars}.`,
    });
  }
  if (bytes > 35_000) {
    warnings.push({
      severity: "error",
      message: `Message has ${bytes} UTF-8 bytes; keep below 35000.`,
    });
  }
  if (text.includes("**")) {
    warnings.push({
      severity: "warning",
      message:
        "Telegram Markdown can render ** literally; prefer parse_mode html.",
    });
  }
  return warnings;
}

function replyTargetMetadata(
  message: StoredMessage,
  source: "cache" | "live",
): ReplyTargetMetadata {
  const trimmedText = message.text.trim();
  return {
    message_id: message.messageId,
    source,
    date: message.date,
    sender_id: message.senderId,
    sender_name: message.senderName,
    text_excerpt: trimmedText
      ? truncateReplyExcerpt(trimmedText)
      : undefined,
  };
}

function truncateReplyExcerpt(text: string): string {
  if (text.length <= REPLY_TARGET_EXCERPT_CHARS) {
    return text;
  }
  return `${text.slice(
    0,
    REPLY_TARGET_EXCERPT_CHARS - 3,
  )}...`;
}

function replyTargetError(
  chatId: string,
  replyToMessageId: number,
  detail: string,
): ToolError {
  return new ToolError({
    category: "reply",
    retryable: false,
    message: `Invalid reply target ${replyToMessageId} in chat ${chatId}. ${detail}`,
  });
}

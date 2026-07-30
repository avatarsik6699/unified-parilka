import { createHash, randomUUID } from "node:crypto";
import { ToolError } from "../errors.js";

export type SendApprovalPayload = {
  chatId: string;
  textHash: string;
  replyToMessageId: number | null;
  parseMode: "none" | "html" | "markdown";
  linkPreview: boolean | null;
  silent: boolean | null;
};

type SendApproval = SendApprovalPayload & {
  id: string;
  expiresAt: number;
};

export class SendApprovalRegistry {
  private readonly approvals = new Map<string, SendApproval>();

  constructor(private readonly ttlMs: number) {}

  create(payload: SendApprovalPayload): SendApproval {
    const now = Date.now();
    this.gc(now);
    const approval = {
      ...payload,
      id: randomUUID(),
      expiresAt: now + this.ttlMs,
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  consume(
    id: string | undefined,
    payload: SendApprovalPayload,
  ): void {
    const now = Date.now();
    this.gc(now);
    if (!id) {
      throw approvalError(
        "Live send requires approval_id from preview_message.",
      );
    }
    const approval = this.approvals.get(id);
    if (!approval) {
      throw approvalError(
        "Live send approval was not found, expired, or already consumed.",
      );
    }
    if (approval.expiresAt <= now) {
      this.approvals.delete(id);
      throw approvalError(
        "Live send approval expired. Preview the message again.",
      );
    }
    if (!sameApprovalPayload(approval, payload)) {
      throw approvalError(
        "Live send approval does not match chat, text, reply, parse mode, link preview, or silent flag.",
      );
    }
    this.approvals.delete(id);
  }

  private gc(now: number): void {
    for (const [id, approval] of this.approvals) {
      if (approval.expiresAt <= now) {
        this.approvals.delete(id);
      }
    }
  }
}

export function approvalPayload(params: {
  chatId: string;
  text: string;
  replyToMessageId?: number;
  parseMode: "none" | "html" | "markdown";
  linkPreview?: boolean;
  silent?: boolean;
}): SendApprovalPayload {
  return {
    chatId: params.chatId,
    textHash: createHash("sha256")
      .update(params.text, "utf8")
      .digest("hex"),
    replyToMessageId: params.replyToMessageId ?? null,
    parseMode: params.parseMode,
    linkPreview: params.linkPreview ?? null,
    silent: params.silent ?? null,
  };
}

export function sendPayloadHash(
  payload: SendApprovalPayload,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        chatId: payload.chatId,
        textHash: payload.textHash,
        replyToMessageId: payload.replyToMessageId,
        parseMode: payload.parseMode,
        linkPreview: payload.linkPreview,
        silent: payload.silent,
      }),
      "utf8",
    )
    .digest("hex");
}

function sameApprovalPayload(
  left: SendApprovalPayload,
  right: SendApprovalPayload,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.textHash === right.textHash &&
    left.replyToMessageId === right.replyToMessageId &&
    left.parseMode === right.parseMode &&
    left.linkPreview === right.linkPreview &&
    left.silent === right.silent
  );
}

function approvalError(message: string): ToolError {
  return new ToolError({
    category: "permission",
    retryable: false,
    message,
  });
}

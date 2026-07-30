import type { StoredMessage } from "../store.js";
import type {
  ImportMessageChangeCounts,
  ImportMessageFieldCounts,
  ImportMessageMergeReport,
} from "./contracts.js";
import type { LegacyStoredMessage } from "./normalization.js";

type MessageField = keyof ImportMessageFieldCounts;

export interface MigratedMessageBatchPlan {
  report: ImportMessageMergeReport;
  writes: StoredMessage[];
}

export class CanonicalMessageConflictError extends Error {
  readonly code = "canonical_message_conflict";

  constructor(
    readonly messageMerge: ImportMessageMergeReport,
  ) {
    super(
      "Canonical target message fields conflict with the Python source; no conflicting batch was written.",
    );
    this.name = "CanonicalMessageConflictError";
  }
}

/**
 * Plans one bounded batch without mutating either input. Canonical target
 * values win on overlap: Python may fill only fields that are genuinely empty.
 * Comparisons are intentionally exact; trimming names/text or reparsing dates
 * could collapse distinct Telegram data.
 */
export function planMigratedMessageBatch(
  existingMessages: readonly StoredMessage[],
  incomingMessages: readonly LegacyStoredMessage[],
): MigratedMessageBatchPlan {
  const existing = new Map(
    existingMessages.map((message) => [message.messageId, message]),
  );
  const report = emptyMessageMergeReport();
  const writes: StoredMessage[] = [];

  for (const incoming of incomingMessages) {
    const previous = existing.get(incoming.messageId);
    if (!previous) {
      report.inserts += 1;
      writes.push(incoming);
      continue;
    }

    report.overlaps += 1;
    let changed = false;
    let conflicted = false;
    const merged: StoredMessage = { ...previous };

    const mergeString = (
      field: Extract<
        MessageField,
        "date" | "senderId" | "senderName" | "text"
      >,
      targetValue: string | undefined,
      sourceValue: string | undefined,
      fill: (value: string) => void,
      preserveDifference = false,
    ): void => {
      const result = compareStringField(targetValue, sourceValue);
      if (result === "fill") {
        incrementChange(report.fills, field);
        fill(sourceValue!);
        changed = true;
      } else if (result === "conflict") {
        if (preserveDifference) {
          return;
        }
        incrementChange(report.conflicts, field);
        conflicted = true;
      }
    };

    mergeString(
      "date",
      previous.date,
      incoming.date,
      (value) => {
        merged.date = value;
      },
      // _record_own() used time.time() after sendMessage returned. On overlap,
      // the canonical MTProto timestamp therefore wins by provenance.
      incoming.legacyDateSource === "local_send_observation",
    );
    mergeString(
      "senderId",
      previous.senderId,
      incoming.senderId,
      (value) => {
        merged.senderId = value;
      },
    );
    mergeString(
      "senderName",
      previous.senderName,
      incoming.senderName,
      (value) => {
        merged.senderName = value;
      },
    );
    mergeString("text", previous.text, incoming.text, (value) => {
      merged.text = value;
    });

    const replyResult = compareReplyField(
      previous.replyToMessageId,
      incoming.replyToMessageId,
    );
    if (replyResult === "fill") {
      incrementChange(report.fills, "replyToMessageId");
      merged.replyToMessageId = incoming.replyToMessageId;
      changed = true;
    } else if (replyResult === "conflict") {
      incrementChange(report.conflicts, "replyToMessageId");
      conflicted = true;
    }

    if (changed) {
      report.fills.messages += 1;
    }
    if (conflicted) {
      report.conflicts.messages += 1;
      continue;
    }
    if (changed) {
      // Starting from `previous` deliberately preserves rawJson, topicId and
      // deletedAt even when the Python source has a different raw payload.
      writes.push(merged);
    }
  }

  return { report, writes };
}

export function emptyMessageMergeReport(): ImportMessageMergeReport {
  return {
    inserts: 0,
    overlaps: 0,
    fills: emptyChangeCounts(),
    conflicts: emptyChangeCounts(),
  };
}

export function addMessageMergeReport(
  target: ImportMessageMergeReport,
  source: Readonly<ImportMessageMergeReport>,
): void {
  target.inserts += source.inserts;
  target.overlaps += source.overlaps;
  addChangeCounts(target.fills, source.fills);
  addChangeCounts(target.conflicts, source.conflicts);
}

function compareStringField(
  targetValue: string | undefined,
  sourceValue: string | undefined,
): "preserve" | "fill" | "conflict" {
  if (!isNonEmptyString(sourceValue)) {
    return "preserve";
  }
  if (!isNonEmptyString(targetValue)) {
    return "fill";
  }
  return targetValue === sourceValue ? "preserve" : "conflict";
}

function compareReplyField(
  targetValue: number | undefined,
  sourceValue: number | undefined,
): "preserve" | "fill" | "conflict" {
  if (sourceValue === undefined) {
    return "preserve";
  }
  if (targetValue === undefined) {
    return "fill";
  }
  return targetValue === sourceValue ? "preserve" : "conflict";
}

function isNonEmptyString(
  value: string | undefined,
): value is string {
  return typeof value === "string" && value.length > 0;
}

function emptyChangeCounts(): ImportMessageChangeCounts {
  return {
    messages: 0,
    total: 0,
    date: 0,
    senderId: 0,
    senderName: 0,
    text: 0,
    replyToMessageId: 0,
  };
}

function incrementChange(
  counts: ImportMessageChangeCounts,
  field: MessageField,
): void {
  counts[field] += 1;
  counts.total += 1;
}

function addChangeCounts(
  target: ImportMessageChangeCounts,
  source: Readonly<ImportMessageChangeCounts>,
): void {
  target.messages += source.messages;
  target.total += source.total;
  target.date += source.date;
  target.senderId += source.senderId;
  target.senderName += source.senderName;
  target.text += source.text;
  target.replyToMessageId += source.replyToMessageId;
}

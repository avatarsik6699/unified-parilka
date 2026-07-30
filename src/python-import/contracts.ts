export type SqlRow = Record<string, unknown>;

export interface CliOptions {
  sourcePath: string;
  targetPath: string;
  chatId: string;
  apply: boolean;
}

export interface ImportMessageFieldCounts {
  date: number;
  senderId: number;
  senderName: number;
  text: number;
  replyToMessageId: number;
}

export interface ImportMessageChangeCounts
  extends ImportMessageFieldCounts {
  messages: number;
  total: number;
}

export interface ImportMessageMergeReport {
  inserts: number;
  overlaps: number;
  fills: ImportMessageChangeCounts;
  conflicts: ImportMessageChangeCounts;
}

export interface ImportReport {
  mode: "dry_run" | "applied";
  source: {
    path: string;
    liveMessages: number;
    dayDigests: number;
    digestRollups: number;
    legacyMonthDigests: number;
    outboxByStatus: Record<string, number>;
    drafts: number;
    events: number;
    contentHash: string;
  };
  target: {
    path: string;
    messagesBefore?: number;
    messagesAfter?: number;
    messageWrites?: number;
    dayDigestWrites?: number;
    rollupWrites?: number;
    messageMerge?: ImportMessageMergeReport;
  };
  notes: string[];
}

export type ImportPhase = "inspect" | "validate" | "apply";

export interface ImportFailureReport {
  event: "python_state_import_failed";
  phase: ImportPhase;
  targetMayBePartiallyModified: boolean;
  messageMerge?: ImportMessageMergeReport;
  error: {
    code: "migration_failed" | "canonical_message_conflict";
    message: string;
  };
}

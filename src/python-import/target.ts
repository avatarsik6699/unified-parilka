import { DatabaseSync } from "node:sqlite";
import {
  MessageStore,
  type StoredMessage,
} from "../store.js";
import type { ChatInfo } from "../telegram-client.js";
import type { CliOptions, ImportReport, SqlRow } from "./contracts.js";
import {
  legacyLiveMessage,
  type LegacyStoredMessage,
  normalizeDayDigest,
  normalizeLegacyMonth,
  normalizeRollup,
} from "./normalization.js";
import {
  createPrivateTargetIfMissing,
  tableExists,
} from "./sqlite-guards.js";
import {
  addMessageMergeReport,
  CanonicalMessageConflictError,
  emptyMessageMergeReport,
  planMigratedMessageBatch,
} from "./message-merge.js";

const MESSAGE_BATCH_SIZE = 500;

export function applyImport(
  source: DatabaseSync,
  options: CliOptions,
  report: ImportReport,
): void {
  createPrivateTargetIfMissing(options.targetPath);
  const store = new MessageStore(options.targetPath);
  const chat: ChatInfo = {
    chatId: options.chatId,
    requested: options.chatId,
    kind: "MigratedBotApiCorpus",
  };
  let messageWrites = 0;
  let dayDigestWrites = 0;
  let rollupWrites = 0;
  try {
    report.target.messagesBefore = store.countMessages(options.chatId);
    const existingDigests = existingTargetDigestKeys(
      options.targetPath,
      options.chatId,
    );
    const messageMerge = preflightMigratedMessages(
      source,
      store,
      options.chatId,
    );
    report.target.messageMerge = messageMerge;
    if (messageMerge.conflicts.total > 0) {
      throw new CanonicalMessageConflictError(messageMerge);
    }
    forEachLegacyMessageBatch(source, options.chatId, (batch) => {
      messageWrites += upsertMigratedMessages(store, chat, batch);
    });

    if (tableExists(source, "digest_day")) {
      const statement = source.prepare(
        `SELECT day, start_msg_id, end_msg_id, n_msgs, in_tokens,
                out_tokens, model, prompt_version, text, created_at
         FROM digest_day
         ORDER BY day ASC`,
      );
      for (const row of statement.iterate() as Iterable<SqlRow>) {
        const normalized = normalizeDayDigest(row, options.chatId);
        if (existingDigests.days.has(normalized.day)) {
          continue;
        }
        store.upsertDayDigest(normalized);
        existingDigests.days.add(normalized.day);
        dayDigestWrites += 1;
      }
    }

    if (tableExists(source, "digest_roll")) {
      const statement = source.prepare(
        `SELECT kind, period, day_from, day_to, n_days, prompt_version,
                text, created_at
         FROM digest_roll
         ORDER BY day_from ASC, period ASC`,
      );
      for (const row of statement.iterate() as Iterable<SqlRow>) {
        const normalized = normalizeRollup(row, options.chatId);
        const key = digestRollupKey(
          normalized.kind,
          normalized.period,
        );
        if (existingDigests.rollups.has(key)) {
          continue;
        }
        store.upsertDigestRollup(normalized);
        existingDigests.rollups.add(key);
        rollupWrites += 1;
      }
    }

    // Older deployments may have month summaries predating digest_roll.
    // Existing rollups win because they contain explicit day bounds.
    if (tableExists(source, "digest_month")) {
      const statement = source.prepare(
        `SELECT month, n_days, prompt_version, text, created_at
         FROM digest_month
         ORDER BY month ASC`,
      );
      for (const row of statement.iterate() as Iterable<SqlRow>) {
        const normalized = normalizeLegacyMonth(row, options.chatId);
        const key = digestRollupKey("month", normalized.period);
        if (existingDigests.rollups.has(key)) {
          continue;
        }
        store.upsertDigestRollup(normalized);
        existingDigests.rollups.add(key);
        rollupWrites += 1;
      }
    }

    report.target.messagesAfter = store.countMessages(options.chatId);
    report.target.messageWrites = messageWrites;
    report.target.dayDigestWrites = dayDigestWrites;
    report.target.rollupWrites = rollupWrites;
  } finally {
    store.close();
  }
}

function upsertMigratedMessages(
  store: MessageStore,
  chat: ChatInfo,
  messages: LegacyStoredMessage[],
): number {
  const plan = planMigratedMessageBatch(
    store.getMessagesByIds({
      chatId: chat.chatId,
      messageIds: messages.map(({ messageId }) => messageId),
    }),
    messages,
  );
  if (plan.report.conflicts.total > 0) {
    throw new CanonicalMessageConflictError(plan.report);
  }
  return plan.writes.length === 0
    ? 0
    : store.upsertMessages(chat, plan.writes);
}

function preflightMigratedMessages(
  source: DatabaseSync,
  store: MessageStore,
  chatId: string,
): ReturnType<typeof emptyMessageMergeReport> {
  const report = emptyMessageMergeReport();
  forEachLegacyMessageBatch(source, chatId, (batch) => {
    const plan = planMigratedMessageBatch(
      store.getMessagesByIds({
        chatId,
        messageIds: batch.map(({ messageId }) => messageId),
      }),
      batch,
    );
    addMessageMergeReport(report, plan.report);
  });
  return report;
}

function forEachLegacyMessageBatch(
  source: DatabaseSync,
  chatId: string,
  visit: (batch: LegacyStoredMessage[]) => void,
): void {
  if (!tableExists(source, "live_msg")) {
    return;
  }
  const statement = source.prepare(
    `SELECT message_id, chat_id, date_unix, sender_id, sender_name,
            text, reply_to, edited_at, raw_json, is_bot
     FROM live_msg
     ORDER BY message_id ASC`,
  );
  let batch: LegacyStoredMessage[] = [];
  for (const row of statement.iterate() as Iterable<SqlRow>) {
    batch.push(legacyLiveMessage(row, chatId));
    if (batch.length >= MESSAGE_BATCH_SIZE) {
      visit(batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    visit(batch);
  }
}

function existingTargetDigestKeys(
  targetPath: string,
  chatId: string,
): {
  days: Set<string>;
  rollups: Set<string>;
} {
  const target = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const days = target
      .prepare(
        `SELECT day
         FROM chat_day_digests
         WHERE chat_id = ?`,
      )
      .all(chatId) as SqlRow[];
    const rollups = target
      .prepare(
        `SELECT kind, period
         FROM chat_digest_rollups
         WHERE chat_id = ?`,
      )
      .all(chatId) as SqlRow[];
    return {
      days: new Set(days.map((row) => String(row.day))),
      rollups: new Set(
        rollups.map((row) =>
          digestRollupKey(
            String(row.kind),
            String(row.period),
          ),
        ),
      ),
    };
  } finally {
    target.close();
  }
}

function digestRollupKey(kind: string, period: string): string {
  return `${kind}\u0000${period}`;
}
